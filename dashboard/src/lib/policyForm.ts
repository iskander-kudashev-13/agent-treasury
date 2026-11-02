import { t } from "@/i18n";
import { formatUsdc, parseUsdc } from "./amount";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MIN_GRACE_MS = HOUR_MS;
export const MAX_GRACE_MS = 30 * DAY_MS;

export type GraceUnit = "hours" | "days";
export interface PolicyDraft {
  daily: string;
  min: string;
  graceValue: string;
  graceUnit: GraceUnit;
}

/** Split a grace in ms into the form's value + unit (days when it is a whole number of days). */
export function graceToDraft(ms: string): { graceValue: string; graceUnit: GraceUnit } {
  const n = Number(ms);
  if (n % DAY_MS === 0) return { graceValue: String(n / DAY_MS), graceUnit: "days" };
  return { graceValue: String(+(n / HOUR_MS).toFixed(2)), graceUnit: "hours" };
}

export function policyToDraft(p: { daily_limit: string; min_payment: string; overdue_grace_ms: string }): PolicyDraft {
  return { daily: formatUsdc(p.daily_limit, 2), min: formatUsdc(p.min_payment, 2), ...graceToDraft(p.overdue_grace_ms) };
}

export interface PolicyErrors {
  daily?: string;
  min?: string;
  grace?: string;
}
/** Mirrors contract `set_policy`: min > 0, min <= daily, grace in [1 h, 30 d]. */
export function validatePolicy(d: PolicyDraft): { policy: { daily_limit: string; min_payment: string; overdue_grace_ms: string } | null; errors: PolicyErrors } {
  const errors: PolicyErrors = {};
  let daily = 0n;
  let min = 0n;
  try {
    daily = BigInt(parseUsdc(d.daily));
    if (daily === 0n) errors.daily = t("pol.mustPositive");
  } catch (e) {
    errors.daily = (e as Error).message;
  }
  try {
    min = BigInt(parseUsdc(d.min));
    if (min === 0n) errors.min = t("pol.mustPositive");
  } catch (e) {
    errors.min = (e as Error).message;
  }
  if (!errors.daily && !errors.min && min > daily) errors.min = t("pol.minOverDaily");
  const g = Number(d.graceValue);
  const ms = Math.round(g * (d.graceUnit === "days" ? DAY_MS : HOUR_MS));
  if (!d.graceValue.trim() || !Number.isFinite(g)) errors.grace = t("pol.enterNumber");
  else if (ms < MIN_GRACE_MS || ms > MAX_GRACE_MS) errors.grace = t("pol.graceRange");
  if (errors.daily || errors.min || errors.grace) return { policy: null, errors };
  return { policy: { daily_limit: daily.toString(), min_payment: min.toString(), overdue_grace_ms: String(ms) }, errors };
}
