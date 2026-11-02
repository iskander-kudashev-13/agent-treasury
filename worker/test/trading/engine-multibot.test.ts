/**
 * Multi-bot engine (ADR-0006 section 4): per-bot limits under account-wide caps, per-bot positions from own fills, sells capped
 * at the bot's position, per-bot loss stops and halts, account-wide halts, the summed account loss stop and the equity backstop.
 * Real engine + FakeHl; no money moves (the fake HL only simulates balances).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { DAY_MS } from "../../src/trading/engine/pnl.js";
import {
  type ActiveRules,
  type BotInput,
  type EngineState,
  type TickConfig,
  type TickResult,
  type VaultView,
  clearHalt,
  haltAll,
  haltBot,
  initialEngineState,
  runTick,
} from "../../src/trading/engine/tick.js";
import { FakeHl } from "../../src/trading/hl/fake.js";
import type { HardLimits, HlFill, Rule, RuleLimits, RuleSetV1 } from "../../src/trading/types.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";
const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const HASH_C = "cc".repeat(32);
const PRE_A = cloidPrefix(HASH_A);
const PRE_B = cloidPrefix(HASH_B);

const hardDefault: HardLimits = {
  maxPositionUsdc: "50",
  maxOrderUsdc: "20",
  dailyLossUsdc: "10",
  maxOrdersPerDay: 20,
  allowedPairs: ["HYPE/USDC"],
  minPairVolumeUsdc: "1000000",
  priceBandBps: 100,
};
const vaultOk: VaultView = { vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: null };

const limits = (o: Partial<RuleLimits> = {}): RuleLimits => ({ max_position_usdc: "50", max_order_usdc: "20", daily_loss_stop_usdc: "8", max_orders_per_day: 10, ...o });
const buy = (id: string, usdc = "12", o: Partial<Rule> = {}): Rule => ({
  id,
  pair: "HYPE/USDC",
  when: { type: "price", op: "lte", usdc: "100" },
  action: { side: "buy", size: { usdc }, order: { type: "ioc" } },
  cooldown: "1d",
  ...o,
});
const sellAll = (id = "exit"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "price", op: "gte", usdc: "1" }, action: { side: "sell", size: { position_pct: "100" }, order: { type: "ioc" } }, cooldown: "15m" });
const active = (hash: string, rules: Rule[], l: Partial<RuleLimits> = {}): ActiveRules => ({
  hash,
  confirmedAtMs: T0 - 3_600_000,
  rules: { version: 1, name: `set-${hash.slice(0, 2)}`, pairs: ["HYPE/USDC"], limits: limits(l), rules } satisfies RuleSetV1,
});
const bot = (id: string, hash: string, prefixes: string[], rules: ActiveRules | null, createdAtMs = 0): BotInput => ({ id, createdAtMs, archived: false, prefixes, rules });

let hl: FakeHl;
let clock: { t: number };
let hard: HardLimits;
let cfg: TickConfig;

beforeEach(() => {
  clock = { t: T0 };
  hl = new FakeHl({ now: () => clock.t });
  hl.account = ACCOUNT;
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent-treasury", validUntilMs: null }]);
  hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  hard = { ...hardDefault };
  cfg = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 10 * DAY_MS };
});

async function tick(now: number, bots: BotInput[], state: EngineState = initialEngineState(), deps: Partial<Parameters<typeof runTick>[0]> = {}): Promise<TickResult> {
  clock.t = now;
  return runTick({ hl, vault: () => Promise.resolve(vaultOk), config: { ...cfg, hard }, ...deps }, { nowMs: now, bots, state });
}
const skipCodes = (r: TickResult, botId?: string): string[] =>
  r.entries.filter((e) => e.kind === "skip" && (botId === undefined || e.bot_id === botId)).map((e) => e.detail.split(":")[0] ?? "");
const placedBy = (prefix: string): number => hl.placed.filter((o) => o.cloid.startsWith(prefix)).length;
const addFill = (f: Partial<HlFill> & Pick<HlFill, "timeMs" | "side" | "price" | "size" | "oid">): void => {
  hl.addFill(ACCOUNT, { tid: f.oid, cloid: null, pair: "HYPE/USDC", feeUsdc: "0", ...f });
};

describe("per-bot limits under account-wide caps", () => {
  it("two bots, each inside its own position cap, together over the ACCOUNT cap: the second is skipped with the account code", async () => {
    hard.maxPositionUsdc = "20";
    const a = active(HASH_A, [buy("a1")], { max_position_usdc: "20" });
    const b = active(HASH_B, [buy("b1")], { max_position_usdc: "20" });
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)]);
    expect(placedBy(PRE_A)).toBe(1);
    expect(placedBy(PRE_B)).toBe(0);
    expect(skipCodes(r, "b")).toEqual(["ACCOUNT_POSITION_CAP"]);
    expect(r.tradingState).toBe("running");
  });

  it("the account order-per-day cap binds across bots (ACCOUNT_MAX_ORDERS_PER_DAY)", async () => {
    hard.maxOrdersPerDay = 1;
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))]);
    expect(hl.placed).toHaveLength(1);
    expect(skipCodes(r, "b")).toEqual(["ACCOUNT_MAX_ORDERS_PER_DAY"]);
    expect(r.state.account.ordersToday).toBe(1);
    expect(r.state.bots["a"]?.ordersToday).toBe(1);
    expect(r.state.bots["b"]?.ordersToday).toBe(0);
  });

  it("a bot's own max_orders_per_day does not use up another bot's allowance", async () => {
    const a = active(HASH_A, [buy("a1", "12", { cooldown: "15m" })], { max_orders_per_day: 1 });
    const b = active(HASH_B, [buy("b1", "12", { cooldown: "15m" })], { max_orders_per_day: 5 });
    let r = await tick(T0, [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)]);
    r = await tick(T0 + 20 * 60_000, [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)], r.state);
    expect(placedBy(PRE_A)).toBe(1);
    expect(placedBy(PRE_B)).toBe(2);
    expect(skipCodes(r, "a")).toEqual(["MAX_ORDERS_PER_DAY"]);
  });

  it("MAX_ORDERS_PER_TICK (2) is account-wide: the third bot waits for the next tick", async () => {
    const mk = (id: string, h: string) => bot(id, h, [cloidPrefix(h)], active(h, [buy(`${id}1`)]));
    const bots = [mk("a", HASH_A), mk("b", HASH_B), mk("c", HASH_C)];
    const r = await tick(T0, bots);
    expect(hl.placed).toHaveLength(2);
    expect(placedBy(cloidPrefix(HASH_C))).toBe(0);
    await tick(T0 + 60_000, bots, r.state);
    expect(placedBy(cloidPrefix(HASH_C))).toBe(1);
  });

  it("a bot's position cap counts only its own holdings, not coins held by hand or by another bot", async () => {
    // 1 HYPE (40 USDC) held by hand; the account cap (50) leaves room for 10 more, the bot's own cap (15) is untouched.
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]);
    const a = active(HASH_A, [buy("a1", "10.5")], { max_position_usdc: "15", max_order_usdc: "20" });
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], a)]);
    // 40 (by hand) + 10.5 > 50: the ACCOUNT cap refuses, not the bot's own
    expect(skipCodes(r, "a")).toEqual(["ACCOUNT_POSITION_CAP"]);
    // fresh scenario: 0.5 HYPE (20 USDC) held by hand from the start
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "0.5", hold: "0" }]);
    const r2 = await tick(T0 + 60_000, [bot("a", HASH_A, [PRE_A], a)]);
    expect(placedBy(PRE_A)).toBe(1); // 20 (by hand) + 10.5 <= 50 and the bot's own position is 0
    expect(r2.tradingState).toBe("running");
  });

  it("free USDC is shared first come first served: a later bot skips with INSUFFICIENT_USDC, never overspends", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "15", hold: "0" }]);
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))]);
    expect(placedBy(PRE_A)).toBe(1);
    expect(skipCodes(r, "b")).toEqual(["INSUFFICIENT_USDC"]);
  });

  it("tighter bot limits still apply under the account caps (effective = min)", async () => {
    const a = active(HASH_A, [buy("a1", "19")], { max_order_usdc: "12" });
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], a)]);
    expect(skipCodes(r, "a")).toEqual(["MAX_ORDER"]);
    expect(r.bots["a"]?.limits).toMatchObject({ max_order_usdc: "12" });
  });
});

describe("shared pair: positions come from each bot's own fills", () => {
  /** Both bots buy once; returns the state after the fills have been read back. */
  async function bothBuy(feeFraction = "0"): Promise<TickResult> {
    hl.buyFeeBaseFraction = feeFraction;
    const a = active(HASH_A, [buy("a1", "20")]);
    const b = active(HASH_B, [buy("b1", "12"), sellAll("b-exit")], {});
    // b's sell rule must not fire in the buy tick: no position yet (and it is evaluated after the buy rule).
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], { ...b, rules: { ...b.rules, rules: [buy("b1", "12")] } })];
    let r = await tick(T0, bots);
    expect(hl.placed).toHaveLength(2);
    r = await tick(T0 + 60_000, bots, r.state);
    return r;
  }

  it("positions of two bots are separate (A: 0.49, B: 0.29) and add up to the account balance", async () => {
    const r = await bothBuy();
    expect(r.bots["a"]?.pos["HYPE/USDC"]).toBe("0.49");
    expect(r.bots["b"]?.pos["HYPE/USDC"]).toBe("0.29");
    expect(r.status.balances.positions[0]?.size).toBe("0.78");
  });

  it("B sells 100% of ITS position net of the base-token fee, never A's coins", async () => {
    const r1 = await bothBuy("0.01");
    // A holds 0.49 * 0.99 = 0.4851, B 0.29 * 0.99 = 0.2871; the account holds 0.7722. B sells floor(0.2871, 2 dp) = 0.28.
    expect(r1.bots["a"]?.pos["HYPE/USDC"]).toBe("0.4851");
    expect(r1.bots["b"]?.pos["HYPE/USDC"]).toBe("0.2871");
    const idleA = active(HASH_A, [buy("a1", "20", { when: { type: "price", op: "gte", usdc: "9999" } })]);
    const sellB = active(HASH_B, [sellAll("b-exit")]);
    const before = hl.placed.length;
    const r2 = await tick(T0 + 2 * 60_000, [bot("a", HASH_A, [PRE_A], idleA), bot("b", HASH_B, [PRE_B], sellB)], r1.state);
    const sells = hl.placed.slice(before).filter((o) => !o.isBuy);
    expect(sells).toHaveLength(1);
    expect(sells[0]?.size).toBe("0.28");
    expect(sells[0]?.cloid.startsWith(PRE_B)).toBe(true);
    // next tick: B is down to 0.0071 and A is untouched
    const r3 = await tick(T0 + 3 * 60_000, [bot("a", HASH_A, [PRE_A], idleA), bot("b", HASH_B, [PRE_B], sellB)], r2.state);
    expect(r3.bots["a"]?.pos["HYPE/USDC"]).toBe("0.4851");
    expect(r3.bots["b"]?.pos["HYPE/USDC"]).toBe("0.0071");
    // B has no sellable lot left (floor to 2 decimals = 0): refused, A's coins stay
    expect(hl.placed.slice(before).filter((o) => !o.isBuy)).toHaveLength(1);
  });

  it("a sell with no own position is refused INSUFFICIENT_BOT_BASE even though the account (another bot) holds coins", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }]);
    addFill({ oid: 5, cloid: `${PRE_A}0000000000000001`, timeMs: T0 - 1000, side: "buy", price: "40", size: "2" });
    const a = active(HASH_A, [buy("a-idle", "12", { when: { type: "price", op: "gte", usdc: "9999" } })]);
    const b = active(HASH_B, [sellAll("b-exit")]);
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)]);
    expect(hl.placed).toHaveLength(0);
    expect(skipCodes(r, "b")).toEqual(["INSUFFICIENT_BOT_BASE"]);
    expect(r.bots["a"]?.pos["HYPE/USDC"]).toBe("2");
  });

  it("a sell larger than the bot's own position is refused by the guard (usdc-sized sell of 12 USDC against 0.1 coin)", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }]);
    addFill({ oid: 5, cloid: `${PRE_A}0000000000000001`, timeMs: T0 - 1000, side: "buy", price: "40", size: "0.1" });
    const sell: Rule = { id: "s", pair: "HYPE/USDC", when: { type: "price", op: "gte", usdc: "1" }, action: { side: "sell", size: { usdc: "12" }, order: { type: "ioc" } }, cooldown: "1d" };
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [sell]))]);
    expect(hl.placed).toHaveLength(0);
    expect(skipCodes(r, "a")).toEqual(["INSUFFICIENT_BOT_BASE"]);
  });

  it("open sell orders of the bot reduce what it may still sell", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "0.6", hold: "0.3" }]);
    addFill({ oid: 5, cloid: `${PRE_A}0000000000000001`, timeMs: T0 - 1000, side: "buy", price: "40", size: "0.6" });
    hl.setOpenOrders(ACCOUNT, [{ oid: 77, cloid: `${PRE_A}0000000000000009`, market: "spot", pair: "HYPE/USDC", side: "sell", price: "45", size: "0.3", placedAtMs: T0 - 5000 }]);
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [sellAll()]))]);
    // 0.6 own - 0.3 resting = 0.3 left to sell (account free = 0.3 too)
    expect(hl.placed.filter((o) => !o.isBuy)[0]?.size).toBe("0.3");
    expect(r.tradingState).toBe("running");
  });

  it("migrated history that is incomplete: the bot sells nothing (BOT_POSITION_UNKNOWN) until it is re-created", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]);
    const r0 = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("idle", "12", { when: { type: "price", op: "gte", usdc: "9999" } })]))]);
    const st = structuredClone(r0.state);
    (st.bots["a"] as NonNullable<(typeof st.bots)["a"]>).agg.totalComplete = false;
    const r = await tick(T0 + 60_000, [bot("a", HASH_A, [PRE_A], active(HASH_A, [sellAll()]))], st);
    expect(skipCodes(r, "a")).toEqual(["BOT_POSITION_UNKNOWN"]);
    expect(hl.placed).toHaveLength(0);
  });
});

