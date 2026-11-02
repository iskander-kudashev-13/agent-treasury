import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/trading/engine/pnl.js";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { FillsTruncatedError } from "../../src/trading/hl/pagination.js";
import {
  type ActiveRules,
  type EngineState,
  MAX_RECENT,
  type TickConfig,
  type TickResult,
  type VaultView,
  clearHalt,
  haltState,
  initialEngineState,
  runTick,
} from "../../src/trading/engine/tick.js";
import type {
  HardLimits,
  HlApprovedAgent,
  HlBook,
  HlCandle,
  HlFill,
  HlLedgerEntry,
  HlMids,
  HlOpenOrder,
  HlOrderResult,
  HlPerpState,
  HlPlaceOrder,
  HlPort,
  HlSpotBalance,
  HlSpotPair,
  Rule,
  RuleLimits,
  RuleSetV1,
} from "../../src/trading/types.js";

// 2026-11-05 12:00:00 UTC
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const H = 3_600_000;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";
const HASH = "ab".repeat(32);

const hard: HardLimits = {
  maxPositionUsdc: "50",
  maxOrderUsdc: "20",
  dailyLossUsdc: "10",
  maxOrdersPerDay: 20,
  allowedPairs: ["HYPE/USDC"],
  minPairVolumeUsdc: "1000000",
  priceBandBps: 100,
};
const cfg: TickConfig = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 10 * DAY_MS };

/** Small scripted HlPort. `calls` records the order of every side-effecting or reading call. */
class Fake implements HlPort {
  calls: string[] = [];
  now = T0;
  pairs: HlSpotPair[] = [{ name: "HYPE/USDC", base: "HYPE", assetId: 10107, szDecimals: 2, volume24hUsdc: "5000000", midUsdc: "40" }];
  mid: string | undefined = "40";
  midsAtMs: number | null = null; // null = fresh (== now)
  book: { bid: string | null; ask: string | null } = { bid: "39.99", ask: "40.01" };
  balances: HlSpotBalance[] = [{ coin: "USDC", total: "100", hold: "0" }];
  perp: HlPerpState = { positions: [], openPerpOrders: 0, accountValueUsdc: "0" };
  orders: HlOpenOrder[] = [];
  agents: HlApprovedAgent[] = [{ address: API, name: "agent-treasury valid_until", validUntilMs: null }];
  ledger: HlLedgerEntry[] = [];
  fills: HlFill[] = [];
  candles: HlCandle[] = [];
  placed: HlPlaceOrder[] = [];
  cancelled: { assetId: number; oid: number }[] = [];
  scheduled: (number | null)[] = [];
  failSchedule = false;
  scheduleError: Error | null = null;
  failCancel = false;
  failReads = false;
  placeResult: ((o: HlPlaceOrder) => HlOrderResult) | null = null;
  nextOid = 1;
  /** Like HL: an order that fills leaves a fill row (at the mid, so P&L stays 0 until tests move the price). */
  autoFills = true;
  nextTid = 1;

  getSpotPairs() {
    this.calls.push("getSpotPairs");
    return this.read(this.pairs);
  }
  /** Mids of other pairs (not tradable here): lets a test price a coin outside the allowed pairs. */
  extraMids: Record<string, string> = {};
  getMids(): Promise<HlMids> {
    this.calls.push("getMids");
    return this.read({ mids: { ...this.extraMids, ...(this.mid === undefined ? {} : { "HYPE/USDC": this.mid }) }, atMs: this.midsAtMs ?? this.now, ...(this.pairAtMs ? { pairAtMs: this.pairAtMs } : {}) });
  }
  getBook(): Promise<HlBook> {
    this.calls.push("getBook");
    return this.read({ ...this.book, atMs: this.now });
  }
  getCandles(): Promise<HlCandle[]> {
    this.calls.push("getCandles");
    return this.read(this.candles);
  }
  getSpotBalances() {
    this.calls.push("getSpotBalances");
    return this.read(this.balances);
  }
  getPerpState() {
    this.calls.push("getPerpState");
    return this.read(this.perp);
  }
  getOpenOrders() {
    this.calls.push("getOpenOrders");
    return this.read([...this.orders]);
  }
  fillsFrom: number[] = [];
  /** Called with the requested start; a returned error rejects the read. */
  fillsError: ((startMs: number) => Error | null) | null = null;
  pairAtMs: Record<string, number> | null = null;
  getUserFills(_a?: string, startMs = 0) {
    this.calls.push("getUserFills");
    this.fillsFrom.push(startMs);
    const err = this.fillsError?.(startMs) ?? null;
    if (err) return Promise.reject(err);
    return this.read(this.fills);
  }
  getLedger(_a: string, startMs: number) {
    this.calls.push("getLedger");
    return this.read(this.ledger.filter((l) => l.timeMs >= startMs));
  }
  getApprovedAgents() {
    this.calls.push("getApprovedAgents");
    return this.read(this.agents);
  }
  placeSpotOrder(o: HlPlaceOrder): Promise<HlOrderResult> {
    this.calls.push("placeSpotOrder");
    this.placed.push(o);
    if (this.placeResult) return Promise.resolve(this.placeResult(o));
    const oid = this.nextOid++;
    if (o.tif === "Gtc") {
      this.orders.push({ oid, cloid: o.cloid, market: "spot", pair: "HYPE/USDC", side: o.isBuy ? "buy" : "sell", price: o.price, size: o.size, placedAtMs: this.now });
      return Promise.resolve({ status: "resting", oid });
    }
    if (this.autoFills) {
      this.fills.push({ oid, tid: this.nextTid++, cloid: o.cloid, pair: "HYPE/USDC", side: o.isBuy ? "buy" : "sell", price: this.mid ?? o.price, size: o.size, feeUsdc: "0", timeMs: this.now });
    }
    return Promise.resolve({ status: "filled", oid, filledSize: o.size, avgPx: o.price });
  }
  cancelOrders(orders: { assetId: number; oid: number }[]) {
    this.calls.push("cancelOrders");
    if (this.failCancel) return Promise.reject(new Error("cancel down"));
    this.cancelled.push(...orders);
    const oids = new Set(orders.map((o) => o.oid));
    this.orders = this.orders.filter((o) => !oids.has(o.oid));
    return Promise.resolve();
  }
  scheduleCancel(t: number | null) {
    this.calls.push("scheduleCancel");
    if (this.failSchedule) return Promise.reject(new Error("schedule down"));
    if (this.scheduleError) return Promise.reject(this.scheduleError);
    this.scheduled.push(t);
    return Promise.resolve();
  }
  private read<T>(v: T): Promise<T> {
    return this.failReads ? Promise.reject(new Error("hl down")) : Promise.resolve(structuredClone(v));
  }
}

const vaultOk: VaultView = {
  vaultPaused: false,
  status: "Active",
  remainingTodayUsdc: "50",
  perTxLimitUsdc: "25",
  paymentsToday: 0,
  maxPaymentsPerDay: 2,
  expiresAtMs: null,
};

const limits = (o: Partial<RuleLimits> = {}): RuleLimits => ({ max_position_usdc: "50", max_order_usdc: "20", daily_loss_stop_usdc: "5", max_orders_per_day: 10, ...o });
const buyRule = (id = "dip", o: Partial<Rule> = {}): Rule => ({
  id,
  pair: "HYPE/USDC",
  when: { type: "price", op: "lte", usdc: "50" },
  action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } },
  cooldown: "1h",
  ...o,
});
const active = (rules: Rule[] = [buyRule()], l: Partial<RuleLimits> = {}, hash = HASH): ActiveRules => ({
  hash,
  confirmedAtMs: T0 - H,
  rules: { version: 1, name: "t", pairs: ["HYPE/USDC"], limits: limits(l), rules } satisfies RuleSetV1,
});

let hl: Fake;
let vault: () => Promise<VaultView>;
beforeEach(() => {
  hl = new Fake();
  vault = () => Promise.resolve(vaultOk);
});

async function tick(now: number, rules: ActiveRules | null, state: EngineState = initialEngineState()): Promise<TickResult> {
  hl.now = now;
  return runTick({ hl, vault, config: cfg }, { nowMs: now, rules, state });
}
const idx = (name: string, from = 0) => hl.calls.indexOf(name, from);

