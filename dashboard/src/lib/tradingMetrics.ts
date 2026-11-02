// Pure helpers for the bot pages (ADR-0006 §7, §9): ranges and candle intervals, chart markers, number formatting, and a
// client-side version of the worker's metrics for the fallback (when the worker has no /trading/bots yet).
import type { BotFill, BotMetrics, HistoryPoint } from "./tradingClient";
import { fmtDec, fmtSigned } from "./tradingView";

export const RANGES = ["1h", "1d", "1w", "1m", "all"] as const;
export type HistoryRange = (typeof RANGES)[number];
export const isRange = (v: unknown): v is HistoryRange => typeof v === "string" && (RANGES as readonly string[]).includes(v);

const H = 3_600_000;
const D = 24 * H;
export const RANGE_MS: Record<Exclude<HistoryRange, "all">, number> = { "1h": H, "1d": D, "1w": 7 * D, "1m": 30 * D };

/** Hyperliquid `candleSnapshot` interval for a chart range (ADR-0006 §9). */
export type CandleInterval = "1m" | "15m" | "1h" | "4h" | "1d";
const INTERVAL: Record<HistoryRange, CandleInterval> = { "1h": "1m", "1d": "15m", "1w": "1h", "1m": "4h", all: "1d" };
export const candleInterval = (r: HistoryRange): CandleInterval => INTERVAL[r];
export const INTERVAL_MS: Record<CandleInterval, number> = { "1m": 60_000, "15m": 15 * 60_000, "1h": H, "4h": 4 * H, "1d": D };

/** Start of the data window. `all` starts when the bot was created (or the first thing we know of it). */
export function rangeStartMs(range: HistoryRange, nowMs: number, createdAtMs: number | null): number {
  if (range !== "all") return nowMs - RANGE_MS[range];
  return createdAtMs !== null && createdAtMs > 0 ? createdAtMs : nowMs - RANGE_MS["1m"];
}
/** Candles for `all` reach back at least 30 days so a bot created today still shows context. */
export function candleStartMs(range: HistoryRange, nowMs: number, createdAtMs: number | null): number {
  const from = rangeStartMs(range, nowMs, createdAtMs);
  return range === "all" ? Math.min(from, nowMs - RANGE_MS["1m"]) : from;
}

/* ───────────── markers ───────────── */

export interface FillMarker {
  /** Unix seconds, snapped to the candle that contains the fill (lightweight-charts wants the bar time). */
  time: number;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** The exact fill time (the marker time is snapped to the candle). */
  timeMs: number;
}
export const MAX_MARKERS = 500;

/** Fills inside the range (newest 500) as chart markers, oldest first, snapped to their candle. */
export function fillMarkers(fills: readonly BotFill[], fromMs: number, interval: CandleInterval, max = MAX_MARKERS): FillMarker[] {
  const step = INTERVAL_MS[interval];
  return fills
    .filter((f) => f.time_ms >= fromMs && Number.isFinite(Number(f.price)))
    .sort((a, b) => b.time_ms - a.time_ms)
    .slice(0, max)
    .sort((a, b) => a.time_ms - b.time_ms)
    .map((f) => ({ time: Math.floor(f.time_ms / step) * (step / 1000), side: f.side, price: Number(f.price), size: Number(f.size), timeMs: f.time_ms }));
}

/* ───────────── formatting ───────────── */

const NUM = /^-?\d+(\.\d+)?$/;
/** Money for a row or a stat: 2 decimals from 1 up, 4 below (fees of a few cents stay visible). Unknown -> an em dash. */
export function fmtMoney(v: string | null): string {
  if (v === null || !NUM.test(v)) return "—";
  return fmtDec(v, Math.abs(Number(v)) >= 1 || Number(v) === 0 ? 2 : 4);
}
export function fmtMoneySigned(v: string | null): string {
  if (v === null || !NUM.test(v)) return "—";
  return fmtSigned(v, Math.abs(Number(v)) >= 1 || Number(v) === 0 ? 2 : 4);
}
/** `"0.5714"` -> `"57%"`. No closed trades -> an em dash. */
export function fmtWinRate(v: string | null): string {
  if (v === null || !NUM.test(v)) return "—";
  return `${Math.round(Number(v) * 100)}%`;
}
/** Size of a fill or a position: up to 6 significant decimals, trailing zeros trimmed. */
export function fmtSize(v: string): string {
  if (!NUM.test(v)) return v;
  const n = Number(v);
  if (n === 0) return "0";
  return n.toFixed(Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 6).replace(/\.?0+$/, "");
}
/** Price with sensible precision (more decimals for cheap coins). */
export function fmtPrice(v: string | number): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 6 });
}
export const sparkNumbers = (spark: readonly string[]): number[] => spark.map(Number).filter(Number.isFinite);

/* ───────────── metrics (fallback; the worker computes the real ones) ───────────── */

