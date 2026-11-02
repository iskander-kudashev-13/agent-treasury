import { getLocale, intlLocale, t } from "@/i18n";
import { DAY_MS, shortDate } from "./frequency";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short weekday: the fixed English table for `en`, Intl (UTC) for other languages. */
function weekdayShort(ms: number): string {
  if (getLocale() === "en") return WEEKDAYS[(Math.floor(ms / DAY_MS) + 4) % 7]!;
  return new Intl.DateTimeFormat(intlLocale(), { weekday: "short", timeZone: "UTC" }).format(ms);
}

/** "Mon 1 Dec" (UTC), the date format of the Upcoming block. */
export function formatDay(ms: number | string): string {
  const n = Number(ms);
  return `${weekdayShort(n)} ${shortDate(n)}`;
}

/** "just now", "12 min ago", "3 h ago", "yesterday", else "3 Dec". `nowMs` is injected (keep render pure). */
export function agoText(ms: number | string, nowMs: number): string {
  const n = Number(ms);
  const d = nowMs - n;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (d < 0) return shortDate(n);
  if (d < 60_000) return t("common.justNow");
  if (d < 3_600_000) return t("time.agoMin", { n: Math.floor(d / 60_000) });
  if (d < DAY_MS) return t("time.agoHour", { n: Math.floor(d / 3_600_000) });
  if (d < 2 * DAY_MS) return t("time.yesterday");
  return shortDate(n);
}