describe("happy path and ordering", () => {
  it("refreshes scheduleCancel BEFORE the first order and places a spot order with a rule-bound cloid", async () => {
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("running");
    expect(hl.placed).toHaveLength(1);
    expect(idx("scheduleCancel")).toBeGreaterThanOrEqual(0);
    expect(idx("scheduleCancel")).toBeLessThan(idx("placeSpotOrder"));
    expect(hl.scheduled).toEqual([T0 + 180_000]);
    const o = hl.placed[0];
    expect(o).toMatchObject({ assetId: 10107, isBuy: true, tif: "Ioc", price: "40.4", size: "0.29" });
    expect(o?.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(o?.cloid.startsWith(cloidPrefix(HASH))).toBe(true);
    expect(r.state.ordersToday).toBe(1);
    expect(r.state.orderCounter).toBe(1);
    expect(r.state.firedAt.dip).toBe(T0);
    expect(r.status.dead_man.cancel_at_ms).toBe(T0 + 180_000);
    expect(r.status.perp_check.ok).toBe(true);
    expect(r.status.api_wallet.approved).toBe(true);
    expect(r.status.next_tick_ms).toBe(T0 + 60_000);
    expect(r.entries.some((e) => e.kind === "order" && e.rule_id === "dip" && e.cloid === o?.cloid)).toBe(true);
    expect(r.status.limits.effective.price_band_bps).toBe(100);
    expect(r.status.balances.usdc_total).toBe("100");
  });

  it("does not mutate the input state", async () => {
    const s = initialEngineState();
    const copy = structuredClone(s);
    await tick(T0, active(), s);
    expect(s).toEqual(copy);
  });

  it("cloid counter is monotonic across ticks", async () => {
    const a = await tick(T0, active([buyRule("a", { cooldown: "15m" })]));
    const b = await tick(T0 + 20 * 60_000, active([buyRule("a", { cooldown: "15m" })]), a.state);
    expect(hl.placed.map((o) => o.cloid.slice(-16))).toEqual(["0000000000000001", "0000000000000002"]);
    expect(b.state.ordersToday).toBe(2);
  });
});

describe("cooldown", () => {
  it("blocks a re-fire inside the cooldown, allows it after, even when the trigger stays true", async () => {
    let r = await tick(T0, active());
    r = await tick(T0 + H - 60_000, active(), r.state);
    expect(hl.placed).toHaveLength(1);
    await tick(T0 + H, active(), r.state);
    expect(hl.placed).toHaveLength(2);
  });
  it("a rejected order still starts the cooldown", async () => {
    hl.placeResult = () => ({ status: "rejected", error: "Order has invalid size" });
    const r = await tick(T0, active());
    expect(r.state.firedAt.dip).toBe(T0);
    expect(r.entries.find((e) => e.kind === "order")?.detail).toContain("rejected");
    await tick(T0 + 60_000, active(), r.state);
    expect(hl.placed).toHaveLength(1);
  });
  it("a placement that throws counts as a rejected attempt", async () => {
    hl.placeResult = () => {
      throw new Error("network");
    };
    const r = await tick(T0, active());
    expect(r.state.firedAt.dip).toBe(T0);
    expect(r.state.ordersToday).toBe(1);
    expect(r.entries.find((e) => e.kind === "order")?.detail).toContain("network");
  });
  it("interval rules use `every` as the cooldown and fire at first tick", async () => {
    const rule: Rule = { id: "dca", pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } };
    let r = await tick(T0, active([rule]));
    expect(hl.placed).toHaveLength(1);
    r = await tick(T0 + H - 1, active([rule]), r.state);
    expect(hl.placed).toHaveLength(1);
    await tick(T0 + H, active([rule]), r.state);
    expect(hl.placed).toHaveLength(2);
  });
});

describe("perp alarm", () => {
  const perpCases: [string, Partial<HlPerpState>][] = [
    ["a perp position", { positions: [{ coin: "BTC", size: "0.001" }] }],
    ["an open perp order", { openPerpOrders: 1 }],
  ];
  for (const [name, patch] of perpCases) {
    it(`${name} halts, cancels all spot orders, places nothing`, async () => {
      hl.perp = { positions: [], openPerpOrders: 0, accountValueUsdc: "0", ...patch };
      hl.orders = [{ oid: 7, cloid: `${cloidPrefix(HASH)}0000000000000009`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "39", size: "0.3", placedAtMs: T0 }];
      const r = await tick(T0, active());
      expect(r.tradingState).toBe("halted");
      expect(r.status.state_reason).toBe("PERP_POSITION_DETECTED");
      expect(r.state.halt?.reason).toBe("PERP_POSITION_DETECTED");
      expect(r.status.perp_check.ok).toBe(false);
      expect(hl.placed).toHaveLength(0);
      expect(hl.cancelled).toEqual([{ assetId: 10107, oid: 7 }]);
      expect(r.entries.some((e) => e.kind === "state" && e.detail.includes("ALARM"))).toBe(true);
    });
  }
  it("USDC in the perp account without positions or orders is a warning, not a halt", async () => {
    hl.perp.accountValueUsdc = "1451.04";
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("running");
    expect(r.state.halt).toBeNull();
    expect(r.status.perp_check.ok).toBe(true);
    expect(r.status.warnings.some((w) => w.includes("perp account holds 1451.04 USDC"))).toBe(true);
  });
  it("exactly 1 USDC of perp value is tolerated", async () => {
    hl.perp.accountValueUsdc = "1";
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("running");
  });
  it("the perp check happens before any write, even the dead-man refresh", async () => {
    hl.perp.openPerpOrders = 1;
    await tick(T0, active());
    expect(hl.calls).not.toContain("scheduleCancel");
    expect(hl.calls).not.toContain("placeSpotOrder");
  });
  it("never tries to cancel perp orders (no perp order path)", async () => {
    hl.perp.openPerpOrders = 2;
    hl.orders = [{ oid: 5, cloid: null, market: "perp", pair: "BTC", side: "buy", price: "1", size: "1", placedAtMs: T0 }];
    await tick(T0, active());
    expect(hl.cancelled).toEqual([]);
  });
  it("is sticky: stays halted after the perp is gone, until clearHalt", async () => {
    hl.perp.positions = [{ coin: "BTC", size: "1" }];
    let r = await tick(T0, active());
    hl.perp.positions = [];
    r = await tick(T0 + 60_000, active(), r.state);
    expect(r.tradingState).toBe("halted");
    expect(hl.placed).toHaveLength(0);
    r = await tick(T0 + 120_000, active(), clearHalt(r.state));
    expect(r.tradingState).toBe("running");
    expect(hl.placed).toHaveLength(1);
  });
  it("a halted engine keeps cancelling leftover spot orders every tick", async () => {
    const s = haltState(initialEngineState(), T0, "KILLED", "owner");
    hl.orders = [{ oid: 3, cloid: `${cloidPrefix(HASH)}0000000000000001`, market: "spot", pair: "HYPE/USDC", side: "sell", price: "50", size: "1", placedAtMs: T0 }];
    const r = await tick(T0, active(), s);
    expect(r.tradingState).toBe("halted");
    expect(r.status.state_reason).toBe("KILLED");
    expect(hl.cancelled).toHaveLength(1);
    expect(hl.placed).toHaveLength(0);
  });
  it("if the cancel fails while halted, falls back to the dead-man switch", async () => {
    hl.failCancel = true;
    hl.perp.openPerpOrders = 1;
    hl.orders = [{ oid: 3, cloid: `${cloidPrefix(HASH)}0000000000000001`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "1", placedAtMs: T0 }];
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("halted");
    expect(hl.scheduled).toEqual([T0 + 180_000]);
    expect(r.status.warnings).toContain("cancel failed");
  });
});