describe("attribution", () => {
  it("fills are matched to bots by cloid prefix, else by the order id remembered when the order was placed", async () => {
    const bots = [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))];
    let r = await tick(T0, bots);
    // HL answers without the cloid on B's fill: the oid path attributes it
    const bFill = hl.fills[ACCOUNT.toLowerCase()]?.find((f) => f.cloid?.startsWith(PRE_B));
    expect(bFill).toBeDefined();
    if (bFill) bFill.cloid = null;
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.bots["a"]?.pos["HYPE/USDC"]).toBe("0.29");
    expect(r.bots["b"]?.pos["HYPE/USDC"]).toBe("0.29");
    expect(r.attributed).toHaveLength(2);
    expect(r.tradingState).toBe("running");
  });

  it("a fill that belongs to no bot is foreign: counted and warned, never in any bot's sums", async () => {
    addFill({ oid: 99, cloid: "0x" + "11".repeat(16), timeMs: T0 - 500, side: "buy", price: "40", size: "1" });
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })]))]);
    expect(r.state.account.fillCursor?.foreignFills).toBe(1);
    expect(r.status.warnings.some((w) => w.includes("not from any bot"))).toBe(true);
    expect(r.bots["a"]?.pos).toEqual({});
  });

  it("prefixes of older rule sets of a bot stay attributed to it for ever (permanent registry)", async () => {
    const old = cloidPrefix("dd".repeat(32));
    addFill({ oid: 5, cloid: `${old}0000000000000003`, timeMs: T0 - 1000, side: "buy", price: "40", size: "0.5" });
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "0.5", hold: "0" }]);
    const r = await tick(T0, [bot("a", HASH_A, [old, PRE_A], active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })]))]);
    expect(r.bots["a"]?.pos["HYPE/USDC"]).toBe("0.5");
  });

  it("an order reported filled without an attributed fill blocks ALL bots (FILLS_NOT_ATTRIBUTED)", async () => {
    const bots = [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))];
    let r = await tick(T0, bots);
    hl.fills[ACCOUNT.toLowerCase()] = []; // HL did not index the fills
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("FILLS_NOT_ATTRIBUTED");
    expect(r.status.state_detail).toMatch(/bot [ab]:/);
  });
});

