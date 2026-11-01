/** USDC has 6 decimals. All arithmetic is bigint on base units; floats never touch money. */
export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** "1500", "1500.5", "0.000001" -> base units. Returns `null` for anything else (no commas, no exponent, no sign). */
export function parseUsdc(input: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m?.[1]) return null;
  return BigInt(m[1]) * UNIT + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0") || "0");
}

/** Base units -> "1500" / "1500.5" (minimal decimals). */
export function formatUsdc(units: bigint): string {
  const whole = units / UNIT;
  const frac = (units % UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Human form for summaries: "1 500" / "1 500.5" (non-breaking space as thousands separator). */
export function formatUsdcHuman(units: bigint): string {
  const [w = "0", f] = formatUsdc(units).split(".");
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return f ? `${grouped}.${f}` : grouped;
}

export function parseU128(s: string): bigint | null {
  return /^\d{1,39}$/.test(s) ? BigInt(s) : null;
}