describe("on-chain status", () => {
  const cases: [string, Partial<VaultView>, string][] = [
    ["agent Paused", { status: "Paused" }, "AGENT_PAUSED"],
    ["agent Revoked", { status: "Revoked" }, "AGENT_REVOKED"],
    ["agent Expired", { status: "Expired" }, "AGENT_EXPIRED"],
    ["expiry timestamp passed", { expiresAtMs: T0 }, "AGENT_EXPIRED"],
    ["vault paused", { vaultPaused: true }, "VAULT_PAUSED"],
  ];
  for (const [name, patch, reason] of cases) {
    it(`${name}: cancels all orders and enters paused_onchain`, async () => {
      vault = () => Promise.resolve({ ...vaultOk, ...patch });
      hl.orders = [{ oid: 4, cloid: `${cloidPrefix(HASH)}0000000000000001`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "39", size: "0.3", placedAtMs: T0 }];
      const r = await tick(T0, active());
      expect(r.tradingState).toBe("paused_onchain");
      expect(r.status.state_reason).toBe(reason);
      expect(hl.placed).toHaveLength(0);
      expect(hl.cancelled).toEqual([{ assetId: 10107, oid: 4 }]);
    });
  }
  it("resume clears it", async () => {
    vault = () => Promise.resolve({ ...vaultOk, status: "Paused" });
    let r = await tick(T0, active());
    vault = () => Promise.resolve(vaultOk);
    r = await tick(T0 + 60_000, active(), r.state);
    expect(r.tradingState).toBe("running");
    expect(hl.placed).toHaveLength(1);
  });
  it("vault status unreadable: fail closed, no orders, no dead-man refresh", async () => {
    vault = () => Promise.reject(new Error("rpc down"));
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("VAULT_STATUS_UNAVAILABLE");
    expect(hl.placed).toHaveLength(0);
    expect(hl.calls).not.toContain("scheduleCancel");
  });
  it("vault unreadable does not stop a perp halt from being enforced", async () => {
    vault = () => Promise.reject(new Error("rpc down"));
    hl.perp.openPerpOrders = 1;
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("halted");
  });
  it("status exposes the vault numbers", async () => {
    const r = await tick(T0, active());
    expect(r.status.limits.vault).toMatchObject({ status: "Active", remaining_today_usdc: "50", per_tx_limit_usdc: "25", payments_today: 0, max_payments_per_day: 2, expires_at_ms: null });
  });
});

describe("other gates", () => {
  it("lists other approved API wallets in the status (audit M7), not our own", async () => {
    hl.agents = [...hl.agents, { address: "0x" + "ab".repeat(20), name: "old", validUntilMs: null }];
    const r = await tick(T0, active());
    expect(r.status.other_approved_agents).toEqual([{ address: "0x" + "ab".repeat(20), name: "old", valid_until_ms: null }]);
  });
  it("API wallet not approved", async () => {
    hl.agents = [];
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("awaiting_api_wallet");
    expect(r.status.api_wallet.approved).toBe(false);
    expect(hl.placed).toHaveLength(0);
    expect(hl.calls).not.toContain("scheduleCancel");
  });
  it("API wallet address match is case-insensitive", async () => {
    hl.agents = [{ address: API.toUpperCase().replace("0X", "0x"), name: null, validUntilMs: null }];
    expect((await tick(T0, active())).tradingState).toBe("running");
  });
  it("API wallet valid for 1 h or less is treated as expiring", async () => {
    hl.agents = [{ address: API, name: "n", validUntilMs: T0 + H }];
    let r = await tick(T0, active());
    expect(r.tradingState).toBe("awaiting_api_wallet");
    expect(r.status.state_reason).toBe("API_WALLET_EXPIRING");
    expect(r.status.api_wallet.valid_until_ms).toBe(T0 + H);
    hl.agents = [{ address: API, name: "n", validUntilMs: T0 + H + 1 }];
    r = await tick(T0, active());
    expect(r.tradingState).toBe("running");
  });
  it("no rules", async () => {
    const r = await tick(T0, null);
    expect(r.tradingState).toBe("no_rules");
    expect(hl.placed).toHaveLength(0);
  });
  it("stale mids (older than 2 ticks): no orders", async () => {
    hl.midsAtMs = T0 - 120_001;
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("STALE_DATA");
    expect(hl.placed).toHaveLength(0);
    hl.midsAtMs = T0 - 120_000;
    expect((await tick(T0, active())).tradingState).toBe("running");
  });
  it("scheduleCancel failure: no order is placed", async () => {
    hl.failSchedule = true;
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("SCHEDULE_CANCEL_FAILED");
    expect(hl.placed).toHaveLength(0);
  });
  it("HL read failure: error, no writes at all", async () => {
    hl.failReads = true;
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("HL_READ_FAILED");
    expect(hl.calls.filter((c) => ["placeSpotOrder", "cancelOrders", "scheduleCancel"].includes(c))).toEqual([]);
  });
  it("missing mid for the rule's pair: skipped, logged once", async () => {
    hl.mid = undefined;
    let r = await tick(T0, active());
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.filter((e) => e.kind === "skip")).toHaveLength(1);
    r = await tick(T0 + 60_000, active(), r.state);
    expect(r.entries.filter((e) => e.kind === "skip")).toHaveLength(0);
  });
});

describe("hard limits beat looser rule limits", () => {
  it("max order 20 applies even if the rule set says 500", async () => {
    const rules = active([buyRule("big", { action: { side: "buy", size: { usdc: "25" }, order: { type: "ioc" } } })], { max_order_usdc: "500" });
    const r = await tick(T0, rules);
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("MAX_ORDER");
  });
  it("rule limits tighter than hard are honoured", async () => {
    const r = await tick(T0, active([buyRule()], { max_order_usdc: "11" }));
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("MAX_ORDER");
  });
});

describe("risk rejections (reject, never resize)", () => {
  it("below 10 USDC notional", async () => {
    const r = await tick(T0, active([buyRule("small", { action: { side: "buy", size: { usdc: "10" }, order: { type: "ioc" } } })]));
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("MIN_NOTIONAL");
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toMatch(/coins at .*use at least \d+ USDC/);
    expect(r.state.firedAt.small).toBeUndefined(); // no attempt, no cooldown
    expect(r.state.ordersToday).toBe(0);
  });
  it("wide spread", async () => {
    hl.book = { bid: "38", ask: "42" };
    const r = await tick(T0, active());
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("SPREAD_TOO_WIDE");
  });
  it("empty book", async () => {
    hl.book = { bid: null, ask: "40" };
    const r = await tick(T0, active());
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("BOOK_EMPTY");
  });
  it("position cap counts open buy orders", async () => {
    hl.orders = [{ oid: 9, cloid: `${cloidPrefix(HASH)}0000000000000001`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "30", size: "1.3", placedAtMs: T0 }]; // 39 USDC open
    hl.balances = [{ coin: "USDC", total: "100", hold: "39" }];
    const r = await tick(T0, active());
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("POSITION_CAP");
  });
  it("position cap counts held base at mid", async () => {
    hl.balances = [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]; // 40 held + 11.7 > 50
    const r = await tick(T0, active());
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("POSITION_CAP");
    expect(r.status.limits.position_usdc).toBe("40");
    expect(r.status.balances.positions).toEqual([{ pair: "HYPE/USDC", base: "HYPE", size: "1", mid: "40", value_usdc: "40" }]);
  });
  it("insufficient USDC", async () => {
    hl.balances = [{ coin: "USDC", total: "5", hold: "0" }];
    const r = await tick(T0, active());
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("INSUFFICIENT_USDC");
  });
  it("sell with nothing to sell", async () => {
    const sell = buyRule("exit", { action: { side: "sell", size: { position_pct: "100" }, order: { type: "ioc" } } });
    const r = await tick(T0, active([sell]));
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("SIZE_ZERO");
  });
  it("sell 100% of the free base: price at the lower band edge, size rounded down", async () => {
    hl.balances = [{ coin: "USDC", total: "10", hold: "0" }, { coin: "HYPE", total: "0.499", hold: "0" }];
    const sell = buyRule("exit", { action: { side: "sell", size: { position_pct: "100" }, order: { type: "ioc" } } });
    await tick(T0, active([sell]));
    expect(hl.placed[0]).toMatchObject({ isBuy: false, size: "0.49", price: "39.6", tif: "Ioc" });
  });
  it("max orders per day, then a new UTC day resets it", async () => {
    const rs = active([buyRule("r", { cooldown: "15m" })], { max_orders_per_day: 2 });
    let r = await tick(T0, rs);
    r = await tick(T0 + 20 * 60_000, rs, r.state);
    r = await tick(T0 + 40 * 60_000, rs, r.state);
    expect(hl.placed).toHaveLength(2);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("MAX_ORDERS_PER_DAY");
    // next day, same state
    const next = Date.UTC(2026, 10, 6, 0, 5, 0);
    r = await tick(next, rs, r.state);
    expect(hl.placed).toHaveLength(3);
    expect(r.state.ordersToday).toBe(1);
  });
  it("identical skips are logged once, then again after the reason changes", async () => {
    hl.book = { bid: "38", ask: "42" };
    let r = await tick(T0, active());
    r = await tick(T0 + 60_000, active(), r.state);
    expect(r.entries.filter((e) => e.kind === "skip")).toHaveLength(0);
    hl.book = { bid: null, ask: null };
    r = await tick(T0 + 120_000, active(), r.state);
    expect(r.entries.filter((e) => e.kind === "skip")).toHaveLength(1);
  });
  it("at most 2 orders per tick and 1 per rule", async () => {
    const rs = active([buyRule("a"), buyRule("b"), buyRule("c")], { max_position_usdc: "50" });
    hl.balances = [{ coin: "USDC", total: "500", hold: "0" }];
    const r = await tick(T0, rs);
    expect(hl.placed).toHaveLength(2);
    expect(Object.keys(r.state.firedAt).sort()).toEqual(["a", "b"]);
    // c fires on the next tick
    await tick(T0 + 60_000, rs, r.state);
    expect(hl.placed).toHaveLength(3);
  });
  it("two orders in one tick cannot together exceed the position cap", async () => {
    // each ~11.7 USDC; cap 20 -> the second is rejected
    const rs = active([buyRule("a"), buyRule("b")], { max_position_usdc: "20" });
    const r = await tick(T0, rs);
    expect(hl.placed).toHaveLength(1);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("POSITION_CAP");
  });
  it("two orders in one tick cannot together overspend free USDC", async () => {
    hl.balances = [{ coin: "USDC", total: "20", hold: "0" }];
    const r = await tick(T0, active([buyRule("a"), buyRule("b")]));
    expect(hl.placed).toHaveLength(1);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("INSUFFICIENT_USDC");
  });
  it("a perp-looking pair (asset id below 10000) is refused even if every allowlist says yes", async () => {
    hl.pairs = [{ name: "HYPE/USDC", base: "HYPE", assetId: 159, szDecimals: 2, volume24hUsdc: "5000000", midUsdc: "40" }];
    const r = await tick(T0, active());
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("SPOT_ONLY");
  });
  it("a pair outside TRADING_ALLOWED_PAIRS is refused", async () => {
    const rs = active([buyRule("x", { pair: "PURR/USDC" })]);
    rs.rules.pairs = ["PURR/USDC"];
    hl.pairs.push({ name: "PURR/USDC", base: "PURR", assetId: 10001, szDecimals: 2, volume24hUsdc: "5000000", midUsdc: "1" });
    hl.mid = "40";
    const orig = hl.getMids.bind(hl);
    hl.getMids = async () => ({ ...(await orig()), mids: { "HYPE/USDC": "40", "PURR/USDC": "40" } });
    const r = await tick(T0, rs);
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("PAIR_NOT_ALLOWED");
  });
});

