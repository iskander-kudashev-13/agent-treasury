/**
 * Pure risk guard and order sizing for the trading engine (ADR-0005 section 6 and 7).
 *
 * Rules of this file:
 *  - No I/O, no clock. Time and every market number come in through arguments.
 *  - A candidate order is either accepted as is or REJECTED with a code and a reason. It is never resized, clamped or
 *    "fixed". (Sizing happens once, in `sizeOrder`, before the guard sees the order.)
 *  - All arithmetic is bigint fixed point with SCALE = 1e12 (`Fx`), so there is no float rounding in money math.
 */
import { formatPrice } from "../hl/format.js";
import type { Action, HardLimits, RuleLimits, RuleSetV1 } from "../types.js";

// ---------------------------------------------------------------------------------------------------------------------
// Fixed point helpers (shared by triggers.ts, pnl.ts and tick.ts)
// ---------------------------------------------------------------------------------------------------------------------

export type Fx = bigint;
export const SCALE = 10n ** 12n;
const DEC_DIGITS = 12;

/** Parse a plain decimal string ("12", "0.034", "-1.5"). Digits beyond 12 decimals are truncated. Throws on garbage. */
export function fx(s: string): Fx {
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal: ${JSON.stringify(s)}`);
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(int) * SCALE + BigInt(frac.slice(0, DEC_DIGITS).padEnd(DEC_DIGITS, "0"));
  return neg ? -v : v;
}

/** Format, truncating toward zero to `maxDecimals` and trimming trailing zeros. */
export function fxStr(v: Fx, maxDecimals = 6): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % SCALE).toString().padStart(DEC_DIGITS, "0").slice(0, maxDecimals).replace(/0+$/, "");
  const s = `${a / SCALE}${frac === "" ? "" : `.${frac}`}`;
  return neg && s !== "0" ? `-${s}` : s;
}

export const fxMul = (a: Fx, b: Fx): Fx => (a * b) / SCALE;
export const fxMin = (a: Fx, b: Fx): Fx => (a < b ? a : b);
export const fxMax = (a: Fx, b: Fx): Fx => (a > b ? a : b);
/** HL minimum order value: 10 USDC. */
export const MIN_NOTIONAL: Fx = 10n * SCALE;

/** Floor a base size to `szDecimals`. */
export function roundSizeDown(size: Fx, szDecimals: number): Fx {
  const step = SCALE / 10n ** BigInt(Math.min(Math.max(szDecimals, 0), DEC_DIGITS));
  return (size / step) * step;
}

/**
 * Round a spot price to what HL accepts: at most 5 significant figures and at most `8 - szDecimals` decimals (integers
 * are always allowed). `dir` is the SAFE side: "down" for a buy (never pay more than computed), "up" for a sell (never
 * receive less). Trailing zeros are free, so a carry (9.99996 -> 10) is always representable.
 */
export function roundPrice(price: Fx, szDecimals: number, dir: "down" | "up"): Fx {
  if (price <= 0n) return 0n;
  // One implementation of HL's tick rules: hl/format.ts (also asserted again before signing in NktkasHl).
  try {
    return fx(formatPrice(fxStr(price, DEC_DIGITS), szDecimals, dir));
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Effective limits
// ---------------------------------------------------------------------------------------------------------------------

export interface EffectiveLimits {
  maxPosition: Fx;
  maxOrder: Fx;
  dailyLossStop: Fx;
  maxOrdersPerDay: number;
}

/**
 * A DSL limit may be tighter than a hard limit, never looser. Validation already rejects looser rule sets; the engine
 * still takes the minimum, so a rule set that slipped through (old file, hard limits lowered later) cannot widen them.
 */
export function effectiveLimits(rules: RuleSetV1 | null, hard: HardLimits): EffectiveLimits {
  const h: EffectiveLimits = {
    maxPosition: fx(hard.maxPositionUsdc),
    maxOrder: fx(hard.maxOrderUsdc),
    dailyLossStop: fx(hard.dailyLossUsdc),
    maxOrdersPerDay: hard.maxOrdersPerDay,
  };
  if (rules === null) return h;
  const l: RuleLimits = rules.limits;
  return {
    maxPosition: fxMin(h.maxPosition, fx(l.max_position_usdc)),
    maxOrder: fxMin(h.maxOrder, fx(l.max_order_usdc)),
    dailyLossStop: fxMin(h.dailyLossStop, fx(l.daily_loss_stop_usdc)),
    maxOrdersPerDay: Math.min(h.maxOrdersPerDay, l.max_orders_per_day),
  };
}

export function effectiveLimitsStatus(e: EffectiveLimits, bps: number): RuleLimits & { price_band_bps: number } {
  return {
    max_position_usdc: fxStr(e.maxPosition),
    max_order_usdc: fxStr(e.maxOrder),
    daily_loss_stop_usdc: fxStr(e.dailyLossStop),
    max_orders_per_day: e.maxOrdersPerDay,
    price_band_bps: bps,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// cloid
// ---------------------------------------------------------------------------------------------------------------------

/** `0x` + first 8 bytes (16 hex) of the rules hash. */
export function cloidPrefix(rulesHash: string): string {
  return `0x${rulesHash.slice(0, 16).toLowerCase()}`;
}

/** `0x || rules_hash[0..8 bytes] || counter_be64` = 16 bytes = 32 hex. */
export function makeCloid(rulesHash: string, counter: number): string {
  return `${cloidPrefix(rulesHash)}${BigInt(counter).toString(16).padStart(16, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------------------------------------------------

/** True while the rule must not fire again. `lastFiredAtMs` is set on every placement attempt, successful or not. */
export function cooldownActive(nowMs: number, lastFiredAtMs: number | undefined, cooldownMs: number | undefined): boolean {
  if (cooldownMs === undefined || lastFiredAtMs === undefined) return false;
  return nowMs - lastFiredAtMs < cooldownMs;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------------------------------------------------

export interface SizeInput {
  action: Action;
  mid: Fx;
  priceBandBps: number;
  szDecimals: number;
  /** Free (total - hold) base balance, for `position_pct`. */
  freeBase: Fx;
}

export type SizedOrder =
  | { ok: true; price: Fx; size: Fx; tif: "Ioc" | "Gtc"; ttl: string | null }
  | { ok: false; code: "NO_PRICE" | "SIZE_ZERO"; reason: string };

/** Order price for a rule action at `mid` (band edge for ioc, offset for limit), rounded to the safe side; null when unusable. */
export function orderPrice(action: Action, mid: Fx, priceBandBps: number, szDecimals: number): Fx | null {
  if (mid <= 0n) return null;
  const buy = action.side === "buy";
  const bps = BigInt(priceBandBps);
  const o = action.order;
  let raw: Fx;
  if (o.type === "ioc") {
    raw = buy ? (mid * (10_000n + bps)) / 10_000n : (mid * (10_000n - bps)) / 10_000n;
  } else {
    // offset_pct has up to 6 decimals; 100% = 100 * 1e6 micro-percent.
    const off = fx(o.offset_pct) / 10n ** 6n; // fx scale 1e12 -> micro-percent scale 1e6
    raw = buy ? (mid * (100_000_000n - off)) / 100_000_000n : (mid * (100_000_000n + off)) / 100_000_000n;
  }
  const price = roundPrice(raw, szDecimals, buy ? "down" : "up");
  return price <= 0n ? null : price;
}

export interface MinOrderAdvice {
  /** Coins a `usdc` order buys/sells after rounding down to szDecimals. */
  coins: Fx;
  notional: Fx;
  belowMin: boolean;
  /** Smallest whole-USDC size that clears the minimum at this price (next lot, +2% margin). */
  suggestedUsdc: bigint;
}

/** What a `size.usdc` order amounts to at `price` after lot rounding, and the smallest size that would clear 10 USDC. */
export function minOrderAdvice(usdc: Fx, price: Fx, szDecimals: number): MinOrderAdvice {
  const coins = roundSizeDown((usdc * SCALE) / price, szDecimals);
  const notional = fxMul(price, coins);
  const lot = SCALE / 10n ** BigInt(Math.min(Math.max(szDecimals, 0), DEC_DIGITS));
  const lotValue = fxMul(price, lot);
  const lots = lotValue <= 0n ? 1n : (MIN_NOTIONAL + lotValue - 1n) / lotValue;
  const withMargin = (lots * lotValue * 102n) / 100n;
  const suggestedUsdc = (withMargin + SCALE - 1n) / SCALE;
  return { coins, notional, belowMin: notional < MIN_NOTIONAL, suggestedUsdc };
}

/** Human text for the advice, used by the validator warning and the engine skip detail. */
export function describeMinOrder(a: MinOrderAdvice, maxOrder: Fx): string {
  const over = a.suggestedUsdc * SCALE > maxOrder;
  return `${fxStr(a.coins, 8)} coins = ${fxStr(a.notional, 4)} USDC, below the 10 USDC minimum; use at least ${a.suggestedUsdc} USDC${over ? ` (this exceeds max order ${fxStr(maxOrder)}, so raise max_order_usdc too, within the hard limit)` : ""}`;
}

/**
 * Price and size of the order a rule asks for. Prices round to the safe side (buy down, sell up), sizes round DOWN to
 * szDecimals so the notional never exceeds what the rule says.
 *  - ioc: limit IOC at the band edge: buy at mid*(1+band), sell at mid*(1-band).
 *  - limit: GTC at mid*(1-offset) for a buy, mid*(1+offset) for a sell.
 *  - size.usdc: base = floor(usdc / order price). size.position_pct: floor(free base * pct / 100).
 * Consequence (by design, see the report): with `size.usdc` equal to the 10 USDC HL minimum the rounded-down notional
 * is almost always just under 10, and the guard rejects it. Use a size a little above 10.
 */
export function sizeOrder(i: SizeInput): SizedOrder {
  const o = i.action.order;
  const price = orderPrice(i.action, i.mid, i.priceBandBps, i.szDecimals);
  if (price === null) return { ok: false, code: "NO_PRICE", reason: i.mid <= 0n ? "mid price is not positive" : "order price rounds to zero" };
  const size =
    "usdc" in i.action.size
      ? roundSizeDown((fx(i.action.size.usdc) * SCALE) / price, i.szDecimals)
      : roundSizeDown((i.freeBase * fx(i.action.size.position_pct)) / (100n * SCALE), i.szDecimals);
  if (size <= 0n) return { ok: false, code: "SIZE_ZERO", reason: "size rounds down to zero at this price/szDecimals" };
  return { ok: true, price, size, tif: o.type === "ioc" ? "Ioc" : "Gtc", ttl: o.type === "limit" ? o.ttl : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------------------------------------------------

export const RISK_CODES = [
  "SPOT_ONLY",
  "PAIR_NOT_ALLOWED",
  "PAIR_NOT_IN_RULES",
  "COOLDOWN",
  "STALE_BOOK",
  "BOOK_EMPTY",
  "SPREAD_TOO_WIDE",
  "PRICE_BAND",
  "MIN_NOTIONAL",
  "MAX_ORDER",
  "MAX_ORDERS_PER_DAY",
  "POSITION_CAP",
  "INSUFFICIENT_USDC",
  "INSUFFICIENT_BASE",
  "BAD_ORDER",
  "LIMIT_NEEDS_DEADMAN",
] as const;
export type RiskCode = (typeof RISK_CODES)[number];

export interface OrderCandidate {
  pair: string;
  assetId: number;
  side: "buy" | "sell";
  price: Fx;
  size: Fx;
  /** Absent = Ioc. A Gtc order rests on the book and is only allowed while the dead-man switch works. */
  tif?: "Ioc" | "Gtc";
}

export interface RiskContext {
  /** False while HL refuses scheduleCancel (volume gate): resting orders could not be cancelled by the dead-man. Absent = true. */
  deadManAvailable?: boolean;
  nowMs: number;
  /** One tick in ms; market data older than 2 ticks is stale. */
  tickMs: number;
  allowedPairs: readonly string[];
  rulePairs: readonly string[];
  priceBandBps: number;
  limits: EffectiveLimits;
  /** Orders already attempted today, including earlier ones in this tick. */
  ordersToday: number;
  mid: Fx;
  book: { bid: Fx | null; ask: Fx | null; atMs: number };
  freeUsdc: Fx;
  freeBase: Fx;
  /** Held base of all allowed pairs valued at mid. */
  positionValue: Fx;
  /** Sum of price*size of ALL open buy orders (they can fill and become position). */
  openBuyValue: Fx;
  lastFiredAtMs: number | undefined;
  cooldownMs: number | undefined;
}

export type RiskResult = { ok: true; notional: Fx } | { ok: false; code: RiskCode; reason: string };

const no = (code: RiskCode, reason: string): RiskResult => ({ ok: false, code, reason });

/** The last line of defence. Order of checks is the order of the ADR; the first failure is reported. */
export function checkOrder(o: OrderCandidate, c: RiskContext): RiskResult {
  if (o.assetId < 10_000) return no("SPOT_ONLY", `asset id ${o.assetId} is below 10000 (perp); only spot is allowed`);
  if (!c.allowedPairs.includes(o.pair)) return no("PAIR_NOT_ALLOWED", `${o.pair} is not in TRADING_ALLOWED_PAIRS`);
  if (!c.rulePairs.includes(o.pair)) return no("PAIR_NOT_IN_RULES", `${o.pair} is not in the active rule set's pairs`);
  if (o.price <= 0n || o.size <= 0n || c.mid <= 0n) return no("BAD_ORDER", "price, size and mid must be positive");
  if (o.tif === "Gtc" && c.deadManAvailable === false)
    return no("LIMIT_NEEDS_DEADMAN", "a resting limit order needs the dead-man switch, which Hyperliquid refuses on this account (volume gate); only IOC orders are placed");
  if (cooldownActive(c.nowMs, c.lastFiredAtMs, c.cooldownMs)) return no("COOLDOWN", "rule is in cooldown");

  // Market sanity: fresh, two-sided, tight book.
  if (c.nowMs - c.book.atMs > 2 * c.tickMs) return no("STALE_BOOK", "order book is older than 2 ticks");
  if (c.book.bid === null || c.book.ask === null || c.book.bid <= 0n || c.book.ask <= 0n || c.book.bid > c.book.ask)
    return no("BOOK_EMPTY", "order book has no usable bid/ask");
  const bps = BigInt(c.priceBandBps);
  if ((c.book.ask - c.book.bid) * 10_000n > c.mid * bps)
    return no("SPREAD_TOO_WIDE", `bid/ask spread is wider than the ${c.priceBandBps} bps band`);

  // Price band (edge inclusive): buy <= mid*(1+band), sell >= mid*(1-band).
  if (o.side === "buy" && o.price * 10_000n > c.mid * (10_000n + bps))
    return no("PRICE_BAND", `buy price ${fxStr(o.price, 8)} is above mid ${fxStr(c.mid, 8)} + ${c.priceBandBps} bps`);
  if (o.side === "sell" && o.price * 10_000n < c.mid * (10_000n - bps))
    return no("PRICE_BAND", `sell price ${fxStr(o.price, 8)} is below mid ${fxStr(c.mid, 8)} - ${c.priceBandBps} bps`);

  const notional = fxMul(o.price, o.size);
  if (notional < MIN_NOTIONAL) return no("MIN_NOTIONAL", `notional ${fxStr(notional)} USDC is below the 10 USDC minimum`);
  if (notional > c.limits.maxOrder) return no("MAX_ORDER", `notional ${fxStr(notional)} USDC is above max order ${fxStr(c.limits.maxOrder)}`);
  if (c.ordersToday >= c.limits.maxOrdersPerDay)
    return no("MAX_ORDERS_PER_DAY", `${c.ordersToday} orders already attempted today (limit ${c.limits.maxOrdersPerDay})`);

  if (o.side === "buy") {
    // Position cap counts what is held at mid PLUS every open buy order, so resting orders cannot stack past it.
    const after = c.positionValue + c.openBuyValue + notional;
    if (after > c.limits.maxPosition)
      return no("POSITION_CAP", `position ${fxStr(c.positionValue)} + open buys ${fxStr(c.openBuyValue)} + order ${fxStr(notional)} exceeds max position ${fxStr(c.limits.maxPosition)}`);
    if (notional > c.freeUsdc) return no("INSUFFICIENT_USDC", `needs ${fxStr(notional)} USDC, free ${fxStr(c.freeUsdc)}`);
  } else if (o.size > c.freeBase) {
    return no("INSUFFICIENT_BASE", `needs ${fxStr(o.size, 8)} base, free ${fxStr(c.freeBase, 8)}`);
  }
  return { ok: true, notional };
}