describe("loss stops", () => {
  /** Bot `id` bought `size` at `price` after the day snapshot of the first tick. */
  const lossFill = (prefix: string, oid: number, price: string, size = "1"): void => {
    addFill({ oid, cloid: `${prefix}00000000000000${oid.toString(16).padStart(2, "0")}`, timeMs: T0 + 5_000, side: "buy", price, size });
  };

  it("one bot's daily loss stop stops only that bot; the other keeps trading in the same tick", async () => {
    const a = active(HASH_A, [buy("a1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "5" });
    const b = active(HASH_B, [buy("b1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "8" });
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)];
    let r = await tick(T0, bots);
    hl.placed.length = 0;
    lossFill(PRE_A, 0x31, "52", "0.5"); // bought 0.5 at 52, mid 40: A is down 6 >= 5; B is flat
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "74", hold: "0" }, { coin: "HYPE", total: "0.5", hold: "0" }]);
    r = await tick(T0 + 20 * 60_000, bots, r.state);
    expect(r.bots["a"]).toMatchObject({ state: "stopped_today", reason: "DAILY_LOSS_STOP" });
    expect(r.bots["b"]?.state).toBe("running");
    expect(r.tradingState).toBe("running");
    expect(placedBy(PRE_A)).toBe(0);
    expect(placedBy(PRE_B)).toBe(1);
    expect(r.state.bots["a"]?.stoppedDayIndex).not.toBeNull();
    expect(r.state.account.stoppedDayIndex).toBeNull();
  });

  it("the stopped bot's resting orders are cancelled, the other bot's are not", async () => {
    const a = active(HASH_A, [buy("a1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "5" });
    const b = active(HASH_B, [buy("b1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "8" });
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)];
    const r0 = await tick(T0, [bot("a", HASH_A, [PRE_A], null), bot("b", HASH_B, [PRE_B], null)]);
    hl.setOpenOrders(ACCOUNT, [
      { oid: 71, cloid: `${PRE_A}00000000000000f1`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
      { oid: 72, cloid: `${PRE_B}00000000000000f2`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
    ]);
    lossFill(PRE_A, 0x32, "46");
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "54", hold: "12" }, { coin: "HYPE", total: "1", hold: "0" }]);
    await tick(T0 + 60_000, bots, r0.state);
    expect(hl.cancelled.map((c) => c.oid)).toEqual([71]);
  });

  it("the SUMMED loss of all bots stops the account (ACCOUNT_LOSS_STOP) although each bot is under its own stop", async () => {
    const a = active(HASH_A, [buy("a1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "8" });
    const b = active(HASH_B, [buy("b1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "8" });
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)];
    let r = await tick(T0, [bot("a", HASH_A, [PRE_A], null), bot("b", HASH_B, [PRE_B], null)]);
    lossFill(PRE_A, 0x33, "46"); // -6
    lossFill(PRE_B, 0x34, "46"); // -6: each < 8, together 12 >= hard 10
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "8", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }]);
    hl.placed.length = 0;
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.state_reason).toBe("ACCOUNT_LOSS_STOP");
    expect(r.state.account.stopReason).toBe("ACCOUNT_LOSS_STOP");
    expect(hl.placed).toHaveLength(0);
    expect(r.bots["a"]?.state).toBe("stopped_today");
    // sticky for the UTC day
    r = await tick(T0 + 120_000, bots, r.state);
    expect(r.status.state_reason).toBe("ACCOUNT_LOSS_STOP");
  });

  it("a profit of one bot never hides the loss of another in the account sum", async () => {
    const a = active(HASH_A, [buy("a1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "9" });
    const b = active(HASH_B, [buy("b1", "12", { cooldown: "15m" })], { daily_loss_stop_usdc: "9" });
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)];
    let r = await tick(T0, [bot("a", HASH_A, [PRE_A], null), bot("b", HASH_B, [PRE_B], null)]);
    lossFill(PRE_A, 0x35, "50"); // -10 for A (mid 40): over its stop 9 and over the account cap alone
    lossFill(PRE_B, 0x36, "30"); // +10 for B
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "20", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }]);
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.bots["a"]?.state).toBe("stopped_today");
    expect(r.status.state_reason).toBe("ACCOUNT_LOSS_STOP");
  });

  it("the equity backstop threshold is min(hard stop, sum of the active bots' stops)", async () => {
    // Bots A (stop 3) and B (stop 2): sum 5 < hard 10. An unexplained equity drop of 6 stops the account.
    const a = active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })], { daily_loss_stop_usdc: "3" });
    const b = active(HASH_B, [buy("b1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })], { daily_loss_stop_usdc: "2" });
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)];
    let r = await tick(T0, bots);
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "94", hold: "0" }]);
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.state_reason).toBe("EQUITY_DROP");
    expect(r.status.state_detail).toContain(">= stop 5");
  });

  it("with one bot the backstop threshold is that bot's stop (unchanged from before bots)", async () => {
    const a = active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })], { daily_loss_stop_usdc: "4" });
    let r = await tick(T0, [bot("a", HASH_A, [PRE_A], a)]);
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "95", hold: "0" }]);
    r = await tick(T0 + 60_000, [bot("a", HASH_A, [PRE_A], a)], r.state);
    expect(r.status.state_reason).toBe("EQUITY_DROP");
    expect(r.status.state_detail).toContain(">= stop 4");
  });

  it("a bot's stop marks only ITS OWN holdings: coins held by hand are left to the equity backstop", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]); // 1 HYPE by hand
    const a = active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })], { daily_loss_stop_usdc: "5" });
    let r = await tick(T0, [bot("a", HASH_A, [PRE_A], a)]);
    hl.setMid("HYPE/USDC", "32"); // -8 on the hand-held coin
    r = await tick(T0 + 60_000, [bot("a", HASH_A, [PRE_A], a)], r.state);
    expect(r.bots["a"]?.lossToday).toBe("0");
    // ...but the account-wide backstop still catches it (8 >= min(hard 10, stop 5))
    expect(r.status.state_reason).toBe("EQUITY_DROP");
  });

  it("a bot's stop marks its own start-of-day holdings: a position bought yesterday that loses value today stops it", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "80", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]);
    addFill({ oid: 5, cloid: `${PRE_A}0000000000000001`, timeMs: T0 - 1000, side: "buy", price: "40", size: "1" });
    const a = active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })], { daily_loss_stop_usdc: "5" });
    const b = active(HASH_B, [buy("b1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })], { daily_loss_stop_usdc: "5" });
    const bots = [bot("a", HASH_A, [PRE_A], a), bot("b", HASH_B, [PRE_B], b)];
    let r = await tick(T0, bots);
    expect(r.state.bots["a"]?.startPositions["HYPE/USDC"]).toEqual({ size: "1", mid: "40" });
    expect(r.state.bots["b"]?.startPositions).toEqual({});
    hl.setMid("HYPE/USDC", "34"); // A's coin lost 6
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.bots["a"]?.state).toBe("stopped_today");
    expect(r.bots["b"]?.state).toBe("running");
  });
});