/** Realized P&L per sell by average cost per pair (ADR-0006 §7), over the whole list. Returns new objects, oldest first. */
export function withRealized(fills: readonly BotFill[]): BotFill[] {
  const book = new Map<string, { size: number; cost: number }>();
  return [...fills]
    .sort((a, b) => a.time_ms - b.time_ms || (a.tid ?? 0) - (b.tid ?? 0))
    .map((f) => {
      const b = book.get(f.pair) ?? { size: 0, cost: 0 };
      book.set(f.pair, b);
      const px = Number(f.price);
      const sz = Number(f.size);
      const fee = Number(f.fee_usdc);
      if (f.side === "buy") {
        const baseFee = f.fee_token !== "USDC" && px > 0 ? fee / px : 0;
        b.cost += px * sz + (f.fee_token === "USDC" ? fee : 0);
        b.size += sz - baseFee;
        return f;
      }
      if (b.size <= 0 || sz <= 0) return { ...f, realized_usdc: null };
      const avg = b.cost / b.size;
      const used = Math.min(sz, b.size);
      b.cost -= used * avg;
      b.size -= used;
      return { ...f, realized_usdc: (sz * (px - avg) - fee).toFixed(6) };
    });
}

/** Max drop from a previous high on the P&L curve, bucket resolution (`lo` vs the running max of `hi`/`pnl`). */
export function maxDrawdown(points: readonly HistoryPoint[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const p of points) {
    const lo = Number(p.lo);
    if (Number.isFinite(peak) && Number.isFinite(lo)) dd = Math.max(dd, peak - lo);
    peak = Math.max(peak, Number(p.hi), Number(p.pnl));
  }
  return dd;
}

export function computeMetrics(input: { fills: readonly BotFill[]; points: readonly HistoryPoint[]; range: HistoryRange; fromMs: number; toMs: number; orders?: number }): BotMetrics {
  const all = withRealized(input.fills);
  const inRange = all.filter((f) => f.time_ms >= input.fromMs && f.time_ms <= input.toMs);
  // A closed trade is one sell order (oid), the sum of its fills.
  const sells = new Map<number, number>();
  for (const f of inRange) if (f.side === "sell") sells.set(f.oid, (sells.get(f.oid) ?? 0) + Number(f.realized_usdc ?? 0));
  const results = [...sells.values()];
  const realized = inRange.reduce((s, f) => s + (f.side === "sell" ? Number(f.realized_usdc ?? 0) : 0), 0);
  const pts = input.points.filter((p) => p.t >= input.fromMs && p.t <= input.toMs);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return {
    range: input.range,
    from_ms: input.fromMs,
    to_ms: input.toMs,
    closed_trades: results.length,
    win_rate: results.length ? (results.filter((r) => r > 0).length / results.length).toFixed(4) : null,
    avg_trade_usdc: results.length ? (results.reduce((s, r) => s + r, 0) / results.length).toFixed(6) : null,
    realized_usdc: realized.toFixed(6),
    pnl_change_usdc: first && last ? (Number(last.pnl) - Number(first.pnl)).toFixed(6) : "0",
    max_drawdown_usdc: maxDrawdown(pts).toFixed(6),
    turnover_usdc: inRange.reduce((s, f) => s + Number(f.price) * Number(f.size), 0).toFixed(6),
    fees_usdc: inRange.reduce((s, f) => s + Number(f.fee_usdc), 0).toFixed(6),
    fills: inRange.length,
    orders: input.orders ?? new Set(inRange.map((f) => f.oid)).size,
  };
}

/* ───────────── local P&L samples (fallback history) ───────────── */

/** One sample of the account P&L, taken whenever the dashboard reads /trading/status. [t_ms, total, today]. */
export type PnlSample = readonly [number, string, string];
export const SAMPLE_GAP_MS = 60_000;
export const SAMPLE_KEEP_MS = 35 * D;
export const SAMPLE_MAX = 4000;

/** Appends a sample (at most one per minute), drops old ones. Pure. */
export function addSample(list: readonly PnlSample[], now: number, total: string, today: string): PnlSample[] {
  if (!NUM.test(total) || !NUM.test(today)) return [...list];
  const keep = list.filter((s) => now - s[0] <= SAMPLE_KEEP_MS);
  const last = keep[keep.length - 1];
  if (last && now - last[0] < SAMPLE_GAP_MS) return keep;
  return [...keep, [now, total, today] as const].slice(-SAMPLE_MAX);
}

export function samplesToPoints(list: readonly PnlSample[], fromMs: number, toMs: number): HistoryPoint[] {
  return list.filter((s) => s[0] >= fromMs && s[0] <= toMs).map(([t, pnl, today]) => ({ t, pnl, lo: pnl, hi: pnl, today, val: "0", px: {} }));
}

/** 24 hourly closes of the total P&L, oldest first (the list sparkline). Hours without a sample repeat the last known value. */
export function hourlySpark(list: readonly PnlSample[], nowMs: number, n = 24): string[] {
  if (list.length === 0) return [];
  const out: string[] = [];
  let k = 0;
  let cur: string | null = null;
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  for (let i = n - 1; i >= 0; i--) {
    const end = nowMs - i * H;
    while (k < sorted.length && sorted[k]![0] <= end) cur = sorted[k++]![1];
    if (cur !== null) out.push(cur);
  }
  return out;
}

/** Local time of the owner's browser for a table cell ("3 Nov, 14:05"); the UTC string goes into a tooltip. */
export function fmtLocalTime(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
