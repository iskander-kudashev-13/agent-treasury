/**
 * One engine tick (ADR-0005 section 7, multi-bot per ADR-0006 section 4). Deterministic: no LLM, no `Date.now()`, no
 * randomness. The caller injects the time, the HL port, a vault-status function, the bots (rule sets + cloid prefixes) and the
 * persisted state, and gets back the next state, the status pieces, per-bot views and the decision log entries. The caller
 * (service) persists `state`, appends `entries`, the journal and the history.
 *
 * Sequence (account reads once, then each bot in turn):
 *   1 read state (HL + vault), fold the new fills into the bots' sums
 *   2 perp alarm (halts the account and every bot, cancels all, no trading)
 *   3 on-chain / API wallet / rules / data gates, account stop, attribution checks
 *   4 scheduleCancel refresh ONCE, BEFORE any order
 *   5 loss stops: per bot, then the summed account loss stop and the equity backstop (account-wide)
 *   6 cancel expired / stale / orphan orders (a bot only cancels its own prefixes)
 *   7 per bot in creation order: evaluate rules, size, risk-check (bot limits, then account caps), place
 * The funding top-up (ADR step 8) is not part of this function; it lives in funding.ts.
 *
 * FAIL-CLOSED MAP (each of these ends the tick without orders, for all bots): HL read failure, truncated fill history,
 * fill tracker out of sync, vault status unknown / paused, API wallet missing or expiring, stale mids, no day snapshot,
 * a held or traded coin without a current mid, an order reported filled without an attributed fill, dead-man switch
 * failure (except the volume gate, which turns the engine IOC-only), account halt, account stop.
 */
import { effectiveCooldown } from "../rules/describe.js";
import type {
  Action,
  AgentIntent,
  AgentStatus,
  BotState,
  Dec,
  HlFill,
  HlOpenOrder,
  HlOrderResult,
  HlPort,
  HlSpotPair,
  HardLimits,
  RuleLimits,
  RuleSetV1,
  SDec,
  TradingState,
  TradingStatus,
} from "../types.js";
import { isFillsTruncated } from "../hl/pagination.js";
import {
  type AttributedFill,
  type BotAgg,
  type FillCursor,
  applyFills,
  basisOf,
  cloidPrefixOf,
  emptyBotAgg,
  emptyCursor,
  positionOf,
  readFrom,
  resolveBot,
  rollBotToday,
  rollCursorToday,
} from "./fills.js";
import { type Equity, type VaultTopup, backstopEquity, computeEquity, pnlSummaryMulti, rollDay, utcDayIndex } from "./pnl.js";
import {
  type EffectiveLimits,
  type Fx,
  SCALE,
  checkOrder,
  describeMinOrder,
  minOrderAdvice,
  cloidPrefix,
  cooldownActive,
  effectiveLimits,
  effectiveLimitsStatus,
  fx,
  fxMax,
  fxMin,
  fxMul,
  fxStr,
  makeCloid,
  sizeOrder,
} from "./risk.js";
import { type BotEngineState, type EngineState, type LogEntry, clearHalt, emptyBotState, haltAll, haltBot, initialEngineState } from "./state.js";
import { DURATION_MS, evalTrigger } from "./triggers.js";

export { clearHalt, haltAll, haltBot, initialEngineState };
export type { BotEngineState, EngineState, LogEntry };

// ---------------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------------

export const MAX_RECENT = 100;
/** Dead-man refresh is only trusted for orders if the HL adapter confirms it; see the report. */
export const MIN_API_WALLET_VALIDITY_MS = 3_600_000;
export const MAX_ORDERS_PER_TICK = 2;
/** Perp account value above this (USDC) counts as a perp position. */
const PERP_VALUE_ALARM = "1";
/** Order ids remembered for fill attribution (fallback when the cloid on a fill is missing or foreign). */
const MAX_BOT_OIDS = 500;
/** Cloids whose rule is remembered per bot (journal `rule_id`). */
const MAX_CLOID_RULES = 200;
/** Fill timestamps this far ahead of the local clock mean the clocks disagree (HL stamps fills with its own clock). */
const CLOCK_SKEW_WARN_MS = 60_000;
/** HL's refusal text: "Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0." */
export const VOLUME_GATE_RE = /enough volume traded/i;
export const DEADMAN_RETRY_MS = 3_600_000;

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
   * Kill epoch check: true once an owner kill arrived after this tick started. Called without an argument for the account
   * (kill all) and with a bot id (kill of that bot). Checked right before every `scheduleCancel` and every `placeSpotOrder`, so a
   * tick that was already running cannot trade or move the dead-man switch after the kill switch was pulled.
   */
  shouldStop?: (botId?: string) => boolean;
  /**
   * Write-ahead hook, called synchronously right before each `placeSpotOrder` with the state that already carries the
   * new order counter / `firedAt` / `ordersToday`. If it throws the order is NOT placed (the state cannot be saved).
   * `attributed` = the fills this tick already folded into the state's sums: the hook writes them to the fills journal BEFORE the
   * state, so a crash after the state write cannot lose journal rows (the cursor in the state has moved past them).
   */
  beforeOrder?: (st: EngineState, attributed: readonly (AttributedFill & { ruleId: string | null })[]) => void;
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

/** One bot as the engine sees it (built by the service from `bots.json` and the verified envelopes). */
export interface BotInput {
  id: string;
  createdAtMs: number;
  archived: boolean;
  /** Every cloid prefix the bot ever used (permanent). */
  prefixes: readonly string[];
  /** Verified active rule set, or null (draft, archived, or the stored envelope was refused). */
  rules: ActiveRules | null;
  /** Set when the stored active envelope failed verification (shown as `blocked: RULES_REFUSED`). */
  refused?: boolean;
}

export interface TickInput {
  nowMs: number;
  /** Creation order = evaluation order. */
  bots: readonly BotInput[];
  state: EngineState;
  /**
   * ADR-0007 agent tick: one order an AI agent asked for, for one agent-mode bot. The whole tick runs as usual (reads, every gate,
   * loss stops, cancels); in step 7 the DSL rules of EVERY bot are skipped and only this intent goes through `attempt()`, the
   * same code path a DSL rule takes. At most one order.
   */
  agent?: { botId: string; intent: AgentIntent; note: string | null };
}

/**
 * Outcome of one order attempt in step 7 (ADR-0007 section 5). `killed` (internal): the kill switch was pulled during the tick;
 * the DSL loop stops evaluating this bot's rules.
 */
export type AttemptOutcome =
  | { placed: false; code: string; reason: string; killed?: true }
  | {
      placed: true;
      cloid: string;
      price: Fx;
      size: Fx;
      notional: Fx;
      result: HlOrderResult;
      /** The order call threw (network error, timeout): HL may or may not have the order. The service answers OUTCOME_UNKNOWN. */
      outcomeUnknown?: true;
    };

/** The part of `TradingStatus` the engine knows. The service adds enabled/network/account/vault/agent/active_rules/bots. */
export type StatusPieces = Omit<TradingStatus, "enabled" | "hl_network" | "hl_account" | "vault" | "agent_id" | "active_rules" | "bots" | "max_bots" | "agent_trading">;

/** One bot after the tick: the status the owner sees and the numbers for history and the bot page. */
export interface BotView {
  id: string;
  state: BotState;
  reason: string | null;
  detail: string | null;
  ordersToday: number;
  /** Positive part of the bot's loss today (what its stop compares). */
  lossToday: Dec;
  pnlToday: SDec;
  pnlTotal: SDec;
  positionUsdc: Dec;
  positions: { pair: string; size: Dec; avgCost: Dec | null; mid: Dec; value: Dec }[];
  /** Position size per pair and mid per pair (history sample). */
  pos: Record<string, Dec>;
  px: Record<string, Dec>;
  limits: (RuleLimits & { price_band_bps: number }) | null;
  openOrders: TradingStatus["open_orders"];
  /** False when no P&L could be computed this tick (HL read failed, no snapshot yet): no history sample then. */
  priced: boolean;
}

