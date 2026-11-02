/**
 * Price / size formatting to Hyperliquid's rules (ADR-0005 §6 "Rounding"), plus the client order id (cloid) builder.
 * Pure functions on decimal strings. All math is BigInt, never floats.
 *
 * HL rules for spot (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size):
 * - sizes have at most `szDecimals` decimals (we always round DOWN, so we never spend more than planned);
 * - prices have at most 5 significant figures AND at most `8 - szDecimals` decimals; integer prices are always allowed
 *   whatever their number of digits;
 * - trailing zeros must be stripped, or the signature hash differs from what the node computes.
 */
import type { Dec } from "../types.js";

export class FormatError extends Error {
  override name = "FormatError";
}

/** Parsed non-negative decimal: value = n / 10^scale. */
interface Parsed {
  n: bigint;
  scale: number;
}

const DEC_RE = /^\d+(\.\d+)?$/;
const MAX_SIG_FIGS = 5;
const SPOT_PRICE_DECIMALS = 8;

export function isDecimal(s: string): boolean {
  return DEC_RE.test(s);
}

function parse(s: string, what: string): Parsed {
  if (!DEC_RE.test(s)) throw new FormatError(`${what} is not a non-negative decimal string: ${JSON.stringify(s)}`);
  const [int = "0", frac = ""] = s.split(".");
  return { n: BigInt(int + frac), scale: frac.length };
}

function pow10(k: number): bigint {
  return 10n ** BigInt(k);
}

/** Render n / 10^scale without trailing zeros ("1.50" -> "1.5", "2.0" -> "2", "0.0" -> "0"). */
function render(n: bigint, scale: number): Dec {
  let digits = n.toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale);
  frac = frac.replace(/0+$/, "");
  digits = frac.length > 0 ? `${int}.${frac}` : int;
  return digits;
}

/** Strip leading/trailing zeros of a decimal string. Throws on malformed input. */
export function normalizeDec(s: string): Dec {
  const p = parse(s, "value");
  return render(p.n, p.scale);
}

/** Round to `decimals` decimals, `down` (floor) or `up` (ceil). */
function roundTo(p: Parsed, decimals: number, dir: "down" | "up"): Parsed {
  if (p.scale <= decimals) return p;
  const div = pow10(p.scale - decimals);
  let q = p.n / div;
  if (dir === "up" && p.n % div !== 0n) q += 1n;
  return { n: q, scale: decimals };
}

/** Compare two decimal strings: -1, 0, 1. */
export function cmpDec(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a, "a");
  const y = parse(b, "b");
  const s = Math.max(x.scale, y.scale);
  const l = x.n * pow10(s - x.scale);
  const r = y.n * pow10(s - y.scale);
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Exact product of two decimal strings (e.g. price x size = notional). */
export function mulDec(a: string, b: string): Dec {
  const x = parse(a, "a");
  const y = parse(b, "b");
  return render(x.n * y.n, x.scale + y.scale);
}

/** Exact sum of two decimal strings. */
export function addDec(a: string, b: string): Dec {
  const x = parse(a, "a");
  const y = parse(b, "b");
  const s = Math.max(x.scale, y.scale);
  return render(x.n * pow10(s - x.scale) + y.n * pow10(s - y.scale), s);
}

/** Exact difference a - b; throws when b > a (balances never go negative in this module). */
export function subDec(a: string, b: string): Dec {
  const x = parse(a, "a");
  const y = parse(b, "b");
  const s = Math.max(x.scale, y.scale);
  const d = x.n * pow10(s - x.scale) - y.n * pow10(s - y.scale);
  if (d < 0n) throw new FormatError(`${a} - ${b} is negative`);
  return render(d, s);
}

/** Round a size DOWN to `szDecimals` decimals. Throws when the result is zero (an order of size 0 is never valid). */
export function formatSize(size: string, szDecimals: number): Dec {
  assertDecimals(szDecimals, "szDecimals");
  const out = roundTo(parse(size, "size"), szDecimals, "down");
  if (out.n === 0n) throw new FormatError(`size ${size} rounds down to 0 at ${szDecimals} decimals`);
  return render(out.n, out.scale);
}

/** Same as formatSize but returns null instead of throwing when the size rounds to zero. */
export function tryFormatSize(size: string, szDecimals: number): Dec | null {
  assertDecimals(szDecimals, "szDecimals");
  const out = roundTo(parse(size, "size"), szDecimals, "down");
  return out.n === 0n ? null : render(out.n, out.scale);
}

