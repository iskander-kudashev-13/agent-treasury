/**
 * Deterministic in-memory HlPort for engine tests (ADR-0005 test plan). No network, no clock of its own: time comes from
 * `now()` which tests advance by hand. Mirrors the real adapter's safety refusals (asset id < 10000) and HL's tick rules,
 * so an engine bug that builds a bad price or size fails in tests the way it would on HL.
 */
import type {
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
  Window,
} from "../types.js";
import { addDec, cmpDec, isValidPrice, mulDec, subDec } from "./format.js";
import { FILLS_PAGE_CAP, FILLS_RETAIN, readAllFills } from "./pagination.js";

export const SPOT_ASSET_ID_BASE = 10000;

/** Every call, in order, so tests can assert "scheduleCancel before any order". */
export type FakeCall =
  | { kind: "read"; method: string }
  | { kind: "place"; order: HlPlaceOrder }
  | { kind: "cancel"; orders: { assetId: number; oid: number }[] }
  | { kind: "scheduleCancel"; timeMs: number | null };

export interface FakeHlOptions {
  now?: () => number;
  pairs?: HlSpotPair[];
}

export const HYPE_PAIR: HlSpotPair = {
  name: "HYPE/USDC",
  base: "HYPE",
  assetId: 10107,
  szDecimals: 2,
  volume24hUsdc: "5000000",
  midUsdc: "40",
};

const EMPTY_PERP: HlPerpState = { positions: [], openPerpOrders: 0, accountValueUsdc: "0" };

export class FakeHl implements HlPort {
  now: () => number;
  pairs: HlSpotPair[];
  mids: Record<string, string | undefined> = {};
  /** Per pair; when unset the book is bid = ask = mid. */
  books: Record<string, { bid: string | null; ask: string | null } | undefined> = {};
  candles: Record<string, HlCandle[] | undefined> = {};
  balances: Record<string, HlSpotBalance[] | undefined> = {};
  perp: Record<string, HlPerpState | undefined> = {};
  openOrders: Record<string, HlOpenOrder[] | undefined> = {};
  fills: Record<string, HlFill[] | undefined> = {};
  ledger: Record<string, HlLedgerEntry[] | undefined> = {};
  agents: Record<string, HlApprovedAgent[] | undefined> = {};
  /** Account the API wallet trades for (orders land in its balances). */
  account = "0x00000000000000000000000000000000000000aa";
  /** Override the `atMs` of getMids/getBook to simulate stale data; null = now(). */
  staleAtMs: number | null = null;
  /** Per-pair age of a mid (getMids().pairAtMs), to simulate one stale pair. */
  pairAtMs: Record<string, number | undefined> | null = null;
  /** Simulated HL caps for userFillsByTime: rows per response and rows retained (newest). */
  fillsPageCap = FILLS_PAGE_CAP;
  fillsRetain = FILLS_RETAIN;
  /** Simulate an HL that answers newest first (the docs do not say which order userFillsByTime uses). */
  fillsNewestFirst = false;
  private nextTid = 1;
  /** When set, every scheduleCancel rejects with it (e.g. HL's volume-gate refusal). */
  scheduleCancelError: Error | null = null;

  readonly calls: FakeCall[] = [];
  readonly placed: HlPlaceOrder[] = [];
  readonly cancelled: { assetId: number; oid: number }[] = [];
  readonly scheduleCancelCalls: (number | null)[] = [];

  /** Next results for placeSpotOrder (consumed in order); default is the fill model below. */
  orderResults: HlOrderResult[] = [];
  /** Make the next call of a method throw this error. */
  private failures = new Map<string, Error>();
  private nextOid = 1000;
  private resting = new Map<number, HlPlaceOrder>();

  constructor(opts: FakeHlOptions = {}) {
    this.now = opts.now ?? (() => 1_700_000_000_000);
    this.pairs = (opts.pairs ?? [HYPE_PAIR]).map((p) => ({ ...p }));
    for (const p of this.pairs) if (p.midUsdc !== null) this.mids[p.name] = p.midUsdc;
  }

