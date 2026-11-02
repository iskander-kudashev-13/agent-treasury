/**
 * One engine tick (ADR-0005 section 7). Deterministic: no LLM, no `Date.now()`, no randomness. The caller injects the
 * time, the HL port, a vault-status function and the persisted state, and gets back the next state, the status pieces
 * and the decision log entries. The caller (store/route, W4/W5) persists `state` and appends `entries`.
 *
 * Sequence:
 *   1 read state (HL + vault)          2 perp alarm (halt, cancel, no trading)   3 on-chain / API wallet / rules / data gates
 *   4 scheduleCancel refresh BEFORE any order     5 UTC day rollover + loss stop
 *   6 cancel expired / stale orders    7 evaluate rules in order, size, risk-check, place     8 persist (caller)
 * The funding top-up (ADR step 8) is not part of this function; it lives in funding.ts.
 */
import { effectiveCooldown } from "../rules/describe.js";
import type {
  AgentStatus,
  Dec,
  HaltReason,
  HlFill,
  HlOpenOrder,
  HlOrderResult,
  HlPort,
  HlSpotPair,
  HardLimits,
  RuleSetV1,
  TradingState,
  TradingStatus,
} from "../types.js";
import { isFillsTruncated } from "../hl/pagination.js";
import { type FillTracker, applyFills, basisOf, completeFrom, emptyTracker, readFrom, rollToday } from "./fills.js";
import { type DaySnapshot, type Equity, type VaultTopup, backstopEquity, computeEquity, pnlSummary, rollDay, utcDayIndex } from "./pnl.js";
import {
  type EffectiveLimits,
  type Fx,
  checkOrder,
  describeMinOrder,
  minOrderAdvice,
  cloidPrefix,
  cooldownActive,
  effectiveLimits,
  effectiveLimitsStatus,
  fx,
  fxMul,
  fxStr,
  makeCloid,
  sizeOrder,
} from "./risk.js";
import { DURATION_MS, evalTrigger } from "./triggers.js";

// ---------------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------------

export interface LogEntry {
  at_ms: number;
  kind: "order" | "skip" | "cancel" | "topup" | "state";
  rule_id?: string;
  detail: string;
  cloid?: string;
  oid?: number;
}

export const MAX_RECENT = 100;
/** Dead-man refresh is only trusted for orders if the HL adapter confirms it; see the report. */
export const MIN_API_WALLET_VALIDITY_MS = 3_600_000;
export const MAX_ORDERS_PER_TICK = 2;
/** Perp account value above this (USDC) counts as a perp position. */
const PERP_VALUE_ALARM = "1";
/** Rule sets remembered for fill attribution. */
const MAX_BOT_PREFIXES = 64;
/** Order ids remembered for fill attribution (fallback when the cloid on a fill is missing or foreign). */
const MAX_BOT_OIDS = 500;
/** Fill timestamps this far ahead of the local clock mean the clocks disagree (HL stamps fills with its own clock). */
const CLOCK_SKEW_WARN_MS = 60_000;
const BOT_PREFIX = /^0x[0-9a-f]{16}$/;
/** HL's refusal text: "Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0." */
export const VOLUME_GATE_RE = /enough volume traded/i;
export const DEADMAN_RETRY_MS = 3_600_000;

/** Everything the engine persists between ticks. JSON-serializable. */
export interface EngineState {
  version: 1;
  /** Rule set the per-rule fields below belong to. A new hash resets `firedAt`. */
  rulesHash: string | null;
  day: DaySnapshot | null;
  /** Order attempts on `day` (including rejected and unfilled ones). */
  ordersToday: number;
  /** UTC day index on which the daily loss stop fired; trading resumes when the day index changes. */
  stoppedDayIndex: number | null;
  /** Sticky. Cleared only by `clearHalt` after a newly signed rule set is confirmed. */
  halt: { reason: HaltReason; atMs: number; detail: string } | null;
  /** Monotonic cloid counter. */
  orderCounter: number;
  /** rule id -> ms of the last placement attempt. */
  firedAt: Record<string, number>;
  /** cloid -> rule and optional expiry of resting orders we placed (GTC limit orders have a ttl). */
  orders: Record<string, { ruleId: string; expiresAtMs: number | null }>;
  /** rule id -> last logged skip code, to avoid logging the same rejection every tick. */
  lastSkip: Record<string, string>;
  deadManAtMs: number | null;
  /**
   * Set (ms of the last refusal) while HL refuses scheduleCancel because the account has not traded enough volume
   * ("Cannot set scheduled cancel time until enough volume traded"). Then only IOC orders are placed, resting bot orders are
   * cancelled, and the switch is tried again at most once per DEADMAN_RETRY_MS.
   */
  deadManGatedAtMs: number | null;
  lastTickMs: number | null;
  /** Bounded in-memory log (MAX_RECENT), newest last. */
  recent: LogEntry[];
  /** Cloid prefixes of every rule set the bot activated (bounded). Fills carrying one are the bot's own, for the loss stop. */
  botPrefixes: string[];
  /** Order ids HL returned for orders the bot placed (bounded, newest last). Fills are the bot's on cloid prefix OR oid. */
  botOids: number[];
  /** How many old prefixes fell off `botPrefixes`: their fills are no longer attributed to the bot. */
  prefixesDropped: number;
  /** Running per-pair sums of the bot's fills + read cursor (engine/fills.ts). Null until the first successful read. */
  fills: FillTracker | null;
  /** Why the loss stop fired on `stoppedDayIndex`. */
  stopReason: "DAILY_LOSS_STOP" | "EQUITY_DROP" | null;
  /** Orders placed on `day` that HL reported as filled; if > 0 while no bot fill is found, attribution is broken. */
  filledOrdersToday: number;
  /** Order ids of those orders (bounded): every one must show up among the attributed fills, else FILLS_NOT_ATTRIBUTED. */
  filledOidsToday: number[];
  /** `state|reason` of the last state entry written to the log; a state entry is appended only when it changes. */
  lastStateKey: string | null;
  /** Ticks spent in `lastStateKey` since it was logged (the repeats that were not logged). */
  lastStateRepeats: number;
}

