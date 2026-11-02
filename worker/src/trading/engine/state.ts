/**
 * Persisted engine state, version 2 (ADR-0006 section 4): one account block plus one block per bot. JSON-serializable.
 *
 * Account block = everything that belongs to the single Hyperliquid account: the day snapshot, the sticky account halt, the
 * account-wide stops (ACCOUNT_LOSS_STOP / EQUITY_DROP), the cloid counter, the dead-man switch, the fill read cursor.
 * Bot block   = what belongs to one rule set: cooldowns, resting orders, order counts, the bot's own halt and loss stop, and the
 *               running sums of the bot's own fills (`agg`), from which its position and P&L come.
 *
 * `version: 1` files (single bot) are converted once on load by `migrateV1` (engine/migrate.ts).
 */
import type { HaltReason } from "../types.js";
import type { BotAgg, FillCursor } from "./fills.js";
import type { DaySnapshot } from "./pnl.js";

export interface LogEntry {
  at_ms: number;
  kind: "order" | "skip" | "cancel" | "topup" | "state";
  rule_id?: string;
  /** Bot the entry is about (absent = account-level). */
  bot_id?: string;
  detail: string;
  cloid?: string;
  oid?: number;
}

export type HaltRecord = { reason: HaltReason; atMs: number; detail: string };

export interface AccountState {
  day: DaySnapshot | null;
  /** Sticky account-wide halt (perp alarm, kill all). Overrides every bot; cleared by any owner confirm. */
  halt: HaltRecord | null;
  /** UTC day index on which the ACCOUNT stopped (summed loss stop or equity backstop); resumes when the day index changes. */
  stoppedDayIndex: number | null;
  stopReason: "ACCOUNT_LOSS_STOP" | "EQUITY_DROP" | null;
  /** Monotonic cloid counter, one for the whole account (cloids stay unique). */
  orderCounter: number;
  /** Order attempts of all bots on `day` (including rejected and unfilled ones). */
  ordersToday: number;
  deadManAtMs: number | null;
  /** See ADR-0005 "scheduleCancel volume gate": set while HL refuses the dead-man switch; then IOC orders only, for all bots. */
  deadManGatedAtMs: number | null;
  lastTickMs: number | null;
  /** Bounded in-memory log (MAX_RECENT), newest last. */
  recent: LogEntry[];
  /** `state|reason` of the last state entry written to the log; a state entry is appended only when it changes. */
  lastStateKey: string | null;
  lastStateRepeats: number;
  /** Null until the first successful fills read (operator reset: set to null with the worker stopped). */
  fillCursor: FillCursor | null;
}

export interface BotEngineState {
  /** Rule set the per-rule fields below belong to. A new hash resets `firedAt`. */
  rulesHash: string | null;
  /** rule id -> ms of the last placement attempt. */
  firedAt: Record<string, number>;
  /** cloid -> rule and optional expiry of resting orders we placed (GTC limit orders have a ttl). */
  orders: Record<string, { ruleId: string; expiresAtMs: number | null }>;
  /** rule id -> last logged skip code, to avoid logging the same rejection every tick. */
  lastSkip: Record<string, string>;
  /** Order attempts on `account.day`. */
  ordersToday: number;
  /** Orders placed on `day` that HL reported as filled; if > 0 while no bot fill is found, attribution is broken. */
  filledOrdersToday: number;
  filledOidsToday: number[];
  /** UTC day index on which THIS bot's daily loss stop fired. */
  stoppedDayIndex: number | null;
  stopReason: "DAILY_LOSS_STOP" | null;
  /** Sticky per-bot halt (kill one bot, perp alarm, kill all). Cleared only by confirming a rule set for this bot. */
  halt: HaltRecord | null;
  agg: BotAgg;
  /** cloid (lower case) -> rule id, the 200 newest: lets the fills journal say which rule placed a fill. */
  cloidRule?: Record<string, string>;
  /** The bot's OWN holdings at the day snapshot (from its fills): the loss stop marks these, never the account's. */
  startPositions: Record<string, { size: string; mid: string }>;
}

export interface EngineStateV2 {
  version: 2;
  account: AccountState;
  /** order id -> bot id, the 500 newest. */
  oidBot: Record<string, string>;
  bots: Record<string, BotEngineState>;
}

/** Engine state type used everywhere. */
export type EngineState = EngineStateV2;

export function emptyBotState(totalComplete = true): BotEngineState {
  return {
    rulesHash: null,
    firedAt: {},
    orders: {},
    lastSkip: {},
    ordersToday: 0,
    filledOrdersToday: 0,
    filledOidsToday: [],
    stoppedDayIndex: null,
    stopReason: null,
    halt: null,
    agg: { total: {}, today: {}, totalComplete, botFillsToday: 0, botOidsToday: [], basis: {} },
    startPositions: {},
  };
}

export function initialEngineState(): EngineStateV2 {
  return {
    version: 2,
    account: {
      day: null,
      halt: null,
      stoppedDayIndex: null,
      stopReason: null,
      orderCounter: 0,
      ordersToday: 0,
      deadManAtMs: null,
      deadManGatedAtMs: null,
      lastTickMs: null,
      recent: [],
      lastStateKey: null,
      lastStateRepeats: 0,
      fillCursor: null,
    },
    oidBot: {},
    bots: {},
  };
}

/**
 * Kill all / perp alarm: the account halts AND every bot named in `botIds` (plus every bot that has a state block) halts, so a
 * later confirm of ONE bot clears the account halt and that bot only.
 */
export function haltAll(s: EngineStateV2, atMs: number, reason: HaltReason, detail: string, botIds: readonly string[] = []): EngineStateV2 {
  const bots: Record<string, BotEngineState> = {};
  for (const id of new Set([...Object.keys(s.bots), ...botIds])) {
    const b = s.bots[id] ?? emptyBotState();
    bots[id] = { ...b, halt: b.halt ?? { reason, atMs, detail } };
  }
  return { ...s, account: { ...s.account, halt: s.account.halt ?? { reason, atMs, detail } }, bots };
}

/** Kill one bot: only that bot stops; the account and the other bots continue. */
export function haltBot(s: EngineStateV2, botId: string, atMs: number, reason: HaltReason, detail: string): EngineStateV2 {
  const b = s.bots[botId] ?? emptyBotState();
  return { ...s, bots: { ...s.bots, [botId]: { ...b, halt: { reason, atMs, detail } } } };
}

/**
 * Called after a rule set was confirmed for `botId` (the route must first refuse while a perp is still open): clears that
 * bot's halt and the account halt. Other bots stay halted until each is confirmed.
 */
export function clearHalt(s: EngineStateV2, botId: string): EngineStateV2 {
  const b = s.bots[botId];
  return {
    ...s,
    account: { ...s.account, halt: null },
    bots: b === undefined ? s.bots : { ...s.bots, [botId]: { ...b, halt: null } },
  };
}