  // -------- test setters --------
  setMid(pair: string, mid: string | undefined): void {
    this.mids[pair] = mid;
    const p = this.pairs.find((x) => x.name === pair);
    if (p) p.midUsdc = mid ?? null;
  }
  setBook(pair: string, bid: string | null, ask: string | null): void {
    this.books[pair] = { bid, ask };
  }
  setCandles(pair: string, candles: HlCandle[]): void {
    this.candles[pair] = candles;
  }
  setBalances(account: string, balances: HlSpotBalance[]): void {
    this.balances[account.toLowerCase()] = balances.map((b) => ({ ...b }));
  }
  setPerp(account: string, state: HlPerpState): void {
    this.perp[account.toLowerCase()] = state;
  }
  setApprovedAgents(account: string, agents: HlApprovedAgent[]): void {
    this.agents[account.toLowerCase()] = agents;
  }
  setLedger(account: string, entries: HlLedgerEntry[]): void {
    this.ledger[account.toLowerCase()] = entries;
  }
  setOpenOrders(account: string, orders: HlOpenOrder[]): void {
    this.openOrders[account.toLowerCase()] = orders;
  }
  addFill(account: string, fill: HlFill): void {
    const k = account.toLowerCase();
    this.fills[k] = [...(this.fills[k] ?? []), fill];
  }
  /** Next call of `method` (a port method name) rejects with `error`. */
  failNext(method: keyof HlPort, error: Error = new Error(`fake ${method} failure`)): void {
    this.failures.set(method, error);
  }
  /** Names of calls so far ("read:getMids", "place", "cancel", "scheduleCancel"). */
  callLog(): string[] {
    return this.calls.map((c) => (c.kind === "read" ? `read:${c.method}` : c.kind));
  }

  // -------- reads --------
  /** Record a read and return its result, or a rejected promise when `failNext(method)` was armed. */
  private read<T>(method: keyof HlPort, fn: () => T): Promise<T> {
    this.calls.push({ kind: "read", method });
    const err = this.takeFailure(method);
    return err ? Promise.reject(err) : Promise.resolve(fn());
  }
  private takeFailure(method: string): Error | undefined {
    const err = this.failures.get(method);
    this.failures.delete(method);
    return err;
  }

  getSpotPairs(): Promise<HlSpotPair[]> {
    return this.read("getSpotPairs", () => this.pairs.map((p) => ({ ...p })));
  }

