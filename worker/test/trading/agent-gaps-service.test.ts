/**
 * ADR-0007 coverage gaps (tester pass 2026-11-03), service + HTTP level, money safety first:
 *   - every bot / account state that must refuse an agent order, through the real service mapping (final, no HL order);
 *   - concurrency: an agent order queued behind a scheduled tick while the owner kills, stops, re-signs, revokes or archives;
 *   - token matrix (malformed, expiry boundary, rotation on a limits change, revoke on the order route);
 *   - idempotency (replay never places a second order, also after a halt; a different body or reason is refused);
 *   - `TRADING_AGENT_ENABLED=false`: the DSL path gives the same v2 message bytes and hashes; an agent bot left over from an
 *     enabled run cannot trade.
 * Real service + FakeHl (no network, no money, no keys).
 */
/* Test-only: HTTP bodies are asserted as loosely typed JSON. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confirmationMessage, hashRuleSet } from "../../src/trading/rules/canonical.js";
import { parseRuleSet } from "../../src/trading/rules/schema.js";
import type { AgentTradingSettings } from "../../src/trading/service.js";
import type { RuleSetV1 } from "../../src/trading/types.js";
import { HL_ACCOUNT, VAULT } from "./fixtures.js";
import { dcaRules, harness } from "./harness.js";

const AGENT: AgentTradingSettings = { enabled: true, maxOrdersPerDay: 10, minOrderIntervalSec: 10, tokenTtlHours: 72 };
const mandate = (o: Partial<RuleSetV1["limits"]> = {}): RuleSetV1 => ({
  version: 1,
  mode: "agent",
  name: "HYPE agent",
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "25", max_order_usdc: "12", daily_loss_stop_usdc: "3", max_orders_per_day: 6, ...o },
  rules: [],
});
type H = ReturnType<typeof harness>;
const IP = { "x-forwarded-for": "7.7.7.7" };
const json = async (r: Response): Promise<any> => r.json();
const BUY = { pair: "HYPE/USDC", side: "buy", usdc: "12" };

async function connect(h: H, botId = "hype-agent", rules: RuleSetV1 = mandate()): Promise<string> {
  const res = await h.confirmOverHttp(rules, { botId, botName: "HYPE agent" });
  const body = await json(res);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.agent_token.token as string;
}
const stateReq = (h: H, auth: string | null) => h.app.request("/trading/agent/state", { headers: { ...IP, ...(auth === null ? {} : { authorization: auth }) } });
const orderReq = (h: H, token: string, body: unknown) =>
  h.app.request("/trading/agent/order", { method: "POST", headers: { ...IP, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const later = (h: H, s = 11) => {
  h.clock.t += s * 1000;
};
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Holds every HL mids read (the first read of a tick) until `open()`. */
function hold(h: H): () => void {
  let open!: () => void;
  h.hl.gate = new Promise<void>((r) => (open = r));
  return () => {
    h.hl.gate = null;
    open();
  };
}
const agentPlaced = (h: H, prefix: string) => h.hl.placed.filter((o) => o.cloid.startsWith(prefix)).length;
async function prefixOf(h: H, botId: string): Promise<string> {
  const d = await json(await h.app.request(`/trading/bots/${botId}`, { headers: h.authed() }));
  return h.service.registry.get(botId)?.hashes.at(-1)?.prefix ?? String(d.id);
}

