/**
 * Equity, day snapshot, loss stop and P&L (ADR-0005 section 7 step 5 and TradingStatus.pnl). Pure.
 *
 * ACCOUNTING (changed 2026-11-03, see ADR-0005 "Accounting change 2026-11-03"). All USDC, bigint fixed point.
 *
 * The daily loss stop and pnl.total measure TRADING P&L ONLY, built from the bot's own fills, not from equity:
 *  - bot fills = fills whose cloid starts with the prefix of any rule set the bot ever activated (`EngineState.botPrefixes`)
 *    OR whose oid is one the bot got back when it placed an order (`EngineState.botOids`). Fills of manual orders are
 *    ignored by the loss stop (counted in `foreignFills`, which the engine warns about).
 *  - the fills are NOT re-read each tick: engine/fills.ts keeps a persisted per-pair running sum and a cursor
 *    (HL caps responses at 2000 fills and keeps 10000, see hl/pagination.ts). `AggMap`s come from there.
 *  - per pair: pnl = cash + mark-to-market - fees, where
 *      cash = sum(sell price*size) - sum(buy price*size) over bot fills in the window,
 *      mark-to-market = start_mark + (bought - sold)*mid_now,
 *      start_mark (the STOP) = min(0, eff_start*(mid_now - start_mid)): only NEGATIVE marks of what was held at the snapshot,
 *        so a pump of a held coin cannot offset bot losses; eff_start = min(start_size, held_now - bought + sold), i.e. the
 *        start holding that is still there or was sold by the bot (a hand-sold or withdrawn start holding causes no loss).
 *        The DISPLAY value (`pnlDisplay`) keeps the full signed mark with the full start size.
 *      fees = sum of the bot fills' fees (already converted to USDC by the adapter).
 *    start_size/start_mid come from the day snapshot (`startPositions`: EVERY allowed-pair coin the account holds at the
 *    snapshot, including coins the owner holds by hand, not only what the bot bought); for pnl.total the start size is 0.
 *    A pair that has activity but no current mid is valued at 0 for the STOP (`pnl`, errs toward stopping); the last known
 *    price is used only for display (`pnlDisplay`). The engine also refuses to trade while such a pair exists
 *    (NO_MID_FOR_POSITION).
 *  - today's window = bot fills at or after `snapshotAtMs` (the tick start: before that tick's equity read and orders; earlier fills are inside the start positions);
 *    total window = bot fills with timeMs >= TRADING_START_MS.
 *  - loss_today = -(trading pnl today). Positive = loss, unrealized included.
 *
 * EQUITY BACKSTOP (`equityDrop`): trading P&L does not see a leaked API key wash-trading with a foreign cloid. So the
 * engine also stops when startBackstop + inflows today - outflows today - backstop equity now >= the daily loss stop (reason
 * EQUITY_DROP). Fees and price moves of the coins held by hand count here too: it errs toward stopping.
 *  - BACKSTOP EQUITY = USDC + allowed-pair coins ONLY (`backstopEquity`), the same definition at the snapshot and now.
 *    The all-coin `equity` is display only: a leaked key could buy a junk coin at an inflated price (or receive dust of a
 *    pumped token) and an all-coin equity would not drop. Coins outside the allowed pairs are worth 0 to the backstop.
 *  - Gains on coins held AT THE SNAPSHOT are not counted (the value of a start holding is clipped at its start mid, only for
 *    min(startSize, size now)), so a pump of a held coin cannot hide a loss elsewhere. Losses on it do count.
 *  - Flows: deposits / transfers in / perp->spot class transfers add to the expected equity, withdrawals / transfers out /
 *    spot->perp class transfers subtract from it. Inflows count from the tick start (`snapshotAtMs`), outflows from just after
 *    the balance read (`balanceAtMs`): an entry that landed between the two is possibly already inside the snapshot, and the
 *    error must lean toward stopping (a double-counted inflow raises the drop; a double-counted outflow would hide it).
 *  - One allowance: HL charges a one-time 1 USDC activation fee on a fresh account. It is excused (ACTIVATION_FEE_USDC, once,
 *    so a leaked key gains at most 1 USDC of hidden loss, once per account) only on the UTC day of the FIRST ledger entry
 *    since TRADING_START_MS, and only if that entry is a deposit / transfer in.
 *
 * What is deliberately NOT trading P&L (it moves equity, never the loss stop):
 *  - the HL account activation fee (1 USDC on a fresh account) and any other fee/adjustment not tied to a bot fill;
 *    it shows up as `untrackedDelta` = equity - netFlow - trading pnl.total (the equity backstop excuses the activation fee once);
 *  - deposits / transfers in: split into `fundedByVault` (inflows matched to a confirmed vault top-up, see `matchVaultInflows`)
 *    and `externalInflow` (everything else, e.g. the faucet);
 *  - withdrawals / transfers out: `externalOutflow`. ADR T10 wanted a manual withdrawal to be visible. It no longer counts
 *    as a trading loss (it is not one), but it is never silent: the field is exposed and the engine adds a warning while
 *    an outflow exists since the day snapshot. The equity backstop does not count it either (an outflow lowers the equity it expects; an API wallet cannot
 *    withdraw anyway, only the master key can). The conservative "outflow = loss" rule of 2026-11-02 is dropped on purpose,
 *    because it could not tell a withdrawal from an activation fee or a faucet deposit that arrived late.
 *  - equity = USDC total + sum(base total * mid) over every non-USDC spot balance with a mid (unpriced coins count 0).
 *    It is display only (see BACKSTOP EQUITY above for what the stop uses). It is still reported, and `netFunded` = sum(deposits+transfers in) - sum(withdrawals+transfers out) since
 *    TRADING_START_MS is kept for the dashboard.
 *
 * Fail-safe notes: a bot position that loses value is caught by the mark-to-market term; a loss that is not a fill or a
 * position mark (e.g. someone else sells the bot's coins manually) is, by definition, not seen by the loss stop; it
 * appears as `untrackedDelta`.
 */