  getMids(): Promise<HlMids> {
    return this.read("getMids", () => {
      const mids: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.mids)) if (v !== undefined) mids[k] = v;
      return { mids, atMs: this.staleAtMs ?? this.now(), ...(this.pairAtMs ? { pairAtMs: { ...this.pairAtMs } } : {}) };
    });
  }

  getBook(pair: string): Promise<HlBook> {
    return this.read("getBook", () => {
      const b = this.books[pair];
      const mid = this.mids[pair] ?? null;
      return { bid: b ? b.bid : mid, ask: b ? b.ask : mid, atMs: this.staleAtMs ?? this.now() };
    });
  }

  getCandles(pair: string, _interval: Window, startMs: number, endMs: number): Promise<HlCandle[]> {
    return this.read("getCandles", () =>
      (this.candles[pair] ?? []).filter((c) => c.closeTimeMs >= startMs && c.openTimeMs <= endMs).map((c) => ({ ...c })),
    );
  }

  getSpotBalances(account: string): Promise<HlSpotBalance[]> {
    return this.read("getSpotBalances", () => (this.balances[account.toLowerCase()] ?? []).map((b) => ({ ...b })));
  }

  getPerpState(account: string): Promise<HlPerpState> {
    return this.read("getPerpState", () => {
      const s = this.perp[account.toLowerCase()] ?? EMPTY_PERP;
      return { ...s, positions: s.positions.map((p) => ({ ...p })) };
    });
  }

  getOpenOrders(account: string): Promise<HlOpenOrder[]> {
    return this.read("getOpenOrders", () => (this.openOrders[account.toLowerCase()] ?? []).map((o) => ({ ...o })));
  }

  getUserFills(account: string, startMs: number): Promise<HlFill[]> {
    this.calls.push({ kind: "read", method: "getUserFills" });
    const err = this.takeFailure("getUserFills");
    if (err) return Promise.reject(err);
    // Behaves like HL: only the newest `fillsRetain` rows exist, a response holds the oldest `fillsPageCap` rows from startTime.
    const all = [...(this.fills[account.toLowerCase()] ?? [])].sort((a, b) => a.timeMs - b.timeMs).slice(-this.fillsRetain);
    return readAllFills(
      (start, end) => {
        const rows = all.filter((f) => f.timeMs >= start && (end === undefined || f.timeMs <= end)).slice(0, this.fillsPageCap);
        const ordered = this.fillsNewestFirst ? [...rows].reverse() : rows;
        return Promise.resolve({
          fills: ordered.map((f) => ({ ...f })),
          rawCount: ordered.length,
          maxTimeMs: rows.at(-1)?.timeMs ?? null,
          minTimeMs: rows[0]?.timeMs ?? null,
          ascending: ordered.every((f, i) => i === 0 || (ordered[i - 1]?.timeMs ?? 0) <= f.timeMs),
        });
      },
      startMs,
      { pageCap: this.fillsPageCap, retain: this.fillsRetain },
    );
  }

  getLedger(account: string, startMs: number): Promise<HlLedgerEntry[]> {
    return this.read("getLedger", () => (this.ledger[account.toLowerCase()] ?? []).filter((e) => e.timeMs >= startMs).map((e) => ({ ...e })));
  }

  getApprovedAgents(account: string): Promise<HlApprovedAgent[]> {
    return this.read("getApprovedAgents", () => (this.agents[account.toLowerCase()] ?? []).map((a) => ({ ...a })));
  }

  // -------- writes --------
  placeSpotOrder(order: HlPlaceOrder): Promise<HlOrderResult> {
    const injected = this.takeFailure("placeSpotOrder");
    if (injected) return Promise.reject(injected);
    if (!Number.isInteger(order.assetId) || order.assetId < SPOT_ASSET_ID_BASE) {
      return Promise.reject(new Error(`refused: asset id ${order.assetId} is not a spot asset (< ${SPOT_ASSET_ID_BASE})`));
    }
    this.calls.push({ kind: "place", order });
    this.placed.push(order);

    const scripted = this.orderResults.shift();
    if (scripted) return Promise.resolve(this.applyScripted(order, scripted));

    const pair = this.pairs.find((p) => p.assetId === order.assetId);
    if (!pair) return Promise.resolve({ status: "rejected", error: `unknown asset ${order.assetId}` });
    if (!isValidPrice(order.price, pair.szDecimals)) {
      return Promise.resolve({ status: "rejected", error: `Price must be divisible by tick size: ${order.price}` });
    }
    if (!/^\d+(\.\d+)?$/.test(order.size) || (order.size.split(".")[1] ?? "").length > pair.szDecimals || cmpDec(order.size, "0") <= 0) {
      return Promise.resolve({ status: "rejected", error: `Invalid size: ${order.size}` });
    }
    if (cmpDec(mulDec(order.price, order.size), "10") < 0) {
      return Promise.resolve({ status: "rejected", error: "Order must have minimum value of $10." });
    }
    const mid = this.mids[pair.name];
    const crosses = mid !== undefined && (order.isBuy ? cmpDec(order.price, mid) >= 0 : cmpDec(order.price, mid) <= 0);

    if (order.tif === "Ioc") {
      if (!crosses) return Promise.resolve({ status: "unfilled" });
      return Promise.resolve(this.fill(order, pair, order.price));
    }
    // Gtc: crossing orders fill immediately at the limit price, others rest.
    if (crosses) return Promise.resolve(this.fill(order, pair, order.price));
    return Promise.resolve(this.rest(order, pair));
  }

  cancelOrders(orders: { assetId: number; oid: number }[]): Promise<void> {
    const injected = this.takeFailure("cancelOrders");
    if (injected) return Promise.reject(injected);
    for (const o of orders) {
      if (!Number.isInteger(o.assetId) || o.assetId < SPOT_ASSET_ID_BASE) {
        return Promise.reject(new Error(`refused: asset id ${o.assetId} is not a spot asset (< ${SPOT_ASSET_ID_BASE})`));
      }
    }
    this.calls.push({ kind: "cancel", orders });
    for (const o of orders) {
      this.cancelled.push(o);
      this.removeResting(o.oid);
    }
    return Promise.resolve();
  }

  scheduleCancel(timeMs: number | null): Promise<void> {
    const injected = this.takeFailure("scheduleCancel") ?? this.scheduleCancelError;
    if (injected) return Promise.reject(injected);
    this.calls.push({ kind: "scheduleCancel", timeMs });
    this.scheduleCancelCalls.push(timeMs);
    return Promise.resolve();
  }

  // -------- fill model --------
  private bal(coin: string): HlSpotBalance {
    const list = (this.balances[this.account.toLowerCase()] ??= []);
    let b = list.find((x) => x.coin === coin);
    if (!b) {
      b = { coin, total: "0", hold: "0" };
      list.push(b);
    }
    return b;
  }

  private applyScripted(order: HlPlaceOrder, r: HlOrderResult): HlOrderResult {
    if (r.status === "resting") {
      const pair = this.pairs.find((p) => p.assetId === order.assetId);
      if (pair) this.resting.set(r.oid, order);
    }
    return r;
  }

  private fill(order: HlPlaceOrder, pair: HlSpotPair, px: string): HlOrderResult {
    const quote = this.bal("USDC");
    const base = this.bal(pair.base);
    const notional = mulDec(px, order.size);
    if (order.isBuy) {
      if (cmpDec(subDec(quote.total, quote.hold), notional) < 0) return { status: "rejected", error: "Insufficient spot balance" };
      quote.total = subDec(quote.total, notional);
      base.total = addDec(base.total, order.size);
    } else {
      if (cmpDec(subDec(base.total, base.hold), order.size) < 0) return { status: "rejected", error: "Insufficient spot balance" };
      base.total = subDec(base.total, order.size);
      quote.total = addDec(quote.total, notional);
    }
    const oid = this.nextOid++;
    this.addFill(this.account, {
      oid,
      cloid: order.cloid,
      pair: pair.name,
      side: order.isBuy ? "buy" : "sell",
      price: px,
      size: order.size,
      feeUsdc: "0",
      timeMs: this.now(),
      tid: this.nextTid++,
    });
    return { status: "filled", oid, filledSize: order.size, avgPx: px };
  }

  private rest(order: HlPlaceOrder, pair: HlSpotPair): HlOrderResult {
    const hold = order.isBuy ? this.bal("USDC") : this.bal(pair.base);
    const amount = order.isBuy ? mulDec(order.price, order.size) : order.size;
    if (cmpDec(subDec(hold.total, hold.hold), amount) < 0) return { status: "rejected", error: "Insufficient spot balance" };
    hold.hold = addDec(hold.hold, amount);
    const oid = this.nextOid++;
    this.resting.set(oid, order);
    const k = this.account.toLowerCase();
    (this.openOrders[k] ??= []).push({
      oid,
      cloid: order.cloid,
      market: "spot",
      pair: pair.name,
      side: order.isBuy ? "buy" : "sell",
      price: order.price,
      size: order.size,
      placedAtMs: this.now(),
    });
    return { status: "resting", oid };
  }

  private removeResting(oid: number): void {
    const order = this.resting.get(oid);
    this.resting.delete(oid);
    const k = this.account.toLowerCase();
    this.openOrders[k] = (this.openOrders[k] ?? []).filter((o) => o.oid !== oid);
    if (!order) return;
    const pair = this.pairs.find((p) => p.assetId === order.assetId);
    if (!pair) return;
    const hold = order.isBuy ? this.bal("USDC") : this.bal(pair.base);
    const amount = order.isBuy ? mulDec(order.price, order.size) : order.size;
    hold.hold = cmpDec(hold.hold, amount) >= 0 ? subDec(hold.hold, amount) : "0";
  }
}
