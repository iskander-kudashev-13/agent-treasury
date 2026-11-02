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