import type { Dec, HlFill, HlLedgerEntry, HlSpotBalance } from "../types.js";
import { type AggMap, type PairAggFx, aggFx, isBotFill } from "./fills.js";
import { type Fx, SCALE, fx, fxMax, fxMin, fxMul, fxStr } from "./risk.js";

export const DAY_MS = 86_400_000;

/** UTC day number since the epoch. */
export const utcDayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

export interface PositionValue {
  pair: string;
  base: string;
  size: Fx;
  mid: Fx;
  value: Fx;
  /** total - hold */
  free: Fx;
}

export interface Equity {
  usdcTotal: Fx;
  usdcFree: Fx;
  /** USDC + every priced spot coin. Display only: NOT what the equity backstop uses (`backstopEquity`). */
  equity: Fx;
  positions: PositionValue[];
  /** Coins held without a usable mid (valued at 0). */
  unpriced: string[];
}

export function computeEquity(balances: readonly HlSpotBalance[], mids: Readonly<Record<string, Dec | undefined>>): Equity {
  let usdcTotal = 0n;
  let usdcHold = 0n;
  let equity = 0n;
  const positions: PositionValue[] = [];
  const unpriced: string[] = [];
  for (const b of balances) {
    const total = fx(b.total);
    const hold = fx(b.hold);
    if (b.coin === "USDC") {
      usdcTotal += total;
      usdcHold += hold;
      equity += total;
      continue;
    }
    if (total <= 0n) continue;
    const pair = `${b.coin}/USDC`;
    const midStr = mids[pair];
    const mid = midStr === undefined ? 0n : fx(midStr);
    if (mid <= 0n) {
      unpriced.push(b.coin);
      continue;
    }
    const value = fxMul(total, mid);
    equity += value;
    positions.push({ pair, base: b.coin, size: total, mid, value, free: fxMax(0n, total - hold) });
  }
  return { usdcTotal, usdcFree: fxMax(0n, usdcTotal - usdcHold), equity, positions, unpriced };
}

/**
 * Equity as the backstop sees it: USDC + allowed-pair coins only, and gains on coins held at the snapshot are clipped at the
 * start mid (for min(startSize, size now) of them). Same definition at the snapshot (no start positions yet) and now.
 */
export function backstopEquity(eq: Equity, allowed: ReadonlySet<string>, startPositions: Readonly<Record<string, { size: Dec; mid: Dec }>> = {}): Fx {
  let sum = eq.usdcTotal;
  for (const p of eq.positions) {
    if (!allowed.has(p.pair)) continue;
    let value = p.value;
    const start = startPositions[p.pair];
    if (start) {
      const startMid = fx(start.mid);
      const gain = fxMul(fxMin(fx(start.size), p.size), p.mid - startMid);
      if (gain > 0n) value -= gain;
    }
    sum += value;
  }
  return sum;
}