/**
 * Round a spot price to HL's tick rules: at most 5 significant figures and at most `8 - szDecimals` decimals.
 * `dir` is the safe side for the order: a buy rounds `down` (never pay more), a sell rounds `up` (never accept less).
 */
export function formatPrice(price: string, szDecimals: number, dir: "down" | "up"): Dec {
  assertDecimals(szDecimals, "szDecimals");
  if (szDecimals > SPOT_PRICE_DECIMALS) throw new FormatError(`szDecimals ${szDecimals} > ${SPOT_PRICE_DECIMALS}`);
  const p = parse(price, "price");
  if (p.n === 0n) throw new FormatError("price is zero");
  // Magnitude e: value in [10^(e-1), 10^e). e <= 0 for values below 1 (e = -(leading zeros after the point)).
  const e = p.n.toString().length - p.scale;
  const sigDecimals = Math.max(0, MAX_SIG_FIGS - e);
  const decimals = Math.min(SPOT_PRICE_DECIMALS - szDecimals, sigDecimals);
  const out = roundTo(p, decimals, dir);
  if (out.n === 0n) throw new FormatError(`price ${price} rounds down to 0 at ${decimals} decimals`);
  return render(out.n, out.scale);
}

/** Price limit of an order inside the band around `mid`: buy at most mid*(1+band), sell at least mid*(1-band). */
export function bandPrice(mid: string, side: "buy" | "sell", bandBps: number, szDecimals: number): Dec {
  if (!Number.isInteger(bandBps) || bandBps < 0 || bandBps >= 10_000) throw new FormatError(`bad band bps ${bandBps}`);
  const m = parse(mid, "mid");
  const factor = side === "buy" ? 10_000 + bandBps : 10_000 - bandBps;
  const raw = render(m.n * BigInt(factor), m.scale + 4);
  return formatPrice(raw, szDecimals, side === "buy" ? "down" : "up");
}

/** True when `price` respects the band around `mid` (buy <= mid*(1+band), sell >= mid*(1-band)). */
export function withinBand(price: string, mid: string, side: "buy" | "sell", bandBps: number): boolean {
  const p = parse(price, "price");
  const m = parse(mid, "mid");
  const s = Math.max(p.scale, m.scale);
  const pv = p.n * pow10(s - p.scale) * 10_000n;
  const mv = m.n * pow10(s - m.scale);
  return side === "buy" ? pv <= mv * BigInt(10_000 + bandBps) : pv >= mv * BigInt(10_000 - bandBps);
}

/** Is `price` valid under the tick rules for `szDecimals` (no rounding needed)? */
export function isValidPrice(price: string, szDecimals: number): boolean {
  if (!isDecimal(price)) return false;
  if (price !== normalizeDec(price)) return false;
  try {
    return formatPrice(price, szDecimals, "down") === price;
  } catch {
    return false;
  }
}

function assertDecimals(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 18) throw new FormatError(`${what} must be an integer 0..18, got ${n}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// cloid: 0x || rules_hash[0..8] || counter_be64  (16 bytes = 32 hex chars; ADR-0005 §5)
// ---------------------------------------------------------------------------------------------------------------------

const HASH_PREFIX_HEX = 16; // 8 bytes
const U64_MAX = (1n << 64n) - 1n;

/** `rulesHashHex` is the 64-hex sha256 of the canonical rule set; `counter` is a per-rule-set order counter. */
export function buildCloid(rulesHashHex: string, counter: number | bigint): string {
  if (!/^[0-9a-fA-F]{64}$/.test(rulesHashHex)) throw new FormatError("rules hash must be 64 hex chars");
  const c = BigInt(counter);
  if (c < 0n || c > U64_MAX) throw new FormatError("cloid counter out of u64 range");
  return `0x${rulesHashHex.slice(0, HASH_PREFIX_HEX).toLowerCase()}${c.toString(16).padStart(16, "0")}`;
}

export function parseCloid(cloid: string): { hashPrefix: string; counter: bigint } | null {
  const m = /^0x([0-9a-f]{16})([0-9a-f]{16})$/.exec(cloid);
  if (!m) return null;
  return { hashPrefix: m[1] ?? "", counter: BigInt(`0x${m[2] ?? "0"}`) };
}

/** Does this cloid belong to the rule set with this hash? Orders placed by hand (null cloid) never match. */
export function cloidMatchesRules(cloid: string | null, rulesHashHex: string): boolean {
  if (cloid === null) return false;
  const p = parseCloid(cloid);
  return p !== null && p.hashPrefix === rulesHashHex.slice(0, HASH_PREFIX_HEX).toLowerCase();
}