describe("every refusing state, through the service mapping (final, no HL order)", () => {
  it("perp alarm: the tick refuses PERP_POSITION_DETECTED; afterwards the pre-check refuses it without a tick", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    h.hl.setPerp(HL_ACCOUNT, { positions: [{ coin: "HYPE", size: "1" }], openPerpOrders: 0, accountValueUsdc: "40" });
    const r = await json(await orderReq(h, token, BUY));
    expect(r).toMatchObject({ status: "rejected", code: "PERP_POSITION_DETECTED", final: true, order: null });
    expect(h.hl.placed).toHaveLength(0);
    later(h);
    const calls = h.hl.midsCalls;
    const r2 = await json(await orderReq(h, token, BUY));
    expect(r2).toMatchObject({ status: "rejected", code: "PERP_POSITION_DETECTED", final: true });
    expect(h.hl.midsCalls).toBe(calls); // pre-check, no tick
    expect(h.hl.placed).toHaveLength(0);
  });

  it("paused on chain: VAULT_PAUSED / AGENT_PAUSED / AGENT_REVOKED / AGENT_EXPIRED are final and place nothing", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const ok = structuredClone(h.vault.view);
    for (const [view, code] of [
      [{ ...ok, vaultPaused: true }, "VAULT_PAUSED"],
      [{ ...ok, status: "Paused" }, "AGENT_PAUSED"],
      [{ ...ok, status: "Revoked" }, "AGENT_REVOKED"],
      [{ ...ok, expiresAtMs: h.clock.t + 11_000 }, "AGENT_EXPIRED"],
    ] as const) {
      h.vault.view = view;
      later(h);
      const r = await json(await orderReq(h, token, BUY));
      expect(r, code).toMatchObject({ status: "rejected", code, final: true, retry_after_s: null, order: null });
    }
    expect(h.hl.placed).toHaveLength(0);
    // Back to Active: the same token trades (none of the above revoked it).
    h.vault.view = ok;
    later(h);
    expect((await json(await orderReq(h, token, BUY))).status).toBe("filled");
  });

  it("vault unreadable: VAULT_STATUS_UNAVAILABLE is transient (final false, retry 60) and places nothing", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    h.vault.down = true;
    later(h);
    const r = await json(await orderReq(h, token, BUY));
    expect(r).toMatchObject({ status: "rejected", code: "VAULT_STATUS_UNAVAILABLE", final: false, retry_after_s: 60 });
    expect(h.hl.placed).toHaveLength(0);
  });

  it("FILLS_TRUNCATED: final, no HL order", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const { FillsTruncatedError } = await import("../../src/trading/hl/pagination.js");
    h.hl.getUserFills = () => Promise.reject(new FillsTruncatedError("10000 rows"));
    later(h);
    const r = await json(await orderReq(h, token, BUY));
    expect(r).toMatchObject({ status: "rejected", code: "FILLS_TRUNCATED", final: true });
    expect(h.hl.placed).toHaveLength(0);
  });

  it("the bot's loss stop hit today: DAILY_LOSS_STOP, final, no HL order", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const st = (h.service as any).state;
    st.bots["hype-agent"].stoppedDayIndex = st.account.day.dayIndex;
    st.bots["hype-agent"].stopReason = "DAILY_LOSS_STOP";
    later(h);
    const r = await json(await orderReq(h, token, BUY));
    expect(r).toMatchObject({ status: "rejected", code: "DAILY_LOSS_STOP", final: true });
    expect(h.hl.placed).toHaveLength(0);
  });

  it("archived bot, called on the service directly (the route already gives 401): BOT_NOT_ACTIVE, no tick", async () => {
    const h = harness({ agent: AGENT });
    await connect(h);
    await h.service.archive("hype-agent");
    const calls = h.hl.midsCalls;
    const r = await h.service.agentOrder("hype-agent", { pair: "HYPE/USDC", side: "buy", size: { usdc: "12" } }, null);
    expect(r).toMatchObject({ status: "rejected", code: "BOT_NOT_ACTIVE", final: true });
    expect(h.hl.midsCalls).toBe(calls);
    expect(h.hl.placed).toHaveLength(0);
    // And a DSL bot cannot be driven through the service either.
    await h.confirmOverHttp(dcaRules(), { botId: "dca", botName: "DCA" });
    const n = h.hl.placed.length;
    const r2 = await h.service.agentOrder("dca", { pair: "HYPE/USDC", side: "buy", size: { usdc: "12" } }, null);
    expect(r2).toMatchObject({ status: "rejected", code: "NOT_AGENT_BOT", final: true });
    expect(h.hl.placed).toHaveLength(n);
  });

  it("an HL rejection of a placed order: HL_REJECTED, final, the order is reported and it counts toward today", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    h.hl.orderResults = [{ status: "rejected", error: "Insufficient spot balance\nasset=HYPE" }];
    const r = await json(await orderReq(h, token, BUY));
    expect(r).toMatchObject({ status: "rejected", code: "HL_REJECTED", final: true, remaining_today: { orders: 5 } });
    expect(r.message).not.toContain("\n");
    expect(r.order?.cloid).toBe(h.hl.placed[0]?.cloid);
    expect(r.request_id).toBe(r.order.cloid);
  });
});

