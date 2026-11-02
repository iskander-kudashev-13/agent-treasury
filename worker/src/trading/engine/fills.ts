/**
 * Incremental bot-fill accounting for the loss stop and P&L. Pure.
 *
 * Re-reading history every tick is not an option (HL returns at most 2000 fills per response and keeps the 10000 newest, so
 * today's fills could silently fall out of the answer). Instead the engine persists a running per-pair sum of the bot's
 * fills plus a cursor, and each tick reads only what is newer than the cursor (hl/pagination.ts fails closed when a read
 * cannot be proven complete).
 *
 *  - `total`  = bot fills with timeMs >= TRADING_START_MS.   - `today` = bot fills with timeMs >= the day snapshot.
 *  - A fill is the bot's when its cloid starts with the prefix of a rule set it activated OR its oid is one the bot got back
 *    from placing an order (`botOids`). The oid path exists because the cloid on live fills is not yet verified.
 *  - Spot fills that are not the bot's are only counted (`foreignFills`): someone else trades this account.
 *  - The cursor is read back by OVERLAP_MS and fills are de-duplicated by `fillKey`, so a fill that HL indexes a little late
 *    (older timestamp than one already seen) is still picked up.
 *  - The cursor is HL's clock: it is the latest fill TIME seen and never the local clock, so a fast local clock can never
 *    skip fills. (Cost: with no fill at all the read keeps starting at the initial cursor, which returns nothing. Non-spot
 *    rows do not move the cursor; a perp trader on the same account would still be paginated through each tick.)
 *  - `basis` keeps the running cost basis per (rule-set prefix, pair) for `position_pnl` rules, so those rules do not re-read
 *    history either (a full re-read from the rule set's confirmation could hit the 10000-fill retention for good).
 *  - MAX_SEEN edge: only the last MAX_SEEN keys inside the overlap are remembered. More than MAX_SEEN fills inside one
 *    OVERLAP_MS window (2000 fills in 120 s) could be read twice and counted twice; at the bot's order limits that is not
 *    reachable by the bot, and a flood by a foreign key only changes the sums by already-counted bot fills.
 */
import { fillKey } from "../hl/pagination.js";
import type { Dec, HlFill } from "../types.js";
import { type Fx, SCALE, fx, fxMul, fxStr } from "./risk.js";

export const OVERLAP_MS = 120_000;
const MAX_SEEN = 2000;
const MAX_OIDS_TODAY = 1000;

/** Per pair, persisted as Dec strings (12 decimals, lossless for `Fx`). cash is signed. */
export interface PairAgg {
  /** sum(sell px*size) - sum(buy px*size) */
  cash: Dec;
  /** bought - sold, base units */
  dq: Dec;
  /** fees in USDC */
  fees: Dec;
  /** price of the latest fill (display fallback) */
  lastPx: Dec;
}
export type AggMap = Record<string, PairAgg>;

export interface FillTracker {
  /** Latest fill time seen. The next read starts at cursorMs - OVERLAP_MS. */
  cursorMs: number;
  /** Keys of the fills within OVERLAP_MS of the cursor (not yet safe to forget). */
  seen: { k: string; t: number }[];
  /** False when a read could not reach back far enough (history truncated): `total` and the cost bases are then partial. */
  totalComplete: boolean;
  /**
   * Fills at or after this time are all accounted for (0 = since TRADING_START_MS). A rule set confirmed before it has a partial
   * cost basis (position_pnl is skipped for it). ABSENT in older files: 0 if totalComplete else Infinity.
   */
  completeFromMs?: number;
  /** Day snapshot time that `today` accumulates from; null = no day snapshot yet. */
  todayFromMs: number | null;
  total: AggMap;
  today: AggMap;
  /** Bot fills inside `today`. */
  botFillsToday: number;
  /** Distinct order ids of the bot fills inside `today` (bounded): compared with the orders reported filled. */
  botOidsToday?: number[];
  /** Running cost basis of the bot fills since TRADING_START_MS: rule-set prefix -> pair -> { size, cost } (Dec). */
  basis?: Record<string, Record<string, { size: Dec; cost: Dec }>>;
  /** Spot fills since TRADING_START_MS that are not the bot's. */
  foreignFills: number;
}

export function emptyTracker(cursorMs: number, todayFromMs: number | null, totalComplete: boolean): FillTracker {
  return {
    cursorMs,
    seen: [],
    totalComplete,
    completeFromMs: totalComplete ? 0 : cursorMs,
    todayFromMs,
    total: {},
    today: {},
    botFillsToday: 0,
    botOidsToday: [],
    basis: {},
    foreignFills: 0,
  };
}

/** Fills from this time on are fully accounted for in the tracker's sums and cost bases. */
export const completeFrom = (t: FillTracker): number => t.completeFromMs ?? (t.totalComplete ? 0 : Number.POSITIVE_INFINITY);

/** Cost basis (size, average cost) of the fills of one rule set on one pair. Flat = size 0. */
export function basisOf(t: FillTracker, prefix: string, pair: string): { size: Fx; avgCost: Fx } {
  const b = t.basis?.[prefix.toLowerCase()]?.[pair];
  if (!b) return { size: 0n, avgCost: 0n };
  const size = fx(b.size);
  return size > 0n ? { size, avgCost: (fx(b.cost) * SCALE) / size } : { size: 0n, avgCost: 0n };
}

