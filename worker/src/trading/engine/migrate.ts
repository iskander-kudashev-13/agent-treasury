/**
 * One-time conversion of the single-bot engine state (`version: 1`, ADR-0005) to the multi-bot state (`version: 2`, ADR-0006).
 * A pure function: no file access (the service writes `engine-state.v1.json` and the new file).
 *
 * Lossless and idempotent by construction:
 *  - everything per rule set (cooldowns, resting orders, order counts, fill sums, cost bases, remembered order ids) goes to the
 *    bot `default`; so does the current position, which is just the sums of the fills that were attributed to the old bot;
 *  - the halt is copied to the account AND to `default`; a loss stop that fired for `DAILY_LOSS_STOP` stays with `default`,
 *    one for `EQUITY_DROP` becomes the account's;
 *  - the day snapshot and the order counter stay account-wide, so cloids stay unique and the day does not restart;
 *  - the old `startPositions` (every allowed coin the account held at the snapshot) become `default`'s start positions, so on
 *    the migrated day its loss stop marks exactly what it marked before; from the next UTC day on, a bot only marks its own
 *    holdings (ADR-0006 section 3);
 *  - a version-2 state is returned as it is.
 * The cloid prefixes the old engine remembered (`botPrefixes`) are returned separately: they are not engine state any more,
 * the permanent prefix registry (`bots.json`) owns them.
 */
import { SCALE, cloidPrefix, fx, fxStr } from "./risk.js";
import type { AggMap, BotAgg, FillCursor } from "./fills.js";
import type { DaySnapshot } from "./pnl.js";
import { DEFAULT_BOT_ID } from "../types.js";
import type { HaltReason } from "../types.js";
import { type BotEngineState, type EngineStateV2, type LogEntry, emptyBotState, initialEngineState } from "./state.js";

/** The old `FillTracker`. */
export interface V1Tracker {
  cursorMs: number;
  seen: { k: string; t: number }[];
  totalComplete: boolean;
  completeFromMs?: number;
  todayFromMs: number | null;
  total: AggMap;
  today: AggMap;
  botFillsToday: number;
  botOidsToday?: number[];
  basis?: Record<string, Record<string, { size: string; cost: string }>>;
  foreignFills: number;
}

/** The old single-bot state (as written by workers before 2026-11-03). */
export interface EngineStateV1 {
  version: 1;
  rulesHash: string | null;
  day: DaySnapshot | null;
  ordersToday: number;
  stoppedDayIndex: number | null;
  halt: { reason: HaltReason; atMs: number; detail: string } | null;
  orderCounter: number;
  firedAt: Record<string, number>;
  orders: Record<string, { ruleId: string; expiresAtMs: number | null }>;
  lastSkip: Record<string, string>;
  deadManAtMs: number | null;
  deadManGatedAtMs: number | null;
  lastTickMs: number | null;
  recent: LogEntry[];
  botPrefixes: string[];
  botOids: number[];
  prefixesDropped: number;
  fills: V1Tracker | null;
  stopReason: "DAILY_LOSS_STOP" | "EQUITY_DROP" | null;
  filledOrdersToday: number;
  filledOidsToday: number[];
  lastStateKey: string | null;
  lastStateRepeats: number;
}

/** Defaults for the fields older v1 files may lack (the loader merges them under the file's own values). */
export function initialEngineStateV1(): EngineStateV1 {
  return {
    version: 1,
    rulesHash: null,
    day: null,
    ordersToday: 0,
    stoppedDayIndex: null,
    halt: null,
    orderCounter: 0,
    firedAt: {},
    orders: {},
    lastSkip: {},
    deadManAtMs: null,
    deadManGatedAtMs: null,
    lastTickMs: null,
    recent: [],
    botPrefixes: [],
    botOids: [],
    prefixesDropped: 0,
    fills: null,
    stopReason: null,
    filledOrdersToday: 0,
    filledOidsToday: [],
    lastStateKey: null,
    lastStateRepeats: 0,
  };
}

const MAX_OIDS = 500;
const PREFIX = /^0x[0-9a-f]{16}$/;

export interface Migrated {
  state: EngineStateV2;
  /** Every cloid prefix the old engine attributed to its bot, oldest first (for `bots.json`). */
  prefixes: string[];
}

/** `completeFromMs` of an old tracker: absent means 0 if the total was complete, else "never" (a safe integer stands for infinity in JSON). */
const NEVER = Number.MAX_SAFE_INTEGER;

