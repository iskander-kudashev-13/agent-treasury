// Plain words for the engine's skip codes, and the last decision per rule taken from the owner-only log.
// The worker's text is untrusted and English: only the code (a fixed list) and one number are used from it.
import { t } from "@/i18n";
import type { LogEntry } from "./tradingClient";

export const SKIP_CODES = [
  "SPOT_ONLY", "PAIR_NOT_ALLOWED", "PAIR_NOT_IN_RULES", "COOLDOWN", "STALE_BOOK", "BOOK_EMPTY", "SPREAD_TOO_WIDE", "PRICE_BAND", "MIN_NOTIONAL", "MAX_ORDER",
  "MAX_ORDERS_PER_DAY", "POSITION_CAP", "INSUFFICIENT_USDC", "INSUFFICIENT_BASE", "BAD_ORDER", "LIMIT_NEEDS_DEADMAN",
] as const;
type SkipCode = (typeof SKIP_CODES)[number];
const isCode = (c: string): c is SkipCode => (SKIP_CODES as readonly string[]).includes(c);

/** Hyperliquid's minimum order value, in USDC. */
export const HL_MIN_NOTIONAL = 10;
const NUM = /(\d+(?:\.\d+)?)/;

/**
 * "MIN_NOTIONAL: notional 9.25 USDC is below the 10 USDC minimum" -> "Order 9.25 USDC is below the 10 USDC Hyperliquid minimum".
 * A known code gives a translated sentence; anything else is shown as received (code included).
 */
export function skipReason(detail: string): string {
  const m = /^([A-Z][A-Z_]+):\s*(.*)$/s.exec(detail);
  const code = m?.[1];
  if (!code || !isCode(code)) return detail;
  if (code === "MIN_NOTIONAL") {
    const amount = NUM.exec(m?.[2] ?? "")?.[1];
    return amount ? t("trading.skip.MIN_NOTIONAL", { amount, min: HL_MIN_NOTIONAL }) : t("trading.skip.MIN_NOTIONAL.plain", { min: HL_MIN_NOTIONAL });
  }
  return t(`trading.skip.${code}`);
}

export interface LastDecision {
  at_ms: number;
  kind: "order" | "skip";
  text: string;
}

/** Newest decision (order placed or skipped) per rule id from a newest-first log. */
export function lastDecisions(log: readonly LogEntry[]): Record<string, LastDecision> {
  const out: Record<string, LastDecision> = {};
  for (const e of log) {
    if (!e.rule_id || (e.kind !== "order" && e.kind !== "skip") || e.rule_id in out) continue;
    out[e.rule_id] = { at_ms: e.at_ms, kind: e.kind, text: e.kind === "skip" ? skipReason(e.detail) : e.detail };
  }
  return out;
}