export function initialEngineState(): EngineState {
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

/** Called by `POST /trading/kill`. The next tick cancels everything and stays halted. */
export function haltState(s: EngineState, atMs: number, reason: HaltReason, detail: string): EngineState {
  return { ...s, halt: { reason, atMs, detail } };
}

/** Called after a new rule set is confirmed (the route must first refuse while a perp is still open). */
export function clearHalt(s: EngineState): EngineState {
  return { ...s, halt: null };
}

/** What the vault says about the trading agent right now (`get_agent_budget` + vault pause flag). */
export interface VaultView {
  vaultPaused: boolean;
  status: AgentStatus;
  remainingTodayUsdc: Dec;
  perTxLimitUsdc: Dec;
  paymentsToday: number;
  maxPaymentsPerDay: number;
  expiresAtMs: number | null;
}

export interface TickConfig {
  /** HL master address whose state is read. */
  account: string;
  /** Address of our API wallet; must be among the master's approved agents. */
  apiWalletAddress: string;
  hard: HardLimits;
  tickSec: number;
  deadmanSec: number;
  /** `TRADING_START_MS`: baseline for net_funded. */
  fundedSinceMs: number;
}

export interface TickDeps {
  hl: HlPort;
  /** Injected vault check. A throw is treated as "unknown" and blocks trading (fail closed). */
  vault: () => Promise<VaultView>;
  config: TickConfig;
  /**
   * Kill epoch check: true once an owner kill arrived after this tick started. Checked right before every
   * `scheduleCancel` and every `placeSpotOrder`, so a tick that was already running cannot trade or move the
   * dead-man switch after the kill switch was pulled.
   */
  shouldStop?: () => boolean;
  /**
   * Write-ahead hook, called synchronously right before each `placeSpotOrder` with the state that already carries the
   * new order counter / `firedAt` / `ordersToday`. If it throws the order is NOT placed (the state cannot be saved).
   */
  beforeOrder?: (st: EngineState) => void;
  /** Confirmed vault top-ups, to tell vault funding from other inflows in the status. Absent = none known. */
  vaultTopups?: () => VaultTopup[];
  /**
   * Local clock, read right after the HL state reads of a tick. Stamps `DaySnapshot.balanceAtMs` (upper bound of when the
   * snapshot balance was read, see engine/pnl.ts). Absent = the tick's `nowMs`.
   */
  clock?: () => number;
}

export interface ActiveRules {
  rules: RuleSetV1;
  hash: string;
  confirmedAtMs: number;
}

export interface TickInput {
  nowMs: number;
  rules: ActiveRules | null;
  state: EngineState;
}

/** The part of `TradingStatus` the engine knows. The route adds enabled/network/account/vault/agent/active_rules. */
export type StatusPieces = Omit<TradingStatus, "enabled" | "hl_network" | "hl_account" | "vault" | "agent_id" | "active_rules">;

export interface TickResult {
  state: EngineState;
  tradingState: TradingState;
  status: StatusPieces;
  /** New decisions of this tick (the same ones were appended to `state.recent`). */
  entries: LogEntry[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------------

const dec = (v: Fx, d = 6): string => fxStr(v, d);

export async function runTick(deps: TickDeps, input: TickInput): Promise<TickResult> {
  const { hl, config: cfg } = deps;
  const now = input.nowMs;
  const tickMs = cfg.tickSec * 1000;
  const st: EngineState = structuredClone(input.state);
  const entries: LogEntry[] = [];
  const warnings: string[] = [];
  const log = (kind: LogEntry["kind"], detail: string, extra: Partial<LogEntry> = {}): void => {
    entries.push({ at_ms: now, kind, detail, ...extra });
  };

  // Mutable view of what was read this tick; stays null when reads failed.
  let equity: Equity | null = null;
  let openOrders: HlOpenOrder[] = [];
  let vaultView: VaultView | null = null;
  let perpOk = true;
  let apiWallet: StatusPieces["api_wallet"] = { address: cfg.apiWalletAddress, approved: false, name: null, valid_until_ms: null };
  let otherAgents: StatusPieces["other_approved_agents"] = [];
  let pnl: ReturnType<typeof pnlSummary> | null = null;
  let eff: EffectiveLimits = effectiveLimits(input.rules?.rules ?? null, cfg.hard);

  const stopped = (): boolean => deps.shouldStop?.() === true;
  /** `safeSchedule` that never runs after a kill. */
  const schedErr = { msg: null as string | null };
  const schedule = async (atMs: number): Promise<boolean> => (stopped() ? false : safeSchedule(hl, atMs, st, warnings, schedErr));

  const finish = (tradingState: TradingState, reason: string | null = null, detail: string | null = null): TickResult => {
    st.lastTickMs = now;
    if (st.deadManGatedAtMs !== null) warnings.push("DEADMAN_VOLUME_GATED: Hyperliquid refuses the dead-man switch until the account has traded $1M; only IOC orders are placed");
    // One state entry per change of state or reason, not one per tick (the status always shows the current one).
    const key = `${tradingState}|${reason ?? ""}`;
    if (tradingState === "running") {
      st.lastStateKey = key;
      st.lastStateRepeats = 0;
    } else if (st.lastStateKey !== key) {
      log("state", `${tradingState}${reason ? `: ${reason}` : ""}${detail ? ` (${detail})` : ""}`);
      st.lastStateKey = key;
      st.lastStateRepeats = 0;
    } else {
      st.lastStateRepeats += 1;
    }
    st.recent = [...st.recent, ...entries].slice(-MAX_RECENT);
    const eq = equity;
    const positionValue = eq === null ? 0n : eq.positions.filter((p) => cfg.hard.allowedPairs.includes(p.pair)).reduce((a, p) => a + p.value, 0n);
    const lossPos = pnl !== null && pnl.lossToday > 0n ? pnl.lossToday : 0n;
    const v: VaultView = vaultView ?? {
      vaultPaused: false,
      status: "Paused",
      remainingTodayUsdc: "0",
      perTxLimitUsdc: "0",
      paymentsToday: 0,
      maxPaymentsPerDay: 0,
      expiresAtMs: null,
    };
    const status: StatusPieces = {
      state: tradingState,
      state_reason: reason,
      state_detail: detail,
      state_repeats: st.lastStateRepeats,
      api_wallet: apiWallet,
      other_approved_agents: otherAgents,
      balances: {
        usdc_free: eq ? dec(eq.usdcFree) : "0",
        usdc_total: eq ? dec(eq.usdcTotal) : "0",
        equity_usdc: eq ? dec(eq.equity) : "0",
        positions: (eq?.positions ?? []).map((p) => ({ pair: p.pair, base: p.base, size: dec(p.size, 8), mid: dec(p.mid, 8), value_usdc: dec(p.value) })),
      },
      pnl: {
        today_usdc: pnl ? dec(pnl.today) : "0",
        total_usdc: pnl ? dec(pnl.total) : "0",
        net_funded_usdc: pnl ? dec(pnl.netFunded < 0n ? 0n : pnl.netFunded) : "0",
        day_start_equity_usdc: pnl ? dec(pnl.dayStartEquity) : "0",
        funded_by_vault_usdc: pnl ? dec(pnl.fundedByVault) : "0",
        external_inflow_usdc: pnl ? dec(pnl.externalInflow) : "0",
        external_outflow_usdc: pnl ? dec(pnl.externalOutflow) : "0",
        fees_usdc: pnl ? dec(pnl.fees) : "0",
        untracked_delta_usdc: pnl ? dec(pnl.untrackedDelta) : "0",
      },
      limits: {
        effective: effectiveLimitsStatus(eff, cfg.hard.priceBandBps),
        today: { orders: st.ordersToday, loss_usdc: dec(lossPos) },
        position_usdc: dec(positionValue),
        vault: {
          status: v.status,
          remaining_today_usdc: v.remainingTodayUsdc,
          per_tx_limit_usdc: v.perTxLimitUsdc,
          payments_today: v.paymentsToday,
          max_payments_per_day: v.maxPaymentsPerDay,
          expires_at_ms: v.expiresAtMs,
        },
      },
      open_orders: openOrders
        .filter((o) => o.market === "spot" && o.cloid !== null)
        .map((o) => ({
          oid: o.oid,
          cloid: o.cloid ?? "",
          pair: o.pair,
          side: o.side,
          price: o.price,
          size: o.size,
          placed_at_ms: o.placedAtMs,
          rule_id: st.orders[o.cloid ?? ""]?.ruleId ?? null,
        })),
      dead_man: { cancel_at_ms: st.deadManAtMs, available: st.deadManGatedAtMs === null, reason: st.deadManGatedAtMs === null ? null : "DEADMAN_VOLUME_GATED" },
      perp_check: { ok: perpOk, at_ms: now },
      last_tick_ms: now,
      next_tick_ms: now + tickMs,
      warnings,
    };
    return { state: st, tradingState, status, entries };
  };

  try {
    // Attribution memory. States written before `botPrefixes` existed carry the active hash in `rulesHash` and the cloids of
    // resting orders in `orders`: seed from both so an upgrade does not forget the rule set that is running.
    const addPrefix = (p: string): void => {
      const pre = p.toLowerCase();
      if (!BOT_PREFIX.test(pre) || st.botPrefixes.includes(pre)) return;
      st.botPrefixes.push(pre);
      if (st.botPrefixes.length > MAX_BOT_PREFIXES) {
        const n = st.botPrefixes.length - MAX_BOT_PREFIXES;
        st.botPrefixes = st.botPrefixes.slice(n);
        st.prefixesDropped += n;
        log("state", `${n} old rule-set prefix(es) forgotten (limit ${MAX_BOT_PREFIXES}): their fills are no longer attributed to the bot`);
      }
    };
    if (st.rulesHash !== null) addPrefix(cloidPrefix(st.rulesHash));
    for (const c of Object.keys(st.orders)) addPrefix(c.slice(0, 18));
    if (input.rules !== null) addPrefix(cloidPrefix(input.rules.hash));
    if (st.prefixesDropped > 0) warnings.push(`${st.prefixesDropped} old rule-set prefix(es) were forgotten: fills of those rule sets are not attributed to the bot`);

    // 0b. A different rule set starts with a clean per-rule slate (cooldowns, skip dedupe).
    if (input.rules !== null && st.rulesHash !== input.rules.hash) {
      st.rulesHash = input.rules.hash;
      st.firedAt = {};
      st.lastSkip = {};
      log("state", `rules ${input.rules.hash.slice(0, 16)} active`);
    }

    // 1. Read state. Any HL read failure = no trading this tick (and no dead-man refresh: orders expire on their own).
    let spotPairs: HlSpotPair[];
    let mids: Awaited<ReturnType<HlPort["getMids"]>>;
    let balances: Awaited<ReturnType<HlPort["getSpotBalances"]>>;
    let perp: Awaited<ReturnType<HlPort["getPerpState"]>>;
    let agents: Awaited<ReturnType<HlPort["getApprovedAgents"]>>;
    let ledger: Awaited<ReturnType<HlPort["getLedger"]>>;
    let newFills: HlFill[];
    /** Set only when there is no persisted tracker yet. */
    let freshTracker: FillTracker | null = null;
    let readsDoneMs = now;
    let fellBack = false;
    try {
      [spotPairs, mids, openOrders, balances, perp, agents] = await Promise.all([
        hl.getSpotPairs(),
        hl.getMids(),
        hl.getOpenOrders(cfg.account),
        hl.getSpotBalances(cfg.account),
        hl.getPerpState(cfg.account),
        hl.getApprovedAgents(cfg.account),
      ]);
      readsDoneMs = Math.max(now, deps.clock?.() ?? now);
      const since = Math.min(cfg.fundedSinceMs, st.day?.snapshotAtMs ?? now, now);
      ledger = await hl.getLedger(cfg.account, since);
      // Fills: only what is newer than the persisted cursor (complete or an error, see hl/pagination.ts). The first read
      // reaches back to the earliest window; if HL no longer has that far back, fall back to today's window and mark the
      // total as partial. The same fallback applies when a persisted cursor is so old (long downtime) that the rows since it
      // exceed what HL keeps: the sums restart from today's window, flagged partial (a gap cannot be repaired), instead of
      // failing for ever. If even today's window cannot be proven complete the error stands (fail closed).
      // OPERATOR RESET: set "fills" to null in engine-state.json (worker stopped) to rebuild the sums from scratch.
      const todayFrom = st.day?.snapshotAtMs ?? null;
      const fallback = async (): Promise<{ fills: HlFill[]; tracker: FillTracker }> => {
        const from = Math.min(todayFrom ?? now, now);
        return { fills: await hl.getUserFills(cfg.account, from), tracker: emptyTracker(from, todayFrom, false) };
      };
      if (st.fills !== null) {
        try {
          newFills = await hl.getUserFills(cfg.account, readFrom(st.fills));
        } catch (e) {
          if (!isFillsTruncated(e)) throw e;
          const fb = await fallback();
          newFills = fb.fills;
          freshTracker = fb.tracker;
          fellBack = true;
        }
      } else {
        try {
          newFills = await hl.getUserFills(cfg.account, since);
          freshTracker = emptyTracker(since, todayFrom, true);
        } catch (e) {
          if (!isFillsTruncated(e)) throw e;
          const fb = await fallback();
          newFills = fb.fills;
          freshTracker = fb.tracker;
        }
      }
    } catch (e) {
      if (isFillsTruncated(e)) {
        warnings.push("fill history truncated");
        return finish("error", "FILLS_TRUNCATED", errMsg(e));
      }
      warnings.push("HL read failed");
      return finish("error", "HL_READ_FAILED", errMsg(e));
    }
    otherAgents = agents
      .filter((a) => a.address.toLowerCase() !== cfg.apiWalletAddress.toLowerCase())
      .slice(0, 20)
      .map((a) => ({ address: a.address, name: a.name, valid_until_ms: a.validUntilMs }));
    const pairMap = new Map(spotPairs.map((p) => [p.name, p]));
    let vaultErr: string | null = null;
    try {
      vaultView = await deps.vault();
    } catch (e) {
      vaultErr = errMsg(e);
      warnings.push("vault status unavailable");
    }

    const fresh = now - mids.atMs <= 2 * tickMs;
    const allowed = new Set(cfg.hard.allowedPairs);
    equity = computeEquity(balances, mids.mids);
    // Skew between the local clock and HL's fill clock: the day window uses local time, fills carry HL time.
    const newest = newFills.reduce((m, f) => Math.max(m, f.timeMs), 0);
    if (newest > now + CLOCK_SKEW_WARN_MS) warnings.push(`HL fill timestamps are ${Math.round((newest - now) / 1000)} s ahead of the local clock; day windows may be off`);
    if (equity.unpriced.length > 0) warnings.push(`no mid for held ${equity.unpriced.join(", ")} (valued at 0)`);
    if (!fresh) warnings.push("market data older than 2 ticks");

    /** A mid counts only if it is positive and current for THAT pair (per-pair age when the adapter has one). */
    const priced = (pair: string): boolean => {
      const m = mids.mids[pair];
      return m !== undefined && fx(m) > 0n && now - (mids.pairAtMs?.[pair] ?? mids.atMs) <= 2 * tickMs;
    };
    const heldBalancePairs = balances.filter((b) => b.coin !== "USDC" && fx(b.total) > 0n).map((b) => `${b.coin}/USDC`).filter((p) => allowed.has(p));

    // Day rollover. Needs fresh mids for a trustworthy equity snapshot, and a mid for EVERY held allowed-pair coin: a coin
    // without a mid would be missing from startPositions and its later losses would be invisible to the loss stop.
    let rolled = false;
    if (fresh && (st.day === null || st.day.dayIndex !== utcDayIndex(now))) {
      const missing = heldBalancePairs.filter((p) => !priced(p));
      if (missing.length > 0) {
        warnings.push(`day snapshot postponed: no current mid for held ${missing.join(", ")}`);
      } else {
        // Note: an allowed coin without a mid keeps the snapshot postponed (above) until HL prices it again; if HL never does
        // (delisted pair), NO_DAY_SNAPSHOT is permanent and needs operator action: sell or move the coin, or remove the pair.
        const r = rollDay(st.day, now, equity.equity, equity.positions.filter((p) => allowed.has(p.pair)), {
          backstop: backstopEquity(equity, allowed),
          balanceAtMs: readsDoneMs,
        });
        st.day = r.day;
        rolled = r.rolled;
        st.ordersToday = 0;
        st.filledOrdersToday = 0;
        st.filledOidsToday = [];
        st.lastStateKey = null; // the state log re-logs the current state once per day
        log("state", `new UTC day ${r.day.dayIndex}, start equity ${r.day.startEquity}`);
      }
    }
    // A snapshot written before startPositions existed cannot value coins that are held now: no trading until the next one.
    const legacyDay = st.day !== null && st.day.startPositions === undefined && heldBalancePairs.length > 0;

    // Fills: fold the new ones into the persisted running sums (the bot's own: cloid prefix OR a remembered oid).
    let trk = fellBack ? freshTracker : (st.fills ?? freshTracker);
    if (trk === null) throw new Error("fill tracker missing"); // unreachable: either persisted or just created
    if (fellBack) warnings.push("fill history gap after a long pause: pnl.total and position_pnl cost bases restart from today's window (partial)");
    if (rolled && st.day !== null) trk = rollToday(trk, st.day.snapshotAtMs);
    for (const o of openOrders) {
      if (o.market === "spot" && o.cloid !== null && st.botPrefixes.some((p) => (o.cloid as string).toLowerCase().startsWith(p)) && !st.botOids.includes(o.oid)) {
        st.botOids = [...st.botOids, o.oid].slice(-MAX_BOT_OIDS);
      }
    }
    trk = applyFills(trk, newFills, { prefixes: st.botPrefixes, oids: new Set(st.botOids), fundedSinceMs: cfg.fundedSinceMs });
    st.fills = trk;
    if (st.day !== null && trk.todayFromMs !== st.day.snapshotAtMs) {
      st.fills = null; // out of sync with the day snapshot (hand-edited state?): rebuild from scratch next tick
      return finish("error", "FILLS_RESYNC", "fill tracker does not match the day snapshot; rebuilding");
    }

    // Held allowed-pair coins and bot positions that have no current mid: valued at 0 by the stop, and no new orders.
    const held = new Set<string>(heldBalancePairs);
    for (const m of [trk.today, trk.total]) for (const [pair, a] of Object.entries(m)) if (fx(a.dq) !== 0n) held.add(pair);
    for (const [pair, sp] of Object.entries(st.day?.startPositions ?? {})) if (fx(sp.size) !== 0n) held.add(pair);
    const unpricedHeld = [...held].filter((p) => !priced(p));

    // Loss stop and P&L: the bot's own fills + mark-to-market only; external flows and fees are reported, not counted.
    if (st.day !== null) {
      pnl = pnlSummary({
        day: st.day,
        equityNow: equity.equity,
        equityBackstopNow: backstopEquity(equity, allowed, st.day.startPositions ?? {}),
        held: Object.fromEntries(balances.filter((b) => b.coin !== "USDC" && fx(b.total) > 0n).map((b) => [`${b.coin}/USDC`, fx(b.total)])),
        ledger,
        fundedSinceMs: cfg.fundedSinceMs,
        todayAgg: trk.today,
        totalAgg: trk.total,
        mids: mids.mids,
        topups: deps.vaultTopups?.() ?? [],
      });
      if (pnl.unpriced.length > 0) warnings.push(`no mid for traded ${pnl.unpriced.join(", ")} (loss stop values it at 0)`);
      if (pnl.outflowToday > 0n) warnings.push(`${dec(pnl.outflowToday)} USDC left the account today outside the bot (withdrawal or transfer); not counted as trading loss`);
    }
    if (trk.foreignFills > 0) warnings.push(`${trk.foreignFills} spot fill(s) since start are not from the bot (manual trades, or an API key trading without the bot's order ids)`);
    if (!trk.totalComplete) warnings.push("pnl.total is partial: fill history before today was not retrievable");
    if (legacyDay) warnings.push("day snapshot predates position tracking while coins are held: no trading until the next UTC day");

    // Orders of this account on spot markets, resolved to asset ids.
    const cancelAllSpot = async (why: string): Promise<boolean> => {
      const targets = openOrders.filter((o) => o.market === "spot").flatMap((o) => {
        const info = pairMap.get(o.pair);
        return info === undefined || info.assetId < 10_000 ? [] : [{ assetId: info.assetId, oid: o.oid }];
      });
      if (targets.length === 0) return true;
      try {
        await hl.cancelOrders(targets);
        log("cancel", `${why}: cancelled ${targets.length} order(s)`);
        openOrders = openOrders.filter((o) => o.market !== "spot");
        st.orders = {};
        return true;
      } catch (e) {
        warnings.push("cancel failed");
        log("cancel", `${why}: cancel failed: ${errMsg(e)}`);
        return false;
      }
    };

    // 2. Perp alarm. Any perp position or open perp order halts the engine for good (owner decision 2026-11-03).
    // USDC merely sitting in the perp account opens nothing by itself (only a signed order can), so it is a warning,
    // not a halt: the owner is told to move it to spot. Orders and positions are what the alarm must catch.
    const perpBad = perp.positions.length > 0 || perp.openPerpOrders > 0;
    perpOk = !perpBad;
    if (!perpBad && fx(perp.accountValueUsdc) > fx(PERP_VALUE_ALARM)) {
      warnings.push(`perp account holds ${perp.accountValueUsdc} USDC with no positions; move it to spot`);
    }
    if (perpBad && st.halt === null) {
      const detail = `perp positions ${perp.positions.length}, open perp orders ${perp.openPerpOrders}, perp account value ${perp.accountValueUsdc}`;
      st.halt = { reason: "PERP_POSITION_DETECTED", atMs: now, detail };
      log("state", `ALARM PERP_POSITION_DETECTED: ${detail}`);
    }
    if (st.halt !== null) {
      const ok = await cancelAllSpot(`halted (${st.halt.reason})`);
      if (!ok) await schedule(now + cfg.deadmanSec * 1000); // backstop if the cancel did not go through
      return finish("halted", st.halt.reason, st.halt.detail);
    }

    // 3. Gates. Each failing gate means no order this tick.
    if (vaultView === null) return finish("error", "VAULT_STATUS_UNAVAILABLE", vaultErr);
    const expired = vaultView.expiresAtMs !== null && vaultView.expiresAtMs <= now;
    if (vaultView.vaultPaused || vaultView.status !== "Active" || expired) {
      const reason = vaultView.vaultPaused ? "VAULT_PAUSED" : expired ? "AGENT_EXPIRED" : `AGENT_${vaultView.status.toUpperCase()}`;
      await cancelAllSpot(reason);
      return finish("paused_onchain", reason, null);
    }

    const me = agents.find((a) => a.address.toLowerCase() === cfg.apiWalletAddress.toLowerCase());
    apiWallet = { address: cfg.apiWalletAddress, approved: false, name: me?.name ?? null, valid_until_ms: me?.validUntilMs ?? null };
    if (me === undefined) return finish("awaiting_api_wallet", "API_WALLET_NOT_APPROVED", null);
    if (me.validUntilMs !== null && me.validUntilMs - now <= MIN_API_WALLET_VALIDITY_MS)
      return finish("awaiting_api_wallet", "API_WALLET_EXPIRING", `valid until ${me.validUntilMs}`);
    apiWallet.approved = true;

    const active = input.rules;
    if (active === null) return finish("no_rules");
    const rules = active.rules;
    eff = effectiveLimits(rules, cfg.hard);

    if (!fresh) return finish("error", "STALE_DATA", `mids are ${now - mids.atMs} ms old`);
    if (st.day === null || pnl === null || st.day.dayIndex !== utcDayIndex(now)) return finish("error", "NO_DAY_SNAPSHOT", st.day === null ? null : "today's snapshot could not be taken yet");
    if (legacyDay) return finish("error", "NO_DAY_SNAPSHOT", "day snapshot predates position tracking; waiting for the next UTC day");

    // The daily loss stop holds for the rest of the UTC day, also across a rule change (only 00:00 UTC clears it).
    if (st.stoppedDayIndex === st.day.dayIndex) {
      await cancelAllSpot("stopped_today");
      const why = st.stopReason ?? "DAILY_LOSS_STOP";
      return finish("stopped_today", why, why === "EQUITY_DROP" ? `equity down ${dec(pnl.equityDrop)} USDC` : `loss today ${dec(pnl.lossToday)} USDC`);
    }
    if (st.stoppedDayIndex !== null && st.stoppedDayIndex !== st.day.dayIndex) {
      st.stoppedDayIndex = null;
      st.stopReason = null;
    }
    // Fail closed on what the stop cannot see.
    if (unpricedHeld.length > 0) return finish("error", "NO_MID_FOR_POSITION", `no current mid for held ${unpricedHeld.join(", ")}`);
    // Every bot order reported filled today must have at least one fill attributed to the bot. A single misattributed order
    // would otherwise hide its P&L from the stop as long as some OTHER fill was attributed.
    const attributedOids = new Set(trk.botOidsToday ?? []);
    const unattributed = st.filledOidsToday.filter((o) => !attributedOids.has(o));
    if (unattributed.length > 0 || (st.filledOrdersToday > 0 && trk.botFillsToday === 0)) {
      return finish(
        "error",
        "FILLS_NOT_ATTRIBUTED",
        `${st.filledOrdersToday} order(s) filled today, ${unattributed.length > 0 ? `order id(s) ${unattributed.slice(0, 5).join(", ")} have` : "no fill is attributed to the bot; none has"} no fill attributed to the bot (cloid/oid mismatch, or the fill is not indexed yet)`,
      );
    }

    // 4. Dead-man switch BEFORE any order. If it cannot be set, no order is placed.
    if (stopped()) return finish("halted", "KILLED", "kill switch pulled while the tick was running");
    // HL refuses scheduleCancel for accounts under $1M traded volume. That is the one refusal that is not fatal: the engine
    // then trades with IOC orders only (nothing rests, so nothing needs the switch) and re-tries once per hour. Any other
    // scheduleCancel failure still blocks trading.
    if (st.deadManGatedAtMs !== null && now - st.deadManGatedAtMs < DEADMAN_RETRY_MS) {
      st.deadManAtMs = null;
    } else if (await schedule(now + cfg.deadmanSec * 1000)) {
      if (st.deadManGatedAtMs !== null) log("state", "dead-man switch accepted again: limit orders are allowed");
      st.deadManGatedAtMs = null;
    } else {
      if (stopped()) return finish("halted", "KILLED", "kill switch pulled while the tick was running");
      if (schedErr.msg === null || !VOLUME_GATE_RE.test(schedErr.msg)) {
        return finish("error", "SCHEDULE_CANCEL_FAILED", "refusing to trade without the dead-man switch");
      }
      if (st.deadManGatedAtMs === null) log("state", "DEADMAN_VOLUME_GATED: HL refuses scheduleCancel until $1M volume is traded; IOC orders only");
      st.deadManGatedAtMs = now;
      st.deadManAtMs = null;
    }
    const deadManOk = st.deadManGatedAtMs === null;

    // 5. Loss stop.
    if (pnl.lossToday >= eff.dailyLossStop) {
      st.stoppedDayIndex = st.day.dayIndex;
      st.stopReason = "DAILY_LOSS_STOP";
      await cancelAllSpot("daily loss stop");
      return finish("stopped_today", "DAILY_LOSS_STOP", `loss today ${dec(pnl.lossToday)} USDC >= stop ${dec(eff.dailyLossStop)} USDC`);
    }
    // Backstop for losses the fill accounting cannot see (a leaked API key trading without the bot's ids).
    if (pnl.equityDrop >= eff.dailyLossStop) {
      st.stoppedDayIndex = st.day.dayIndex;
      st.stopReason = "EQUITY_DROP";
      await cancelAllSpot("equity drop");
      return finish("stopped_today", "EQUITY_DROP", `equity down ${dec(pnl.equityDrop)} USDC >= stop ${dec(eff.dailyLossStop)} USDC (not explained by flows)`);
    }

    // 6. Cancel orders past their ttl, and orders that belong to another rule set.
    const prefix = cloidPrefix(active.hash);
    const toCancel: HlOpenOrder[] = [];
    let cancelledBuyValue = 0n;
    for (const o of openOrders) {
      if (o.market !== "spot" || o.cloid === null) continue;
      const meta = st.orders[o.cloid];
      if (!o.cloid.toLowerCase().startsWith(prefix)) toCancel.push(o);
      else if (meta?.expiresAtMs != null && meta.expiresAtMs <= now) toCancel.push(o);
      // Without the dead-man switch no bot order may rest: nothing would cancel it if the worker dies.
      else if (!deadManOk) toCancel.push(o);
    }
    if (toCancel.length > 0) {
      const targets = toCancel.flatMap((o) => {
        const info = pairMap.get(o.pair);
        return info === undefined ? [] : [{ assetId: info.assetId, oid: o.oid }];
      });
      try {
        if (targets.length > 0) await hl.cancelOrders(targets);
        log("cancel", `cancelled ${targets.length} expired or stale order(s)`);
        // Fail closed: HL treats "already cancelled or filled" as success, so an expired buy may have filled just before the
        // cancel. The balances read at the top of the tick do not show that fill, so keep these buys counted this tick.
        cancelledBuyValue = toCancel.filter((o) => o.side === "buy").reduce((a, o) => a + fxMul(fx(o.price), fx(o.size)), 0n);
        const gone = new Set(toCancel.map((o) => o.oid));
        openOrders = openOrders.filter((o) => !gone.has(o.oid));
      } catch (e) {
        warnings.push("ttl cancel failed");
        log("cancel", `ttl cancel failed: ${errMsg(e)}`);
      }
    }
    const live = new Set(openOrders.map((o) => o.cloid));
    st.orders = Object.fromEntries(Object.entries(st.orders).filter(([c]) => live.has(c)));

    // 7. Evaluate rules in array order. At most 1 order per rule and 2 per tick. Free balances are decremented as we go,
    //    conservatively assuming each attempted order fills, so a second order in the same tick cannot overspend.
    // position_pnl: cost basis per rule set from the incremental tracker (no history re-read). It is exact only for rule sets
    // confirmed at or after `completeFrom(trk)`; for an older one (history gap) those rules are skipped, never guessed.
    const basisPartial = completeFrom(trk) > active.confirmedAtMs;
    if (basisPartial && rules.rules.some((r) => r.when.type === "position_pnl")) {
      warnings.push("position_pnl cost basis is partial (fill history gap); those rules are skipped until a new rule set is confirmed");
    }
    let freeUsdc = equity.usdcFree;
    const freeBase = new Map(equity.positions.map((p) => [p.pair, p.free]));
    let positionValue = equity.positions.filter((p) => cfg.hard.allowedPairs.includes(p.pair)).reduce((a, p) => a + p.value, 0n);
    const openBuyValue =
      cancelledBuyValue +
      openOrders
        .filter((o) => o.market === "spot" && o.side === "buy")
        .reduce((a, o) => a + fxMul(fx(o.price), fx(o.size)), 0n);
    if (openOrders.some((o) => o.cloid === null)) warnings.push("open orders without cloid (placed by hand) are counted but never cancelled");
    let placed = 0;

    for (const rule of rules.rules) {
      if (placed >= MAX_ORDERS_PER_TICK) break;
      const info = pairMap.get(rule.pair);
      const midStr = mids.mids[rule.pair];
      if (info === undefined || midStr === undefined) {
        skip(st, log, rule.id, "NO_MARKET", `no spot pair or mid for ${rule.pair}`);
        continue;
      }
      // Live 24 h volume (the offline check at load time cannot know it): a thin pair is never traded.
      if (fx(info.volume24hUsdc) < fx(cfg.hard.minPairVolumeUsdc)) {
        skip(st, log, rule.id, "PAIR_LOW_VOLUME", `${rule.pair} 24h volume ${info.volume24hUsdc} is below the minimum ${cfg.hard.minPairVolumeUsdc}`);
        continue;
      }
      const mid = fx(midStr);
      const cdName = effectiveCooldown(rule);
      const cdMs = cdName === undefined ? undefined : DURATION_MS[cdName];
      if (cooldownActive(now, st.firedAt[rule.id], cdMs)) continue;

      if (rule.when.type === "position_pnl" && basisPartial) {
        skip(st, log, rule.id, "COST_BASIS_PARTIAL", "fill history before the gap is unknown, so the cost basis of this rule set is unreliable");
        continue;
      }
      let fired: boolean;
      try {
        const cost = basisOf(trk, prefix, rule.pair);
        fired = (await evalTrigger(rule.when, { nowMs: now, pair: rule.pair, mid, lastFiredAtMs: st.firedAt[rule.id], cost, getCandles: (p, i, s, e) => hl.getCandles(p, i, s, e) })).fired;
      } catch (e) {
        skip(st, log, rule.id, "TRIGGER_ERROR", `trigger failed: ${errMsg(e)}`);
        continue;
      }
      if (!fired) {
        clearSkip(st, rule.id);
        continue;
      }

      const sized = sizeOrder({ action: rule.action, mid, priceBandBps: cfg.hard.priceBandBps, szDecimals: info.szDecimals, freeBase: freeBase.get(rule.pair) ?? 0n });
      if (!sized.ok) {
        skip(st, log, rule.id, sized.code, sized.reason);
        continue;
      }

      let book;
      try {
        book = await hl.getBook(rule.pair);
      } catch (e) {
        skip(st, log, rule.id, "BOOK_UNAVAILABLE", `order book unavailable: ${errMsg(e)}`);
        continue;
      }
      const verdict = checkOrder(
        { pair: rule.pair, assetId: info.assetId, side: rule.action.side, price: sized.price, size: sized.size, tif: sized.tif },
        {
          nowMs: now,
          tickMs,
          deadManAvailable: deadManOk,
          allowedPairs: cfg.hard.allowedPairs,
          rulePairs: rules.pairs,
          priceBandBps: cfg.hard.priceBandBps,
          limits: eff,
          ordersToday: st.ordersToday,
          mid,
          book: { bid: book.bid === null ? null : fx(book.bid), ask: book.ask === null ? null : fx(book.ask), atMs: book.atMs },
          freeUsdc,
          freeBase: freeBase.get(rule.pair) ?? 0n,
          positionValue,
          openBuyValue,
          lastFiredAtMs: st.firedAt[rule.id],
          cooldownMs: cdMs,
        },
      );
      if (!verdict.ok) {
        let reason = verdict.reason;
        if (verdict.code === "MIN_NOTIONAL") {
          const adv = "usdc" in rule.action.size ? minOrderAdvice(fx(rule.action.size.usdc), sized.price, info.szDecimals) : undefined;
          reason += `; order is ${fxStr(sized.size, 8)} coins at ${fxStr(sized.price, 8)}${adv ? `, ${describeMinOrder(adv, eff.maxOrder)}` : ""}`;
        }
        skip(st, log, rule.id, verdict.code, reason);
        continue;
      }

      // Second lock (checkOrder rejects this already): a resting order never goes out without the dead-man switch.
      if (sized.tif !== "Ioc" && !deadManOk) {
        skip(st, log, rule.id, "LIMIT_NEEDS_DEADMAN", "a resting order needs the dead-man switch, which is unavailable");
        continue;
      }
      // Place. From here the rule is "fired" whatever HL answers (a rejected order still starts the cooldown).
      if (stopped()) {
        log("skip", "kill switch pulled while the tick was running: no further orders", { rule_id: rule.id });
        break;
      }
      clearSkip(st, rule.id);
      const prevFired = st.firedAt[rule.id];
      st.orderCounter += 1;
      const cloid = makeCloid(active.hash, st.orderCounter);
      st.firedAt[rule.id] = now;
      st.ordersToday += 1;
      try {
        deps.beforeOrder?.(st); // write-ahead: counters are on disk before the order can reach HL
      } catch (e) {
        st.orderCounter -= 1;
        st.ordersToday -= 1;
        st.firedAt = Object.fromEntries(Object.entries(st.firedAt).filter(([k]) => k !== rule.id || prevFired !== undefined));
        if (prevFired !== undefined) st.firedAt[rule.id] = prevFired;
        warnings.push("state write failed");
        return finish("error", "STATE_WRITE_FAILED", `refusing to place an order: ${errMsg(e)}`);
      }
      placed += 1;
      let result: HlOrderResult;
      try {
        result = await hl.placeSpotOrder({
          assetId: info.assetId,
          isBuy: rule.action.side === "buy",
          price: dec(sized.price, 12),
          size: dec(sized.size, 12),
          tif: sized.tif,
          cloid,
        });
      } catch (e) {
        result = { status: "rejected", error: errMsg(e) };
      }
      if ("oid" in result) st.botOids = [...st.botOids, result.oid].slice(-MAX_BOT_OIDS);
      if (result.status === "filled" && fx(result.filledSize) > 0n) {
        st.filledOrdersToday += 1;
        if ("oid" in result) st.filledOidsToday = [...st.filledOidsToday, result.oid].slice(-MAX_BOT_OIDS);
      }
      log("order", `${rule.action.side} ${dec(sized.size, 8)} ${rule.pair} @ ${dec(sized.price, 8)} ${sized.tif}: ${result.status}${result.status === "rejected" ? ` (${result.error})` : ""}`, {
        rule_id: rule.id,
        cloid,
        ...("oid" in result ? { oid: result.oid } : {}),
      });
      if (result.status === "resting") {
        const ttl = rule.action.order.type === "limit" ? rule.action.order.ttl : null;
        st.orders[cloid] = { ruleId: rule.id, expiresAtMs: ttl === null ? null : now + DURATION_MS[ttl] };
      }
      if (rule.action.side === "buy") {
        freeUsdc -= verdict.notional;
        positionValue += verdict.notional;
      } else {
        freeBase.set(rule.pair, (freeBase.get(rule.pair) ?? 0n) - sized.size);
      }
    }
    return finish("running");
  } catch (e) {
    warnings.push("internal error");
    return finish("error", "INTERNAL_ERROR", errMsg(e));
  }
}

function clearSkip(st: EngineState, ruleId: string): void {
  st.lastSkip = Object.fromEntries(Object.entries(st.lastSkip).filter(([k]) => k !== ruleId));
}

function skip(st: EngineState, log: (k: LogEntry["kind"], d: string, x?: Partial<LogEntry>) => void, ruleId: string, code: string, reason: string): void {
  if (st.lastSkip[ruleId] === code) return;
  st.lastSkip[ruleId] = code;
  log("skip", `${code}: ${reason}`, { rule_id: ruleId });
}

async function safeSchedule(hl: HlPort, atMs: number, st: EngineState, warnings: string[], err: { msg: string | null }): Promise<boolean> {
  try {
    await hl.scheduleCancel(atMs);
    st.deadManAtMs = atMs;
    err.msg = null;
    return true;
  } catch (e) {
    err.msg = errMsg(e);
    // The volume gate is reported by its own warning (DEADMAN_VOLUME_GATED), not as a failure.
    if (!VOLUME_GATE_RE.test(err.msg)) warnings.push("scheduleCancel failed");
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { utcDayIndex };
