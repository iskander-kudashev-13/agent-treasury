/**
 * Pure per-bot metrics over a range (docs/adr/0006 section 7). No I/O, no clock: everything comes in as arguments.
 *
 *  - Realized P&L by AVERAGE COST per pair. Buy: cost += px*sz (+ the fee when it is charged in USDC), size += sz minus
 *    the fee when it is charged in the base token. Sell: realized = sold*px - cost removed at the average - fee.
 *    A sell that is not covered by the known position (journal rotated, hand-held coins) is realized only for the covered
 *    part; with no covered part its realized P&L is unknown (null) and it is left out of the closed-trade statistics.
 *  - Closed trade = one sell ORDER (oid): the sum of the realized P&L of its fills. Time = its last fill.
 *  - Max drawdown on the total P&L curve at bucket resolution: max over buckets t of
 *    (max over earlier buckets of max(hi, pnl)) - lo_t. USDC only, no percentage.
 *  - Money math is bigint fixed point (`Fx`), no floats.
 */
import { fx, fxStr, SCALE } from "./engine/risk.js";
import type { Fx } from "./engine/risk.js";
import { RANGE_MS } from "./history.js";
import type { HistoryPoint, Range } from "./history.js";
import type { JournalFill } from "./journal.js";
import type { Dec, SDec } from "./types.js";

export interface BotMetrics {
  range: Range;
  from_ms: number;
  to_ms: number;
  closed_trades: number;
  /** wins / closed_trades with 4 decimals ("0.5714"), null when nothing closed. */
  win_rate: string | null;
  avg_trade_usdc: SDec | null;
  realized_usdc: SDec;
  pnl_change_usdc: SDec;
  max_drawdown_usdc: Dec;
  turnover_usdc: Dec;
  fees_usdc: Dec;
  fills: number;
  orders: number;
}

/** Average-cost position of a bot, per pair. */
export type CostBook = Map<string, { size: Fx; cost: Fx }>;

/** Fee of a fill in USDC: as charged for USDC, converted at the fill price for a base token fee. */
export function feeInUsdc(f: Pick<JournalFill, "fee_token" | "fee_amount" | "px">): Fx {
  const amount = fx(f.fee_amount);
  return f.fee_token === "USDC" ? amount : (amount * fx(f.px)) / SCALE;
}

export interface AppliedFill {
  /** Realized P&L of the fill; null for buys and for sells with no known cost basis. */
  realized: Fx | null;
  /** Position size of the pair after the fill. */
  posAfter: Fx;
}

/** Applies one fill (in time order) to the book. Exported so the tick can fill `realized_usdc` / `pos_after`. */
export function applyFill(book: CostBook, f: JournalFill): AppliedFill {
  const px = fx(f.px);
  const sz = fx(f.sz);
  const fee = feeInUsdc(f);
  const pos = book.get(f.pair) ?? { size: 0n, cost: 0n };
  book.set(f.pair, pos);
  if (f.side === "buy") {
    pos.size += f.fee_token === "USDC" ? sz : sz - fx(f.fee_amount);
    pos.cost += (px * sz) / SCALE + (f.fee_token === "USDC" ? fee : 0n);
    return { realized: null, posAfter: pos.size };
  }
  if (pos.size <= 0n || sz <= 0n) return { realized: null, posAfter: pos.size };
  const sold = sz < pos.size ? sz : pos.size;
  const removed = sold === pos.size ? pos.cost : (pos.cost * sold) / pos.size;
  const realized = (px * sold) / SCALE - removed - (fee * sold) / sz;
  pos.size -= sold;
  pos.cost -= removed;
  return { realized, posAfter: pos.size };
}

/** Runs `applyFill` over fills sorted oldest first; returns realized per index. */
export function realizedByFill(fills: readonly JournalFill[]): (Fx | null)[] {
  const book: CostBook = new Map();
  return fills.map((f) => applyFill(book, f).realized);
}

/** Round half up to 4 decimals of n/d (n, d > 0), as "0.5714". */
function ratio4(n: bigint, d: bigint): string {
  const scaled = (n * 20000n + d) / (2n * d);
  return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, "0")}`;
}

export function maxDrawdown(points: readonly Pick<HistoryPoint, "pnl" | "lo" | "hi">[]): Fx {
  let peak: Fx | null = null;
  let dd = 0n;
  for (const p of points) {
    if (peak !== null) {
      const d = peak - fx(p.lo);
      if (d > dd) dd = d;
    }
    const top = fx(p.hi) > fx(p.pnl) ? fx(p.hi) : fx(p.pnl);
    if (peak === null || top > peak) peak = top;
  }
  return dd;
}

export interface MetricsInput {
  range: Range;
  nowMs: number;
  /** Start of the `all` range. */
  createdAtMs: number;
  /** Every journal fill of the bot, oldest first (the cost basis needs the history before the range). */
  fills: readonly JournalFill[];
  /** History points of the range, from the tier of the range (`HistoryStore.read(...).points`). */
  points: readonly HistoryPoint[];
  /** Order attempts from the log. Default: distinct orders with a fill in the range. */
  orders?: number;
}

export function computeMetrics(inp: MetricsInput): BotMetrics {
  const win = RANGE_MS[inp.range];
  const fromMs = win !== null ? inp.nowMs - win : Math.max(0, inp.createdAtMs);
  const toMs = inp.nowMs;

  const realized = realizedByFill(inp.fills);
  let realizedSum = 0n;
  let turnover = 0n;
  let fees = 0n;
  let nFills = 0;
  const inRangeOids = new Set<number>();
  const sells = new Map<number, { sum: Fx; lastMs: number }>();
  inp.fills.forEach((f, i) => {
    const r = realized[i] ?? null;
    const inRange = f.time_ms >= fromMs && f.time_ms <= toMs;
    if (inRange) {
      nFills++;
      inRangeOids.add(f.oid);
      turnover += (fx(f.px) * fx(f.sz)) / SCALE;
      fees += feeInUsdc(f);
      if (r !== null) realizedSum += r;
    }
    if (f.side === "sell" && r !== null) {
      const o = sells.get(f.oid) ?? { sum: 0n, lastMs: 0 };
      o.sum += r;
      o.lastMs = Math.max(o.lastMs, f.time_ms);
      sells.set(f.oid, o);
    }
  });

  let closed = 0;
  let wins = 0;
  let closedSum = 0n;
  for (const o of sells.values()) {
    if (o.lastMs < fromMs || o.lastMs > toMs) continue;
    closed++;
    closedSum += o.sum;
    if (o.sum > 0n) wins++;
  }

  const first = inp.points[0];
  const last = inp.points[inp.points.length - 1];
  const change = first !== undefined && last !== undefined ? fx(last.pnl) - fx(first.pnl) : 0n;

  return {
    range: inp.range,
    from_ms: fromMs,
    to_ms: toMs,
    closed_trades: closed,
    win_rate: closed === 0 ? null : ratio4(BigInt(wins), BigInt(closed)),
    avg_trade_usdc: closed === 0 ? null : fxStr(closedSum / BigInt(closed)),
    realized_usdc: fxStr(realizedSum),
    pnl_change_usdc: fxStr(change),
    max_drawdown_usdc: fxStr(maxDrawdown(inp.points)),
    turnover_usdc: fxStr(turnover),
    fees_usdc: fxStr(fees),
    fills: nFills,
    orders: inp.orders ?? inRangeOids.size,
  };
}
