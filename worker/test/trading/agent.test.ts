/**
 * ADR-0007 units: shared vectors (message v3), token format / verification, the note sanitiser, the order body schema, the
 * per-bot gate, the registry fields (kind, token record) and the AI authoring refusal.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnState } from "../../src/ai/proposals.js";
import { AGENT_MODE_NOT_FROM_AI, buildTradingRulesCard, stubPairInfoProvider } from "../../src/ai/trading.js";
import { AGENT_TOKEN_RE, AgentGate, agentOrderBody, canonicalBody, isFinal, makeAgentToken, rejected, sanitizeNote, TRANSIENT, verifyAgentToken } from "../../src/trading/agent.js";
import { RegistryError, botKind, openRegistry } from "../../src/trading/bots.js";
import { offlinePairInfo, verifyEnvelope } from "../../src/trading/confirm.js";
import { effectiveLimits } from "../../src/trading/engine/risk.js";
import { confirmationMessage, hashRuleSet } from "../../src/trading/rules/canonical.js";
import { describe as render } from "../../src/trading/rules/describe.js";
import { parseRuleSet } from "../../src/trading/rules/schema.js";
import { validate } from "../../src/trading/rules/validate.js";
import type { AgentOrderResponse, ConfirmedRules, RuleSetV1 } from "../../src/trading/types.js";
import { freshNear, HARD, HL_ACCOUNT, makeCtx, ownerKeyPair, OWNER, PAIRS, tmpDir, VAULT } from "./fixtures.js";

interface MsgVector {
  input: { vault: string; agentId: string; hlNetwork: "mainnet" | "testnet"; hlAccount: string; rulesSha256: string; botId?: string; mode?: "agent" };
  message: string;
}
const vectors = JSON.parse(readFileSync(new URL("../../../docs/trading-rules-vectors.json", import.meta.url), "utf8")) as {
  valid: { name: string; input: unknown; sha256: string }[];
  messages: { v2: MsgVector[]; v1_legacy: MsgVector[]; v3_agent: MsgVector[] };
};

const mandate = (o: Partial<RuleSetV1> = {}): RuleSetV1 => ({
  version: 1,
  mode: "agent",
  name: "PURR agent",
  pairs: ["PURR/USDC"],
  limits: { max_position_usdc: "25", max_order_usdc: "12", daily_loss_stop_usdc: "3", max_orders_per_day: 6 },
  rules: [],
  ...o,
});

describe("vectors and the v3 message", () => {
  it("the frozen agent vector hashes to f29e…bd0c and renders the agent line", () => {
    const p = parseRuleSet(mandate());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(hashRuleSet(p.value)).toBe("f29ef0d0ac3a06c46640a840c4014f216babbdc2dc6944666809b369079bbd0c");
    expect(render(p.value).at(-1)).toBe("Orders: chosen by a connected AI agent; each is an immediate-or-cancel order inside the price band and is checked against these limits");
  });
  it("matches the shared v3_agent, v2 and v1_legacy message vectors", () => {
    expect(vectors.messages.v3_agent.length).toBeGreaterThan(0);
    for (const v of [...vectors.messages.v3_agent, ...vectors.messages.v2, ...vectors.messages.v1_legacy]) expect(confirmationMessage(v.input)).toBe(v.message);
  });
  it("v3 differs from v2 in the header and the mode line; mode without botId throws", () => {
    const base = { vault: "v", agentId: "a", hlNetwork: "testnet" as const, hlAccount: HL_ACCOUNT, rulesSha256: "a".repeat(64), botId: "b" };
    const v2 = confirmationMessage(base);
    const v3 = confirmationMessage({ ...base, mode: "agent" });
    expect(v3.split("\n")[0]).toBe("Agent Treasury: activate AI agent trading limits");
    expect(v3).toContain("\nmode: agent\n");
    expect(v2).not.toContain("mode:");
    const noBot = { vault: base.vault, agentId: base.agentId, hlNetwork: base.hlNetwork, hlAccount: base.hlAccount, rulesSha256: base.rulesSha256 };
    expect(() => confirmationMessage({ ...noBot, mode: "agent" })).toThrow();
  });
  it("DSL hashes are unchanged by the new optional key (mode absent = DSL)", () => {
    const v0 = vectors.valid[0] as { input: unknown; sha256: string };
    const p = parseRuleSet(v0.input);
    expect(p.ok && hashRuleSet(p.value)).toBe(v0.sha256);
    expect(p.ok && "mode" in p.value).toBe(false);
  });
  it("agent limits: LIMIT_AGENT_MAX_ORDERS only with the agent cap set, and effectiveLimits takes the minimum", () => {
    const m = mandate({ limits: { ...mandate().limits, max_orders_per_day: 11 } });
    expect(validate(m, HARD, PAIRS).ok).toBe(true);
    expect(validate(m, { ...HARD, agentMaxOrdersPerDay: 10 }, PAIRS).errors.map((e) => e.code)).toEqual(["LIMIT_AGENT_MAX_ORDERS"]);
    expect(effectiveLimits(mandate(), { ...HARD, agentMaxOrdersPerDay: 4 }).maxOrdersPerDay).toBe(4);
    // A DSL rule set ignores the agent cap.
    const dsl = parseRuleSet(vectors.valid[0]?.input);
    expect(dsl.ok && effectiveLimits(dsl.value, { ...HARD, agentMaxOrdersPerDay: 1 }).maxOrdersPerDay).toBe(3);
  });
});

describe("signature confusion (MESSAGE_MISMATCH)", () => {
  const near = freshNear();
  const ctx = makeCtx(near);
  const env = (rules: RuleSetV1, message: string): ConfirmedRules => {
    const nonce = Buffer.alloc(32, 7);
    return {
      bot_id: "b1",
      rules,
      hash: hashRuleSet(rules),
      message,
      signature: ownerKeyPair.signNep413({ message, nonce, recipient: VAULT, callbackUrl: null }),
      public_key: ownerKeyPair.publicKey,
      account_id: OWNER,
      nonce: nonce.toString("base64"),
      callback_url: null,
      confirmed_at_ms: 1,
    };
  };
  const msg = (rules: RuleSetV1, mode?: "agent") =>
    confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL_ACCOUNT, rulesSha256: hashRuleSet(rules), botId: "b1", ...(mode ? { mode } : {}) });
  const dsl = parseRuleSet(vectors.valid[0]?.input);
  if (!dsl.ok) throw new Error("vector");
  const agent = { ...mandate(), pairs: ["HYPE/USDC"] };

  it("a correctly signed agent envelope verifies; the same with the DSL message is refused", async () => {
    await expect(verifyEnvelope(env(agent, msg(agent, "agent")), ctx, offlinePairInfo(HARD), { botId: "b1" })).resolves.toMatchObject({ mode: "agent" });
    await expect(verifyEnvelope(env(agent, msg(agent)), ctx, offlinePairInfo(HARD), { botId: "b1" })).rejects.toMatchObject({ code: "MESSAGE_MISMATCH" });
  });
  it("a DSL envelope signed with the agent message is refused", async () => {
    await expect(verifyEnvelope(env(dsl.value, msg(dsl.value)), ctx, offlinePairInfo(HARD), { botId: "b1" })).resolves.toBeTruthy();
    await expect(verifyEnvelope(env(dsl.value, msg(dsl.value, "agent")), ctx, offlinePairInfo(HARD), { botId: "b1" })).rejects.toMatchObject({ code: "MESSAGE_MISMATCH" });
  });
  it("an agent envelope can never be a legacy v1 envelope", async () => {
    const e = env(agent, msg(agent, "agent"));
    delete e.bot_id;
    await expect(verifyEnvelope(e, ctx, offlinePairInfo(HARD), { botId: "default", legacyV1Hash: e.hash })).rejects.toMatchObject({ code: "MESSAGE_MISMATCH" });
  });
});

describe("agent token", () => {
  const reg = () => {
    const r = openRegistry(tmpDir());
    return r;
  };
  it("has the documented format and only its sha256 is in the record", () => {
    const { issued, record } = makeAgentToken("purr-agent", 1000, 3_600_000);
    expect(issued.token).toMatch(AGENT_TOKEN_RE);
    expect(issued.token.startsWith("atk1_purr-agent_")).toBe(true);
    expect(record.token_sha256).toBe(createHash("sha256").update(issued.token).digest("hex"));
    expect(record.token_id).toBe(record.token_sha256.slice(0, 8));
    expect(JSON.stringify(record)).not.toContain(issued.token.slice(16));
    expect(record.expires_at_ms).toBe(1000 + 3_600_000);
  });
  it("verify: one code for every bad case, a separate one for expiry; the bot id comes from the token", () => {
    const r = reg();
    const { issued, record } = makeAgentToken("ag", 1000, 10_000);
    r.activate({ botId: "ag", hash: "1".repeat(64), name: "Ag", maxBots: 3, kind: "agent" }, 1000, record);
    r.activate({ botId: "dsl", hash: "2".repeat(64), name: "Dsl", maxBots: 3 }, 1000);
    const ok = verifyAgentToken(r, `Bearer ${issued.token}`, 2000);
    expect(ok).toMatchObject({ ok: true, botId: "ag", tokenId: record.token_id });
    const secret = issued.token.slice("atk1_ag_".length);
    for (const h of [undefined, "", "Bearer", `Basic ${issued.token}`, `Bearer ${issued.token}x`, `Bearer atk1_ag_${"A".repeat(43)}`, `Bearer atk1_dsl_${secret}`, `Bearer atk1_nobody_${secret}`])
      expect(verifyAgentToken(r, h, 2000)).toMatchObject({ ok: false, status: 401, code: "AGENT_UNAUTHORIZED" });
    expect(verifyAgentToken(r, `Bearer ${issued.token}`, 11_000)).toMatchObject({ ok: false, code: "AGENT_TOKEN_EXPIRED" });
    r.revokeAgentToken("ag");
    expect(verifyAgentToken(r, `Bearer ${issued.token}`, 2000)).toMatchObject({ ok: false, code: "AGENT_UNAUTHORIZED" });
  });
});

describe("registry: kind and token record", () => {
  it("an old bots.json without kind loads as rules and refuses an agent mandate (and vice versa)", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "bots.json"),
      JSON.stringify({ version: 1, legacy_v1: null, bots: [{ id: "old", name: "Old", created_at_ms: 1, archived_at_ms: null, active_hash: null, hashes: [] }] }),
    );
    const r = openRegistry(dir);
    const old = r.get("old");
    expect(old && botKind(old)).toBe("rules");
    expect(() => r.check({ botId: "old", hash: "3".repeat(64), maxBots: 3, kind: "agent" })).toThrow(RegistryError);
    try {
      r.check({ botId: "old", hash: "3".repeat(64), maxBots: 3, kind: "agent" });
    } catch (e) {
      expect((e as RegistryError).code).toBe("BOT_KIND_MISMATCH");
    }
    r.activate({ botId: "ag", hash: "4".repeat(64), name: "Ag", maxBots: 3, kind: "agent" }, 5, makeAgentToken("ag", 5, 10).record);
    expect(() => r.check({ botId: "ag", hash: "5".repeat(64), maxBots: 3 })).toThrow(/vice versa/);
    // The old bot round-trips without new keys; the new agent bot carries kind + token in the same file.
    const file = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) as { bots: Record<string, unknown>[] };
    expect(Object.keys(file.bots[0] ?? {})).not.toContain("kind");
    expect(file.bots[1]).toMatchObject({ id: "ag", kind: "agent", active_hash: "4".repeat(64), agent: { token_id: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown } });
    expect(openRegistry(dir).get("ag")?.agent?.token_id).toBe((file.bots[1]?.["agent"] as { token_id: string }).token_id);
  });
  it("activate writes the hash and the new token in one commit; archive and revoke clear the token", () => {
    const dir = tmpDir();
    const r = openRegistry(dir);
    const t1 = makeAgentToken("ag", 1, 100).record;
    r.activate({ botId: "ag", hash: "6".repeat(64), name: "Ag", maxBots: 3, kind: "agent" }, 1, t1);
    const t2 = makeAgentToken("ag", 2, 100).record;
    r.activate({ botId: "ag", hash: "6".repeat(64), maxBots: 3, kind: "agent" }, 2, t2);
    const disk = () => (JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) as { bots: { agent?: { token_sha256: string } | null; archived_at_ms: number | null }[] }).bots[0];
    expect(disk()?.agent?.token_sha256).toBe(t2.token_sha256);
    expect(r.revokeAgentToken("ag")).toBe(true);
    expect(disk()?.agent).toBeNull();
    expect(r.revokeAgentToken("ag")).toBe(false);
    r.activate({ botId: "ag", hash: "6".repeat(64), maxBots: 3, kind: "agent" }, 3, makeAgentToken("ag", 3, 100).record);
    r.archive("ag", 4);
    expect(disk()?.agent).toBeNull();
    expect(disk()?.archived_at_ms).toBe(4);
    expect(() => r.activate({ botId: "dsl", hash: "7".repeat(64), name: "D", maxBots: 3 }, 1, t1)).toThrow(/agent token/);
  });
  it("a token record on a rules bot or a malformed record makes bots.json unusable (fail closed)", () => {
    for (const bad of [
      { kind: "rules", agent: makeAgentToken("x", 1, 1).record },
      { kind: "agent", agent: { token_sha256: "zz", token_id: "zz", issued_at_ms: 1, expires_at_ms: 2 } },
      { kind: "robot" },
    ]) {
      const dir = tmpDir();
      writeFileSync(join(dir, "bots.json"), JSON.stringify({ version: 1, legacy_v1: null, bots: [{ id: "x", name: "X", created_at_ms: 1, archived_at_ms: null, active_hash: null, hashes: [], ...bad }] }));
      expect(() => openRegistry(dir)).toThrow();
    }
  });
});

describe("note sanitiser", () => {
  it("removes control, format (bidi) and separator characters, collapses whitespace, caps at 200 code points", () => {
    expect(sanitizeNote("buy \u202Eevil\u202C now\n\nplease\u0000!")).toBe("buy evil now please !");
    expect(sanitizeNote("a\u2028b\u2029c\td")).toBe("a b c d");
    expect(sanitizeNote("   \n\t ")).toBeNull();
    expect(sanitizeNote(undefined)).toBeNull();
    const long = sanitizeNote("x".repeat(300));
    expect(long).toHaveLength(200);
    expect(Array.from(sanitizeNote("🚀".repeat(250)) ?? "")).toHaveLength(200);
  });
});

describe("order body", () => {
  const ok = (b: unknown) => agentOrderBody.safeParse(b).success;
  it("exactly one size field; position_pct for sells only, 1..100; usdc > 0; strict keys", () => {
    expect(ok({ pair: "HYPE/USDC", side: "buy", usdc: "12" })).toBe(true);
    expect(ok({ pair: "HYPE/USDC", side: "sell", position_pct: "100", reason: "take profit", idempotency_key: "abcdefgh" })).toBe(true);
    expect(ok({ pair: "HYPE/USDC", side: "buy" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "sell", usdc: "12", position_pct: "50" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "buy", position_pct: "50" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "sell", position_pct: "0.5" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "sell", position_pct: "101" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "buy", usdc: "0" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "buy", usdc: 12 })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "buy", usdc: "12", price: "1" })).toBe(false);
    expect(ok({ pair: "HYPE", side: "buy", usdc: "12" })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "buy", usdc: "12", reason: "x".repeat(201) })).toBe(false);
    expect(ok({ pair: "HYPE/USDC", side: "buy", usdc: "12", idempotency_key: "short" })).toBe(false);
  });
  it("the canonical body ignores the idempotency key and key order", () => {
    const a = agentOrderBody.parse({ side: "buy", pair: "HYPE/USDC", usdc: "12", idempotency_key: "k1k1k1k1" });
    const b = agentOrderBody.parse({ pair: "HYPE/USDC", usdc: "12", side: "buy" });
    expect(canonicalBody(a)).toBe(canonicalBody(b));
  });
});

describe("gate and mapping", () => {
  const res = (): AgentOrderResponse => rejected("MAX_ORDER", "too big", { orders: 3, loss_usdc: "2" });
  it("in flight, interval (Retry-After), replay before the interval, reused key with another body", () => {
    const clock = { t: 0 };
    const g = new AgentGate(10_000, () => clock.t);
    const a = g.begin("b", "t1", "key-0001", "A");
    expect(a.kind).toBe("go");
    expect(g.begin("b", "t1", undefined, "B")).toMatchObject({ kind: "error", status: 409, code: "ORDER_IN_FLIGHT" });
    if (a.kind === "go") a.release(res());
    clock.t = 3_000;
    expect(g.begin("b", "t1", undefined, "B")).toMatchObject({ kind: "error", status: 429, code: "AGENT_RATE_LIMITED", retryAfterS: 7 });
    expect(g.begin("b", "t1", "key-0001", "A")).toMatchObject({ kind: "replay", response: { replayed: true, code: "MAX_ORDER" } });
    expect(g.begin("b", "t1", "key-0001", "B")).toMatchObject({ kind: "error", status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    // Another token (re-sign) starts fresh.
    expect(g.begin("b", "t2", "key-0001", "B").kind).toBe("go");
    clock.t = 10_000;
    expect(g.begin("b", "t1", undefined, "B").kind).toBe("go");
  });
  it("final unless TRANSIENT; retry_after_s 60 only for transient refusals", () => {
    expect(isFinal("MAX_ORDER")).toBe(true);
    expect(isFinal("SOMETHING_NEW")).toBe(true);
    for (const c of TRANSIENT) expect(isFinal(c)).toBe(false);
    expect(rejected("STALE_DATA", "x", { orders: 1, loss_usdc: "1" })).toMatchObject({ final: false, retry_after_s: 60, status: "rejected" });
    expect(rejected("BOT_HALTED", "x", { orders: 1, loss_usdc: "1" })).toMatchObject({ final: true, retry_after_s: null });
    expect(rejected("X", "y".repeat(500), { orders: 1, loss_usdc: "1" }).message).toHaveLength(300);
    expect(rejected("X", "y", { orders: 1, loss_usdc: "1" }).request_id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("AI authoring never produces agent mode", () => {
  it("buildTradingRulesCard refuses any rule set with a mode key", async () => {
    const r = await buildTradingRulesCard({ hard: HARD, pairs: stubPairInfoProvider(PAIRS) }, new TurnState(), mandate(), { showInvalid: true });
    expect(r.errors).toEqual([AGENT_MODE_NOT_FROM_AI]);
    const r2 = await buildTradingRulesCard({ hard: HARD, pairs: stubPairInfoProvider(PAIRS) }, new TurnState(), { ...mandate(), mode: "rules" }, { showInvalid: true });
    expect(r2.errors?.[0]).toMatch(/^AGENT_MODE_NOT_FROM_AI/);
  });
  it("and cannot target an existing agent bot with DSL rules (BOT_KIND_MISMATCH)", async () => {
    const reg = openRegistry(tmpDir());
    reg.activate({ botId: "ag", hash: "8".repeat(64), name: "Ag", maxBots: 3, kind: "agent" }, 1, makeAgentToken("ag", 1, 100).record);
    const dsl = vectors.valid[0]?.input;
    const r = await buildTradingRulesCard({ hard: HARD, pairs: stubPairInfoProvider(PAIRS), bots: { registry: reg, maxBots: 3 } }, new TurnState("ag"), dsl, { showInvalid: true });
    expect(r.card?.validation.ok).toBe(false);
    expect(r.card?.validation.errors.join(" ")).toContain("BOT_KIND_MISMATCH");
  });
});
