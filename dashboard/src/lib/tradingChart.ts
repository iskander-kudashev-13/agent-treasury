/** Pure data shaping for the charts (lightweight-charts wants strictly ascending unique `time` in seconds). */
import type { HistoryPoint } from "./tradingClient";
import type { Candle } from "./tradingBots";

export interface LinePoint {
  time: number;
  value: number;
}

/** P&L points -> a line: seconds, ascending, one value per second (last wins), non-numbers dropped. */
export function pnlSeries(points: readonly HistoryPoint[]): LinePoint[] {
  const byTime = new Map<number, number>();
  for (const p of points) {
    const v = Number(p.pnl);
    if (Number.isFinite(v) && Number.isFinite(p.t)) byTime.set(Math.floor(p.t / 1000), v);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

/** Candles, ascending and unique by time. */
export function candleSeries(candles: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** `#rrggbb` + alpha -> `rgba(...)`; anything else is returned unchanged (the chart cannot parse CSS variables). */
export function hexA(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Close prices as a line (same ordering rules as the candles). */
export function lineSeries(candles: readonly Candle[]): LinePoint[] {
  return candleSeries(candles).map((c) => ({ time: c.time, value: c.close }));
}

/**
 * Decimals for the price axis: enough that the visible range shows a few distinct steps (a cheap junk coin moving by a
 * thousandth needs 4-5 decimals, a 2000-dollar coin needs 2), never fewer than 2 nor more than 8.
 */
export function pricePrecision(values: readonly number[]): number {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return 2;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo > 0 ? hi - lo : Math.abs(hi) * 0.01;
  if (!(span > 0)) return 2;
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(span / 20))));
}
