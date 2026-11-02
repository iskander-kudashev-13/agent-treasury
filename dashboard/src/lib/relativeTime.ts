import { t } from "@/i18n";
import { DAY_MS } from "./frequency";

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** "in 4 days", "in 3 hours", "5 days ago", "just now", "never" for null. Coarse on purpose (largest unit only). The one relative-time helper. */
export function relativeTime(target: number | string | null | undefined, nowMs: number): string {
  if (target === null || target === undefined) return t("common.never");
  const diff = Number(target) - nowMs;
  const abs = Math.abs(diff);
  if (abs < MIN_MS) return t("common.justNow");
  const span =
    abs >= DAY_MS ? t("time.days", { count: Math.floor(abs / DAY_MS) }) : abs >= HOUR_MS ? t("time.hours", { count: Math.floor(abs / HOUR_MS) }) : t("time.minutes", { count: Math.floor(abs / MIN_MS) });
  return diff >= 0 ? t("time.in", { span }) : t("time.ago", { span });
}