/** Signed net EXTERNAL flow of ledger entries accepted by `inWindow` (perp<->spot class transfers are internal: skipped). */
export function netFlow(entries: readonly HlLedgerEntry[], inWindow: (timeMs: number) => boolean, countOutflow = true): Fx {
  let sum = 0n;
  for (const e of entries) {
    if (!inWindow(e.timeMs)) continue;
    if (e.kind === "class_in" || e.kind === "class_out") continue;
    const v = fx(e.usdc);
    if (e.kind === "deposit" || e.kind === "transfer_in") sum += v;
    else if (countOutflow) sum -= v;
  }
  return sum;
}

/** Start-of-day snapshot persisted in the engine state. */
export interface DaySnapshot {
  dayIndex: number;
  /** Dec string. */
  startEquity: Dec;
  /** Tick start of the snapshot: fills and inflows count from here. */
  snapshotAtMs: number;
  /** `backstopEquity` at the snapshot (USDC + allowed-pair coins). ABSENT = older snapshot: `startEquity` is used (conservative). */
  startBackstop?: Dec;
  /** Time just after the balance read of the snapshot tick: outflows count from here (see the header). ABSENT = `snapshotAtMs`. */
  balanceAtMs?: number;
  /**
   * Allowed-pair coins held at the snapshot (incl. manual holdings), for mark-to-market. Always written since 2026-11-03
   * ({} = none); ABSENT = a snapshot from before that date, which cannot be trusted while such coins are held.
   */
  startPositions?: Record<string, { size: Dec; mid: Dec }>;
}

/** Take a new snapshot when the UTC day changed (or none exists). Pure: returns the snapshot to use. */
export function rollDay(
  prev: DaySnapshot | null,
  nowMs: number,
  equity: Fx,
  positions: readonly PositionValue[] = [],
  extra: { backstop?: Fx; balanceAtMs?: number } = {},
): { day: DaySnapshot; rolled: boolean } {
  const idx = utcDayIndex(nowMs);
  if (prev !== null && prev.dayIndex === idx) return { day: prev, rolled: false };
  const startPositions = Object.fromEntries(positions.map((p) => [p.pair, { size: fxStr(p.size, 12), mid: fxStr(p.mid, 12) }]));
  const day: DaySnapshot = { dayIndex: idx, startEquity: fxStr(equity, 12), snapshotAtMs: nowMs, startPositions };
  if (extra.backstop !== undefined) day.startBackstop = fxStr(extra.backstop, 12);
  if (extra.balanceAtMs !== undefined) day.balanceAtMs = extra.balanceAtMs;
  return { day, rolled: true };
}

/** Fills placed by the bot: cloid prefix of a rule set it activated, or an oid it placed. */
export function botFills(fills: readonly HlFill[], prefixes: readonly string[], oids: ReadonlySet<number> = new Set()): HlFill[] {
  return fills.filter((f) => isBotFill(f, prefixes, oids));
}

export interface TradingPnl {
  /** cash + mark-to-market - fees with a pair that has no mid valued at 0 (the figure the stop uses). Positive = profit. */
  pnl: Fx;
  /** Same, but an unpriced pair is valued at the start mid / last fill price. Display only. */
  pnlDisplay: Fx;
  fees: Fx;
  /** Pairs with activity but without a current mid. */
  unpriced: string[];
}

/**
 * Trading P&L of the aggregated bot fills of a window (see the header comment). `held` = size of every coin held now (by pair);
 * when given, the start holding that can still lose value is capped by it (see "start_mark"). Absent = no cap (tests, totals).
 */
export function tradingPnl(
  agg: Readonly<Record<string, PairAggFx>>,
  startPositions: Readonly<Record<string, { size: Dec; mid: Dec }>>,
  mids: Readonly<Record<string, Dec | undefined>>,
  held?: Readonly<Record<string, Fx>>,
): TradingPnl {
  const pairs = new Set<string>([...Object.keys(startPositions), ...Object.keys(agg)]);
  let pnl = 0n;
  let display = 0n;
  let fees = 0n;
  const unpriced: string[] = [];
  for (const pair of pairs) {
    const start = startPositions[pair];
    const startSize = start ? fx(start.size) : 0n;
    const startMid = start ? fx(start.mid) : 0n;
    const a = agg[pair];
    const cash = a?.cash ?? 0n;
    const dq = a?.dq ?? 0n;
    fees += a?.fees ?? 0n;
    // The start holding that is still here (held_now - bought + sold) or that the bot sold; never more than was held.
    const startEff = held === undefined ? startSize : fxMax(0n, fxMin(startSize, (held[pair] ?? 0n) - dq));
    const dqValue = (mid: Fx): Fx => (dq >= 0n ? fxMul(dq, mid) : -fxMul(-dq, mid));
    const stopValue = (mid: Fx): Fx => {
      const mark = startEff > 0n ? fxMul(startEff, mid - startMid) : 0n;
      return cash + (mark < 0n ? mark : 0n) + dqValue(mid);
    };
    const displayValue = (mid: Fx): Fx => cash + (startSize > 0n ? fxMul(startSize, mid - startMid) : 0n) + dqValue(mid);
    const midStr = mids[pair];
    const mid = midStr === undefined ? 0n : fx(midStr);
    if (mid > 0n) {
      pnl += stopValue(mid);
      display += displayValue(mid);
    } else {
      if (startSize !== 0n || dq !== 0n) unpriced.push(pair);
      pnl += stopValue(0n);
      display += displayValue(startMid > 0n ? startMid : (a?.lastPx ?? 0n));
    }
  }
  return { pnl: pnl - fees, pnlDisplay: display - fees, fees, unpriced };
}

