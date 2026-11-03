import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, confirmationMessage, describeBlocks, describeRules, hashRuleSet, parseRuleSet, sha256Hex, type RuleSetV1 } from "./tradingRules";

interface MsgVector {
  input: { vault: string; agentId: string; hlNetwork: "mainnet" | "testnet"; hlAccount: string; rulesSha256: string; botId?: string };
  message: string;
}
interface Vectors {
  valid: Array<{ name: string; input: unknown; canonical: string; sha256: string; describe: string[] }>;
  invalid: Array<{ name: string; layer: "schema" | "limits"; input: unknown; errors: string[] }>;
  messages: { v2: MsgVector[]; v1_legacy: MsgVector[] };
}
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/trading-rules-vectors.json", import.meta.url)), "utf8")) as Vectors;

describe("shared vectors (docs/trading-rules-vectors.json)", () => {
  it("has vectors", () => {
    expect(vectors.valid.length).toBeGreaterThan(0);
    expect(vectors.invalid.length).toBeGreaterThan(0);
  });
  for (const v of vectors.valid) {
    describe(v.name, () => {
      const parsed = parseRuleSet(v.input);
      it("parses", () => expect(parsed.ok).toBe(true));
      it("canonical string is identical", () => {
        if (parsed.ok) expect(canonicalize(parsed.rules)).toBe(v.canonical);
      });
      it("sha256 is identical", async () => {
        if (parsed.ok) expect(await hashRuleSet(parsed.rules)).toBe(v.sha256);
        expect(await sha256Hex(v.canonical)).toBe(v.sha256);
      });
      it("rendering is identical", () => {
        if (parsed.ok) expect(describeRules(parsed.rules)).toEqual(v.describe);
      });
    });
  }
  // Limits-layer vectors need the worker's env and market data; the dashboard only guarantees well-formed v1 JSON.
  for (const v of vectors.invalid.filter((i) => i.layer === "schema")) {
    it(`rejects: ${v.name}`, () => {
      const r = parseRuleSet(v.input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toEqual(v.errors);
    });
  }
  for (const v of vectors.invalid.filter((i) => i.layer === "limits")) {
    it(`well-formed (limits are the worker's): ${v.name}`, () => expect(parseRuleSet(v.input).ok).toBe(true));
  }
});

describe("canonical form", () => {
  const rs: RuleSetV1 = {
    version: 1,
    name: "n",
    pairs: ["HYPE/USDC"],
    limits: { max_position_usdc: "40", max_order_usdc: "10", daily_loss_stop_usdc: "5", max_orders_per_day: 3 },
    rules: [{ id: "a", pair: "HYPE/USDC", when: { type: "interval", every: "1d" }, action: { side: "buy", size: { usdc: "10" }, order: { type: "ioc" } } }],
  };
  it("omits unset optional keys and keeps decimal strings as they are", () => {
    expect(canonicalize(rs)).not.toContain("cooldown");
    expect(canonicalize({ ...rs, limits: { ...rs.limits, max_order_usdc: "10.0" } })).toContain('"max_order_usdc":"10.0"');
  });
  it("different decimal text is a different hash", async () => {
    expect(await hashRuleSet(rs)).not.toBe(await hashRuleSet({ ...rs, limits: { ...rs.limits, max_order_usdc: "10.0" } }));
  });
  it("blocks carry the same per-rule lines", () => {
    const b = describeBlocks(rs);
    expect(b.rules[0]?.title).toBe("Rule 1 [a] on HYPE/USDC");
    expect(b.rules[0]?.lines[0]).toMatch(/^When: every 1 day/);
  });
});

describe("confirmationMessage", () => {
  it("is the ADR text with a lower-case HL account", () => {
    expect(confirmationMessage({ vault: "v.testnet", agentId: "hl-trader", hlNetwork: "testnet", hlAccount: "0xABCDEF0123456789abcdef0123456789ABCDEF01", rulesSha256: "a".repeat(64) })).toBe(
      ["Agent Treasury: activate trading rules", "vault: v.testnet", "agent: hl-trader", "hl_network: testnet", "hl_account: 0xabcdef0123456789abcdef0123456789abcdef01", `rules_sha256: ${"a".repeat(64)}`].join("\n"),
    );
  });
  it("matches the shared v2 vectors (bot line)", () => {
    for (const v of vectors.messages.v2) expect(confirmationMessage(v.input)).toBe(v.message);
  });
  it("matches the shared v1_legacy vectors (no bot line)", () => {
    for (const v of vectors.messages.v1_legacy) expect(confirmationMessage(v.input)).toBe(v.message);
  });
});

/* ───────────── ADR-0007: AI-agent mandates ───────────── */

/** The frozen vector of ADR-0007 §1 (also in docs/trading-rules-vectors.json once the worker side adds it). */
const AGENT_VECTOR = {
  input: { version: 1, mode: "agent", name: "PURR agent", pairs: ["PURR/USDC"], limits: { max_position_usdc: "25", max_order_usdc: "12", daily_loss_stop_usdc: "3", max_orders_per_day: 6 }, rules: [] },
  canonical: '{"limits":{"daily_loss_stop_usdc":"3","max_order_usdc":"12","max_orders_per_day":6,"max_position_usdc":"25"},"mode":"agent","name":"PURR agent","pairs":["PURR/USDC"],"rules":[],"version":1}',
  sha256: "f29ef0d0ac3a06c46640a840c4014f216babbdc2dc6944666809b369079bbd0c",
  describe: [
    "Rule set: PURR agent",
    "Pairs: PURR/USDC",
    "Max position: 25 USDC",
    "Max order: 12 USDC",
    "Daily loss stop: 3 USDC",
    "Max orders per day: 6",
    "Orders: chosen by a connected AI agent; each is an immediate-or-cancel order inside the price band and is checked against these limits",
  ],
};

describe("agent mode (ADR-0007 frozen vector)", () => {
  const parsed = parseRuleSet(AGENT_VECTOR.input);
  it("parses", () => expect(parsed.ok).toBe(true));
  it("canonical form, hash and describe are the frozen ones", async () => {
    if (!parsed.ok) throw new Error("not parsed");
    expect(parsed.rules.mode).toBe("agent");
    expect(canonicalize(parsed.rules)).toBe(AGENT_VECTOR.canonical);
    expect(await hashRuleSet(parsed.rules)).toBe(AGENT_VECTOR.sha256);
    expect(describeRules(parsed.rules)).toEqual(AGENT_VECTOR.describe);
  });
  it("blocks carry the agent line and no rules", () => {
    if (!parsed.ok) throw new Error("not parsed");
    const b = describeBlocks(parsed.rules);
    expect(b.rules).toEqual([]);
    expect(b.summary.at(-1)).toMatch(/^Orders: chosen by a connected AI agent/);
  });
  it("a DSL rule set has no mode key in its canonical form (DSL hashes unchanged)", () => {
    const dsl = vectors.valid[0];
    if (!dsl) throw new Error("no vector");
    const p = parseRuleSet(dsl.input);
    expect(p.ok && canonicalize(p.rules)).not.toContain('"mode"');
  });
  const bad = (over: Record<string, unknown>, drop?: string) => {
    const o: Record<string, unknown> = { ...AGENT_VECTOR.input, ...over };
    if (drop) delete o[drop];
    return parseRuleSet(o);
  };
  it('mode "rules" (or anything but "agent") gives BAD_MODE', () => {
    expect(bad({ mode: "rules" })).toEqual({ ok: false, errors: ["BAD_MODE"] });
    expect(bad({ mode: null })).toEqual({ ok: false, errors: ["BAD_MODE"] });
  });
  it("agent mode with a rule gives AGENT_HAS_RULES", () => {
    const rule = { id: "a", pair: "PURR/USDC", when: { type: "interval", every: "1d" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } };
    expect(bad({ rules: [rule] })).toEqual({ ok: false, errors: ["AGENT_HAS_RULES"] });
  });
  it("agent mode without a rules key gives SCHEMA", () => {
    expect(bad({}, "rules")).toEqual({ ok: false, errors: ["SCHEMA"] });
  });
  it("a DSL rule set with no rules still gives NO_RULES, and unknown keys stay UNKNOWN_KEY", () => {
    expect(bad({}, "mode")).toEqual({ ok: false, errors: ["NO_RULES"] });
    expect(bad({ extra: 1 })).toEqual({ ok: false, errors: ["UNKNOWN_KEY"] });
  });
  it("max_orders_per_day above the worker's agent cap is the worker's check (LIMIT_AGENT_MAX_ORDERS): well-formed here", () => {
    expect(bad({ limits: { ...AGENT_VECTOR.input.limits, max_orders_per_day: 11 } }).ok).toBe(true);
  });
});

describe("confirmationMessage v3 (agent mode)", () => {
  const p = { vault: "v.testnet", agentId: "hl-trader", hlNetwork: "testnet" as const, hlAccount: "0xABCDEF0123456789abcdef0123456789ABCDEF01", rulesSha256: AGENT_VECTOR.sha256, botId: "purr-agent" };
  it("is the ADR-0007 text", () => {
    expect(confirmationMessage({ ...p, mode: "agent" })).toBe(
      [
        "Agent Treasury: activate AI agent trading limits",
        "vault: v.testnet",
        "agent: hl-trader",
        "bot: purr-agent",
        "mode: agent",
        "hl_network: testnet",
        "hl_account: 0xabcdef0123456789abcdef0123456789abcdef01",
        `rules_sha256: ${AGENT_VECTOR.sha256}`,
      ].join("\n"),
    );
  });
  it("differs from the v2 message for the same input, and needs a bot id", () => {
    expect(confirmationMessage({ ...p, mode: "agent" })).not.toBe(confirmationMessage(p));
    expect(() => confirmationMessage({ vault: p.vault, agentId: p.agentId, hlNetwork: p.hlNetwork, hlAccount: p.hlAccount, rulesSha256: p.rulesSha256, mode: "agent" })).toThrow();
  });
  it("matches the shared v3 vectors when the worker side has added them", () => {
    const v3 = (vectors.messages as unknown as Record<string, MsgVector[] | undefined>).v3 ?? [];
    for (const v of v3) expect(confirmationMessage(v.input as Parameters<typeof confirmationMessage>[0])).toBe(v.message);
  });
});
