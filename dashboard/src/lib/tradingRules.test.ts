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
