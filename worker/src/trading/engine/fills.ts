/**
 * Incremental per-bot fill accounting for the loss stops and P&L. Pure. (ADR-0005 "Accounting change", ADR-0006 sections 2-3.)
 *
 * Re-reading history every tick is not an option (HL returns at most 2000 fills per response and keeps the 10000 newest, so
 * today's fills could silently fall out of the answer). Instead the engine persists, per bot, running per-pair sums of the
 * bot's fills, and per ACCOUNT one read cursor; each tick reads only what is newer than the cursor (hl/pagination.ts fails
 * closed when a read cannot be proven complete).
 *
 *  - `total`  = bot fills with timeMs >= TRADING_START_MS.   - `today` = bot fills with timeMs >= the day snapshot.
 *  - A fill belongs to bot X when its cloid prefix maps to X in the permanent prefix registry (`bots.json`), else when its oid
 *    is one the engine remembers for X (`oidBot`). The oid path exists because the cloid on live fills is not always
 *    verified. Anything else is foreign: only counted (`foreignFills`), someone else trades this account.
 *  - The cursor is read back by OVERLAP_MS and fills are de-duplicated by `fillKey`, so a fill that HL indexes a little late
 *    (older timestamp than one already seen) is still picked up.
 *  - The cursor is HL's clock: it is the latest fill TIME seen and never the local clock, so a fast local clock can never
 *    skip fills. (Cost: with no fill at all the read keeps starting at the initial cursor, which returns nothing. Non-spot
 *    rows do not move the cursor; a perp trader on the same account would still be paginated through each tick.)
 *  - `basis` keeps the running cost basis per (rule-set prefix, pair) for `position_pnl` rules, so those rules do not re-read
 *    history either.
 *  - `feeBase` per pair = base-token fees on buys (spot buys pay the fee in what they buy). The bot's position in a pair is
 *    `dq - feeBase` (what it really received); `dq` stays gross because the P&L converts the same fee to USDC separately.
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
  /** bought - sold, base units (gross: fees charged in the base token are NOT taken off here) */
  dq: Dec;
  /** fees in USDC */
  fees: Dec;
  /** price of the latest fill (display fallback) */
  lastPx: Dec;
  /** Sum of the fees charged in the base token on buys (base units). Absent in sums written before 2026-11-03 = 0. */
  feeBase?: Dec;
}
export type AggMap = Record<string, PairAgg>;

/** Account-wide read cursor (one per account, not per bot). */
export interface FillCursor {
  /** Latest fill time seen. The next read starts at cursorMs - OVERLAP_MS. */
  cursorMs: number;
  /** Keys of the fills within OVERLAP_MS of the cursor (not yet safe to forget). */
  seen: { k: string; t: number }[];
  /**
   * Fills at or after this time are all accounted for (0 = since TRADING_START_MS). A rule set confirmed before it has a partial
   * cost basis (position_pnl is skipped for it).
   */
  completeFromMs: number;
  /** Day snapshot time that `today` accumulates from; null = no day snapshot yet. */
  todayFromMs: number | null;
  /** Spot fills since TRADING_START_MS that belong to no bot. */
  foreignFills: number;
}

/** Per-bot running sums. */
export interface BotAgg {
  total: AggMap;
  today: AggMap;
  /** False when a read could not reach back far enough (history truncated): `total` and the cost bases are then partial. */
  totalComplete: boolean;
  /** Bot fills inside `today`. */
  botFillsToday: number;
  /** Distinct order ids of the bot fills inside `today` (bounded): compared with the orders reported filled. */
  botOidsToday: number[];
  /** Running cost basis of the bot fills since TRADING_START_MS: rule-set prefix -> pair -> { size, cost } (Dec). */
  basis: Record<string, Record<string, { size: Dec; cost: Dec }>>;
}

export function emptyCursor(cursorMs: number, todayFromMs: number | null, complete: boolean): FillCursor {
  return { cursorMs, seen: [], completeFromMs: complete ? 0 : cursorMs, todayFromMs, foreignFills: 0 };
}

export function emptyBotAgg(totalComplete = true): BotAgg {
  return { total: {}, today: {}, totalComplete, botFillsToday: 0, botOidsToday: [], basis: {} };
}

/** Cost basis (size, average cost) of the fills of one rule set on one pair. Flat = size 0. */
export function basisOf(a: BotAgg, prefix: string, pair: string): { size: Fx; avgCost: Fx } {
  const b = a.basis[prefix.toLowerCase()]?.[pair];
  if (!b) return { size: 0n, avgCost: 0n };
  const size = fx(b.size);
  return size > 0n ? { size, avgCost: (fx(b.cost) * SCALE) / size } : { size: 0n, avgCost: 0n };
}

/** New UTC day: `today` restarts at the new snapshot. */
export function rollCursorToday(c: FillCursor, snapshotAtMs: number): FillCursor {
  return { ...c, todayFromMs: snapshotAtMs };
}
export function rollBotToday(a: BotAgg): BotAgg {
  return { ...a, today: {}, botFillsToday: 0, botOidsToday: [] };
}

/** Where the next read starts. */
export const readFrom = (c: FillCursor): number => Math.max(0, c.cursorMs - OVERLAP_MS);

/** First 16 hex of a cloid (`0x` + 16 hex) in lower case, or null for a short / absent cloid. */
export function cloidPrefixOf(cloid: string | null): string | null {
  if (cloid === null || cloid.length < 18) return null;
  return cloid.slice(0, 18).toLowerCase();
}

