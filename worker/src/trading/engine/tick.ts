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
  HlOpenOrder,
  HlOrderResult,
  HlPort,
  HlSpotPair,
  HardLimits,
  RuleSetV1,
  TradingState,
  TradingStatus,
} from "../types.js";
import { type DaySnapshot, type Equity, computeEquity, costBasis, pnlSummary, rollDay, utcDayIndex } from "./pnl.js";
import {
  type EffectiveLimits,
  type Fx,
  checkOrder,
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
  lastTickMs: number | null;
  /** Bounded in-memory log (MAX_RECENT), newest last. */
  recent: LogEntry[];
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
    lastTickMs: null,
    recent: [],
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
  const schedule = async (atMs: number): Promise<boolean> => (stopped() ? false : safeSchedule(hl, atMs, st, warnings));

  const finish = (tradingState: TradingState, reason: string | null = null, detail: string | null = null): TickResult => {
    st.lastTickMs = now;
    if (tradingState !== "running") log("state", `${tradingState}${reason ? `: ${reason}` : ""}${detail ? ` (${detail})` : ""}`);
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
      dead_man: { cancel_at_ms: st.deadManAtMs },
      perp_check: { ok: perpOk, at_ms: now },
      last_tick_ms: now,
      next_tick_ms: now + tickMs,
      warnings,
    };
    return { state: st, tradingState, status, entries };
  };

  try {
    // 0. A different rule set starts with a clean per-rule slate (cooldowns, skip dedupe).
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
    try {
      [spotPairs, mids, openOrders, balances, perp, agents] = await Promise.all([
        hl.getSpotPairs(),
        hl.getMids(),
        hl.getOpenOrders(cfg.account),
        hl.getSpotBalances(cfg.account),
        hl.getPerpState(cfg.account),
        hl.getApprovedAgents(cfg.account),
      ]);
      ledger = await hl.getLedger(cfg.account, Math.min(cfg.fundedSinceMs, st.day?.snapshotAtMs ?? now, now));
    } catch (e) {
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
    equity = computeEquity(balances, mids.mids);
    if (equity.unpriced.length > 0) warnings.push(`no mid for held ${equity.unpriced.join(", ")} (valued at 0)`);
    if (!fresh) warnings.push("market data older than 2 ticks");

    // Day rollover (needs fresh mids for a trustworthy equity snapshot).
    if (fresh) {
      const r = rollDay(st.day, now, equity.equity);
      st.day = r.day;
      if (r.rolled) {
        st.ordersToday = 0;
        log("state", `new UTC day ${r.day.dayIndex}, start equity ${r.day.startEquity}`);
      }
    }
    if (st.day !== null) pnl = pnlSummary(st.day, equity.equity, ledger, cfg.fundedSinceMs);

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

    // 2. Perp alarm. Any perp position, open perp order, or perp account value above 1 USDC halts the engine for good.
    const perpBad = perp.positions.length > 0 || perp.openPerpOrders > 0 || fx(perp.accountValueUsdc) > fx(PERP_VALUE_ALARM);
    perpOk = !perpBad;
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
    if (st.day === null || pnl === null) return finish("error", "NO_DAY_SNAPSHOT");

    // The daily loss stop holds for the rest of the UTC day, also across a rule change (only 00:00 UTC clears it).
    if (st.stoppedDayIndex === st.day.dayIndex) {
      await cancelAllSpot("stopped_today");
      return finish("stopped_today", "DAILY_LOSS_STOP", `loss today ${dec(pnl.lossToday)} USDC`);
    }
    if (st.stoppedDayIndex !== null && st.stoppedDayIndex !== st.day.dayIndex) st.stoppedDayIndex = null;

    // 4. Dead-man switch BEFORE any order. If it cannot be set, no order is placed.
    if (stopped()) return finish("halted", "KILLED", "kill switch pulled while the tick was running");
    if (!(await schedule(now + cfg.deadmanSec * 1000))) {
      if (stopped()) return finish("halted", "KILLED", "kill switch pulled while the tick was running");
      return finish("error", "SCHEDULE_CANCEL_FAILED", "refusing to trade without the dead-man switch");
    }

    // 5. Loss stop.
    if (pnl.lossToday >= eff.dailyLossStop) {
      st.stoppedDayIndex = st.day.dayIndex;
      await cancelAllSpot("daily loss stop");
      return finish("stopped_today", "DAILY_LOSS_STOP", `loss today ${dec(pnl.lossToday)} USDC >= stop ${dec(eff.dailyLossStop)} USDC`);
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
    const needFills = rules.rules.some((r) => r.when.type === "position_pnl");
    let fills: Awaited<ReturnType<HlPort["getUserFills"]>> = [];
    if (needFills) {
      try {
        fills = await hl.getUserFills(cfg.account, active.confirmedAtMs);
      } catch (e) {
        warnings.push("fills unavailable");
        log("skip", `fills unavailable: ${errMsg(e)}`);
      }
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

      let fired: boolean;
      try {
        const cost = costBasis(fills, rule.pair, prefix);
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
        { pair: rule.pair, assetId: info.assetId, side: rule.action.side, price: sized.price, size: sized.size },
        {
          nowMs: now,
          tickMs,
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
        skip(st, log, rule.id, verdict.code, verdict.reason);
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

async function safeSchedule(hl: HlPort, atMs: number, st: EngineState, warnings: string[]): Promise<boolean> {
  try {
    await hl.scheduleCancel(atMs);
    st.deadManAtMs = atMs;
    return true;
  } catch {
    warnings.push("scheduleCancel failed");
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { utcDayIndex };
