/**
 * Trigger evaluation, exactly as in the DSL (ADR-0005 "Rules DSL v1"). No clock: `nowMs` is an argument.
 * Comparisons are exact bigint cross-multiplications, there is no float division.
 */
import type { Cooldown, Every, HlCandle, Trigger, Ttl, Window } from "../types.js";
import type { CostBasis } from "./pnl.js";
import { type Fx, SCALE, fx } from "./risk.js";

export const DURATION_MS: Record<Window | Every | Ttl | Cooldown, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
};

/** The finest candle the port offers (`Window`); it is used for every price_change window. */
const CANDLE_INTERVAL: Window = "1h";
const CANDLE_MS = DURATION_MS[CANDLE_INTERVAL];

export interface TriggerEnv {
  nowMs: number;
  pair: string;
  mid: Fx;
  /** Last placement attempt of this rule (ms); undefined = never fired under this rule set. */
  lastFiredAtMs: number | undefined;
  cost: CostBasis;
  getCandles: (pair: string, interval: Window, startMs: number, endMs: number) => Promise<HlCandle[]>;
}

export type TriggerResult = { fired: boolean; detail: string };

const cmp = (op: "lte" | "gte", lhs: bigint, rhs: bigint): boolean => (op === "lte" ? lhs <= rhs : lhs >= rhs);

/**
 * Reference close for `price_change`: the close of the last 1h candle that CLOSED at or before `now - window` (candle
 * open + 1h <= now - window). So the reference is the price at the hour boundary at or just before `window` ago, which
 * is at most 1 h older than the window. (The ADR wording "candle starting window ago" read literally would be the
 * current candle for the same-size interval; see the report.) null when no such candle exists.
 */
export function referenceClose(candles: readonly HlCandle[], nowMs: number, window: Window): Fx | null {
  const t = nowMs - DURATION_MS[window];
  let best: HlCandle | null = null;
  for (const c of candles) {
    if (c.openTimeMs + CANDLE_MS > t) continue;
    if (best === null || c.openTimeMs > best.openTimeMs) best = c;
  }
  return best === null ? null : fx(best.close);
}

export async function evalTrigger(t: Trigger, env: TriggerEnv): Promise<TriggerResult> {
  switch (t.type) {
    case "price": {
      const thr = fx(t.usdc);
      return { fired: cmp(t.op, env.mid, thr), detail: `mid ${env.mid} vs ${t.usdc}` };
    }
    case "interval": {
      const every = DURATION_MS[t.every];
      const due = env.lastFiredAtMs === undefined || env.nowMs - env.lastFiredAtMs >= every;
      return { fired: due, detail: env.lastFiredAtMs === undefined ? "first run" : `last fired ${env.nowMs - env.lastFiredAtMs} ms ago` };
    }
    case "price_change": {
      const ref = referenceClose(
        await env.getCandles(env.pair, CANDLE_INTERVAL, env.nowMs - DURATION_MS[t.window] - 3 * CANDLE_MS, env.nowMs),
        env.nowMs,
        t.window,
      );
      if (ref === null || ref <= 0n) return { fired: false, detail: "no reference candle" };
      // (mid - ref) / ref * 100 <op> pct   <=>   (mid - ref) * 100 <op> pct * ref   (ref > 0). both sides are scaled by SCALE^2 so nothing is truncated.
      const lhs = (env.mid - ref) * 100n;
      return { fired: cmp(t.op, lhs * SCALE, fx(t.pct) * ref), detail: `ref ${ref} mid ${env.mid} vs ${t.pct}%` };
    }
    case "position_pnl": {
      if (env.cost.size <= 0n || env.cost.avgCost <= 0n) return { fired: false, detail: "flat" };
      const lhs = (env.mid - env.cost.avgCost) * 100n;
      return { fired: cmp(t.op, lhs * SCALE, fx(t.pct) * env.cost.avgCost), detail: `avg cost ${env.cost.avgCost} mid ${env.mid} vs ${t.pct}%` };
    }
  }
}