describe("concurrency: agent order + scheduled tick + owner actions", () => {
  it("kill-all while the agent order waits behind a scheduled tick: refused, no order placed after the kill", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    const open = hold(h);
    const t = h.service.tick();
    await settle();
    const o = orderReq(h, token, BUY);
    await settle();
    const k = h.service.kill("test");
    await settle();
    open();
    await t;
    const r = await json(await o);
    const kr = await k;
    expect(r.status).toBe("rejected");
    expect(r.final).toBe(true);
    expect(["KILLED", "BOT_HALTED"]).toContain(r.code);
    expect(h.hl.placed).toHaveLength(0);
    expect(kr.steps.tick_wait).toBe("ok");
  });

  it("kill-all DURING the agent tick (after its reads started): KILLED, no order", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    const open = hold(h);
    const o = orderReq(h, token, BUY);
    await settle();
    const k = h.service.kill();
    await settle();
    open();
    const r = await json(await o);
    await k;
    expect(r).toMatchObject({ status: "rejected", code: "KILLED", final: true });
    expect(h.hl.placed).toHaveLength(0);
  });

  it("Stop of the bot DURING the agent tick: refused, no order", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    const open = hold(h);
    const o = orderReq(h, token, BUY);
    await settle();
    const k = h.service.killBot("hype-agent");
    await settle();
    open();
    const r = await json(await o);
    await k;
    expect(r.status).toBe("rejected");
    expect(["KILLED", "BOT_HALTED"]).toContain(r.code);
    expect(h.hl.placed).toHaveLength(0);
  });

  it("archive while the agent order waits: no order (the bot is halted first)", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    const open = hold(h);
    const t = h.service.tick();
    await settle();
    const o = orderReq(h, token, BUY);
    await settle();
    const a = h.service.archive("hype-agent");
    await settle();
    open();
    await t;
    const r = await json(await o);
    await a;
    expect(r.status).toBe("rejected");
    expect(h.hl.placed).toHaveLength(0);
  });

  // BUG (ADR-0007 section 3 "Stop does not revoke; it blocks ... once a Stop happens, the old token can never place another
  // order"). The token is verified once, in route.ts `auth()` (src/trading/route.ts:421-427), BEFORE
  // `service.agentOrder` waits for the single-flight slot (src/trading/service.ts:1467 `while (this.inflight) await
  // this.inflight;`). A Stop followed by a re-sign while the order waits clears the halt (`activated` -> `clearHalt`,
  // service.ts ~1284) and rotates the token, yet the queued old-token order still runs its tick and reaches HL. Nothing
  // re-checks the token (or a per-bot epoch captured at authentication) after the wait.
  it.fails("BUG: Stop + re-sign while an old-token order waits: the old token must not place an order", async () => {
    const h = harness({ agent: AGENT });
    const oldToken = await connect(h);
    const prefix = await prefixOf(h, "hype-agent");
    later(h);
    const open = hold(h);
    const t = h.service.tick();
    await settle();
    const o = orderReq(h, oldToken, BUY); // authenticated now, then waits for the scheduled tick
    await settle();
    const k = h.service.killBot("hype-agent"); // Stop
    await settle();
    h.hl.gate = null; // the confirm's own reads must not block; the scheduled tick is still held by the first promise
    const resign = h.confirmOverHttp(mandate(), { botId: "hype-agent", botName: "HYPE agent" });
    await settle();
    await settle();
    open();
    await t;
    await k;
    const r = await json(await o);
    await resign;
    expect((await stateReq(h, `Bearer ${oldToken}`)).status).toBe(401); // the rotation itself worked
    expect(r.status).toBe("rejected");
    expect(agentPlaced(h, prefix)).toBe(0);
  });

  // Same family, lower severity: the owner's Disconnect (revoke, "toward safety") returns `revoked: true` while an order that
  // authenticated just before it is still queued; that order is then placed (service.ts:1467, no re-check after the wait).
  it.fails("BUG: revoke while an order waits: the revoked token must not place an order", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    const open = hold(h);
    const t = h.service.tick();
    await settle();
    const o = orderReq(h, token, BUY);
    await settle();
    const rv = await json(await h.app.request("/trading/bots/hype-agent/agent-token/revoke", { method: "POST", headers: h.authed(), body: "{}" }));
    expect(rv.revoked).toBe(true);
    open();
    await t;
    const r = await json(await o);
    expect(r.status).toBe("rejected");
    expect(h.hl.placed).toHaveLength(0);
  });

  it("an agent order and a DSL bot's scheduled tick in a row: one order each, counted once on the account", async () => {
    const h = harness({ agent: AGENT });
    await h.confirmOverHttp(dcaRules(), { botId: "dca", botName: "DCA" }); // the interval rule fires at confirm
    const afterDsl = h.hl.placed.length;
    expect(afterDsl).toBe(1);
    const token = await connect(h);
    const before = (h.service as any).state.account.ordersToday as number;
    later(h);
    const open = hold(h);
    const t = h.service.tick();
    await settle();
    const o = orderReq(h, token, BUY);
    await settle();
    open();
    await t;
    expect((await json(await o)).status).toBe("filled");
    later(h);
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(afterDsl + 1);
    const st = (h.service as any).state;
    expect(st.account.ordersToday).toBe(before + 1);
    expect(st.account.ordersToday).toBe(h.hl.placed.length);
    expect(st.bots["hype-agent"].ordersToday).toBe(1);
    expect(st.bots["dca"].ordersToday).toBe(1);
  });
});