export interface ApplyCtx {
  /** Bot that owns a fill (cloid prefix first, then remembered oid), or null for a foreign fill. */
  resolve: (f: HlFill) => string | null;
  fundedSinceMs: number;
}

/** Resolution used by the engine: permanent prefix map first, then the remembered order ids. */
export function resolveBot(f: HlFill, prefixToBot: ReadonlyMap<string, string>, oidBot: Readonly<Record<string, string>>): string | null {
  const p = cloidPrefixOf(f.cloid);
  if (p !== null) {
    const b = prefixToBot.get(p);
    if (b !== undefined) return b;
  }
  return oidBot[String(f.oid)] ?? null;
}

/** True when the fee of the fill was charged in the base token (a spot buy). */
export function baseFeeOf(f: HlFill): Fx {
  if (f.side !== "buy" || f.feeToken === undefined || f.feeToken === "USDC" || f.feeAmount === undefined) return 0n;
  return fx(f.feeAmount);
}

function addTo(map: AggMap, f: HlFill): void {
  const cur = map[f.pair];
  let cash = cur ? fx(cur.cash) : 0n;
  let dq = cur ? fx(cur.dq) : 0n;
  let feeBase = cur?.feeBase !== undefined ? fx(cur.feeBase) : 0n;
  const fees = (cur ? fx(cur.fees) : 0n) + fx(f.feeUsdc);
  const sz = fx(f.size);
  const px = fx(f.price);
  const notional = fxMul(sz, px);
  if (f.side === "buy") {
    cash -= notional;
    dq += sz;
    feeBase += baseFeeOf(f);
  } else {
    cash += notional;
    dq -= sz;
  }
  map[f.pair] = { cash: fxStr(cash, 12), dq: fxStr(dq, 12), fees: fxStr(fees, 12), lastPx: fxStr(px, 12), feeBase: fxStr(feeBase, 12) };
}

/** What the bot really holds per pair according to a sum: bought - sold - base-token fees (never negative). */
export function positionOf(m: AggMap): Record<string, Fx> {
  const out: Record<string, Fx> = {};
  for (const [pair, a] of Object.entries(m)) {
    const q = fx(a.dq) - (a.feeBase !== undefined ? fx(a.feeBase) : 0n);
    out[pair] = q > 0n ? q : 0n;
  }
  return out;
}

/** Weighted-average cost update (same rule as `costBasis` in pnl.ts): a buy adds size and cost, a sell removes size at the average cost. */
function addToBasis(a: BotAgg, prefix: string, f: HlFill): void {
  const perPair = (a.basis[prefix] ??= {});
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

export interface AttributedFill {
  botId: string;
  fill: HlFill;
}

/**
 * Folds newly read fills into the cursor and the bots' sums. Fills seen before are skipped. Returns new objects (inputs are not
 * mutated) plus the fills that were new and attributed to a bot, in time order (for the fills journal).
 */
export function applyFills(
  cursor: FillCursor,
  aggs: Readonly<Record<string, BotAgg>>,
  fills: readonly HlFill[],
  ctx: ApplyCtx,
): { cursor: FillCursor; aggs: Record<string, BotAgg>; attributed: AttributedFill[] } {
  const next: FillCursor = { ...cursor, seen: [...cursor.seen] };
  const out: Record<string, BotAgg> = {};
  const get = (id: string): BotAgg => {
    let a = out[id];
    if (a === undefined) {
      const src = aggs[id] ?? emptyBotAgg(true);
      a = { ...src, total: { ...src.total }, today: { ...src.today }, botOidsToday: [...src.botOidsToday], basis: structuredClone(src.basis) };
      out[id] = a;
    }
    return a;
  };
  for (const id of Object.keys(aggs)) get(id);
  const attributed: AttributedFill[] = [];
  const seen = new Set(next.seen.map((s) => s.k));
  const floor = cursor.cursorMs - OVERLAP_MS;
  for (const f of [...fills].sort((a, b) => a.timeMs - b.timeMs)) {
    const k = fillKey(f);
    if (seen.has(k) || f.timeMs < floor) continue;
    seen.add(k);
    next.seen.push({ k, t: f.timeMs });
    next.cursorMs = Math.max(next.cursorMs, f.timeMs);
    if (f.timeMs < ctx.fundedSinceMs) continue;
    const botId = ctx.resolve(f);
    if (botId === null) {
      next.foreignFills += 1;
      continue;
    }
    const a = get(botId);
    addTo(a.total, f);
    const pre = cloidPrefixOf(f.cloid);
    if (pre !== null) addToBasis(a, pre, f);
    if (next.todayFromMs !== null && f.timeMs >= next.todayFromMs) {
      addTo(a.today, f);
      a.botFillsToday += 1;
      if (!a.botOidsToday.includes(f.oid)) a.botOidsToday = [...a.botOidsToday, f.oid].slice(-MAX_OIDS_TODAY);
    }
    attributed.push({ botId, fill: f });
  }
  // The cursor stays at the latest FILL time (HL's clock). It is deliberately not moved to the local `now`.
  const keep = next.cursorMs - OVERLAP_MS;
  next.seen = next.seen.filter((s) => s.t >= keep).slice(-MAX_SEEN);
  return { cursor: next, aggs: out, attributed };
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