/**
 * v1 sums have no `feeBase` (base-token fees on buys), so a migrated bot would think it holds `dq` coins when it really holds
 * `dq - fees paid in coins`. Rebuilds an estimate from what v1 did keep: `fees` (USDC value of ALL fees) and prices. Each base
 * fee was valued at its fill's price, so base fee = fees / price. The price used is the LOWER of the last fill price and the
 * average buy price: a lower price gives a larger fee, i.e. a smaller position. Wrong in the safe direction (selling a bit less
 * than held) when sells paid USDC fees or the price drifted; never above the real position by more than rounding.
 */
function withEstimatedFeeBase(m: AggMap): AggMap {
  const out: AggMap = {};
  for (const [pair, a] of Object.entries(m)) {
    if (a.feeBase !== undefined) {
      out[pair] = a;
      continue;
    }
    const dq = fx(a.dq);
    const fees = fx(a.fees);
    let px = fx(a.lastPx);
    const cash = fx(a.cash);
    if (dq > 0n && cash < 0n) {
      const avg = (-cash * SCALE) / dq;
      if (avg > 0n && (px <= 0n || avg < px)) px = avg;
    }
    if (dq <= 0n || fees <= 0n || px <= 0n) {
      out[pair] = a;
      continue;
    }
    let est = (fees * SCALE) / px;
    if (est > dq) est = dq;
    out[pair] = { ...a, feeBase: fxStr(est, 12) };
  }
  return out;
}

function migrateTracker(t: V1Tracker): { cursor: FillCursor; agg: BotAgg } {
  const cursor: FillCursor = {
    cursorMs: t.cursorMs,
    seen: t.seen,
    completeFromMs: t.completeFromMs ?? (t.totalComplete ? 0 : NEVER),
    todayFromMs: t.todayFromMs,
    foreignFills: t.foreignFills,
  };
  const agg: BotAgg = {
    total: withEstimatedFeeBase(t.total),
    today: withEstimatedFeeBase(t.today),
    totalComplete: t.totalComplete,
    botFillsToday: t.botFillsToday,
    botOidsToday: t.botOidsToday ?? [],
    basis: t.basis ?? {},
  };
  return { cursor, agg };
}

/** Converts a v1 state. `v1` must already have passed the loader's shape checks (the service validates before calling). */
export function migrateV1(v1: EngineStateV1): Migrated {
  const s = initialEngineState();
  const bot: BotEngineState = emptyBotState();
  const accountStop = v1.stoppedDayIndex !== null && v1.stopReason === "EQUITY_DROP";
  s.account = {
    ...s.account,
    day: v1.day,
    halt: v1.halt,
    stoppedDayIndex: accountStop ? v1.stoppedDayIndex : null,
    stopReason: accountStop ? "EQUITY_DROP" : null,
    orderCounter: v1.orderCounter,
    ordersToday: v1.ordersToday,
    deadManAtMs: v1.deadManAtMs,
    deadManGatedAtMs: v1.deadManGatedAtMs,
    lastTickMs: v1.lastTickMs,
    recent: v1.recent,
    lastStateKey: v1.lastStateKey,
    lastStateRepeats: v1.lastStateRepeats,
  };
  bot.rulesHash = v1.rulesHash;
  bot.firedAt = v1.firedAt;
  bot.orders = v1.orders;
  bot.lastSkip = v1.lastSkip;
  bot.ordersToday = v1.ordersToday;
  bot.filledOrdersToday = v1.filledOrdersToday;
  bot.filledOidsToday = v1.filledOidsToday;
  bot.halt = v1.halt;
  if (v1.stoppedDayIndex !== null && !accountStop) {
    bot.stoppedDayIndex = v1.stoppedDayIndex;
    bot.stopReason = "DAILY_LOSS_STOP";
  }
  bot.startPositions = v1.day?.startPositions ?? {};
  if (v1.fills !== null) {
    const m = migrateTracker(v1.fills);
    s.account.fillCursor = m.cursor;
    bot.agg = m.agg;
  }
  s.bots[DEFAULT_BOT_ID] = bot;
  for (const oid of v1.botOids.slice(-MAX_OIDS)) s.oidBot[String(oid)] = DEFAULT_BOT_ID;

  const prefixes: string[] = [];
  const add = (p: string): void => {
    const x = p.toLowerCase();
    if (PREFIX.test(x) && !prefixes.includes(x)) prefixes.push(x);
  };
  for (const p of v1.botPrefixes) add(p);
  if (v1.rulesHash !== null) add(cloidPrefix(v1.rulesHash));
  for (const c of Object.keys(v1.orders)) add(c.slice(0, 18));
  return { state: s, prefixes };
}