describe("token matrix (beyond the existing one)", () => {
  // (Leading/trailing whitespace in a header value is stripped by the Fetch Headers class before the worker sees it.)
  it("malformed tokens and headers all give 401 AGENT_UNAUTHORIZED and never reach the engine", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const secret = token.slice("atk1_hype-agent_".length);
    const calls = h.hl.midsCalls;
    for (const auth of [
      token, // no "Bearer "
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Basic ${token}`,
      `Bearer ${token}x`,
      `Bearer ${token.slice(0, -1)}`,
      `Bearer atk1_HYPE-AGENT_${secret}`,
      `Bearer atk2_hype-agent_${secret}`,
      `Bearer atk1_hype_agent_${secret}`,
      `Bearer atk1__${secret}`,
      `Bearer atk1_hype-agent_${secret.slice(0, 42)}=`,
      `Bearer ${"a".repeat(5000)}`,
      "Bearer ",
      "",
    ]) {
      const r = await stateReq(h, auth);
      expect(r.status, JSON.stringify(auth.slice(0, 40))).toBe(401);
      expect((await json(r)).code).toBe("AGENT_UNAUTHORIZED");
      const o = await h.app.request("/trading/agent/order", { method: "POST", headers: { ...IP, authorization: auth, "content-type": "application/json" }, body: JSON.stringify(BUY) });
      expect(o.status).toBe(401);
    }
    // A token in the query string or another header is not accepted.
    expect((await h.app.request(`/trading/agent/state?token=${token}`, { headers: IP })).status).toBe(401);
    expect((await h.app.request("/trading/agent/state", { headers: { ...IP, "x-agent-token": token } })).status).toBe(401);
    expect(h.hl.midsCalls).toBe(calls);
    expect(h.hl.placed).toHaveLength(0);
    expect((await stateReq(h, `Bearer ${token}`)).status).toBe(200);
  });

  it("expiry boundary: valid 1 ms before expires_at_ms, AGENT_TOKEN_EXPIRED at it; an expired token places nothing", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const exp = h.service.registry.get("hype-agent")?.agent?.expires_at_ms as number;
    h.clock.t = exp - 1;
    expect((await stateReq(h, `Bearer ${token}`)).status).toBe(200);
    h.clock.t = exp;
    const r = await orderReq(h, token, BUY);
    expect(r.status).toBe(401);
    expect((await json(r)).code).toBe("AGENT_TOKEN_EXPIRED");
    expect(h.hl.placed).toHaveLength(0);
  });

  it("a re-sign with NEW limits (new hash) also rotates: the old token gets 401 on the order route, the new one trades on the new limits", async () => {
    const h = harness({ agent: AGENT });
    const a = await connect(h);
    const b = await connect(h, "hype-agent", mandate({ max_order_usdc: "11" }));
    expect(b).not.toBe(a);
    later(h);
    const old = await orderReq(h, a, BUY);
    expect(old.status).toBe(401);
    expect(h.hl.placed).toHaveLength(0);
    const r = await json(await orderReq(h, b, BUY));
    expect(r).toMatchObject({ status: "rejected", code: "MAX_ORDER" });
    later(h);
    expect((await json(await orderReq(h, b, { ...BUY, usdc: "11" }))).status).toBe("filled");
  });

  it("revoke: the order route gives 401 afterwards and nothing is placed; a revoked bot's token cannot be resurrected by a re-sign of another bot", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const other = await connect(h, "other-agent", { ...mandate(), name: "other" });
    await h.app.request("/trading/bots/hype-agent/agent-token/revoke", { method: "POST", headers: h.authed(), body: "{}" });
    const r = await orderReq(h, token, BUY);
    expect(r.status).toBe(401);
    expect((await json(r)).code).toBe("AGENT_UNAUTHORIZED");
    expect(h.hl.placed).toHaveLength(0);
    await connect(h, "other-agent", { ...mandate(), name: "other" }); // re-sign of another bot
    expect((await stateReq(h, `Bearer ${token}`)).status).toBe(401);
    expect((await stateReq(h, `Bearer ${other}`)).status).toBe(401); // that one rotated
  });

  it("the order lands on the bot named by the token: cloid prefix of that bot's mandate, the other bot's counters untouched", async () => {
    const h = harness({ agent: AGENT });
    const a = await connect(h, "bot-a");
    await connect(h, "bot-b", { ...mandate(), name: "bot b" });
    const pa = await prefixOf(h, "bot-a");
    const r = await json(await orderReq(h, a, BUY));
    expect(r.status).toBe("filled");
    expect(r.order.cloid.startsWith(pa)).toBe(true);
    const st = (h.service as any).state;
    expect(st.bots["bot-a"].ordersToday).toBe(1);
    expect(st.bots["bot-b"]?.ordersToday ?? 0).toBe(0);
  });
});

describe("idempotency (replay never places a second order)", () => {
  it("replay after the bot was stopped returns the stored result and places nothing", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const body = { ...BUY, idempotency_key: "key-000001" };
    const a = await json(await orderReq(h, token, body));
    expect(a.status).toBe("filled");
    await h.service.killBot("hype-agent");
    const b = await json(await orderReq(h, token, body));
    expect(b).toEqual({ ...a, replayed: true });
    expect(h.hl.placed).toHaveLength(1);
    // A new key on the stopped bot: refused.
    later(h);
    expect((await json(await orderReq(h, token, { ...BUY, idempotency_key: "key-000002" }))).code).toBe("BOT_HALTED");
    expect(h.hl.placed).toHaveLength(1);
  });

  it("a rejected result is replayed as rejected (no order); many replays in a row never place", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const body = { ...BUY, usdc: "100", idempotency_key: "key-big-0001" };
    const a = await json(await orderReq(h, token, body));
    expect(a.code).toBe("MAX_ORDER");
    for (let i = 0; i < 5; i += 1) expect(await json(await orderReq(h, token, body))).toEqual({ ...a, replayed: true });
    expect(h.hl.placed).toHaveLength(0);
  });

  it("the same key with another reason, side, pair or size field is 409 IDEMPOTENCY_KEY_REUSED and places nothing", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const body = { ...BUY, reason: "first", idempotency_key: "key-reuse-01" };
    expect((await json(await orderReq(h, token, body))).status).toBe("filled");
    for (const changed of [{ ...body, reason: "second" }, { ...body, reason: undefined }, { ...body, side: "sell" }, { pair: "PURR/USDC", side: "buy", usdc: "12", reason: "first", idempotency_key: "key-reuse-01" }, { ...body, usdc: "12.0" }]) {
      later(h);
      const r = await orderReq(h, token, changed);
      expect(r.status, JSON.stringify(changed)).toBe(409);
      expect((await json(r)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(h.hl.placed).toHaveLength(1);
    // Key order in the JSON does not matter: still a replay.
    const reordered = { idempotency_key: "key-reuse-01", reason: "first", usdc: "12", side: "buy", pair: "HYPE/USDC" };
    expect((await json(await orderReq(h, token, reordered))).replayed).toBe(true);
    expect(h.hl.placed).toHaveLength(1);
  });

  it("the same key while the first request is still in flight: 409 ORDER_IN_FLIGHT, one HL order; then a replay", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    later(h);
    const body = { ...BUY, idempotency_key: "key-flight-1" };
    const open = hold(h);
    const first = orderReq(h, token, body);
    await settle();
    const second = await orderReq(h, token, body);
    expect(second.status).toBe(409);
    expect((await json(second)).code).toBe("ORDER_IN_FLIGHT");
    open();
    const a = await json(await first);
    expect(a.status).toBe("filled");
    expect(await json(await orderReq(h, token, body))).toEqual({ ...a, replayed: true });
    expect(h.hl.placed).toHaveLength(1);
  });

  it("a replay does not consume the interval or today's orders", async () => {
    const h = harness({ agent: AGENT });
    const token = await connect(h);
    const body = { ...BUY, idempotency_key: "key-count-01" };
    const a = await json(await orderReq(h, token, body));
    for (let i = 0; i < 3; i += 1) await orderReq(h, token, body);
    const st = await json(await stateReq(h, `Bearer ${token}`));
    expect(st.today.orders_used).toBe(1);
    expect(a.remaining_today.orders).toBe(5);
  });
});

describe("TRADING_AGENT_ENABLED=false keeps the DSL path unchanged", () => {
  it("a DSL confirm gives the same v2 message bytes and hash with the flag on and off", async () => {
    const off = harness();
    const on = harness({ agent: AGENT });
    const a = await json(await off.confirmOverHttp(dcaRules(), { botId: "dca", botName: "DCA" }));
    const b = await json(await on.confirmOverHttp(dcaRules(), { botId: "dca", botName: "DCA" }));
    expect(a.active.message).toBe(b.active.message);
    expect(a.active.hash).toBe(b.active.hash);
    const p = parseRuleSet(dcaRules());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(a.active.hash).toBe(hashRuleSet(p.value));
    expect(a.active.message).toBe(confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL_ACCOUNT, rulesSha256: a.active.hash, botId: "dca" }));
    expect(a.active.message.split("\n")[0]).toBe("Agent Treasury: activate trading rules");
    expect(a.active.message).not.toContain("mode:");
    expect(a.agent_token).toBeNull();
    expect(Object.keys(a.active).sort()).toEqual(Object.keys(b.active).sort());
    // The registry entry of a DSL bot carries no token record in either mode.
    for (const h of [off, on]) expect(JSON.parse(readFileSync(`${h.dir}/bots.json`, "utf8")).bots.find((x: any) => x.id === "dca").agent ?? null).toBeNull();
  });

  it("an agent bot created while enabled cannot trade after a restart with the flag off: routes 404, ticks place nothing", async () => {
    const on = harness({ agent: AGENT });
    const token = await connect(on);
    expect(on.hl.placed).toHaveLength(0);
    const off = harness({ dir: on.dir });
    off.clock.t = on.clock.t + 60_000;
    expect((await stateReq(off, `Bearer ${token}`)).status).toBe(404);
    expect((await orderReq(off, token, BUY)).status).toBe(404);
    await off.service.tick();
    off.clock.t += 3_600_000;
    await off.service.tick();
    expect(off.hl.placed).toHaveLength(0);
  });
});
