import { DAY_MS, shortDate } from "./frequency";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 1 Dec" (UTC), the date format of the Upcoming block. */
export function formatDay(ms: number | string): string {
  const n = Number(ms);
  return `${WEEKDAYS[(Math.floor(n / DAY_MS) + 4) % 7]} ${shortDate(n)}`;
}

/** "just now", "12 min ago", "3 h ago", "yesterday", else "3 Dec". `nowMs` is injected (keep render pure). */
export function agoText(ms: number | string, nowMs: number): string {
  const n = Number(ms);
  const d = nowMs - n;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (d < 0) return shortDate(n);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < DAY_MS) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 2 * DAY_MS) return "yesterday";
  return shortDate(n);
}