describe("triggers inside the tick", () => {
  it("price trigger false: nothing happens, nothing logged", async () => {
    const r = await tick(T0, active([buyRule("x", { when: { type: "price", op: "lte", usdc: "30" } })]));
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.filter((e) => e.kind === "skip")).toHaveLength(0);
  });
  it("price_change from candles", async () => {
    hl.candles = [{ openTimeMs: T0 - 24 * H - H, closeTimeMs: T0 - 24 * H - 1, open: "42", close: "42" }];
    const rule = buyRule("chg", { when: { type: "price_change", window: "1d", op: "lte", pct: "-3" } });
    await tick(T0, active([rule]));
    expect(hl.placed).toHaveLength(1);
  });
  it("candles are only fetched for price_change rules", async () => {
    await tick(T0, active());
    expect(hl.calls).not.toContain("getCandles");
  });
  it("position_pnl uses fills of this rule set only and is false when flat", async () => {
    const rule = buyRule("tp", {
      when: { type: "position_pnl", op: "gte", pct: "10" },
      action: { side: "sell", size: { position_pct: "100" }, order: { type: "ioc" } },
    });
    hl.balances = [{ coin: "USDC", total: "10", hold: "0" }, { coin: "HYPE", total: "0.5", hold: "0" }];
    await tick(T0, active([rule]));
    expect(hl.placed).toHaveLength(0); // flat under this rule set
    hl.fills = [{ oid: 1, cloid: `${cloidPrefix(HASH)}0000000000000001`, pair: "HYPE/USDC", side: "buy", price: "30", size: "0.5", feeUsdc: "0", timeMs: T0 - 1000 }];
    await tick(T0 + 60_000, active([rule]));
    expect(hl.placed).toHaveLength(1); // 40 vs 30 = +33%
  });
  it("a throwing trigger is skipped, other rules still run", async () => {
    hl.getCandles = () => Promise.reject(new Error("candles down"));
    const rs = active([buyRule("chg", { when: { type: "price_change", window: "1d", op: "lte", pct: "-3" } }), buyRule("ok")]);
    const r = await tick(T0, rs);
    expect(hl.placed).toHaveLength(1);
    expect(r.entries.find((e) => e.rule_id === "chg")?.detail).toContain("TRIGGER_ERROR");
  });
});

describe("limit orders and ttl", () => {
  const limitRule = (): Rule =>
    buyRule("lim", { action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "1", ttl: "15m" } } });

  it("places GTC below mid and cancels it after the ttl", async () => {
    let r = await tick(T0, active([limitRule()]));
    expect(hl.placed[0]).toMatchObject({ tif: "Gtc", price: "39.6" });
    const cloid = hl.placed[0]?.cloid ?? "";
    expect(r.state.orders[cloid]).toEqual({ ruleId: "lim", expiresAtMs: T0 + 15 * 60_000 });
    r = await tick(T0 + 14 * 60_000, active([limitRule()]), r.state);
    expect(hl.cancelled).toHaveLength(0);
    expect(r.status.open_orders[0]).toMatchObject({ cloid, rule_id: "lim", side: "buy", price: "39.6" });
    r = await tick(T0 + 15 * 60_000, active([limitRule()]), r.state);
    expect(hl.cancelled).toHaveLength(1);
    expect(r.state.orders).toEqual({});
    expect(r.entries.some((e) => e.kind === "cancel")).toBe(true);
  });
  it("a resting order prevents the same cooldown-free overbuy via the position cap", async () => {
    const rule = buyRule("lim", { cooldown: "15m", action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "1", ttl: "1d" } } });
    const rs = active([rule], { max_position_usdc: "30" });
    hl.balances = [{ coin: "USDC", total: "100", hold: "0" }];
    let r = await tick(T0, rs);
    hl.balances = [{ coin: "USDC", total: "100", hold: "11.88" }];
    r = await tick(T0 + 16 * 60_000, rs, r.state);
    hl.balances = [{ coin: "USDC", total: "100", hold: "23.76" }];
    r = await tick(T0 + 32 * 60_000, rs, r.state);
    expect(hl.placed).toHaveLength(2); // 11.9 + 11.9 + 11.9 > 30
    expect(r.entries.find((e) => e.kind === "skip")?.detail).toContain("POSITION_CAP");
  });
  it("orders of a previous rule set are cancelled when a new one is active", async () => {
    let r = await tick(T0, active([limitRule()]));
    expect(hl.orders).toHaveLength(1);
    const other = "cd".repeat(32);
    r = await tick(T0 + 60_000, active([limitRule()], {}, other), r.state);
    expect(hl.cancelled).toHaveLength(1);
    expect(r.state.rulesHash).toBe(other);
    expect(r.state.firedAt.lim).toBe(T0 + 60_000); // old cooldown reset, rule fired under the new set
    expect(hl.placed[1]?.cloid.startsWith(cloidPrefix(other))).toBe(true);
  });
  it("hand-placed orders (no cloid) are left alone", async () => {
    hl.orders = [{ oid: 99, cloid: null, market: "spot", pair: "HYPE/USDC", side: "sell", price: "99", size: "1", placedAtMs: T0 }];
    const r = await tick(T0, active());
    expect(hl.cancelled).toEqual([]);
    expect(r.status.warnings.some((w) => w.includes("without cloid"))).toBe(true);
    expect(r.status.open_orders).toEqual([]);
  });
});