export interface TickResult {
  state: EngineState;
  tradingState: TradingState;
  status: StatusPieces;
  /** New decisions of this tick (the same ones were appended to `state.account.recent`). */
  entries: LogEntry[];
  bots: Record<string, BotView>;
  /**
   * Fills that were new this tick and belong to a bot, oldest first, with the rule that placed them when known. `note` (ADR-0007)
   * = the sanitised reason an AI agent gave for the order, when the order came from an agent.
   */
  attributed: (AttributedFill & { ruleId: string | null; note?: string | null })[];
  /** Account-level history sample; null when equity could not be computed. */
  accountSample: { pnl: SDec; today: SDec; equity: Dec; positionUsdc: Dec; px: Record<string, Dec> } | null;
  /** ADR-0007: set by an agent tick that reached step 7. Undefined = the tick ended earlier (see `status.state_reason`). */
  agent?: AttemptOutcome;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------------

/** `rule_id` of agent orders in the log, `firedAt`, `cloidRule` and the journal (ADR-0007). Agent bots have no DSL rules, so it cannot clash. */
export const AGENT_RULE_ID = "agent";

/** One order to try in step 7: a fired DSL rule or an agent intent (ADR-0007 section 5). */
interface Candidate {
  ruleId: string;
  pair: string;
  action: Action;
  cooldownMs: number | undefined;
  source: "rules" | "agent";
  /** Sanitised agent note; null for DSL rules. */
  note: string | null;
}

/** Per-bot setup of step 7 (`botPosition` and `ownOpenSell` change as orders are placed in the tick). */
interface BotCtx {
  bot: BotInput;
  active1: ActiveRules;
  rules: RuleSetV1;
  s: BotEngineState;
  botEff: EffectiveLimits;
  prefix: string;
  ownOpenSell: Map<string, Fx>;
  botPosition: Fx;
  botOpenBuy: Fx;
  capacityOf: (pair: string) => Fx | null;
}

const dec = (v: Fx, d = 6): string => fxStr(v, d);
const pos0 = (v: Fx): Fx => (v > 0n ? v : 0n);

function trimOids(rec: Record<string, string>): Record<string, string> {
  const keys = Object.keys(rec);
  if (keys.length <= MAX_BOT_OIDS) return rec;
  const keep = keys.sort((a, b) => Number(a) - Number(b)).slice(-MAX_BOT_OIDS);
  return Object.fromEntries(keep.map((k) => [k, rec[k] as string]));
}

export async function runTick(deps: TickDeps, input: TickInput): Promise<TickResult> {
  const { hl, config: cfg } = deps;
  const now = input.nowMs;
  const tickMs = cfg.tickSec * 1000;
  const st: EngineState = structuredClone(input.state);
  const acct = st.account;
  const entries: LogEntry[] = [];
  const warnings: string[] = [];
  const log = (kind: LogEntry["kind"], detail: string, extra: Partial<LogEntry> = {}): void => {
    entries.push({ at_ms: now, kind, detail, ...extra });
  };

  const botIn = new Map(input.bots.map((b) => [b.id, b]));
  for (const b of input.bots) st.bots[b.id] ??= emptyBotState(true);
  const bs = (id: string): BotEngineState => (st.bots[id] ??= emptyBotState(true));
  /** cloid prefix -> bot id (permanent registry, plus the cloids of resting orders the state itself remembers). */
  const prefixToBot = new Map<string, string>();
  for (const b of input.bots) {
    for (const p of b.prefixes) prefixToBot.set(p.toLowerCase(), b.id);
    if (b.rules !== null) prefixToBot.set(cloidPrefix(b.rules.hash), b.id);
  }
  for (const [id, b] of Object.entries(st.bots)) for (const c of Object.keys(b.orders)) if (!prefixToBot.has(c.slice(0, 18).toLowerCase())) prefixToBot.set(c.slice(0, 18).toLowerCase(), id);
  const ownerOf = (cloid: string | null): string | undefined => {
    const p = cloidPrefixOf(cloid);
    return p === null ? undefined : prefixToBot.get(p);
  };
  const active = input.bots.filter((b) => !b.archived && b.rules !== null);

  // Mutable view of what was read this tick; stays null when reads failed.
  let equity: Equity | null = null;
  let openOrders: HlOpenOrder[] = [];
  let vaultView: VaultView | null = null;
  let perpOk = true;
  let apiWallet: StatusPieces["api_wallet"] = { address: cfg.apiWalletAddress, approved: false, name: null, valid_until_ms: null };
  let otherAgents: StatusPieces["other_approved_agents"] = [];
  let pnl: ReturnType<typeof pnlSummaryMulti> | null = null;
  let mids: Awaited<ReturnType<HlPort["getMids"]>> | null = null;
  let attributed: (AttributedFill & { ruleId: string | null; note?: string | null })[] = [];
  /** ADR-0007: outcome of the agent intent, when this is an agent tick that reached step 7. */
  let agentOut: AttemptOutcome | undefined;
  const bestBot = input.bots.find((b) => b.id === "default" && b.rules !== null && !b.archived) ?? active[0] ?? null;
  const bestRules = bestBot?.rules ?? null;
  let eff: EffectiveLimits = effectiveLimits(bestRules?.rules ?? null, cfg.hard);

  const stopped = (botId?: string): boolean => deps.shouldStop?.(botId) === true;
  /** `safeSchedule` that never runs after a kill. */
  const schedErr = { msg: null as string | null };
  const schedule = async (atMs: number): Promise<boolean> => (stopped() ? false : safeSchedule(hl, atMs, st, warnings, schedErr));

  // Losses that count: the bot's stop value, only the positive part (a profit of one bot never hides another's loss).
  const botLoss = (id: string): Fx => (pnl?.bots[id] ? pos0(pnl.bots[id].lossToday) : 0n);

  const sumLoss = (): Fx => Object.keys(st.bots).reduce((a, id) => a + botLoss(id), 0n);

  const botRow = (id: string, tradingState: TradingState, reason: string | null): { state: BotState; reason: string | null } => {
    const b = botIn.get(id);
    if (b?.archived) return { state: "archived", reason: null };
    if (b === undefined || b.rules === null) return b?.refused ? { state: "blocked", reason: "RULES_REFUSED" } : { state: "draft", reason: null };
    const s = bs(id);
    if (acct.halt !== null || s.halt !== null) return { state: "halted", reason: (s.halt ?? acct.halt)?.reason ?? null };
    const dayIdx = acct.day?.dayIndex;
    if (dayIdx !== undefined && (s.stoppedDayIndex === dayIdx || acct.stoppedDayIndex === dayIdx))
      return { state: "stopped_today", reason: acct.stoppedDayIndex === dayIdx ? (acct.stopReason ?? "ACCOUNT_LOSS_STOP") : (s.stopReason ?? "DAILY_LOSS_STOP") };
    if (tradingState !== "running") return { state: "blocked", reason: reason ?? tradingState };
    return { state: "running", reason: null };
  };

  const finish = (tradingState: TradingState, reason: string | null = null, detail: string | null = null): TickResult => {
    acct.lastTickMs = now;
    if (acct.deadManGatedAtMs !== null) warnings.push("DEADMAN_VOLUME_GATED: Hyperliquid refuses the dead-man switch until the account has traded $1M; only IOC orders are placed");
    // One state entry per change of state or reason, not one per tick (the status always shows the current one).
    const key = `${tradingState}|${reason ?? ""}`;
    if (tradingState === "running") {
      acct.lastStateKey = key;
      acct.lastStateRepeats = 0;
    } else if (acct.lastStateKey !== key) {
      log("state", `${tradingState}${reason ? `: ${reason}` : ""}${detail ? ` (${detail})` : ""}`);
      acct.lastStateKey = key;
      acct.lastStateRepeats = 0;
    } else {
      acct.lastStateRepeats += 1;
    }
    acct.recent = [...acct.recent, ...entries].slice(-MAX_RECENT);
    const eq = equity;
    const allowedSet = new Set(cfg.hard.allowedPairs);
    const positionValue = eq === null ? 0n : eq.positions.filter((p) => allowedSet.has(p.pair)).reduce((a, p) => a + p.value, 0n);
    const lossSum = sumLoss();
    const v: VaultView = vaultView ?? {
      vaultPaused: false,
      status: "Paused",
      remainingTodayUsdc: "0",
      perTxLimitUsdc: "0",
      paymentsToday: 0,
      maxPaymentsPerDay: 0,
      expiresAtMs: null,
    };
    const orderRows: TradingStatus["open_orders"] = openOrders
      .filter((o) => o.market === "spot" && o.cloid !== null)
      .map((o) => {
        const owner = ownerOf(o.cloid);
        return {
          oid: o.oid,
          cloid: o.cloid ?? "",
          pair: o.pair,
          side: o.side,
          price: o.price,
          size: o.size,
          placed_at_ms: o.placedAtMs,
          rule_id: owner === undefined ? null : (bs(owner).orders[o.cloid ?? ""]?.ruleId ?? null),
          bot_id: owner ?? null,
        };
      });
    const status: StatusPieces = {
      state: tradingState,
      state_reason: reason,
      state_detail: detail,
      state_repeats: acct.lastStateRepeats,
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
        // `effective` describes ONE bot (the default bot, else the first active one); the account caps apply to all of them.
        effective_bot_id: bestBot?.id ?? null,
        today: { orders: acct.ordersToday, loss_usdc: dec(lossSum) },
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
      open_orders: orderRows,
      dead_man: { cancel_at_ms: acct.deadManAtMs, available: acct.deadManGatedAtMs === null, reason: acct.deadManGatedAtMs === null ? null : "DEADMAN_VOLUME_GATED" },
      perp_check: { ok: perpOk, at_ms: now },
      last_tick_ms: now,
      next_tick_ms: now + tickMs,
      warnings,
    };

    // Per-bot views (state, numbers, positions).
    const views: Record<string, BotView> = {};
    const midOf = (pair: string): Fx => {
      const m = mids?.mids[pair];
      return m === undefined ? 0n : fx(m);
    };
    for (const b of input.bots) {
      const s = bs(b.id);
      const row = botRow(b.id, tradingState, reason);
      const p = positionOf(s.agg.total);
      const positions: BotView["positions"] = [];
      const pos: Record<string, Dec> = {};
      const px: Record<string, Dec> = {};
      let value = 0n;
      for (const [pair, size] of Object.entries(p)) {
        if (size <= 0n) continue;
        const mid = midOf(pair);
        const val = fxMul(size, mid);
        let cost = 0n;
        let bsize = 0n;
        for (const per of Object.values(s.agg.basis)) {
          const e = per[pair];
          if (e) {
            bsize += fx(e.size);
            cost += fx(e.cost);
          }
        }
        positions.push({ pair, size: dec(size, 8), avgCost: bsize > 0n ? dec((cost * SCALE) / bsize, 8) : null, mid: dec(mid, 8), value: dec(val) });
        pos[pair] = dec(size, 8);
        if (mid > 0n) px[pair] = dec(mid, 8);
        value += val;
      }
      for (const pair of b.rules?.rules.pairs ?? []) if (px[pair] === undefined && midOf(pair) > 0n) px[pair] = dec(midOf(pair), 8);
      const bp = pnl?.bots[b.id];
      views[b.id] = {
        id: b.id,
        state: row.state,
        reason: row.reason,
        detail: null,
        ordersToday: s.ordersToday,
        lossToday: dec(botLoss(b.id)),
        pnlToday: bp ? dec(bp.today) : "0",
        pnlTotal: bp ? dec(bp.total) : "0",
        positionUsdc: dec(value),
        positions,
        pos,
        px,
        limits: b.rules ? effectiveLimitsStatus(effectiveLimits(b.rules.rules, cfg.hard), cfg.hard.priceBandBps) : null,
        openOrders: orderRows.filter((o) => o.bot_id === b.id),
        priced: bp !== undefined,
      };
    }
    const accountSample =
      eq !== null && pnl !== null
        ? {
            pnl: dec(pnl.total),
            today: dec(pnl.today),
            equity: dec(eq.equity),
            positionUsdc: dec(positionValue),
            px: Object.fromEntries(eq.positions.map((p) => [p.pair, dec(p.mid, 8)])),
          }
        : null;
    return { state: st, tradingState, status, entries, bots: views, attributed, accountSample, ...(agentOut !== undefined ? { agent: agentOut } : {}) };
  };

  try {
    // Attribution memory of a bot's resting orders: a different rule set starts with a clean per-rule slate.
    for (const b of active) {
      const s = bs(b.id);
      const r = b.rules as ActiveRules;
      if (s.rulesHash !== r.hash) {
        s.rulesHash = r.hash;
        s.firedAt = {};
        s.lastSkip = {};
        log("state", `rules ${r.hash.slice(0, 16)} active`, { bot_id: b.id });
      }
    }

    // 1. Read state. Any HL read failure = no trading this tick (and no dead-man refresh: orders expire on their own).
    let spotPairs: HlSpotPair[];
    let balances: Awaited<ReturnType<HlPort["getSpotBalances"]>>;
    let perp: Awaited<ReturnType<HlPort["getPerpState"]>>;
    let agents: Awaited<ReturnType<HlPort["getApprovedAgents"]>>;
    let ledger: Awaited<ReturnType<HlPort["getLedger"]>>;
    let newFills: HlFill[];
    let midsRead: Awaited<ReturnType<HlPort["getMids"]>>;
    /** Set only when there is no persisted cursor yet (or a gap forced a restart). */
    let freshCursor: FillCursor | null = null;
    let readsDoneMs = now;
    let fellBack = false;
    try {
      [spotPairs, midsRead, openOrders, balances, perp, agents] = await Promise.all([
        hl.getSpotPairs(),
        hl.getMids(),
        hl.getOpenOrders(cfg.account),
        hl.getSpotBalances(cfg.account),
        hl.getPerpState(cfg.account),
        hl.getApprovedAgents(cfg.account),
      ]);
      readsDoneMs = Math.max(now, deps.clock?.() ?? now);
      const since = Math.min(cfg.fundedSinceMs, acct.day?.snapshotAtMs ?? now, now);
      ledger = await hl.getLedger(cfg.account, since);
      // Fills: only what is newer than the persisted cursor (complete or an error, see hl/pagination.ts). The first read
      // reaches back to the earliest window; if HL no longer has that far back, fall back to today's window and mark the
      // totals as partial. The same fallback applies when a persisted cursor is so old (long downtime) that the rows since it
      // exceed what HL keeps: the sums restart from today's window, flagged partial (a gap cannot be repaired), instead of
      // failing for ever. If even today's window cannot be proven complete the error stands (fail closed).
      // OPERATOR RESET: set "account.fillCursor" to null in engine-state.json (worker stopped) to rebuild the sums from scratch.
      const todayFrom = acct.day?.snapshotAtMs ?? null;
      const fallback = async (): Promise<{ fills: HlFill[]; cursor: FillCursor }> => {
        const from = Math.min(todayFrom ?? now, now);
        return { fills: await hl.getUserFills(cfg.account, from), cursor: emptyCursor(from, todayFrom, false) };
      };
      if (acct.fillCursor !== null) {
        try {
          newFills = await hl.getUserFills(cfg.account, readFrom(acct.fillCursor));
        } catch (e) {
          if (!isFillsTruncated(e)) throw e;
          const fb = await fallback();
          newFills = fb.fills;
          freshCursor = fb.cursor;
          fellBack = true;
        }
      } else {
        try {
          newFills = await hl.getUserFills(cfg.account, since);
          freshCursor = emptyCursor(since, todayFrom, true);
        } catch (e) {
          if (!isFillsTruncated(e)) throw e;
          const fb = await fallback();
          newFills = fb.fills;
          freshCursor = fb.cursor;
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
    mids = midsRead;
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

    const fresh = now - midsRead.atMs <= 2 * tickMs;
    const allowed = new Set(cfg.hard.allowedPairs);
    equity = computeEquity(balances, midsRead.mids);
    // Skew between the local clock and HL's fill clock: the day window uses local time, fills carry HL time.
    const newest = newFills.reduce((m, f) => Math.max(m, f.timeMs), 0);
    if (newest > now + CLOCK_SKEW_WARN_MS) warnings.push(`HL fill timestamps are ${Math.round((newest - now) / 1000)} s ahead of the local clock; day windows may be off`);
    if (equity.unpriced.length > 0) warnings.push(`no mid for held ${equity.unpriced.join(", ")} (valued at 0)`);
    if (!fresh) warnings.push("market data older than 2 ticks");

    /** A mid counts only if it is positive and current for THAT pair (per-pair age when the adapter has one). */
    const priced = (pair: string): boolean => {
      const m = midsRead.mids[pair];
      return m !== undefined && fx(m) > 0n && now - (midsRead.pairAtMs?.[pair] ?? midsRead.atMs) <= 2 * tickMs;
    };
    const heldBalancePairs = balances.filter((b) => b.coin !== "USDC" && fx(b.total) > 0n).map((b) => `${b.coin}/USDC`).filter((p) => allowed.has(p));
    /** Pairs in which any bot holds something according to its fills (they need a mid for the day snapshot too). */
    const botPairs = (): string[] => [...new Set(Object.values(st.bots).flatMap((b) => Object.entries(positionOf(b.agg.total)).filter(([, q]) => q > 0n).map(([p]) => p)))];

    // Day rollover. Needs fresh mids for a trustworthy equity snapshot, and a mid for EVERY held allowed-pair coin: a coin
    // without a mid would be missing from startPositions and its later losses would be invisible to the loss stop.
    let rolled = false;
    if (fresh && (acct.day === null || acct.day.dayIndex !== utcDayIndex(now))) {
      const missing = [...new Set([...heldBalancePairs, ...botPairs()])].filter((p) => !priced(p));
      if (missing.length > 0) {
        warnings.push(`day snapshot postponed: no current mid for held ${missing.join(", ")}`);
      } else {
        // Note: an allowed coin without a mid keeps the snapshot postponed (above) until HL prices it again; if HL never does
        // (delisted pair), NO_DAY_SNAPSHOT is permanent and needs operator action: sell or move the coin, or remove the pair.
        const r = rollDay(acct.day, now, equity.equity, equity.positions.filter((p) => allowed.has(p.pair)), {
          backstop: backstopEquity(equity, allowed),
          balanceAtMs: readsDoneMs,
        });
        acct.day = r.day;
        rolled = r.rolled;
        acct.ordersToday = 0;
        acct.lastStateKey = null; // the state log re-logs the current state once per day
        for (const s of Object.values(st.bots)) {
          s.ordersToday = 0;
          s.filledOrdersToday = 0;
          s.filledOidsToday = [];
        }
        log("state", `new UTC day ${r.day.dayIndex}, start equity ${r.day.startEquity}`);
      }
    }
    // A snapshot written before startPositions existed cannot value coins that are held now: no trading until the next one.
    const legacyDay = acct.day !== null && acct.day.startPositions === undefined && heldBalancePairs.length > 0;

    // Fills: fold the new ones into the bots' persisted running sums.
    let cur: FillCursor | null = fellBack ? freshCursor : (acct.fillCursor ?? freshCursor);
    if (cur === null) throw new Error("fill cursor missing"); // unreachable: either persisted or just created
    if (fellBack) warnings.push("fill history gap after a long pause: pnl.total, positions and position_pnl cost bases restart from today's window (partial)");
    // A fresh cursor means the sums are rebuilt from scratch: old per-bot sums would be counted twice.
    const resetSums = freshCursor !== null && (fellBack || acct.fillCursor === null);
    if (resetSums) {
      const complete = freshCursor === null || freshCursor.completeFromMs === 0;
      for (const s of Object.values(st.bots)) s.agg = emptyBotAgg(complete);
    }
    if (rolled && acct.day !== null) {
      cur = rollCursorToday(cur, acct.day.snapshotAtMs);
      for (const s of Object.values(st.bots)) s.agg = rollBotToday(s.agg);
    }
    // Open orders of a bot tell us their order ids (fills may carry no usable cloid).
    for (const o of openOrders) {
      const owner = o.market === "spot" ? ownerOf(o.cloid) : undefined;
      if (owner !== undefined) st.oidBot[String(o.oid)] = owner;
    }
    st.oidBot = trimOids(st.oidBot);
    const aggsIn: Record<string, BotAgg> = Object.fromEntries(Object.entries(st.bots).map(([id, s]) => [id, s.agg]));
    const ap = applyFills(cur, aggsIn, newFills, { fundedSinceMs: cfg.fundedSinceMs, resolve: (f) => resolveBot(f, prefixToBot, st.oidBot) });
    acct.fillCursor = ap.cursor;
    for (const [id, a] of Object.entries(ap.aggs)) bs(id).agg = a;
    attributed = ap.attributed.map((x) => {
      const ruleId = (x.fill.cloid !== null ? bs(x.botId).cloidRule?.[x.fill.cloid.toLowerCase()] : undefined) ?? null;
      // ADR-0007: the agent's sanitised note for the order (only present for agent orders, so DSL rows are unchanged).
      const note = x.fill.cloid !== null ? bs(x.botId).cloidNote?.[x.fill.cloid.toLowerCase()] : undefined;
      return note === undefined ? { ...x, ruleId } : { ...x, ruleId, note };
    });
    if (acct.day !== null && ap.cursor.todayFromMs !== acct.day.snapshotAtMs) {
      acct.fillCursor = null; // out of sync with the day snapshot (hand-edited state?): rebuild from scratch next tick
      return finish("error", "FILLS_RESYNC", "fill tracker does not match the day snapshot; rebuilding");
    }
    // A bot's own start-of-day holdings = its position now minus what today's fills changed (so fills read late still count).
    if (rolled) {
      for (const s of Object.values(st.bots)) {
        const start: BotEngineState["startPositions"] = {};
        const total = positionOf(s.agg.total);
        const todayNet = (pair: string): Fx => {
          const a = s.agg.today[pair];
          return a ? fx(a.dq) - (a.feeBase !== undefined ? fx(a.feeBase) : 0n) : 0n;
        };
        for (const pair of Object.keys(s.agg.total)) {
          const t = s.agg.total[pair];
          const net = t ? fx(t.dq) - (t.feeBase !== undefined ? fx(t.feeBase) : 0n) : 0n;
          const size = fxMin(total[pair] ?? 0n, pos0(net - todayNet(pair)));
          const m = midsRead.mids[pair];
          if (size > 0n && m !== undefined) start[pair] = { size: fxStr(size, 12), mid: fxStr(fx(m), 12) };
        }
        s.startPositions = start;
      }
    }
    const trk = ap.cursor;

    // Held allowed-pair coins and bot positions that have no current mid: valued at 0 by the stop, and no new orders.
    const held = new Set<string>(heldBalancePairs);
    for (const s of Object.values(st.bots)) {
      for (const m of [s.agg.today, s.agg.total]) for (const [pair, a] of Object.entries(m)) if (fx(a.dq) !== 0n) held.add(pair);
      for (const [pair, sp] of Object.entries(s.startPositions)) if (fx(sp.size) !== 0n) held.add(pair);
    }
    for (const [pair, sp] of Object.entries(acct.day?.startPositions ?? {})) if (fx(sp.size) !== 0n) held.add(pair);
    const unpricedHeld = [...held].filter((p) => !priced(p));

    // Loss stops and P&L: the bots' own fills + mark-to-market only; external flows and fees are reported, not counted.
    if (acct.day !== null) {
      pnl = pnlSummaryMulti({
        day: acct.day,
        equityNow: equity.equity,
        equityBackstopNow: backstopEquity(equity, allowed, acct.day.startPositions ?? {}),
        held: Object.fromEntries(balances.filter((b) => b.coin !== "USDC" && fx(b.total) > 0n).map((b) => [`${b.coin}/USDC`, fx(b.total)])),
        ledger,
        fundedSinceMs: cfg.fundedSinceMs,
        bots: Object.fromEntries(Object.entries(st.bots).map(([id, s]) => [id, { todayAgg: s.agg.today, totalAgg: s.agg.total, startPositions: s.startPositions }])),
        mids: midsRead.mids,
        topups: deps.vaultTopups?.() ?? [],
      });
      if (pnl.unpriced.length > 0) warnings.push(`no mid for traded ${pnl.unpriced.join(", ")} (loss stop values it at 0)`);
      if (pnl.outflowToday > 0n) warnings.push(`${dec(pnl.outflowToday)} USDC left the account today outside the bot (withdrawal or transfer); not counted as trading loss`);
    }
    if (trk.foreignFills > 0) warnings.push(`${trk.foreignFills} spot fill(s) since start are not from any bot (manual trades, or an API key trading without the bots' order ids)`);
    if (Object.values(st.bots).some((s) => !s.agg.totalComplete)) warnings.push("pnl.total is partial: fill history before today was not retrievable");
    if (legacyDay) warnings.push("day snapshot predates position tracking while coins are held: no trading until the next UTC day");

    // Orders of this account on spot markets, resolved to asset ids.
    const cancelSpot = async (why: string, pred: (o: HlOpenOrder) => boolean = () => true, botId?: string): Promise<boolean> => {
      const chosen = openOrders.filter((o) => o.market === "spot" && pred(o));
      const targets = chosen.flatMap((o) => {
        const info = pairMap.get(o.pair);
        return info === undefined || info.assetId < 10_000 ? [] : [{ assetId: info.assetId, oid: o.oid }];
      });
      if (targets.length === 0) return true;
      const extra = botId === undefined ? {} : { bot_id: botId };
      try {
        await hl.cancelOrders(targets);
        log("cancel", `${why}: cancelled ${targets.length} order(s)`, extra);
        const gone = new Set(chosen.map((o) => o.oid));
        const goneCloids = new Set(chosen.map((o) => o.cloid));
        openOrders = openOrders.filter((o) => !gone.has(o.oid));
        for (const s of Object.values(st.bots)) s.orders = Object.fromEntries(Object.entries(s.orders).filter(([c]) => !goneCloids.has(c)));
        return true;
      } catch (e) {
        warnings.push("cancel failed");
        log("cancel", `${why}: cancel failed: ${errMsg(e)}`, extra);
        return false;
      }
    };
    const cancelAllSpot = (why: string): Promise<boolean> => cancelSpot(why);
    const cancelBot = (id: string, why: string): Promise<boolean> => cancelSpot(why, (o) => ownerOf(o.cloid) === id, id);

    // 2. Perp alarm. Any perp position or open perp order halts the account and every bot for good (owner decision 2026-11-03).
    // USDC merely sitting in the perp account opens nothing by itself (only a signed order can), so it is a warning,
    // not a halt: the owner is told to move it to spot. Orders and positions are what the alarm must catch.
    const perpBad = perp.positions.length > 0 || perp.openPerpOrders > 0;
    perpOk = !perpBad;
    if (!perpBad && fx(perp.accountValueUsdc) > fx(PERP_VALUE_ALARM)) {
      warnings.push(`perp account holds ${perp.accountValueUsdc} USDC with no positions; move it to spot`);
    }
    if (perpBad && acct.halt === null) {
      const detail = `perp positions ${perp.positions.length}, open perp orders ${perp.openPerpOrders}, perp account value ${perp.accountValueUsdc}`;
      const h = haltAll(st, now, "PERP_POSITION_DETECTED", detail, input.bots.map((b) => b.id));
      acct.halt = h.account.halt;
      st.bots = h.bots;
      log("state", `ALARM PERP_POSITION_DETECTED: ${detail}`);
    }
    if (acct.halt !== null) {
      const ok = await cancelAllSpot(`halted (${acct.halt.reason})`);
      if (!ok) await schedule(now + cfg.deadmanSec * 1000); // backstop if the cancel did not go through
      return finish("halted", acct.halt.reason, acct.halt.detail);
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

    if (active.length === 0) return finish("no_rules");
    eff = effectiveLimits(bestRules?.rules ?? null, cfg.hard);

    if (!fresh) return finish("error", "STALE_DATA", `mids are ${now - midsRead.atMs} ms old`);
    if (acct.day === null || pnl === null || acct.day.dayIndex !== utcDayIndex(now)) return finish("error", "NO_DAY_SNAPSHOT", acct.day === null ? null : "today's snapshot could not be taken yet");
    if (legacyDay) return finish("error", "NO_DAY_SNAPSHOT", "day snapshot predates position tracking; waiting for the next UTC day");
    const day = acct.day;
    const dayPnl = pnl;

    // The account stop holds for the rest of the UTC day, also across a rule change (only 00:00 UTC clears it).
    if (acct.stoppedDayIndex === day.dayIndex) {
      await cancelAllSpot("stopped_today");
      const why = acct.stopReason ?? "ACCOUNT_LOSS_STOP";
      return finish("stopped_today", why, why === "EQUITY_DROP" ? `equity down ${dec(dayPnl.equityDrop)} USDC` : `summed loss today ${dec(sumLoss())} USDC`);
    }
    if (acct.stoppedDayIndex !== null && acct.stoppedDayIndex !== day.dayIndex) {
      acct.stoppedDayIndex = null;
      acct.stopReason = null;
    }
    for (const s of Object.values(st.bots)) {
      if (s.stoppedDayIndex !== null && s.stoppedDayIndex !== day.dayIndex) {
        s.stoppedDayIndex = null;
        s.stopReason = null;
      }
    }
    /** Bots that may still place orders now: active, not halted, not stopped for today. */
    const liveBots = (): BotInput[] => active.filter((b) => bs(b.id).halt === null && bs(b.id).stoppedDayIndex !== day.dayIndex);
    /** Ends the tick when no bot can trade: cancels what rests and reports halted (all killed) or stopped_today. */
    const finishIfNoLiveBot = async (): Promise<TickResult | null> => {
      if (liveBots().length > 0) return null;
      for (const b of active) await cancelBot(b.id, bs(b.id).halt !== null ? "halted" : "stopped_today");
      const halted = active.filter((b) => bs(b.id).halt !== null);
      if (halted.length === active.length) {
        const h = bs((halted[0] as BotInput).id).halt;
        return finish("halted", h?.reason ?? "KILLED", h?.detail ?? null);
      }
      const first = active.find((b) => bs(b.id).stoppedDayIndex === day.dayIndex) as BotInput;
      const lim = effectiveLimits((first.rules as ActiveRules).rules, cfg.hard);
      return finish("stopped_today", "DAILY_LOSS_STOP", `loss today ${dec(botLoss(first.id))} USDC >= stop ${dec(lim.dailyLossStop)} USDC`);
    };
    {
      const r = await finishIfNoLiveBot();
      if (r !== null) return r;
    }

    // Fail closed on what the stop cannot see.
    if (unpricedHeld.length > 0) return finish("error", "NO_MID_FOR_POSITION", `no current mid for held ${unpricedHeld.join(", ")}`);
    // Every bot order reported filled today must have at least one fill attributed to that bot. A single misattributed order
    // would otherwise hide its P&L from the stop as long as some OTHER fill was attributed.
    for (const [id, s] of Object.entries(st.bots)) {
      const attributedOids = new Set(s.agg.botOidsToday);
      const unattributed = s.filledOidsToday.filter((o) => !attributedOids.has(o));
      if (unattributed.length > 0 || (s.filledOrdersToday > 0 && s.agg.botFillsToday === 0)) {
        return finish(
          "error",
          "FILLS_NOT_ATTRIBUTED",
          `bot ${id}: ${s.filledOrdersToday} order(s) filled today, ${unattributed.length > 0 ? `order id(s) ${unattributed.slice(0, 5).join(", ")} have` : "no fill is attributed to the bot; none has"} no fill attributed to the bot (cloid/oid mismatch, or the fill is not indexed yet)`,
        );
      }
    }

    // 4. Dead-man switch BEFORE any order. If it cannot be set, no order is placed.
    if (stopped()) return finish("halted", "KILLED", "kill switch pulled while the tick was running");
    // HL refuses scheduleCancel for accounts under $1M traded volume. That is the one refusal that is not fatal: the engine
    // then trades with IOC orders only (nothing rests, so nothing needs the switch) and re-tries once per hour. Any other
    // scheduleCancel failure still blocks trading.
    if (acct.deadManGatedAtMs !== null && now - acct.deadManGatedAtMs < DEADMAN_RETRY_MS) {
      acct.deadManAtMs = null;
    } else if (await schedule(now + cfg.deadmanSec * 1000)) {
      if (acct.deadManGatedAtMs !== null) log("state", "dead-man switch accepted again: limit orders are allowed");
      acct.deadManGatedAtMs = null;
    } else {
      if (stopped()) return finish("halted", "KILLED", "kill switch pulled while the tick was running");
      if (schedErr.msg === null || !VOLUME_GATE_RE.test(schedErr.msg)) {
        return finish("error", "SCHEDULE_CANCEL_FAILED", "refusing to trade without the dead-man switch");
      }
      if (acct.deadManGatedAtMs === null) log("state", "DEADMAN_VOLUME_GATED: HL refuses scheduleCancel until $1M volume is traded; IOC orders only");
      acct.deadManGatedAtMs = now;
      acct.deadManAtMs = null;
    }
    const deadManOk = acct.deadManGatedAtMs === null;

    // 5. Loss stops. Per bot first (its own fills, its own start holdings), then the summed account stop, then the backstop.
    for (const b of liveBots()) {
      const lim = effectiveLimits((b.rules as ActiveRules).rules, cfg.hard);
      if (botLoss(b.id) >= lim.dailyLossStop) {
        const s = bs(b.id);
        s.stoppedDayIndex = day.dayIndex;
        s.stopReason = "DAILY_LOSS_STOP";
        log("state", `DAILY_LOSS_STOP: loss today ${dec(botLoss(b.id))} USDC >= stop ${dec(lim.dailyLossStop)} USDC`, { bot_id: b.id });
        await cancelBot(b.id, "daily loss stop");
      }
    }
    if (sumLoss() >= fx(cfg.hard.dailyLossUsdc)) {
      acct.stoppedDayIndex = day.dayIndex;
      acct.stopReason = "ACCOUNT_LOSS_STOP";
      await cancelAllSpot("account loss stop");
      return finish("stopped_today", "ACCOUNT_LOSS_STOP", `summed loss today ${dec(sumLoss())} USDC >= account stop ${cfg.hard.dailyLossUsdc} USDC`);
    }
    {
      const r = await finishIfNoLiveBot();
      if (r !== null) return r;
    }
    // Backstop for losses the fill accounting cannot see (a leaked API key trading without the bots' ids). Threshold:
    // min(hard stop, sum of the active bots' stops), which is the single bot's stop when there is one.
    const sumStops = active.reduce((a, b) => a + effectiveLimits((b.rules as ActiveRules).rules, cfg.hard).dailyLossStop, 0n);
    const backstopStop = fxMin(fx(cfg.hard.dailyLossUsdc), sumStops);
    if (dayPnl.equityDrop >= backstopStop) {
      acct.stoppedDayIndex = day.dayIndex;
      acct.stopReason = "EQUITY_DROP";
      await cancelAllSpot("equity drop");
      return finish("stopped_today", "EQUITY_DROP", `equity down ${dec(dayPnl.equityDrop)} USDC >= stop ${dec(backstopStop)} USDC (not explained by flows)`);
    }

    // 6. Cancel orders past their ttl, orders of a superseded or unknown rule set, and orders of bots that may not trade.
    const live = liveBots();
    const liveIds = new Set(live.map((b) => b.id));
    const toCancel: HlOpenOrder[] = [];
    const cancelledBuyByBot = new Map<string, Fx>();
    let cancelledBuyValue = 0n;
    for (const o of openOrders) {
      if (o.market !== "spot" || o.cloid === null) continue;
      const owner = ownerOf(o.cloid);
      const ob = owner === undefined ? undefined : botIn.get(owner);
      const meta = owner === undefined ? undefined : bs(owner).orders[o.cloid];
      let drop = false;
      if (owner === undefined || ob === undefined || ob.archived || ob.rules === null) drop = true; // no bot / no active rule set
      else if (!liveIds.has(owner)) drop = true; // halted or stopped bot
      else if (cloidPrefixOf(o.cloid) !== cloidPrefix(ob.rules.hash)) drop = true; // superseded rule set
      else if (meta?.expiresAtMs != null && meta.expiresAtMs <= now) drop = true;
      // Without the dead-man switch no bot order may rest: nothing would cancel it if the worker dies.
      else if (!deadManOk) drop = true;
      if (drop) toCancel.push(o);
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
        for (const o of toCancel) {
          if (o.side !== "buy") continue;
          const v = fxMul(fx(o.price), fx(o.size));
          cancelledBuyValue += v;
          const owner = ownerOf(o.cloid);
          if (owner !== undefined) cancelledBuyByBot.set(owner, (cancelledBuyByBot.get(owner) ?? 0n) + v);
        }
        const gone = new Set(toCancel.map((o) => o.oid));
        openOrders = openOrders.filter((o) => !gone.has(o.oid));
      } catch (e) {
        warnings.push("ttl cancel failed");
        log("cancel", `ttl cancel failed: ${errMsg(e)}`);
      }
    }
    const liveCloids = new Set(openOrders.map((o) => o.cloid));
    for (const s of Object.values(st.bots)) s.orders = Object.fromEntries(Object.entries(s.orders).filter(([c]) => liveCloids.has(c)));

    // 7. Per bot, in creation order. At most 1 order per rule and MAX_ORDERS_PER_TICK per tick for the whole account. Free
    //    balances are decremented as we go, conservatively assuming each attempted order fills, so a later order (also of
    //    another bot) cannot overspend.
    //    ADR-0007: everything from sizing to the post-placement balance updates lives in `attempt()`, the ONE path by which an
    //    order reaches HL, for a fired DSL rule and for an AI agent's intent alike.
    const freeBase = new Map(equity.positions.map((p) => [p.pair, p.free]));
    let freeUsdc = equity.usdcFree;
    let accountPosition = equity.positions.filter((p) => allowed.has(p.pair)).reduce((a, p) => a + p.value, 0n);
    const openSpot = openOrders.filter((o) => o.market === "spot");
    const accountOpenBuy = cancelledBuyValue + openSpot.filter((o) => o.side === "buy").reduce((a, o) => a + fxMul(fx(o.price), fx(o.size)), 0n);
    if (openOrders.some((o) => o.cloid === null)) warnings.push("open orders without cloid (placed by hand) are counted but never cancelled");
    let placed = 0;
    const hardAcct = effectiveLimits(null, cfg.hard);

    /** Per-bot setup: the bot's limits, its own holdings and orders. A bot only ever sells what its own fills bought. */
    const botCtx = (bot: BotInput): BotCtx => {
      const active1 = bot.rules as ActiveRules;
      const rules = active1.rules;
      const s = bs(bot.id);
      const botEff = effectiveLimits(rules, cfg.hard);
      const prefix = cloidPrefix(active1.hash);
      const ownPos = positionOf(s.agg.total);
      const mine = openSpot.filter((o) => ownerOf(o.cloid) === bot.id);
      const ownOpenSell = new Map<string, Fx>();
      for (const o of mine) if (o.side === "sell") ownOpenSell.set(o.pair, (ownOpenSell.get(o.pair) ?? 0n) + fx(o.size));
      let botPosition = 0n;
      for (const [pair, q] of Object.entries(ownPos)) botPosition += fxMul(q, fx(midsRead.mids[pair] ?? "0"));
      const botOpenBuy = (cancelledBuyByBot.get(bot.id) ?? 0n) + mine.filter((o) => o.side === "buy").reduce((a, o) => a + fxMul(fx(o.price), fx(o.size)), 0n);
      /** What a sell of this pair may still take from the bot: its own position minus its open sells; null = unknown. */
      const capacityOf = (pair: string): Fx | null => (s.agg.totalComplete ? pos0((ownPos[pair] ?? 0n) - (ownOpenSell.get(pair) ?? 0n)) : null);
      return { bot, active1, rules, s, botEff, prefix, ownOpenSell, botPosition, botOpenBuy, capacityOf };
    };

    /** A refusal: DSL skips keep their de-duplication; every agent refusal is logged (with its code and the agent's note). */
    const refuse = (botId: string, s: BotEngineState, cand: Candidate, code: string, reason: string): AttemptOutcome => {
      if (cand.source === "rules") skip(s, log, botId, cand.ruleId, code, reason);
      else log("skip", `${code}: ${reason}`, { rule_id: cand.ruleId, bot_id: botId, source: "agent", code, ...(cand.note !== null ? { note: cand.note } : {}) });
      return { placed: false, code, reason };
    };

    /**
     * The shared order path (ADR-0007 section 5): market checks, sell capacity, sizing, book, `checkOrder` (bot limits, then the
     * account caps), the dead-man lock, the kill check, write-ahead counters, placement, attribution and balance updates.
     * Returns a TickResult only when the write-ahead failed (STATE_WRITE_FAILED ends the tick).
     */
    const attempt = async (ctx: BotCtx, cand: Candidate): Promise<AttemptOutcome | TickResult> => {
      const { bot, active1, rules, s, botEff } = ctx;
      // Audit AL4: an agent may name ANY pair, so for agent orders the pair checks of `checkOrder` run first (same codes, same
      // text): an off-mandate request costs no HL read and gets the code the owner expects. DSL rules are always on mandate
      // pairs, so their path is unchanged (checkOrder still runs both checks below for every order).
      if (cand.source === "agent") {
        if (!cfg.hard.allowedPairs.includes(cand.pair)) return refuse(bot.id, s, cand, "PAIR_NOT_ALLOWED", `${cand.pair} is not in TRADING_ALLOWED_PAIRS`);
        if (!rules.pairs.includes(cand.pair)) return refuse(bot.id, s, cand, "PAIR_NOT_IN_RULES", `${cand.pair} is not in the active rule set's pairs`);
      }
      const info = pairMap.get(cand.pair);
      const midStr = midsRead.mids[cand.pair];
      if (info === undefined || midStr === undefined) return refuse(bot.id, s, cand, "NO_MARKET", `no spot pair or mid for ${cand.pair}`);
      // Live 24 h volume (the offline check at load time cannot know it): a thin pair is never traded.
      if (fx(info.volume24hUsdc) < fx(cfg.hard.minPairVolumeUsdc))
        return refuse(bot.id, s, cand, "PAIR_LOW_VOLUME", `${cand.pair} 24h volume ${info.volume24hUsdc} is below the minimum ${cfg.hard.minPairVolumeUsdc}`);
      const mid = fx(midStr);
      const action = cand.action;

      const isSell = action.side === "sell";
      const accountFree = freeBase.get(cand.pair) ?? 0n;
      let botBase: Fx | null | undefined;
      if (isSell) {
        botBase = ctx.capacityOf(cand.pair);
        if (botBase === null)
          return refuse(bot.id, s, cand, "BOT_POSITION_UNKNOWN", "this bot's position cannot be derived from its fills (history before today is incomplete), so it sells nothing");
        if (botBase <= 0n) return refuse(bot.id, s, cand, "INSUFFICIENT_BOT_BASE", "this bot owns none of this coin (it never sells another bot's or the owner's coins)");
      }
      const sized = sizeOrder({ action, mid, priceBandBps: cfg.hard.priceBandBps, szDecimals: info.szDecimals, freeBase: botBase === undefined || botBase === null ? accountFree : fxMin(accountFree, botBase) });
      if (!sized.ok) return refuse(bot.id, s, cand, sized.code, sized.reason);

      let book;
      try {
        book = await hl.getBook(cand.pair);
      } catch (e) {
        return refuse(bot.id, s, cand, "BOOK_UNAVAILABLE", `order book unavailable: ${errMsg(e)}`);
      }
      const verdict = checkOrder(
        { pair: cand.pair, assetId: info.assetId, side: action.side, price: sized.price, size: sized.size, tif: sized.tif },
        {
          nowMs: now,
          tickMs,
          deadManAvailable: deadManOk,
          allowedPairs: cfg.hard.allowedPairs,
          rulePairs: rules.pairs,
          priceBandBps: cfg.hard.priceBandBps,
          limits: botEff,
          ordersToday: s.ordersToday,
          mid,
          book: { bid: book.bid === null ? null : fx(book.bid), ask: book.ask === null ? null : fx(book.ask), atMs: book.atMs },
          freeUsdc,
          freeBase: accountFree,
          positionValue: ctx.botPosition,
          openBuyValue: ctx.botOpenBuy,
          lastFiredAtMs: s.firedAt[cand.ruleId],
          cooldownMs: cand.cooldownMs,
          account: { maxPosition: hardAcct.maxPosition, maxOrdersPerDay: hardAcct.maxOrdersPerDay, ordersToday: acct.ordersToday, positionValue: accountPosition, openBuyValue: accountOpenBuy },
          ...(isSell ? { botBase } : {}),
        },
      );
      if (!verdict.ok) {
        let reason = verdict.reason;
        if (verdict.code === "MIN_NOTIONAL") {
          const adv = "usdc" in action.size ? minOrderAdvice(fx(action.size.usdc), sized.price, info.szDecimals) : undefined;
          reason += `; order is ${fxStr(sized.size, 8)} coins at ${fxStr(sized.price, 8)}${adv ? `, ${describeMinOrder(adv, botEff.maxOrder)}` : ""}`;
        }
        return refuse(bot.id, s, cand, verdict.code, reason);
      }

      // Second lock (checkOrder rejects this already): a resting order never goes out without the dead-man switch.
      if (sized.tif !== "Ioc" && !deadManOk) return refuse(bot.id, s, cand, "LIMIT_NEEDS_DEADMAN", "a resting order needs the dead-man switch, which is unavailable");
      // Place. From here the rule is "fired" whatever HL answers (a rejected order still starts the cooldown).
      if (stopped(bot.id)) {
        const reason = "kill switch pulled while the tick was running: no further orders";
        log("skip", reason, { rule_id: cand.ruleId, bot_id: bot.id, ...(cand.source === "agent" ? { source: "agent" as const, code: "KILLED", ...(cand.note !== null ? { note: cand.note } : {}) } : {}) });
        return { placed: false, code: "KILLED", reason, killed: true };
      }
      clearSkip(s, cand.ruleId);
      const prevFired = s.firedAt[cand.ruleId];
      acct.orderCounter += 1;
      const cloid = makeCloid(active1.hash, acct.orderCounter);
      s.firedAt[cand.ruleId] = now;
      s.ordersToday += 1;
      acct.ordersToday += 1;
      try {
        deps.beforeOrder?.(st, attributed); // write-ahead: counters are on disk before the order can reach HL
      } catch (e) {
        acct.orderCounter -= 1;
        s.ordersToday -= 1;
        acct.ordersToday -= 1;
        s.firedAt = Object.fromEntries(Object.entries(s.firedAt).filter(([k]) => k !== cand.ruleId || prevFired !== undefined));
        if (prevFired !== undefined) s.firedAt[cand.ruleId] = prevFired;
        warnings.push("state write failed");
        return finish("error", "STATE_WRITE_FAILED", `refusing to place an order: ${errMsg(e)}`);
      }
      placed += 1;
      let result: HlOrderResult;
      let outcomeUnknown = false;
      try {
        result = await hl.placeSpotOrder({
          assetId: info.assetId,
          isBuy: action.side === "buy",
          price: dec(sized.price, 12),
          size: dec(sized.size, 12),
          tif: sized.tif,
          cloid,
        });
      } catch (e) {
        // A throw (not an HL error status, see hl/nktkas.ts) leaves the outcome unknown; fills/open orders reconcile it later.
        result = { status: "rejected", error: errMsg(e) };
        outcomeUnknown = true;
      }
      s.cloidRule = Object.fromEntries(Object.entries({ ...(s.cloidRule ?? {}), [cloid]: cand.ruleId }).slice(-MAX_CLOID_RULES));
      if (cand.note !== null) s.cloidNote = Object.fromEntries(Object.entries({ ...(s.cloidNote ?? {}), [cloid]: cand.note }).slice(-MAX_CLOID_RULES));
      if ("oid" in result) {
        st.oidBot[String(result.oid)] = bot.id;
        st.oidBot = trimOids(st.oidBot);
      }
      if (result.status === "filled" && fx(result.filledSize) > 0n) {
        s.filledOrdersToday += 1;
        if ("oid" in result) s.filledOidsToday = [...s.filledOidsToday, result.oid].slice(-MAX_BOT_OIDS);
      }
      log("order", `${action.side} ${dec(sized.size, 8)} ${cand.pair} @ ${dec(sized.price, 8)} ${sized.tif}: ${result.status}${result.status === "rejected" ? ` (${result.error})` : ""}`, {
        rule_id: cand.ruleId,
        bot_id: bot.id,
        cloid,
        ...("oid" in result ? { oid: result.oid } : {}),
        ...(cand.source === "agent"
          ? { source: "agent" as const, ...(result.status === "rejected" ? { code: outcomeUnknown ? "OUTCOME_UNKNOWN" : "HL_REJECTED" } : {}), ...(cand.note !== null ? { note: cand.note } : {}) }
          : {}),
      });
      if (result.status === "resting") {
        const ttl = action.order.type === "limit" ? action.order.ttl : null;
        s.orders[cloid] = { ruleId: cand.ruleId, expiresAtMs: ttl === null ? null : now + DURATION_MS[ttl] };
      }
      if (action.side === "buy") {
        freeUsdc -= verdict.notional;
        ctx.botPosition += verdict.notional;
        accountPosition += verdict.notional;
      } else {
        freeBase.set(cand.pair, fxMax(0n, accountFree - sized.size));
        ctx.ownOpenSell.set(cand.pair, (ctx.ownOpenSell.get(cand.pair) ?? 0n) + sized.size);
      }
      return { placed: true, cloid, price: sized.price, size: sized.size, notional: verdict.notional, result, ...(outcomeUnknown ? { outcomeUnknown: true as const } : {}) };
    };

    // ADR-0007 agent tick: no DSL rule of any bot is evaluated; the one intent goes through `attempt()`.
    if (input.agent !== undefined) {
      const ag = input.agent;
      const cand: Candidate = { ruleId: AGENT_RULE_ID, pair: ag.intent.pair, action: { side: ag.intent.side, size: ag.intent.size, order: { type: "ioc" } }, cooldownMs: undefined, source: "agent", note: ag.note };
      const target = active.find((b) => b.id === ag.botId);
      const sb = bs(ag.botId);
      if (target === undefined) agentOut = refuse(ag.botId, sb, cand, "BOT_NOT_ACTIVE", "this bot has no active, verified mandate (archived, not confirmed, or its stored mandate was refused)");
      else if ((target.rules as ActiveRules).rules.mode !== "agent") agentOut = refuse(ag.botId, sb, cand, "NOT_AGENT_BOT", "this bot's signed rule set is not an AI-agent mandate");
      else if (sb.halt !== null) agentOut = refuse(ag.botId, sb, cand, "BOT_HALTED", `this bot is stopped (${sb.halt.reason}); the owner must sign its limits again`);
      else if (sb.stoppedDayIndex === day.dayIndex) agentOut = refuse(ag.botId, sb, cand, "DAILY_LOSS_STOP", "this bot hit its daily loss stop; it trades again after 00:00 UTC");
      else {
        const r = await attempt(botCtx(target), cand);
        if (!("placed" in r)) return r;
        agentOut = r;
      }
      return finish("running");
    }

    for (const bot of live) {
      if (placed >= MAX_ORDERS_PER_TICK) break;
      const ctx = botCtx(bot);
      const { active1, rules, s, prefix } = ctx;
      // position_pnl: cost basis per rule set from the incremental sums (no history re-read). It is exact only for rule sets
      // confirmed at or after the cursor's `completeFromMs`; for an older one (history gap) those rules are skipped, never guessed.
      const basisPartial = trk.completeFromMs > active1.confirmedAtMs;
      if (basisPartial && rules.rules.some((r) => r.when.type === "position_pnl")) {
        warnings.push(`bot ${bot.id}: position_pnl cost basis is partial (fill history gap); those rules are skipped until a new rule set is confirmed`);
      }

      for (const rule of rules.rules) {
        if (placed >= MAX_ORDERS_PER_TICK) break;
        const info = pairMap.get(rule.pair);
        const midStr = midsRead.mids[rule.pair];
        if (info === undefined || midStr === undefined) {
          skip(s, log, bot.id, rule.id, "NO_MARKET", `no spot pair or mid for ${rule.pair}`);
          continue;
        }
        // Live 24 h volume (the offline check at load time cannot know it): a thin pair is never traded.
        if (fx(info.volume24hUsdc) < fx(cfg.hard.minPairVolumeUsdc)) {
          skip(s, log, bot.id, rule.id, "PAIR_LOW_VOLUME", `${rule.pair} 24h volume ${info.volume24hUsdc} is below the minimum ${cfg.hard.minPairVolumeUsdc}`);
          continue;
        }
        const mid = fx(midStr);
        const cdName = effectiveCooldown(rule);
        const cdMs = cdName === undefined ? undefined : DURATION_MS[cdName];
        if (cooldownActive(now, s.firedAt[rule.id], cdMs)) continue;

        if (rule.when.type === "position_pnl" && basisPartial) {
          skip(s, log, bot.id, rule.id, "COST_BASIS_PARTIAL", "fill history before the gap is unknown, so the cost basis of this rule set is unreliable");
          continue;
        }
        let fired: boolean;
        try {
          const cost = basisOf(s.agg, prefix, rule.pair);
          fired = (await evalTrigger(rule.when, { nowMs: now, pair: rule.pair, mid, lastFiredAtMs: s.firedAt[rule.id], cost, getCandles: (p, i, st0, e) => hl.getCandles(p, i, st0, e) })).fired;
        } catch (e) {
          skip(s, log, bot.id, rule.id, "TRIGGER_ERROR", `trigger failed: ${errMsg(e)}`);
          continue;
        }
        if (!fired) {
          clearSkip(s, rule.id);
          continue;
        }

        const r = await attempt(ctx, { ruleId: rule.id, pair: rule.pair, action: rule.action, cooldownMs: cdMs, source: "rules", note: null });
        if (!("placed" in r)) return r; // STATE_WRITE_FAILED
        if (!r.placed && r.killed === true) break;
      }
    }
    // Account state: running while at least one bot can still trade (always true here: a tick with no live bot returned above).
    return finish("running");
  } catch (e) {
    warnings.push("internal error");
    return finish("error", "INTERNAL_ERROR", errMsg(e));
  }
}

function clearSkip(s: BotEngineState, ruleId: string): void {
  s.lastSkip = Object.fromEntries(Object.entries(s.lastSkip).filter(([k]) => k !== ruleId));
}

function skip(s: BotEngineState, log: (k: LogEntry["kind"], d: string, x?: Partial<LogEntry>) => void, botId: string, ruleId: string, code: string, reason: string): void {
  if (s.lastSkip[ruleId] === code) return;
  s.lastSkip[ruleId] = code;
  log("skip", `${code}: ${reason}`, { rule_id: ruleId, bot_id: botId });
}

async function safeSchedule(hl: HlPort, atMs: number, st: EngineState, warnings: string[], err: { msg: string | null }): Promise<boolean> {
  try {
    await hl.scheduleCancel(atMs);
    st.account.deadManAtMs = atMs;
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