/** New UTC day: `today` restarts at the new snapshot. */
export function rollToday(t: FillTracker, snapshotAtMs: number): FillTracker {
  return { ...t, todayFromMs: snapshotAtMs, today: {}, botFillsToday: 0, botOidsToday: [] };
}

/** Where the next read starts. */
export const readFrom = (t: FillTracker): number => Math.max(0, t.cursorMs - OVERLAP_MS);

export interface ApplyCtx {
  prefixes: readonly string[];
  oids: ReadonlySet<number>;
  fundedSinceMs: number;
}

export function isBotFill(f: HlFill, prefixes: readonly string[], oids: ReadonlySet<number>): boolean {
  if (oids.has(f.oid)) return true;
  if (f.cloid === null) return false;
  const c = f.cloid.toLowerCase();
  return prefixes.some((p) => c.startsWith(p.toLowerCase()));
}

function addTo(map: AggMap, f: HlFill): void {
  const cur = map[f.pair];
  let cash = cur ? fx(cur.cash) : 0n;
  let dq = cur ? fx(cur.dq) : 0n;
  const fees = (cur ? fx(cur.fees) : 0n) + fx(f.feeUsdc);
  const sz = fx(f.size);
  const px = fx(f.price);
  const notional = fxMul(sz, px);
  if (f.side === "buy") {
    cash -= notional;
    dq += sz;
  } else {
    cash += notional;
    dq -= sz;
  }
  map[f.pair] = { cash: fxStr(cash, 12), dq: fxStr(dq, 12), fees: fxStr(fees, 12), lastPx: fxStr(px, 12) };
}

/** Weighted-average cost update (same rule as `costBasis` in pnl.ts): a buy adds size and cost, a sell removes size at the average cost. */
function addToBasis(t: FillTracker, prefix: string, f: HlFill): void {
  const basis = (t.basis ??= {});
  const perPair = (basis[prefix] ??= {});
  const cur = perPair[f.pair];
  let size = cur ? fx(cur.size) : 0n;
  let cost = cur ? fx(cur.cost) : 0n;
  const sz = fx(f.size);
  if (f.side === "buy") {
    size += sz;
    cost += fxMul(sz, fx(f.price));
  } else if (size > 0n) {
    const sold = sz > size ? size : sz;
    cost -= (cost * sold) / size;
    size -= sold;
  }
  perPair[f.pair] = { size: fxStr(size, 12), cost: fxStr(cost, 12) };
}

/** Folds newly read fills into the tracker. Fills seen before are skipped. Returns a new tracker. */
export function applyFills(t: FillTracker, fills: readonly HlFill[], ctx: ApplyCtx): FillTracker {
  const next: FillTracker = {
    ...t,
    total: { ...t.total },
    today: { ...t.today },
    seen: [...t.seen],
    botOidsToday: [...(t.botOidsToday ?? [])],
    basis: structuredClone(t.basis ?? {}),
  };
  const seen = new Set(next.seen.map((s) => s.k));
  const floor = t.cursorMs - OVERLAP_MS;
  for (const f of [...fills].sort((a, b) => a.timeMs - b.timeMs)) {
    const k = fillKey(f);
    if (seen.has(k) || f.timeMs < floor) continue;
    seen.add(k);
    next.seen.push({ k, t: f.timeMs });
    next.cursorMs = Math.max(next.cursorMs, f.timeMs);
    if (f.timeMs < ctx.fundedSinceMs) continue;
    if (!isBotFill(f, ctx.prefixes, ctx.oids)) {
      next.foreignFills += 1;
      continue;
    }
    addTo(next.total, f);
    if (f.cloid !== null) {
      const c = f.cloid.toLowerCase();
      const pre = ctx.prefixes.map((p) => p.toLowerCase()).find((p) => c.startsWith(p));
      if (pre !== undefined) addToBasis(next, pre, f);
    }
    if (next.todayFromMs !== null && f.timeMs >= next.todayFromMs) {
      addTo(next.today, f);
      next.botFillsToday += 1;
      const oids = next.botOidsToday ?? [];
      if (!oids.includes(f.oid)) next.botOidsToday = [...oids, f.oid].slice(-MAX_OIDS_TODAY);
    }
  }
  // The cursor stays at the latest FILL time (HL's clock). It is deliberately not moved to the local `now`.
  const keep = next.cursorMs - OVERLAP_MS;
  next.seen = next.seen.filter((s) => s.t >= keep).slice(-MAX_SEEN);
  return next;
}

/** Bigint view of an `AggMap` for `tradingPnl`. */
export interface PairAggFx {
  cash: Fx;
  dq: Fx;
  fees: Fx;
  lastPx: Fx;
}
export function aggFx(m: AggMap): Record<string, PairAggFx> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { cash: fx(v.cash), dq: fx(v.dq), fees: fx(v.fees), lastPx: fx(v.lastPx) }]));
}

/** Aggregate of plain fills (tests, and anything that has the fills at hand). */
export function aggFromFills(fills: readonly HlFill[]): AggMap {
  const m: AggMap = {};
  for (const f of [...fills].sort((a, b) => a.timeMs - b.timeMs)) addTo(m, f);
  return m;
}