/** A top-up the vault confirmed (recorded by the funder). */
export interface VaultTopup {
  atMs: number;
  amountUsdc: Dec;
}

/** Ledger and top-up clocks differ (settlement takes minutes): an inflow may follow its request by up to this long. */
export const TOPUP_MATCH_WINDOW_MS = 6 * 3_600_000;
const TOPUP_CLOCK_SLACK_MS = 120_000;
/** 1Click fees and slippage: a landed amount may differ from the requested one by this share (bps). */
const TOPUP_AMOUNT_TOLERANCE_BPS = 500n;

/**
 * Sum of the ledger inflows that can be attributed to a confirmed vault top-up: each top-up claims at most one inflow, the
 * closest in amount among those that landed within [atMs - slack, atMs + window] and are within 5% of the requested amount.
 */
export function matchVaultInflows(entries: readonly HlLedgerEntry[], topups: readonly VaultTopup[]): Fx {
  const inflows = entries.filter((e) => e.kind === "deposit" || e.kind === "transfer_in").map((e) => ({ t: e.timeMs, v: fx(e.usdc), used: false }));
  let sum = 0n;
  for (const tp of [...topups].sort((a, b) => a.atMs - b.atMs)) {
    const want = fx(tp.amountUsdc);
    const tol = (want * TOPUP_AMOUNT_TOLERANCE_BPS) / 10_000n;
    let best: (typeof inflows)[number] | undefined;
    let bestDiff = 0n;
    for (const i of inflows) {
      if (i.used || i.t < tp.atMs - TOPUP_CLOCK_SLACK_MS || i.t > tp.atMs + TOPUP_MATCH_WINDOW_MS) continue;
      const diff = i.v > want ? i.v - want : want - i.v;
      if (diff > tol) continue;
      if (best === undefined || diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    }
    if (best) {
      best.used = true;
      sum += best.v;
    }
  }
  return sum;
}

export interface PnlSummary {
  /** Trading P&L today (positive = profit), display valuation. */
  today: Fx;
  /** Trading P&L since TRADING_START_MS, display valuation. */
  total: Fx;
  /** Net external flow (deposits - withdrawals) since TRADING_START_MS; may be negative. */
  netFunded: Fx;
  dayStartEquity: Fx;
  /** -(stop valuation of today's P&L). Positive = loss; what the daily loss stop compares. */
  lossToday: Fx;
  /** startBackstop + inflows today - outflows today - backstop equity now, less the one-time activation fee allowance. Backstop. */
  equityDrop: Fx;
  fundedByVault: Fx;
  externalInflow: Fx;
  /** Since TRADING_START_MS. */
  externalOutflow: Fx;
  /** Outflows at or after the day snapshot. */
  outflowToday: Fx;
  /** Bot trading fees since TRADING_START_MS (already inside `total`). */
  fees: Fx;
  /** equity - netFunded - total: activation fee and anything else that is neither a flow nor a bot fill. */
  untrackedDelta: Fx;
  unpriced: string[];
}

export interface PnlInput {
  day: DaySnapshot;
  /** All-coin equity, display only (untrackedDelta). */
  equityNow: Fx;
  /** `backstopEquity` now; defaults to `equityNow` (tests). */
  equityBackstopNow?: Fx;
  /** Size of every coin held now by pair (balances); caps the start holding in the stop. Absent = no cap. */
  held?: Readonly<Record<string, Fx>>;
  ledger: readonly HlLedgerEntry[];
  fundedSinceMs: number;
  /** Aggregated bot fills since the day snapshot / since TRADING_START_MS (engine/fills.ts). */
  todayAgg: AggMap;
  totalAgg: AggMap;
  mids: Readonly<Record<string, Dec | undefined>>;
  topups?: readonly VaultTopup[];
}

/** HL charges this once when it activates a fresh account. */
export const ACTIVATION_FEE_USDC: Fx = 1n * SCALE;

/**
 * Equity backstop (see header). `ledger` must reach back to TRADING_START_MS. The activation fee is excused only when the
 * earliest ledger entry since `fundedSinceMs` is an inflow that falls inside today's window (the fee was charged with it).
 */
export function equityDrop(day: DaySnapshot, equityNow: Fx, ledger: readonly HlLedgerEntry[], fundedSinceMs: number): Fx {
  let inflow = 0n;
  let outflow = 0n;
  const outflowFrom = day.balanceAtMs ?? day.snapshotAtMs;
  for (const e of ledger) {
    const v = fx(e.usdc);
    if (e.kind === "deposit" || e.kind === "transfer_in" || e.kind === "class_in") {
      if (e.timeMs >= day.snapshotAtMs) inflow += v;
    } else if (e.timeMs >= outflowFrom) outflow += v;
  }
  const first = ledger.filter((e) => e.timeMs >= fundedSinceMs).reduce<HlLedgerEntry | undefined>((m, e) => (m === undefined || e.timeMs < m.timeMs ? e : m), undefined);
  const allowance =
    first !== undefined && (first.kind === "deposit" || first.kind === "transfer_in") && first.timeMs >= day.snapshotAtMs ? ACTIVATION_FEE_USDC : 0n;
  return fx(day.startBackstop ?? day.startEquity) + inflow - outflow - equityNow - allowance;
}

export function pnlSummary(i: PnlInput): PnlSummary {
  const today = tradingPnl(aggFx(i.todayAgg), i.day.startPositions ?? {}, i.mids, i.held);
  const total = tradingPnl(aggFx(i.totalAgg), {}, i.mids);
  const inWindow = i.ledger.filter((e) => e.timeMs >= i.fundedSinceMs);
  const netFunded = netFlow(inWindow, () => true);
  const inflow = netFlow(inWindow, () => true, false);
  const externalOutflow = inflow - netFunded;
  const fundedByVault = matchVaultInflows(inWindow, i.topups ?? []);
  const outflowToday = netFlow(inWindow, (t) => t >= i.day.snapshotAtMs, true) - netFlow(inWindow, (t) => t >= i.day.snapshotAtMs, false);
  return {
    today: today.pnlDisplay,
    total: total.pnlDisplay,
    netFunded,
    dayStartEquity: fx(i.day.startEquity),
    lossToday: -today.pnl,
    equityDrop: equityDrop(i.day, i.equityBackstopNow ?? i.equityNow, i.ledger, i.fundedSinceMs),
    fundedByVault,
    externalInflow: inflow - fundedByVault,
    externalOutflow,
    outflowToday: -outflowToday,
    fees: total.fees,
    untrackedDelta: i.equityNow - netFunded - total.pnlDisplay,
    unpriced: [...new Set([...today.unpriced, ...total.unpriced])],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Position and average cost of fills under one rule set (for the position_pnl trigger)
// ---------------------------------------------------------------------------------------------------------------------

export interface CostBasis {
  /** Base size still held from fills of this rule set. */
  size: Fx;
  /** Weighted average cost per base in USDC; 0 when flat. */
  avgCost: Fx;
}

/**
 * Weighted-average cost of the fills whose cloid starts with `cloidPrefix` (the rule set's hash) on `pair`. A buy raises
 * size and cost; a sell removes size at the current average cost (average cost is unchanged by sells). Fees are ignored.
 * Flat (size 0) means position_pnl is false.
 */
export function costBasis(fills: readonly HlFill[], pair: string, cloidPrefix: string): CostBasis {
  let size = 0n;
  let cost = 0n;
  const mine = fills
    .filter((f) => f.pair === pair && f.cloid !== null && f.cloid.toLowerCase().startsWith(cloidPrefix))
    .sort((a, b) => a.timeMs - b.timeMs);
  for (const f of mine) {
    const sz = fx(f.size);
    if (f.side === "buy") {
      size += sz;
      cost += fxMul(sz, fx(f.price));
    } else if (size > 0n) {
      const sold = sz > size ? size : sz;
      cost -= (cost * sold) / size;
      size -= sold;
    }
  }
  return size > 0n ? { size, avgCost: (cost * SCALE) / size } : { size: 0n, avgCost: 0n };
}