describe("state log", () => {
  it("logs a state entry only when the state or reason changes", async () => {
    let r = await tick(T0, null);
    expect(r.entries.filter((e) => e.kind === "state" && e.detail === "no_rules")).toHaveLength(1);
    for (let k = 1; k <= 3; k++) r = await tick(T0 + k * 60_000, null, r.state);
    expect(r.entries.filter((e) => e.kind === "state")).toHaveLength(0);
    expect(r.state.recent.filter((e) => e.kind === "state" && e.detail === "no_rules")).toHaveLength(1);
    expect(r.state.lastStateRepeats).toBe(3);
    // a different reason is logged again
    hl.agents = [];
    r = await tick(T0 + 5 * 60_000, null, r.state);
    expect(r.entries.filter((e) => e.kind === "state").map((e) => e.detail)).toEqual(["awaiting_api_wallet: API_WALLET_NOT_APPROVED"]);
    // and so is returning to the earlier state
    hl.agents = [{ address: API, name: "agent-treasury valid_until", validUntilMs: null }];
    r = await tick(T0 + 6 * 60_000, null, r.state);
    expect(r.entries.filter((e) => e.kind === "state").map((e) => e.detail)).toEqual(["no_rules"]);
  });
});

describe("loss stop and day rollover", () => {
  const rs = () => active([buyRule("r", { cooldown: "15m" })], { daily_loss_stop_usdc: "5" });
  /** A rule set whose rule never fires: the first tick places nothing. */
  const quiet = () => active([buyRule("r", { when: { type: "price", op: "lte", usdc: "1" } })], { daily_loss_stop_usdc: "5" });
  /** A bot fill (cloid of the active rule set). */
  const botFill = (timeMs: number, side: "buy" | "sell", price: string, size: string, feeUsdc = "0", cloid: string | null = `${cloidPrefix(HASH)}0000000000000001`): HlFill => ({
    oid: 1,
    cloid,
    pair: "HYPE/USDC",
    side,
    price,
    size,
    feeUsdc,
    timeMs,
  });
  /** The bot bought 1 HYPE at 40 shortly after the snapshot; the price is now `mid`. */
  const holdOneAt = (mid: string, cash = "60", at = T0 + 1000) => {
    hl.fills = [botFill(at, "buy", "40", "1")];
    hl.balances = [{ coin: "USDC", total: cash, hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }];
    hl.mid = mid;
  };

  it("takes a start-of-day snapshot on the first fresh tick", async () => {
    const r = await tick(T0, rs());
    expect(r.state.day).toEqual({ dayIndex: Math.floor(T0 / DAY_MS), startEquity: "100", snapshotAtMs: T0, startPositions: {}, startBackstop: "100", balanceAtMs: T0 });
    expect(r.status.pnl).toEqual({
      today_usdc: "0",
      total_usdc: "0",
      net_funded_usdc: "0",
      day_start_equity_usdc: "100",
      funded_by_vault_usdc: "0",
      external_inflow_usdc: "0",
      external_outflow_usdc: "0",
      fees_usdc: "0",
      untracked_delta_usdc: "100",
    });
  });

  it("stops when the bot's position loses the stop amount (unrealized included), cancels everything, places nothing", async () => {
    let r = await tick(T0, rs());
    holdOneAt("35"); // bought at 40, now 35 -> -5
    hl.orders = [{ oid: 4, cloid: `${cloidPrefix(HASH)}0000000000000001`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "34", size: "0.3", placedAtMs: T0 }];
    const before = hl.placed.length;
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.state_reason).toBe("DAILY_LOSS_STOP");
    expect(hl.placed.length).toBe(before);
    expect(hl.cancelled).toHaveLength(1);
    expect(r.status.limits.today.loss_usdc).toBe("5");
    expect(r.status.pnl.today_usdc).toBe("-5");
    expect(r.state.stoppedDayIndex).toBe(Math.floor(T0 / DAY_MS));
  });

  it("fees of the bot's fills count as loss", async () => {
    let r = await tick(T0, rs());
    hl.fills = [botFill(T0 + 1000, "buy", "40", "1", "5")];
    hl.balances = [{ coin: "USDC", total: "55", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }];
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.pnl.fees_usdc).toBe("5");
  });

  it("just under the stop keeps trading", async () => {
    let r = await tick(T0, rs());
    holdOneAt("35.01");
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("running");
  });

  it("a balance drop without bot fills (activation fee, manual withdrawal) is NOT a trading loss", async () => {
    let r = await tick(T0, rs());
    hl.balances = [{ coin: "USDC", total: "89", hold: "0" }]; // -11, more than the hard stop of 10
    hl.ledger = [{ timeMs: T0 + 60_000, kind: "withdraw", usdc: "10" }];
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("running");
    expect(r.status.limits.today.loss_usdc).toBe("0");
    expect(r.status.pnl.external_outflow_usdc).toBe("10");
    expect(r.status.warnings.some((w) => w.includes("left the account today outside the bot"))).toBe(true);
  });

  it("fills of manual orders (no cloid or a foreign cloid) are ignored by the P&L stop and warned about", async () => {
    let r = await tick(T0, rs());
    hl.fills = [
      ...hl.fills,
      { ...botFill(T0 + 1000, "buy", "40", "1", "0", null), oid: 91, tid: 91 },
      { ...botFill(T0 + 1000, "buy", "40", "1", "0", "0x" + "11".repeat(16)), oid: 92, tid: 92 },
    ];
    hl.balances = [{ coin: "USDC", total: "20", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }]; // 20 + 2*40 = 100: no value lost
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("running");
    expect(r.status.limits.today.loss_usdc).toBe("0");
    expect(r.status.warnings.some((w) => w.includes("2 spot fill(s) since start are not from the bot"))).toBe(true);
  });

  it("T10: a wash trade with a foreign cloid that loses value is caught by the equity backstop (EQUITY_DROP)", async () => {
    let r = await tick(T0, quiet());
    hl.fills = [...hl.fills, { ...botFill(T0 + 1000, "buy", "40", "1", "0", "0x" + "11".repeat(16)), oid: 91, tid: 91 }];
    hl.balances = [{ coin: "USDC", total: "20", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }];
    hl.mid = "10"; // 20 + 2*10 = 40: equity down 60, no flow explains it
    r = await tick(T0 + 20 * 60_000, quiet(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.state_reason).toBe("EQUITY_DROP");
    expect(r.state.stopReason).toBe("EQUITY_DROP");
    // sticky for the day, with the same reason
    hl.mid = "40";
    hl.balances = [{ coin: "USDC", total: "100", hold: "0" }];
    r = await tick(T0 + 40 * 60_000, quiet(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.state_reason).toBe("EQUITY_DROP");
  });

  it("stays stopped for the rest of the UTC day, even after the price recovers", async () => {
    let r = await tick(T0, rs());
    holdOneAt("34");
    r = await tick(T0 + 60_000, rs(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    hl.mid = "60";
    r = await tick(T0 + 11 * H, rs(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(hl.placed).toHaveLength(1); // only the very first order of the first tick
  });

  it("a top-up the same day neither triggers nor hides the stop", async () => {
    let r = await tick(T0, quiet());
    // top-up of 20 lands, bot is flat: equity 120 -> no loss
    hl.balances = [{ coin: "USDC", total: "120", hold: "0" }];
    hl.ledger = [{ timeMs: T0 + 60_000, kind: "deposit", usdc: "20" }];
    r = await tick(T0 + 20 * 60_000, quiet(), r.state);
    expect(r.tradingState).toBe("running");
    expect(r.status.limits.today.loss_usdc).toBe("0");
    expect(r.status.pnl.net_funded_usdc).toBe("20");
    expect(r.status.pnl.external_inflow_usdc).toBe("20");
    // the bot then loses 7 on a position: stop, although equity (113 + ...) is above the start
    holdOneAt("33", "100", T0 + 30 * 60_000);
    r = await tick(T0 + 40 * 60_000, quiet(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    expect(r.status.limits.today.loss_usdc).toBe("7");
  });

  it("a confirmed vault top-up is reported as funded by the vault", async () => {
    hl.ledger = [{ timeMs: T0 + 60_000, kind: "deposit", usdc: "19.97" }];
    const state = (await tick(T0, rs())).state;
    hl.now = T0 + 120_000;
    const r = await runTick({ hl, vault, config: cfg, vaultTopups: () => [{ atMs: T0 + 30_000, amountUsdc: "20" }] }, { nowMs: T0 + 120_000, rules: rs(), state });
    expect(r.status.pnl.funded_by_vault_usdc).toBe("19.97");
    expect(r.status.pnl.external_inflow_usdc).toBe("0");
  });

  it("the stop is the tighter of rule and hard limit", async () => {
    const loose = active([buyRule("r")], { daily_loss_stop_usdc: "500" });
    let r = await tick(T0, loose);
    holdOneAt("29"); // -11 >= hard 10
    r = await tick(T0 + 60_000, loose, r.state);
    expect(r.tradingState).toBe("stopped_today");
  });

  it("UTC rollover clears stopped_today and resets the counters and the snapshot", async () => {
    const lateDay = Date.UTC(2026, 10, 5, 23, 50, 0);
    let r = await tick(lateDay - H, rs());
    hl.fills = [botFill(lateDay - H + 1000, "buy", "40", "1")];
    hl.balances = [{ coin: "USDC", total: "60", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }];
    hl.mid = "34";
    r = await tick(lateDay, rs(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    const midnight = Date.UTC(2026, 10, 6, 0, 0, 0);
    r = await tick(midnight - 1, rs(), r.state);
    expect(r.tradingState).toBe("stopped_today");
    r = await tick(midnight, rs(), r.state);
    expect(r.tradingState).toBe("running");
    expect(r.state.stoppedDayIndex).toBeNull();
    expect(r.state.day).toEqual({
      dayIndex: Math.floor(midnight / DAY_MS),
      startEquity: "94",
      snapshotAtMs: midnight,
      startPositions: { "HYPE/USDC": { size: "1", mid: "34" } },
      startBackstop: "94",
      balanceAtMs: midnight,
    });
    expect(r.state.ordersToday).toBe(1);
    expect(r.status.pnl.today_usdc).toBe("0");
  });

  it("no day rollover is recorded from stale data", async () => {
    hl.midsAtMs = T0 - 10 * 60_000;
    const r = await tick(T0, rs());
    expect(r.state.day).toBeNull();
  });
});

describe("log", () => {
  it("state.recent is bounded", async () => {
    let s = initialEngineState();
    for (let i = 0; i < MAX_RECENT + 30; i++) {
      hl.mid = undefined; // every tick: no_market skip is deduped, so force varying entries via state change
      s = { ...(await tick(T0 + i * 60_000, active(), s)).state, lastSkip: {} };
    }
    expect(s.recent.length).toBe(MAX_RECENT);
  });
  it("order entries carry rule id, cloid and oid", async () => {
    const r = await tick(T0, active());
    const e = r.entries.find((x) => x.kind === "order");
    expect(e).toMatchObject({ rule_id: "dip", oid: 1 });
    expect(e?.cloid).toBe(hl.placed[0]?.cloid);
    expect(r.state.recent).toEqual(expect.arrayContaining(r.entries));
  });
});


describe("fills window, unpriced coins and attribution (review 2026-11-03)", () => {
  const rs = () => active([buyRule("r", { cooldown: "15m" })], { daily_loss_stop_usdc: "5" });
  const quiet = () => active([buyRule("r", { when: { type: "price", op: "lte", usdc: "1" } })], { daily_loss_stop_usdc: "5" });
  const holding = (): HlSpotBalance[] => [{ coin: "USDC", total: "60", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }];
  const botFill = (timeMs: number, extra: Partial<HlFill> = {}): HlFill => ({
    oid: 1,
    tid: 500 + timeMs,
    cloid: `${cloidPrefix(HASH)}0000000000000001`,
    pair: "HYPE/USDC",
    side: "buy",
    price: "40",
    size: "1",
    feeUsdc: "0",
    timeMs,
    ...extra,
  });

  it("fails closed with FILLS_TRUNCATED and does not move the cursor", async () => {
    hl.fillsError = () => new FillsTruncatedError("10000 rows");
    const r = await tick(T0, rs());
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("FILLS_TRUNCATED");
    expect(hl.placed).toHaveLength(0);
    expect(r.state.fills).toBeNull();
  });

  it("when the long history is truncated, falls back to today's window and marks the total partial", async () => {
    hl.fillsError = (start) => (start < T0 ? new FillsTruncatedError("history") : null);
    const r = await tick(T0, rs());
    expect(r.tradingState).toBe("running");
    expect(r.state.fills?.totalComplete).toBe(false);
    expect(r.status.warnings.some((w) => w.includes("pnl.total is partial"))).toBe(true);
  });

  it("reads only past the persisted cursor after the first tick (no re-reading of history)", async () => {
    let r = await tick(T0, quiet());
    hl.fills = [botFill(T0 + 5_000)];
    r = await tick(T0 + 60_000, quiet(), r.state);
    r = await tick(T0 + 120_000, quiet(), r.state);
    expect(hl.fillsFrom[0]).toBeLessThan(T0);
    expect(hl.fillsFrom[1]).toBe(T0 - 10 * DAY_MS - 120_000); // cursor stays at the initial window start until a fill moves it
    expect(hl.fillsFrom[2]).toBe(T0 + 5_000 - 120_000); // then the cursor is the latest FILL time (HL clock), not the local now
    expect(r.state.fills?.total["HYPE/USDC"]?.dq).toBe("1");
  });

  it("a held coin without a mid: no orders (NO_MID_FOR_POSITION), loss valued at 0, not at the start mid", async () => {
    hl.balances = holding();
    let r = await tick(T0, quiet());
    expect(r.state.day?.startPositions).toEqual({ "HYPE/USDC": { size: "1", mid: "40" } });
    hl.mid = undefined;
    r = await tick(T0 + 60_000, rs(), r.state);
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("NO_MID_FOR_POSITION");
    expect(hl.placed).toHaveLength(0);
    expect(r.status.limits.today.loss_usdc).toBe("40");
  });

  it("freshness is checked per pair: a stale mid of a held pair blocks trading although the snapshot is fresh", async () => {
    hl.balances = holding();
    let r = await tick(T0, quiet());
    hl.pairAtMs = { "HYPE/USDC": T0 - H };
    r = await tick(T0 + 60_000, rs(), r.state);
    expect(r.status.state_reason).toBe("NO_MID_FOR_POSITION");
    expect(hl.placed).toHaveLength(0);
  });

  it("does not roll the UTC day while a held coin has no mid (the snapshot would drop it)", async () => {
    hl.balances = holding();
    let r = await tick(T0, quiet());
    const next = Date.UTC(2026, 10, 6, 0, 5, 0);
    hl.mid = undefined;
    r = await tick(next, rs(), r.state);
    expect(r.state.day?.dayIndex).toBe(Math.floor(T0 / DAY_MS));
    expect(r.status.state_reason).toBe("NO_DAY_SNAPSHOT");
    expect(hl.placed).toHaveLength(0);
    hl.mid = "40";
    r = await tick(next + 60_000, quiet(), r.state);
    expect(r.state.day?.dayIndex).toBe(Math.floor(next / DAY_MS));
    expect(r.state.day?.startPositions).toEqual({ "HYPE/USDC": { size: "1", mid: "40" } });
  });

  it("matches fills on the oid of the bot's own order when the cloid is missing", async () => {
    let r = await tick(T0, rs());
    const oid = r.state.botOids[0];
    expect(oid).toBeDefined();
    hl.fills = [botFill(T0 + 1000, { cloid: null, oid: oid ?? 0, size: "0.29", price: "40" })];
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("running");
    expect(r.state.fills?.botFillsToday).toBe(1);
  });

  it("alarms and stops placing when the bot's filled order leaves no attributable fill", async () => {
    hl.autoFills = false;
    let r = await tick(T0, rs());
    expect(hl.placed).toHaveLength(1);
    expect(r.state.filledOrdersToday).toBe(1);
    r = await tick(T0 + 20 * 60_000, rs(), r.state);
    expect(r.tradingState).toBe("error");
    expect(r.status.state_reason).toBe("FILLS_NOT_ATTRIBUTED");
    expect(hl.placed).toHaveLength(1);
  });

  it("a day snapshot from before position tracking plus a held coin: NO_DAY_SNAPSHOT until the next rollover", async () => {
    let r = await tick(T0, quiet());
    const legacy: EngineState = { ...r.state, day: { dayIndex: r.state.day?.dayIndex ?? 0, startEquity: "100", snapshotAtMs: T0 } };
    hl.balances = holding();
    r = await tick(T0 + 60_000, rs(), legacy);
    expect(r.status.state_reason).toBe("NO_DAY_SNAPSHOT");
    expect(hl.placed).toHaveLength(0);
    // no coin held: the legacy snapshot is harmless
    hl.balances = [{ coin: "USDC", total: "100", hold: "0" }];
    r = await tick(T0 + 120_000, quiet(), legacy);
    expect(r.tradingState).toBe("running");
    // next UTC day: a fresh snapshot with startPositions
    hl.balances = holding();
    r = await tick(Date.UTC(2026, 10, 6, 0, 1, 0), rs(), legacy);
    expect(r.state.day?.startPositions).toEqual({ "HYPE/USDC": { size: "1", mid: "40" } });
  });

  it("seeds botPrefixes from rulesHash and resting-order cloids on upgrade", async () => {
    const oldHash = "cd".repeat(32);
    const third = "0x" + "ee".repeat(8);
    const legacyState: EngineState = {
      ...initialEngineState(),
      rulesHash: oldHash,
      botPrefixes: [],
      orders: { [`${third}0000000000000009`]: { ruleId: "x", expiresAtMs: null } },
    };
    const r = await tick(T0, quiet(), legacyState);
    expect(r.state.botPrefixes).toEqual(expect.arrayContaining([cloidPrefix(oldHash), third, cloidPrefix(HASH)]));
  });

  it("warns when more than 64 prefixes were remembered and the oldest were dropped", async () => {
    const many = Array.from({ length: 64 }, (_, i) => "0x" + i.toString(16).padStart(16, "0"));
    const r = await tick(T0, quiet(), { ...initialEngineState(), botPrefixes: many });
    expect(r.state.botPrefixes).toHaveLength(64);
    expect(r.state.prefixesDropped).toBe(1);
    expect(r.status.warnings.some((w) => w.includes("old rule-set prefix"))).toBe(true);
  });

  it("the state log repeats its entry on a new UTC day and /status exposes the repeat count", async () => {
    hl.perp = { positions: [], openPerpOrders: 0, accountValueUsdc: "0" };
    hl.agents = []; // awaiting_api_wallet
    let r = await tick(T0, quiet());
    r = await tick(T0 + 60_000, quiet(), r.state);
    r = await tick(T0 + 120_000, quiet(), r.state);
    expect(r.status.state_repeats).toBe(2);
    const count = (st: EngineState) => st.recent.filter((e) => e.kind === "state" && e.detail.startsWith("awaiting_api_wallet")).length;
    expect(count(r.state)).toBe(1);
    r = await tick(Date.UTC(2026, 10, 6, 0, 1, 0), quiet(), r.state);
    expect(count(r.state)).toBe(2);
  });

  it("excuses the one-time 1 USDC activation fee on the first day only", async () => {
    // funded 1000, fee 1: equity 999. The stop is 5, so make it tight: stop 1.
    hl.balances = [{ coin: "USDC", total: "999", hold: "0" }];
    hl.ledger = [{ timeMs: T0 - 1000, kind: "deposit", usdc: "1000" }];
    const tight = active([buyRule("r", { when: { type: "price", op: "lte", usdc: "1" } })], { daily_loss_stop_usdc: "1" });
    const r = await runTick({ hl, vault, config: { ...cfg, fundedSinceMs: T0 - 2000 } }, { nowMs: T0, rules: tight, state: initialEngineState() });
    expect(r.tradingState).toBe("running");
  });
});

describe("dead-man volume gate (HL refuses scheduleCancel under $1M volume), 2026-11-03", () => {
  const GATE = new Error("Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.");
  const limitRule = (): Rule => buyRule("lim", { action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "0.5", ttl: "1h" } } });

  it("keeps trading with IOC orders only and reports dead_man.available=false", async () => {
    hl.scheduleError = GATE;
    const r = await tick(T0, active());
    expect(r.tradingState).toBe("running");
    expect(hl.placed).toHaveLength(1);
    expect(hl.placed[0]?.tif).toBe("Ioc");
    expect(r.status.dead_man).toEqual({ cancel_at_ms: null, available: false, reason: "DEADMAN_VOLUME_GATED" });
    expect(r.status.warnings.some((w) => w.startsWith("DEADMAN_VOLUME_GATED"))).toBe(true);
    expect(r.status.warnings).not.toContain("scheduleCancel failed");
    expect(r.state.deadManGatedAtMs).toBe(T0);
  });

  it("a rule that would rest is rejected by the guard with LIMIT_NEEDS_DEADMAN", async () => {
    hl.scheduleError = GATE;
    const r = await tick(T0, active([limitRule()]));
    expect(hl.placed).toHaveLength(0);
    expect(r.entries.some((e) => e.kind === "skip" && e.detail.startsWith("LIMIT_NEEDS_DEADMAN"))).toBe(true);
  });

  it("cancels bot orders that already rest", async () => {
    hl.scheduleError = GATE;
    const cloid = `${cloidPrefix(HASH)}0000000000000007`;
    hl.orders = [{ oid: 9, cloid, market: "spot", pair: "HYPE/USDC", side: "buy", price: "39", size: "0.3", placedAtMs: T0 - 1000 }];
    await tick(T0, active([buyRule("dip", { when: { type: "price", op: "lte", usdc: "1" } })]), { ...initialEngineState(), orders: { [cloid]: { ruleId: "dip", expiresAtMs: null } } });
    expect(hl.cancelled).toEqual([{ assetId: 10107, oid: 9 }]);
  });

  it("re-tries scheduleCancel at most once per hour and switches back when HL accepts it", async () => {
    hl.scheduleError = GATE;
    let r = await tick(T0, active());
    const tried = () => hl.calls.filter((c) => c === "scheduleCancel").length;
    expect(tried()).toBe(1);
    r = await tick(T0 + 60_000, active(), r.state);
    r = await tick(T0 + 30 * 60_000, active(), r.state);
    expect(tried()).toBe(1);
    r = await tick(T0 + H, active(), r.state); // still gated: one more attempt, timer restarts
    expect(tried()).toBe(2);
    expect(r.state.deadManGatedAtMs).toBe(T0 + H);
    r = await tick(T0 + H + 60_000, active(), r.state);
    expect(tried()).toBe(2);
    hl.scheduleError = null;
    r = await tick(T0 + 2 * H, active(), r.state);
    expect(tried()).toBe(3);
    expect(r.state.deadManGatedAtMs).toBeNull();
    expect(r.status.dead_man.available).toBe(true);
    expect(r.status.dead_man.cancel_at_ms).toBe(T0 + 2 * H + 180_000);
  });

  it("with the switch working a limit rule rests as before", async () => {
    const r = await tick(T0, active([limitRule()]));
    expect(hl.placed[0]?.tif).toBe("Gtc");
    expect(r.status.dead_man.available).toBe(true);
  });

  it("any other scheduleCancel error still blocks trading", async () => {
    hl.scheduleError = new Error("Too many requests");
    const r = await tick(T0, active());
    expect(r.status.state_reason).toBe("SCHEDULE_CANCEL_FAILED");
    expect(hl.placed).toHaveLength(0);
    expect(r.state.deadManGatedAtMs).toBeNull();
  });
});

describe("re-review fixes 2026-11-03 (loss stop only errs toward stopping)", () => {
  const rs = () => active([buyRule("r", { cooldown: "15m" })], { daily_loss_stop_usdc: "5" });
  const quiet = () => active([buyRule("r", { when: { type: "price", op: "lte", usdc: "1" } })], { daily_loss_stop_usdc: "5" });
  const botFill = (timeMs: number, extra: Partial<HlFill> = {}): HlFill => ({
    oid: 1,
    tid: 500 + timeMs,
    cloid: `${cloidPrefix(HASH)}0000000000000001`,
    pair: "HYPE/USDC",
    side: "buy",
    price: "40",
    size: "1",
    feeUsdc: "0",
    timeMs,
    ...extra,
  });

  describe("B1 equity backstop ignores coins outside the allowed pairs", () => {
    it("a foreign buy of a junk coin at an inflated mid still shows as EQUITY_DROP", async () => {
      let r = await tick(T0, quiet());
      expect(r.state.day?.startBackstop).toBe("100");
      // 20 USDC spent on 1000 JUNK that HL prices at 0.05 -> all-coin equity 130 (up), backstop equity 80
      hl.balances = [{ coin: "USDC", total: "80", hold: "0" }, { coin: "JUNK", total: "1000", hold: "0" }];
      hl.extraMids = { "JUNK/USDC": "0.05" };
      r = await tick(T0 + 60_000, quiet(), r.state);
      expect(r.tradingState).toBe("stopped_today");
      expect(r.status.state_reason).toBe("EQUITY_DROP");
      expect(r.status.balances.equity_usdc).toBe("130");
      expect(hl.placed).toHaveLength(0);
    });
    it("the same junk coin received as a gift (no USDC change) neither stops nor hides anything", async () => {
      let r = await tick(T0, quiet());
      hl.balances = [{ coin: "USDC", total: "100", hold: "0" }, { coin: "JUNK", total: "1000", hold: "0" }];
      hl.extraMids = { "JUNK/USDC": "0.05" };
      r = await tick(T0 + 60_000, quiet(), r.state);
      expect(r.tradingState).toBe("running");
    });
    it("a pump of a coin held at the snapshot cannot hide a loss elsewhere (gains on the start holding are clipped)", async () => {
      hl.balances = [{ coin: "USDC", total: "60", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }];
      let r = await tick(T0, quiet());
      expect(r.state.day?.startBackstop).toBe("100");
      // HYPE 40 -> 50 (+10) while 6 USDC vanished into a junk buy: all-coin equity 104 would look fine
      hl.mid = "50";
      hl.balances = [{ coin: "USDC", total: "54", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }];
      r = await tick(T0 + 60_000, quiet(), r.state);
      expect(r.status.balances.equity_usdc).toBe("104");
      expect(r.status.state_reason).toBe("EQUITY_DROP");
    });
    it("a legacy snapshot without startBackstop falls back to the all-coin start equity", async () => {
      let r = await tick(T0, quiet());
      const legacy: EngineState = { ...r.state, day: { dayIndex: r.state.day?.dayIndex ?? 0, startEquity: "100", snapshotAtMs: T0, startPositions: {} } };
      hl.balances = [{ coin: "USDC", total: "90", hold: "0" }];
      r = await tick(T0 + 60_000, quiet(), legacy);
      expect(r.status.state_reason).toBe("EQUITY_DROP");
    });
  });

  describe("H1 the fill cursor follows HL's clock", () => {
    it("a late-indexed fill older than the local read time is still picked up", async () => {
      let r = await tick(T0, quiet());
      r = await tick(T0 + 30 * 60_000, quiet(), r.state); // half an hour with no fill: the cursor must not run to the local now
      hl.fills = [botFill(T0 + 10_000)];
      r = await tick(T0 + 31 * 60_000, quiet(), r.state);
      expect(r.state.fills?.total["HYPE/USDC"]?.dq).toBe("1");
      expect(r.state.fills?.cursorMs).toBe(T0 + 10_000);
    });
    it("warns when fill timestamps run ahead of the local clock", async () => {
      hl.fills = [botFill(T0 + 10 * 60_000)];
      const r = await tick(T0, quiet());
      expect(r.status.warnings.some((w) => w.includes("ahead of the local clock"))).toBe(true);
      expect(r.state.fills?.cursorMs).toBe(T0 + 10 * 60_000);
    });
  });

  describe("H4 position_pnl cost basis comes from the incremental tracker", () => {
    const tp = (): Rule =>
      buyRule("tp", { when: { type: "position_pnl", op: "gte", pct: "10" }, action: { side: "sell", size: { position_pct: "100" }, order: { type: "ioc" } } });
    const held = (): HlSpotBalance[] => [{ coin: "USDC", total: "10", hold: "0" }, { coin: "HYPE", total: "0.5", hold: "0" }];

    it("does not re-read the fill history for the rule (one fills read per tick)", async () => {
      hl.balances = held();
      hl.fills = [botFill(T0 - 1000, { price: "30", size: "0.5" })];
      await tick(T0, active([tp()]));
      expect(hl.calls.filter((c) => c === "getUserFills")).toHaveLength(1);
      expect(hl.placed).toHaveLength(1); // 40 vs 30 = +33%
    });
    it("after a long pause the truncated read restarts from today's window, flagged partial, instead of failing for ever", async () => {
      hl.balances = held();
      let r = await tick(T0, quiet());
      hl.fillsError = (start) => (start < T0 ? new FillsTruncatedError("too many rows since the old cursor") : null);
      hl.fills = [botFill(T0 + 1000, { price: "30", size: "0.5" })];
      r = await tick(T0 + 60_000, active([tp()]), r.state);
      expect(r.tradingState).toBe("running");
      expect(r.state.fills?.totalComplete).toBe(false);
      expect(r.state.fills?.completeFromMs).toBe(T0);
      expect(r.status.warnings.some((w) => w.includes("fill history gap"))).toBe(true);
      // the rule set confirmed (T0 - 1h) before the gap: position_pnl is skipped, not guessed
      expect(hl.placed).toHaveLength(0);
      expect(r.entries.some((e) => e.kind === "skip" && e.detail.startsWith("COST_BASIS_PARTIAL"))).toBe(true);
      // a rule set confirmed after the gap has a complete basis again
      const hash2 = "cd".repeat(32);
      const later: ActiveRules = { ...active([tp()], {}, hash2), confirmedAtMs: T0 + 30_000 };
      hl.fills = [botFill(T0 + 40_000, { price: "30", size: "0.5", cloid: `${cloidPrefix(hash2)}0000000000000001`, oid: 2 })];
      await tick(T0 + 120_000, later, r.state);
      expect(hl.placed).toHaveLength(1);
    });
    it("the fallback itself still fails closed when even today's window is truncated", async () => {
      let r = await tick(T0, quiet());
      hl.fillsError = () => new FillsTruncatedError("everything");
      r = await tick(T0 + 60_000, quiet(), r.state);
      expect(r.status.state_reason).toBe("FILLS_TRUNCATED");
    });
  });

  describe("H5 every filled bot order needs an attributed fill", () => {
    it("blocks when one of two filled orders has no fill although another does", async () => {
      let r = await tick(T0, rs());
      expect(r.state.filledOidsToday).toEqual([1]);
      hl.autoFills = false; // order 2 is reported filled but leaves no fill row
      r = await tick(T0 + 20 * 60_000, rs(), r.state);
      expect(hl.placed).toHaveLength(2);
      expect(r.state.filledOidsToday).toEqual([1, 2]);
      r = await tick(T0 + 40 * 60_000, rs(), r.state);
      expect(r.tradingState).toBe("error");
      expect(r.status.state_reason).toBe("FILLS_NOT_ATTRIBUTED");
      expect(r.status.state_detail).toContain("2");
      expect(hl.placed).toHaveLength(2);
    });
    it("trades on while every filled order has a fill, and the list resets with the UTC day", async () => {
      let r = await tick(T0, rs());
      r = await tick(T0 + 20 * 60_000, rs(), r.state);
      expect(r.state.filledOidsToday).toEqual([1, 2]);
      expect(hl.placed).toHaveLength(2);
      r = await tick(Date.UTC(2026, 10, 6, 0, 1, 0), quiet(), r.state);
      expect(r.state.filledOidsToday).toEqual([]);
    });
  });

  describe("snapshot stamps", () => {
    it("balanceAtMs is read from the injected clock right after the HL reads", async () => {
      hl.now = T0;
      const r = await runTick({ hl, vault, config: cfg, clock: () => T0 + 4_000 }, { nowMs: T0, rules: quiet(), state: initialEngineState() });
      expect(r.state.day).toMatchObject({ snapshotAtMs: T0, balanceAtMs: T0 + 4_000 });
    });
    it("a withdrawal between the tick start and the balance read is not subtracted again (the drop stays visible)", async () => {
      hl.now = T0;
      // the 8 USDC left at T0+1s; the snapshot balance (read at ~T0+2s) already lacks it
      hl.balances = [{ coin: "USDC", total: "92", hold: "0" }];
      hl.ledger = [{ timeMs: T0 - 5000, kind: "deposit", usdc: "1000" }, { timeMs: T0 + 1_000, kind: "withdraw", usdc: "8" }];
      const first = await runTick({ hl, vault, config: cfg, clock: () => T0 + 2_000 }, { nowMs: T0, rules: quiet(), state: initialEngineState() });
      hl.now = T0 + 60_000;
      hl.balances = [{ coin: "USDC", total: "86", hold: "0" }]; // a real 6 USDC loss afterwards
      const r = await runTick({ hl, vault, config: cfg, clock: () => T0 + 60_000 }, { nowMs: T0 + 60_000, rules: quiet(), state: first.state });
      expect(r.status.state_reason).toBe("EQUITY_DROP");
    });
  });
});