describe("halts and kill", () => {
  const two = (): { bots: BotInput[] } => ({
    bots: [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))],
  });

  it("kill ONE bot: only its orders are cancelled and B places an order in the same tick", async () => {
    const { bots } = two();
    hl.setOpenOrders(ACCOUNT, [
      { oid: 71, cloid: `${PRE_A}00000000000000f1`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
      { oid: 72, cloid: `${PRE_B}00000000000000f2`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
    ]);
    const st = haltBot(initialEngineState(), "a", T0 - 1000, "KILLED", "kill switch");
    const r = await tick(T0, bots, st);
    expect(hl.cancelled.map((c) => c.oid)).toEqual([71]);
    expect(placedBy(PRE_A)).toBe(0);
    expect(placedBy(PRE_B)).toBe(1);
    expect(r.bots["a"]).toMatchObject({ state: "halted", reason: "KILLED" });
    expect(r.bots["b"]?.state).toBe("running");
    expect(r.tradingState).toBe("running");
  });

  it("kill ALL: account halt plus every bot halted; everything is cancelled and nothing is placed", async () => {
    const { bots } = two();
    hl.setOpenOrders(ACCOUNT, [
      { oid: 71, cloid: `${PRE_A}00000000000000f1`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
      { oid: 72, cloid: `${PRE_B}00000000000000f2`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
    ]);
    const st = haltAll(initialEngineState(), T0 - 1000, "KILLED", "kill switch", ["a", "b"]);
    expect(st.bots["a"]?.halt?.reason).toBe("KILLED");
    expect(st.bots["b"]?.halt?.reason).toBe("KILLED");
    const r = await tick(T0, bots, st);
    expect(r.tradingState).toBe("halted");
    expect(hl.cancelled.map((c) => c.oid).sort()).toEqual([71, 72]);
    expect(hl.placed).toHaveLength(0);
    expect(r.bots["a"]?.state).toBe("halted");
    expect(r.bots["b"]?.state).toBe("halted");
  });

  it("confirming bot A clears A and the account halt; B stays halted until it is confirmed too", async () => {
    const { bots } = two();
    let st = haltAll(initialEngineState(), T0 - 1000, "KILLED", "kill switch", ["a", "b"]);
    st = clearHalt(st, "a");
    expect(st.account.halt).toBeNull();
    expect(st.bots["a"]?.halt).toBeNull();
    expect(st.bots["b"]?.halt).not.toBeNull();
    const r = await tick(T0, bots, st);
    expect(placedBy(PRE_A)).toBe(1);
    expect(placedBy(PRE_B)).toBe(0);
    expect(r.bots["b"]).toMatchObject({ state: "halted", reason: "KILLED" });
    expect(r.tradingState).toBe("running");
    const r2 = await tick(T0 + 61_000, bots, clearHalt(r.state, "b"));
    expect(placedBy(PRE_B)).toBe(1);
    expect(r2.bots["b"]?.state).toBe("running");
  });

  it("re-signing the SAME hash resumes: the halt is cleared, cooldowns are kept", async () => {
    const a = active(HASH_A, [buy("a1")]);
    let r = await tick(T0, [bot("a", HASH_A, [PRE_A], a)]);
    expect(hl.placed).toHaveLength(1);
    const st = clearHalt(haltBot(r.state, "a", T0 + 10, "KILLED", "kill"), "a");
    r = await tick(T0 + 60_000, [bot("a", HASH_A, [PRE_A], a)], st);
    expect(hl.placed).toHaveLength(1); // the 1d cooldown of rule a1 survived
    expect(r.bots["a"]?.state).toBe("running");
  });

  it("a perp position halts the account AND every bot, and cancels everything", async () => {
    const { bots } = two();
    hl.setPerp(ACCOUNT, { positions: [{ coin: "BTC", size: "0.01" }], openPerpOrders: 0, accountValueUsdc: "5" });
    const r = await tick(T0, bots);
    expect(r.tradingState).toBe("halted");
    expect(r.status.state_reason).toBe("PERP_POSITION_DETECTED");
    expect(r.state.account.halt?.reason).toBe("PERP_POSITION_DETECTED");
    expect(r.state.bots["a"]?.halt?.reason).toBe("PERP_POSITION_DETECTED");
    expect(r.state.bots["b"]?.halt?.reason).toBe("PERP_POSITION_DETECTED");
    expect(hl.placed).toHaveLength(0);
  });

  it("an off-chain pause (vault paused) blocks every bot", async () => {
    const { bots } = two();
    const r = await tick(T0, bots, initialEngineState(), { vault: () => Promise.resolve({ ...vaultOk, vaultPaused: true }) });
    expect(r.tradingState).toBe("paused_onchain");
    expect(hl.placed).toHaveLength(0);
    expect(r.bots["a"]?.state).toBe("blocked");
    expect(r.bots["b"]).toMatchObject({ state: "blocked", reason: "VAULT_PAUSED" });
  });

  it("IOC-only mode (dead-man volume gate) applies to every bot: limit rules are skipped for all", async () => {
    hl.scheduleCancelError = new Error("Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.");
    const lim = (id: string): Rule => buy(id, "12", { action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "2", ttl: "1h" } } });
    const bots = [bot("a", HASH_A, [PRE_A], active(HASH_A, [lim("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [lim("b1"), buy("b2", "12")]))];
    const r = await tick(T0, bots);
    expect(r.status.dead_man.available).toBe(false);
    expect(skipCodes(r, "a")).toEqual(["LIMIT_NEEDS_DEADMAN"]);
    expect(skipCodes(r, "b")).toContain("LIMIT_NEEDS_DEADMAN");
    expect(hl.placed.every((o) => o.tif === "Ioc")).toBe(true);
    expect(placedBy(PRE_B)).toBe(1); // b2 is an IOC order
  });

  it("scheduleCancel is refreshed once per tick, before the first order of any bot", async () => {
    const { bots } = two();
    await tick(T0, bots);
    const log = hl.callLog();
    expect(log.filter((c) => c === "scheduleCancel")).toHaveLength(1);
    expect(log.indexOf("scheduleCancel")).toBeLessThan(log.indexOf("place"));
  });

  it("a kill that arrives while a tick runs stops that bot's later orders only (shouldStop(botId))", async () => {
    const { bots } = two();
    const r = await tick(T0, bots, initialEngineState(), { shouldStop: (id) => id === "a" });
    expect(placedBy(PRE_A)).toBe(0);
    expect(placedBy(PRE_B)).toBe(1);
    expect(r.entries.some((e) => e.detail.includes("kill switch pulled") && e.bot_id === "a")).toBe(true);
  });
});

describe("orders of other rule sets", () => {
  it("a superseded rule set's resting order is cancelled for that bot only; orders without a cloid are never touched", async () => {
    const oldPre = cloidPrefix("ee".repeat(32));
    hl.setOpenOrders(ACCOUNT, [
      { oid: 71, cloid: `${oldPre}00000000000000f1`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
      { oid: 72, cloid: `${PRE_B}00000000000000f2`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
      { oid: 73, cloid: null, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
      { oid: 74, cloid: "0x" + "99".repeat(16), market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 },
    ]);
    const bots = [bot("a", HASH_A, [oldPre, PRE_A], active(HASH_A, [buy("a1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1", "12", { when: { type: "price", op: "gte", usdc: "9999" } })]))];
    await tick(T0, bots);
    // 71: superseded prefix of bot a; 74: no bot owns it. 72 (current prefix of b) and 73 (by hand) stay.
    expect(hl.cancelled.map((c) => c.oid).sort()).toEqual([71, 74]);
  });

  it("an archived bot's orders are cancelled; an archived bot never trades", async () => {
    hl.setOpenOrders(ACCOUNT, [{ oid: 71, cloid: `${PRE_A}00000000000000f1`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "0.4", placedAtMs: T0 }]);
    const archived: BotInput = { id: "a", createdAtMs: 0, archived: true, prefixes: [PRE_A], rules: null };
    const r = await tick(T0, [archived, bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))]);
    expect(hl.cancelled.map((c) => c.oid)).toEqual([71]);
    expect(r.bots["a"]?.state).toBe("archived");
    expect(placedBy(PRE_B)).toBe(1);
  });

  it("a draft bot (no rules) and a refused bot are shown as draft / blocked and do not stop the others", async () => {
    const refused: BotInput = { id: "r", createdAtMs: 0, archived: false, prefixes: [], rules: null, refused: true };
    const draft: BotInput = { id: "d", createdAtMs: 0, archived: false, prefixes: [], rules: null };
    const r = await tick(T0, [refused, draft, bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))]);
    expect(r.bots["r"]).toMatchObject({ state: "blocked", reason: "RULES_REFUSED" });
    expect(r.bots["d"]?.state).toBe("draft");
    expect(r.bots["b"]?.state).toBe("running");
    expect(r.tradingState).toBe("running");
  });

  it("no bot with rules: the account is no_rules", async () => {
    const r = await tick(T0, [{ id: "d", createdAtMs: 0, archived: false, prefixes: [], rules: null }]);
    expect(r.tradingState).toBe("no_rules");
  });
});

describe("engine state v2 properties", () => {
  it("does not mutate the input state and survives a JSON round trip", async () => {
    const bots = [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")]))];
    const s = initialEngineState();
    const copy = structuredClone(s);
    const r = await tick(T0, bots, s);
    expect(s).toEqual(copy);
    const again = await tick(T0 + 60_000, bots, JSON.parse(JSON.stringify(r.state)) as EngineState);
    expect(again.tradingState).toBe("running");
  });

  it("the cloid counter is one for the whole account (unique cloids across bots)", async () => {
    const bots = [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], active(HASH_B, [buy("b1")]))];
    const r = await tick(T0, bots);
    expect(hl.placed.map((o) => o.cloid.slice(-16))).toEqual(["0000000000000001", "0000000000000002"]);
    expect(r.state.account.orderCounter).toBe(2);
  });

  it("history samples: one per bot with the numbers of the bot, and an account sample", async () => {
    const bots = [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")])), bot("b", HASH_B, [PRE_B], null)];
    let r = await tick(T0, bots);
    r = await tick(T0 + 60_000, bots, r.state);
    expect(r.bots["a"]).toMatchObject({ priced: true, pos: { "HYPE/USDC": "0.29" } });
    expect(Number(r.bots["a"]?.positionUsdc)).toBeGreaterThan(11);
    expect(r.bots["b"]).toMatchObject({ priced: true, positionUsdc: "0" });
    expect(r.accountSample?.equity).toBeDefined();
  });

  it("errors before P&L exists give no samples (no false curve)", async () => {
    hl.failNext("getMids");
    const r = await tick(T0, [bot("a", HASH_A, [PRE_A], active(HASH_A, [buy("a1")]))]);
    expect(r.status.state_reason).toBe("HL_READ_FAILED");
    expect(r.bots["a"]?.priced).toBe(false);
    expect(r.accountSample).toBeNull();
  });
});
