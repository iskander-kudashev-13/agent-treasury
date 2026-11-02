import { t } from "@/i18n";
/** USDC amounts: always strings / bigint of smallest units (6 decimals). Never floats. */
export const USDC_DECIMALS = 6;

const toBig = (v: string | bigint): bigint => (typeof v === "bigint" ? v : BigInt(v));

/** Raw units -> decimal string. `minFraction` keeps trailing zeros up to that many digits (default 2; 6 = fixed). */
export function formatUnits(raw: string | bigint, decimals = USDC_DECIMALS, minFraction = 2): string {
  const v = toBig(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  let frac = (abs % base).toString().padStart(decimals, "0");
  while (frac.length > minFraction && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${whole}${frac.length > 0 ? "." + frac : ""}`;
}

export const formatUsdc = (raw: string | bigint, minFraction = 2): string =>
  formatUnits(raw, USDC_DECIMALS, minFraction);

/** Human decimal string -> raw units string. Throws on invalid input or more than `decimals` fraction digits. */
export function parseUnits(input: string, decimals = USDC_DECIMALS): string {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(t("amount.invalid", { value: input }));
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(t("amount.maxDecimals", { n: decimals }));
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"))).toString();
}

export const parseUsdc = (input: string): string => parseUnits(input, USDC_DECIMALS);

/** Percentage 0..100 (integer) of part/total using bigint math. */
export function percent(part: string | bigint, total: string | bigint): number {
  const t = toBig(total);
  if (t <= 0n) return 0;
  const p = (toBig(part) * 100n) / t;
  return Number(p > 100n ? 100n : p < 0n ? 0n : p);
}

/** "12480500000" -> "12,480.50" (en-US grouping, at least 2 decimals, exact: no floats). */
export function usdcGrouped(raw: string | bigint, minFraction = 2): string {
  const [whole = "0", frac] = formatUsdc(raw, minFraction).split(".");
  const neg = whole.startsWith("-");
  const g = (neg ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${g}${frac ? "." + frac : ""}`;
}

/** Display ratio only (SpendBar / RingGauge props). Never use for money math. */
export const usdcNumber = (raw: string): number => Number(formatUsdc(raw, 6));

/** spent / limit as a fraction for gauges (0 when the limit is 0). */
export function fraction(spent: string, limit: string): number {
  const l = BigInt(limit);
  return l === 0n ? 0 : usdcNumber(spent) / usdcNumber(limit);
}
