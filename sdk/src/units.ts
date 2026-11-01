import { SdkError } from "./errors.js";

/** USDC has 6 decimals on NEAR and on every chain we support. All math is bigint; floats are never used. */
export const USDC_DECIMALS = 6;
const MAX_U128 = (1n << 128n) - 1n;
const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/;

/** "12.5" -> 12500000n. Rejects negatives, exponents, more than 6 decimals, zero and values above u128. */
export function parseUsdc(input: string): bigint {
  if (typeof input !== "string") throw new SdkError("INVALID_INPUT", "amount must be a decimal string such as \"12.5\"");
  const m = AMOUNT_RE.exec(input.trim());
  if (!m) throw new SdkError("INVALID_INPUT", `invalid USDC amount "${input}": use a plain decimal like "12.5"`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) {
    throw new SdkError("INVALID_INPUT", `USDC has ${USDC_DECIMALS} decimals; "${input}" has ${frac.length}`);
  }
  const base = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
  if (base <= 0n) throw new SdkError("INVALID_INPUT", "amount must be greater than zero");
  if (base > MAX_U128) throw new SdkError("INVALID_INPUT", "amount is too large");
  return base;
}

/** 12500000n -> "12.5"; 1n -> "0.000001"; trailing zeros trimmed. */
export function formatUsdc(base: bigint, decimals: number = USDC_DECIMALS): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac === "" ? "" : `.${frac}`}`;
}

/** Parses a U128 decimal string from the contract. */
export function parseU128(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new SdkError("VAULT_ERROR", `contract returned a non-numeric amount "${s}"`);
  return BigInt(s);
}

/** Rescales an integer amount between decimals without floats (truncates toward zero when shrinking). */
export function rescale(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  return from < to ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to);
}
