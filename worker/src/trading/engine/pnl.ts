/**
 * Equity, day snapshot, loss stop and P&L (ADR-0005 section 7 step 5 and TradingStatus.pnl). Pure.
 *
 * Definitions (all in USDC, bigint fixed point):
 *  - equity = USDC total (free + held) + sum(base total * mid) over every non-USDC spot balance that has a mid. A held
 *    coin with no mid is valued at 0 and reported (conservative: it looks like a loss, so it can only stop trading).
 *  - net flow over a window = sum(deposit + transfer_in) - sum(withdraw + transfer_out) of the HL ledger entries in the
 *    window. Vault top-ups arrive as deposits, so they are inflow: they neither hide a loss nor fake a profit.
 *  - day snapshot: the first fresh tick of each UTC day records equity at `snapshotAtMs`. Only ledger entries STRICTLY
 *    AFTER `snapshotAtMs` count as today's inflow, because earlier ones are already inside the snapshot equity.
 *  - loss_today = day_start_equity + INFLOW_since_snapshot - equity_now. Positive = loss, unrealized included.
 *    Only inflows are added back. The ADR formula nets withdrawals out too, but T10 says a manual outflow must count as
 *    a loss; the two disagree and we follow T10 (the conservative one): a withdrawal lowers equity and is not added back. A deposit that lands between the equity read and
 *    the snapshot timestamp may be counted twice, which also errs toward a bigger loss, i.e. toward stopping.
 *  - pnl.total = equity - net_funded, net_funded = net flow with timeMs >= TRADING_START_MS.
 */
import type { Dec, HlFill, HlLedgerEntry, HlSpotBalance } from "../types.js";
import { type Fx, SCALE, fx, fxMax, fxMul, fxStr } from "./risk.js";

export const DAY_MS = 86_400_000;

/** UTC day number since the epoch. */
export const utcDayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

export interface PositionValue {
  pair: string;
  base: string;
  size: Fx;
  mid: Fx;
  value: Fx;
  /** total - hold */
  free: Fx;
}

export interface Equity {
  usdcTotal: Fx;
  usdcFree: Fx;
  equity: Fx;
  positions: PositionValue[];
  /** Coins held without a usable mid (valued at 0). */
  unpriced: string[];
}

export function computeEquity(balances: readonly HlSpotBalance[], mids: Readonly<Record<string, Dec | undefined>>): Equity {
  let usdcTotal = 0n;
  let usdcHold = 0n;
  let equity = 0n;
  const positions: PositionValue[] = [];
  const unpriced: string[] = [];
  for (const b of balances) {
    const total = fx(b.total);
    const hold = fx(b.hold);
    if (b.coin === "USDC") {
      usdcTotal += total;
      usdcHold += hold;
      equity += total;
      continue;
    }
    if (total <= 0n) continue;
    const pair = `${b.coin}/USDC`;
    const midStr = mids[pair];
    const mid = midStr === undefined ? 0n : fx(midStr);
    if (mid <= 0n) {
      unpriced.push(b.coin);
      continue;
    }
    const value = fxMul(total, mid);
    equity += value;
    positions.push({ pair, base: b.coin, size: total, mid, value, free: fxMax(0n, total - hold) });
  }
  return { usdcTotal, usdcFree: fxMax(0n, usdcTotal - usdcHold), equity, positions, unpriced };
}

/** Signed net flow of ledger entries accepted by `inWindow`. */
export function netFlow(entries: readonly HlLedgerEntry[], inWindow: (timeMs: number) => boolean, countOutflow = true): Fx {
  let sum = 0n;
  for (const e of entries) {
    if (!inWindow(e.timeMs)) continue;
    const v = fx(e.usdc);
    if (e.kind === "deposit" || e.kind === "transfer_in") sum += v;
    else if (countOutflow) sum -= v;
  }
  return sum;
}

/** Start-of-day snapshot persisted in the engine state. */
export interface DaySnapshot {
  dayIndex: number;
  /** Dec string. */
  startEquity: Dec;
  snapshotAtMs: number;
}

/** Take a new snapshot when the UTC day changed (or none exists). Pure: returns the snapshot to use. */
export function rollDay(prev: DaySnapshot | null, nowMs: number, equity: Fx): { day: DaySnapshot; rolled: boolean } {
  const idx = utcDayIndex(nowMs);
  if (prev !== null && prev.dayIndex === idx) return { day: prev, rolled: false };
  return { day: { dayIndex: idx, startEquity: fxStr(equity, 12), snapshotAtMs: nowMs }, rolled: true };
}

/** loss_today per the header comment. Positive is a loss. */
export function lossToday(day: DaySnapshot, equityNow: Fx, ledger: readonly HlLedgerEntry[]): Fx {
  // Inflows only: an outflow (withdraw/send) is NOT netted out, so it shows up as a loss (ADR T10: errs toward stopping).
  const inflow = netFlow(ledger, (t) => t > day.snapshotAtMs, false);
  return fx(day.startEquity) + inflow - equityNow;
}

export interface PnlSummary {
  today: Fx;
  total: Fx;
  netFunded: Fx;
  dayStartEquity: Fx;
  lossToday: Fx;
}

export function pnlSummary(day: DaySnapshot, equityNow: Fx, ledger: readonly HlLedgerEntry[], fundedSinceMs: number): PnlSummary {
  const loss = lossToday(day, equityNow, ledger);
  const netFunded = netFlow(ledger, (t) => t >= fundedSinceMs);
  return { today: -loss, total: equityNow - netFunded, netFunded, dayStartEquity: fx(day.startEquity), lossToday: loss };
}

// ---------------------------------------------------------------------------------------------------------------------
// Position and average cost of fills under one rule set (for the position_pnl trigger)
// ---------------------------------------------------------------------------------------------------------------------

export interface CostBasis {
  /** Base size still held from fills of this rule set. */
  size: Fx;
  /** Weighted average cost per base in USDC; 0 when flat. */
  avgCost: Fx;
}

/**
 * Weighted-average cost of the fills whose cloid starts with `cloidPrefix` (the rule set's hash) on `pair`. A buy raises
 * size and cost; a sell removes size at the current average cost (average cost is unchanged by sells). Fees are ignored.
 * Flat (size 0) means position_pnl is false.
 */
export function costBasis(fills: readonly HlFill[], pair: string, cloidPrefix: string): CostBasis {
  let size = 0n;
  let cost = 0n;
  const mine = fills
    .filter((f) => f.pair === pair && f.cloid !== null && f.cloid.toLowerCase().startsWith(cloidPrefix))
    .sort((a, b) => a.timeMs - b.timeMs);
  for (const f of mine) {
    const sz = fx(f.size);
    if (f.side === "buy") {
      size += sz;
      cost += fxMul(sz, fx(f.price));
    } else if (size > 0n) {
      const sold = sz > size ? size : sz;
      cost -= (cost * sold) / size;
      size -= sold;
    }
  }
  return size > 0n ? { size, avgCost: (cost * SCALE) / size } : { size: 0n, avgCost: 0n };
}
