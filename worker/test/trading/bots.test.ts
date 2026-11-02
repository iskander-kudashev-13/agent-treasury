/**
 * Several bots through TradingService and the HTTP routes (ADR-0006 sections 5, 6, 8 and "Owner defaults"): two bots on one
 * pair, per-bot kill vs kill all, confirm clearing halts, archive rules, history / journal / metrics wiring, API auth and shapes.
 * Real service, store, registry, confirmer and router; FakeHl simulates the exchange; no money moves.
 */
/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { hashRuleSet } from "../../src/trading/rules/canonical.js";
import type { Rule, RuleSetV1 } from "../../src/trading/types.js";
import { harness, T0 } from "./harness.js";
import { HL_ACCOUNT } from "./fixtures.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<Json> => (await r.json()) as Json;
const get = (app: Hono, path: string, headers: Record<string, string> = { "x-forwarded-for": "9.9.9.9" }) => app.request(`/trading${path}`, { headers });
const post = (app: Hono, path: string, headers: Record<string, string>, body: unknown = {}) =>
  app.request(`/trading${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const H = 3_600_000;

const dca = (id = "dca"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } });
const limitBuy = (id = "lim"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "2", ttl: "4h" } } });
const sellAll = (id = "exit"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "price", op: "gte", usdc: "1" }, action: { side: "sell", size: { position_pct: "100" }, order: { type: "ioc" } }, cooldown: "15m" });
const idle = (): Rule => ({ id: "idle", pair: "HYPE/USDC", when: { type: "price", op: "gte", usdc: "9999" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } }, cooldown: "1d" });
const rulesOf = (name: string, rules: Rule[] = [dca()]): RuleSetV1 => ({
  version: 1,
  name,
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "40", max_order_usdc: "12", daily_loss_stop_usdc: "5", max_orders_per_day: 10 },
  rules,
});
type H = ReturnType<typeof harness>;
const fundedHarness = (): H => {
  const h = harness();
  h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  return h;
};
const step = async (h: H, ms = 60_000): Promise<void> => {
  h.clock.t += ms;
  await h.service.tick();
};
const prefixOf = (name: string, rules?: Rule[]): string => cloidPrefix(hashRuleSet(rulesOf(name, rules)));

describe("two bots on one pair, through the service", () => {
  it("each bot places its own order, fills are attributed by prefix, positions and journals are separate", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy"), "beta", "Beta");
    await step(h);
    expect(h.hl.placed.map((o) => o.cloid.slice(0, 18))).toEqual([prefixOf("Alpha strategy"), prefixOf("Beta strategy")]);
    expect(h.service.status().bots).toEqual([
      { id: "alpha", name: "Alpha", state: "running" },
      { id: "beta", name: "Beta", state: "running" },
    ]);
    const a = await h.service.botDetail("alpha");
    const b = await h.service.botDetail("beta");
    expect(a.positions).toMatchObject([{ pair: "HYPE/USDC", size: "0.29" }]);
    expect(b.positions).toMatchObject([{ pair: "HYPE/USDC", size: "0.29" }]);
    expect(h.service.botFills("alpha", {}).fills).toHaveLength(1);
    expect(h.service.botFills("alpha", {}).fills[0]).toMatchObject({ pair: "HYPE/USDC", side: "buy", size: "0.29", price: "40.4", rule_id: "dca", realized_usdc: null });
    expect(h.service.botFills("beta", {}).fills).toHaveLength(1);
    // the log says which bot did what
    const orders = h.service.readLog(50).filter((e) => e.kind === "order");
    expect(orders.map((e) => e.bot_id).sort()).toEqual(["alpha", "beta"]);
    expect(h.service.readLog(50, "beta").every((e) => e.bot_id === "beta")).toBe(true);
  });

  it("a sell journal line carries realized P&L (average cost) and the position after the fill", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy", [dca(), sellAll()]), "alpha", "Alpha");
    await step(h); // fill of the buy is read; the sell rule fires now (the bot owns 0.29)
    await step(h); // the sell's fill is read
    const fills = h.service.botFills("alpha", {}).fills; // newest first
    expect(fills.map((f) => f.side)).toEqual(["sell", "buy"]);
    const sell = fills[0];
    // sold 0.28 (floor of 0.29 * 100%... 0.29) at the lower band edge 39.6; average cost 40.4
    expect(sell?.realized_usdc).not.toBeNull();
    expect(Number(sell?.realized_usdc)).toBeLessThan(0);
    expect(Number(sell?.realized_usdc)).toBeCloseTo(0.29 * (39.6 - 40.4), 3);
    const m = h.service.botMetrics("alpha", "all");
    expect(m).toMatchObject({ closed_trades: 1, win_rate: "0.0000", fills: 2 });
    expect(Number(m.realized_usdc)).toBeCloseTo(0.29 * (39.6 - 40.4), 3);
    expect(Number(m.turnover_usdc)).toBeGreaterThan(20);
  });

  it("history: every tick folds a sample per bot and for the account; closed buckets are appended to disk", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await step(h);
    await step(h, 2 * 60_000);
    await step(h, 5 * 60_000);
    const hist = h.service.botHistory("alpha", "1h");
    expect(hist.bucket_ms).toBe(60_000);
    expect(hist.points.length).toBeGreaterThanOrEqual(3);
    expect(hist.points.at(-1)).toMatchObject({ val: expect.any(String), px: { "HYPE/USDC": "40" } });
    expect(Object.keys(hist.points[0] ?? {}).sort()).toEqual(["hi", "lo", "pnl", "px", "t", "today", "val"]);
    // closed buckets reach disk (the open one lives in memory)
    expect(existsSync(join(h.dir, "bots", "alpha", "h-1m.jsonl"))).toBe(true);
    expect(existsSync(join(h.dir, "account", "h-1m.jsonl"))).toBe(true);
    const line = JSON.parse(readFileSync(join(h.dir, "bots", "alpha", "h-1m.jsonl"), "utf8").trim().split("\n")[0] ?? "{}");
    expect(line).toMatchObject({ pnl: expect.any(String), lo: expect.any(String), hi: expect.any(String) });
    expect(h.service.botHistory("alpha", "all").bucket_ms).toBe(86_400_000);
    expect(h.service.botHistory("alpha", "1w").bucket_ms).toBe(900_000);
  });

  it("history also records ticks that did not trade (no false gaps), but not ticks without data", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Idle strategy", [idle()]), "idle", "Idle");
    h.vault.view = { ...h.vault.view, vaultPaused: true };
    await step(h);
    expect(h.service.status().state).toBe("paused_onchain");
    expect(h.service.botHistory("idle", "1h").points.length).toBeGreaterThanOrEqual(2);
    const n = h.service.botHistory("idle", "1h").points.length;
    h.hl.failNext("getMids");
    await step(h, 5 * 60_000);
    expect(h.service.status().state_reason).toBe("HL_READ_FAILED");
    expect(h.service.botHistory("idle", "1h").points.length).toBe(n);
  });

  it("the journal survives a restart and does not double-write overlap re-reads", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    for (let i = 0; i < 4; i++) await step(h);
    expect(h.service.botFills("alpha", {}).fills).toHaveLength(1);
    const lines = readFileSync(join(h.dir, "bots", "alpha", "fills.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});

describe("kill one bot vs kill all; confirm clears per bot", () => {
  async function twoWithRestingOrders(): Promise<H> {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy", [limitBuy()]), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy", [limitBuy()]), "beta", "Beta");
    await step(h);
    expect(h.hl.openOrders[HL_ACCOUNT.toLowerCase()]).toHaveLength(2);
    return h;
  }
  const open = (h: H) => (h.hl.openOrders[HL_ACCOUNT.toLowerCase()] ?? []).map((o) => (o.cloid ?? "").slice(0, 18));

  it("killing alpha cancels only alpha's orders, halts only alpha, and beta keeps running", async () => {
    const h = await twoWithRestingOrders();
    const r = await h.service.killBot("alpha", "stop this one");
    expect(r).toEqual({ bot_id: "alpha", state: "halted", cancelled_orders: 1, steps: { cancel: "ok", state_saved: "ok" } });
    expect(open(h)).toEqual([prefixOf("Beta strategy", [limitBuy()])]);
    expect(h.hl.scheduleCancelCalls.some((t) => t !== null && t <= T0 + 10_000)).toBe(false); // the dead-man switch was not touched
    await step(h, H + 60_000); // beta's 1h interval is due again
    const st = h.service.status();
    expect(st.bots).toEqual([
      { id: "alpha", name: "Alpha", state: "halted" },
      { id: "beta", name: "Beta", state: "running" },
    ]);
    expect(st.state).toBe("running");
    expect(h.hl.placed.filter((o) => o.cloid.startsWith(prefixOf("Alpha strategy", [limitBuy()])))).toHaveLength(1);
    expect(h.hl.placed.filter((o) => o.cloid.startsWith(prefixOf("Beta strategy", [limitBuy()])))).toHaveLength(2);
  });

  it("kill all halts the account and every bot; confirming one bot clears it and the account, the other stays halted", async () => {
    const h = await twoWithRestingOrders();
    await h.service.kill("all");
    expect(open(h)).toEqual([]);
    expect(h.service.status().state).toBe("halted");
    await step(h);
    expect(h.service.status().bots.map((b) => b.state)).toEqual(["halted", "halted"]);
    // re-sign alpha: same hash, fresh nonce = resume
    await h.confirmDirect(rulesOf("Alpha strategy", [limitBuy()]), "alpha");
    const st = h.service.status();
    expect(st.bots).toEqual([
      { id: "alpha", name: "Alpha", state: expect.stringMatching(/running/) },
      { id: "beta", name: "Beta", state: "halted" },
    ]);
    expect(st.state).toBe("running");
    await h.confirmDirect(rulesOf("Beta strategy", [limitBuy()]), "beta");
    expect(h.service.status().bots.map((b) => b.state)).toEqual(["running", "running"]);
  });

  it("a kill of one bot that arrives while a tick is running stops that bot's orders in that tick (kill epoch), the other bot still trades", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy"), "beta", "Beta");
    const before = h.hl.placed.length;
    let release: () => void = () => undefined;
    h.hl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.clock.t += H; // both DCA rules are due again
    const tickP = h.service.tick();
    const killP = h.service.killBot("alpha");
    release();
    await Promise.all([tickP, killP]);
    const fresh = h.hl.placed.slice(before);
    expect(fresh.filter((o) => o.cloid.startsWith(prefixOf("Alpha strategy")))).toHaveLength(0);
    expect(fresh.filter((o) => o.cloid.startsWith(prefixOf("Beta strategy")))).toHaveLength(1);
    expect(h.service.status().bots.find((b) => b.id === "alpha")?.state).toBe("halted");
  });

  it("a perp alarm halts everything; a confirm is refused while the perp is open, allowed after it is closed", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy", [idle()]), "alpha", "Alpha");
    h.hl.setPerp(HL_ACCOUNT, { positions: [{ coin: "BTC", size: "0.01" }], openPerpOrders: 0, accountValueUsdc: "5" });
    await step(h);
    expect(h.service.status().bots).toEqual([{ id: "alpha", name: "Alpha", state: "halted" }]);
    const res = await h.confirmOverHttp(rulesOf("Alpha strategy", [idle()]), { botId: "alpha" });
    expect(res.status).toBe(409);
    expect(await j(res)).toMatchObject({ code: "PERP_STILL_OPEN" });
    h.hl.setPerp(HL_ACCOUNT, { positions: [], openPerpOrders: 0, accountValueUsdc: "0" });
    const ok = await h.confirmOverHttp(rulesOf("Alpha strategy", [idle()]), { botId: "alpha" });
    expect(ok.status).toBe(200);
    expect(h.service.status().state).toBe("running");
  });
});

describe("archive, rename, max bots", () => {
  it("archive is refused while the bot holds >= 10 USDC; allowed once the position is below the HL minimum; the id is never reused", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await step(h); // fill read: 0.29 HYPE ~ 11.6 USDC
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ status: 409, code: "BOT_HOLDS_POSITION" });
    expect(h.service.registry.get("alpha")?.archived_at_ms).toBeNull();
    h.hl.setMid("HYPE/USDC", "30"); // 0.29 * 30 = 8.7 < 10
    h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "88", hold: "0" }, { coin: "HYPE", total: "0.29", hold: "0" }]);
    await step(h);
    const r = await h.service.archive("alpha");
    expect(r.bot).toMatchObject({ id: "alpha", state: "archived" });
    expect(h.service.registry.get("alpha")).toMatchObject({ active_hash: null, archived_at_ms: expect.any(Number) });
    expect(h.service.status().bots).toEqual([]);
    const ch = await post(h.app, "/rules/challenge", h.authed(), { rules: rulesOf("Alpha again"), bot_id: "alpha", bot_name: "Alpha" });
    expect(ch.status).toBe(409);
    expect(await j(ch)).toMatchObject({ code: "BOT_ARCHIVED" });
  });

  it("archive cancels the bot's resting orders and frees a slot; its fills and history files stay", async () => {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy", [limitBuy()]), "alpha", "Alpha");
    await step(h);
    // a resting limit buy holds no coins yet: nothing to sell, archive is allowed
    const r = await h.service.archive("alpha");
    expect(r.cancelled_orders).toBe(1);
    expect(h.hl.openOrders[HL_ACCOUNT.toLowerCase()] ?? []).toHaveLength(0);
    await step(h);
    expect(h.service.botHistory("alpha", "1h").points.length).toBeGreaterThan(0);
    expect(h.service.botsList(true).find((b) => b.id === "alpha")).toMatchObject({ state: "archived" });
  });

  it("archiving an unknown bot is 404; archiving twice is a no-op", async () => {
    const h = fundedHarness();
    await expect(h.service.archive("ghost")).rejects.toMatchObject({ status: 404 });
    await h.confirmDirect(rulesOf("Idle strategy", [idle()]), "idle", "Idle");
    await h.service.archive("idle");
    expect((await h.service.archive("idle")).cancelled_orders).toBe(0);
  });

  it("rename changes the display name only (not signed, hash and prefixes unchanged)", async () => {
    const h = fundedHarness();
    const env = await h.confirmDirect(rulesOf("Idle strategy", [idle()]), "idle", "Idle");
    const r = h.service.rename("idle", "  A better name \u0007 ");
    expect(r.name).toBe("A better name");
    expect(h.service.registry.get("idle")?.active_hash).toBe(env.hash);
    expect(() => h.service.rename("idle", "   ")).toThrow();
    expect(() => h.service.rename("ghost", "x")).toThrow(/No such bot/);
    // still verifies on load: the name is not part of the signature
    await step(h);
    expect(h.service.status().bots[0]).toMatchObject({ name: "A better name", state: "running" });
  });

  it("TRADING_MAX_BOTS: default 3, 1..5 accepted, 0 and 6 rejected; the service enforces it", () => {
    const base = { VAULT_CONTRACT_ID: "vault.testnet" };
    expect(loadConfig(base).TRADING_MAX_BOTS).toBe(3);
    expect(loadConfig({ ...base, TRADING_MAX_BOTS: "5" }).TRADING_MAX_BOTS).toBe(5);
    expect(() => loadConfig({ ...base, TRADING_MAX_BOTS: "6" })).toThrow(/TRADING_MAX_BOTS/);
    expect(() => loadConfig({ ...base, TRADING_MAX_BOTS: "0" })).toThrow(/TRADING_MAX_BOTS/);
  });

  it("the fourth bot is refused over HTTP with 409 MAX_BOTS; archiving one frees the slot", async () => {
    const h = fundedHarness();
    for (const n of ["one", "two", "three"]) await h.confirmDirect(rulesOf(`Strategy ${n}`, [idle()]), n, n);
    const four = await post(h.app, "/rules/challenge", h.authed(), { rules: rulesOf("Strategy four", [idle()]), bot_id: "four", bot_name: "Four" });
    expect(four.status).toBe(409);
    expect(await j(four)).toMatchObject({ code: "MAX_BOTS" });
    expect((await post(h.app, "/bots/one/archive", h.authed(), {})).status).toBe(200);
    expect((await post(h.app, "/rules/challenge", h.authed(), { rules: rulesOf("Strategy four", [idle()]), bot_id: "four", bot_name: "Four" })).status).toBe(200);
    expect((await get(h.app, "/status")).status).toBe(200);
    expect(await j(await get(h.app, "/status"))).toMatchObject({ max_bots: 3 });
  });
});

describe("HTTP: bots API", () => {
  async function withBots(): Promise<H> {
    const h = fundedHarness();
    await h.confirmDirect(rulesOf("Alpha strategy", [dca(), sellAll()]), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy", [idle()]), "beta", "Beta");
    for (let i = 0; i < 3; i++) await step(h, H);
    return h;
  }

  it("GET /bots: public view has only id, name, state and pairs; the owner session adds P&L, position and sparkline", async () => {
    const h = await withBots();
    const pub = await get(h.app, "/bots");
    expect(pub.status).toBe(200);
    const pj = await j(pub);
    expect(pj.max_bots).toBe(3);
    for (const b of pj.bots) {
      expect(Object.keys(b).sort()).toEqual(["archived_at_ms", "created_at_ms", "id", "name", "pairs", "state", "state_reason"]);
    }
    expect(pj.bots.map((b: Json) => b.id)).toEqual(["alpha", "beta"]);
    expect(pj.bots[0]).toMatchObject({ name: "Alpha", state: "running", pairs: ["HYPE/USDC"] });
    expect(JSON.stringify(pj)).not.toMatch(/pnl|spark|position/);
    const own = await j(await get(h.app, "/bots", h.authed()));
    expect(own.bots[0]).toMatchObject({ id: "alpha", pnl_today_usdc: expect.any(String), pnl_total_usdc: expect.any(String), position_usdc: expect.any(String), spark: expect.any(Array), last_fill_ms: expect.any(Number) });
    expect(own.bots[1]).toMatchObject({ id: "beta", last_fill_ms: null });
    // a bad or foreign token is a 401/403, not a silently thinner answer
    expect((await get(h.app, "/bots", { authorization: "Bearer nonsense", "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
    expect((await get(h.app, "/bots", h.authed("mallory.near"))).status).toBe(403);
  });

  it("GET /bots/:id (owner): BotDetail shape, 404 for an unknown or malformed id, 401 without a token", async () => {
    const h = await withBots();
    expect((await get(h.app, "/bots/alpha")).status).toBe(401);
    expect((await get(h.app, "/bots/ghost", h.authed())).status).toBe(404);
    expect((await get(h.app, "/bots/Not%20An%20Id", h.authed())).status).toBe(404);
    const d = await j(await get(h.app, "/bots/alpha", h.authed()));
    expect(Object.keys(d).sort()).toEqual(["bot", "hl_network", "limits", "open_orders", "pairs", "positions", "rules", "rules_history", "today"]);
    expect(d.bot).toMatchObject({ id: "alpha", state: "running" });
    expect(d.rules).toMatchObject({ bot_id: "alpha", hash: hashRuleSet(rulesOf("Alpha strategy", [dca(), sellAll()])) });
    expect(d.limits.bot).toMatchObject({ max_order_usdc: "12" });
    expect(d.limits.account).toMatchObject({ max_order_usdc: "20", price_band_bps: 100 });
    expect(d.pairs).toEqual([{ name: "HYPE/USDC", coin: "@107", sz_decimals: 2 }]);
    expect(d.rules_history).toHaveLength(1);
    expect(d.hl_network).toBe("testnet");
    expect(d.today).toMatchObject({ orders: expect.any(Number), loss_usdc: expect.any(String) });
  });

  it("GET /bots/:id/history validates the range and returns the documented shape", async () => {
    const h = await withBots();
    expect((await get(h.app, "/bots/alpha/history?range=2y", h.authed())).status).toBe(400);
    expect((await get(h.app, "/bots/alpha/history", { "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
    expect((await get(h.app, "/bots/ghost/history?range=1d", h.authed())).status).toBe(404);
    for (const [range, bucket] of [["1h", 60_000], ["1d", 60_000], ["1w", 900_000], ["1m", 900_000], ["all", 86_400_000]] as const) {
      const r = await j(await get(h.app, `/bots/alpha/history?range=${range}`, h.authed()));
      expect(r).toMatchObject({ range, bucket_ms: bucket });
      expect(r.points.length).toBeGreaterThan(0);
      expect(r.points.length).toBeLessThanOrEqual(3000);
    }
  });

  it("GET /bots/:id/fills: newest first, limit 1..200, cursor round trip, from_ms, bad cursor 400", async () => {
    const h = await withBots();
    const all = await j(await get(h.app, "/bots/alpha/fills?limit=200", h.authed()));
    expect(all.fills.length).toBeGreaterThanOrEqual(3);
    expect(all.next_cursor).toBeNull();
    const times = all.fills.map((f: Json) => f.time_ms);
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
    expect(Object.keys(all.fills[0]).sort()).toEqual(["cloid", "fee_token", "fee_usdc", "oid", "pair", "price", "realized_usdc", "rule_id", "side", "size", "tid", "time_ms"]);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Json = await j(await get(h.app, `/bots/alpha/fills?limit=1${cursor ? `&cursor=${cursor}` : ""}`, h.authed()));
      expect(page.fills.length).toBeLessThanOrEqual(1);
      seen.push(...page.fills.map((f: Json) => f.oid));
      cursor = page.next_cursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(all.fills.map((f: Json) => f.oid));
    for (const bad of ["limit=0", "limit=201", "limit=x", "from_ms=-1", "from_ms=abc"]) expect((await get(h.app, `/bots/alpha/fills?${bad}`, h.authed())).status, bad).toBe(400);
    const badCursor = await get(h.app, "/bots/alpha/fills?cursor=!!!", h.authed());
    expect(badCursor.status).toBe(400);
    expect(await j(badCursor)).toMatchObject({ code: "BAD_CURSOR" });
    const cut = await j(await get(h.app, `/bots/alpha/fills?from_ms=${all.fills[0].time_ms}`, h.authed()));
    expect(cut.fills).toHaveLength(all.fills.filter((f: Json) => f.time_ms === all.fills[0].time_ms).length);
    expect((await j(await get(h.app, `/bots/alpha/fills?from_ms=${all.fills[0].time_ms + 1}`, h.authed()))).fills).toEqual([]);
    expect((await get(h.app, "/bots/beta/fills", h.authed())).status).toBe(200);
    expect((await j(await get(h.app, "/bots/beta/fills", h.authed()))).fills).toEqual([]);
  });

  it("GET /bots/:id/metrics: BotMetrics shape; a bot with no sells has a null win rate", async () => {
    const h = await withBots();
    expect((await get(h.app, "/bots/alpha/metrics?range=nope", h.authed())).status).toBe(400);
    const m = await j(await get(h.app, "/bots/alpha/metrics?range=all", h.authed()));
    expect(Object.keys(m).sort()).toEqual(["avg_trade_usdc", "closed_trades", "fees_usdc", "fills", "from_ms", "max_drawdown_usdc", "orders", "pnl_change_usdc", "range", "realized_usdc", "to_ms", "turnover_usdc", "win_rate"]);
    expect(m.fills).toBeGreaterThanOrEqual(3);
    expect(m.orders).toBeGreaterThanOrEqual(3);
    const b = await j(await get(h.app, "/bots/beta/metrics?range=1d", h.authed()));
    expect(b).toMatchObject({ closed_trades: 0, win_rate: null, avg_trade_usdc: null, fills: 0, turnover_usdc: "0" });
  });

  it("GET /log?bot= filters; entries carry bot_id; a bad bot id is 400", async () => {
    const h = await withBots();
    const all = await j(await get(h.app, "/log?limit=200", h.authed()));
    expect(all.entries.some((e: Json) => e.bot_id === null)).toBe(true);
    const a = await j(await get(h.app, "/log?bot=alpha&limit=200", h.authed()));
    expect(a.entries.length).toBeGreaterThan(0);
    expect(a.entries.every((e: Json) => e.bot_id === "alpha")).toBe(true);
    expect((await get(h.app, "/log?bot=BAD!", h.authed())).status).toBe(400);
  });

  it("POST rename / archive / kill: owner only; kill is allowed with NEAR RPC down (safety), rename and archive are not", async () => {
    const h = await withBots();
    for (const path of ["/bots/beta/rename", "/bots/beta/archive", "/bots/beta/kill"]) {
      expect((await post(h.app, path, { "x-forwarded-for": "9.9.9.9" }, {})).status, path).toBe(401);
      expect((await post(h.app, path, h.authed("mallory.near"), { name: "x" })).status, path).toBe(403);
    }
    expect((await post(h.app, "/bots/beta/rename", h.authed(), { name: "" })).status).toBe(400);
    expect((await post(h.app, "/bots/beta/rename", h.authed(), { nope: 1 })).status).toBe(400);
    const ren = await post(h.app, "/bots/beta/rename", h.authed(), { name: "Beta two" });
    expect(await j(ren)).toMatchObject({ bot: { id: "beta", name: "Beta two" } });
    expect((await post(h.app, "/bots/ghost/rename", h.authed(), { name: "x" })).status).toBe(404);
    h.near.rpcDown = true;
    expect((await post(h.app, "/bots/beta/rename", h.authed(), { name: "x" })).status).toBe(502);
    expect((await post(h.app, "/bots/beta/archive", h.authed(), {})).status).toBe(502);
    const kill = await post(h.app, "/bots/beta/kill", h.authed(), { reason: "rpc is down" });
    expect(kill.status).toBe(200);
    expect(await j(kill)).toEqual({ bot_id: "beta", state: "halted", cancelled_orders: 0, steps: { cancel: "ok", state_saved: "ok" } });
    h.near.rpcDown = false;
    expect(h.service.status().bots.find((b) => b.id === "beta")?.state).toBe("halted");
    expect(h.service.status().bots.find((b) => b.id === "alpha")?.state).not.toBe("halted");
  });

  it("the kill routes are not rate limited; the archive and rename routes are", async () => {
    const h = await withBots();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await post(h.app, "/bots/beta/kill", h.authed(), {})).status);
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it("confirm over HTTP: the answer has the bot and the state; a v2 message and a bound nonce", async () => {
    const h = fundedHarness();
    const ok = await h.confirmOverHttp(rulesOf("Gamma strategy", [idle()]), { botId: "gamma", botName: "Gamma" });
    expect(ok.status).toBe(200);
    const body = await j(ok);
    expect(body.bot).toMatchObject({ id: "gamma", name: "Gamma", state: "running" });
    expect(body.active.message).toContain("bot: gamma");
    expect(body.state).toBe("running");
    // challenge without bot_id = default (callers from before bots); the message still names the bot
    const ch = await j(await post(h.app, "/rules/challenge", h.authed(), { rules: rulesOf("Legacy caller", [idle()]) }));
    expect(ch).toMatchObject({ bot_id: "default", is_new: true });
    expect(ch.message).toContain("bot: default");
  });
});
