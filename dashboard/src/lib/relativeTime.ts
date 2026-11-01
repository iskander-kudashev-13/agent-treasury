import { DAY_MS } from "./frequency";

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** "in 4 days", "in 3 hours", "5 days ago", "just now", "never" for null. Coarse on purpose (largest unit only). The one relative-time helper. */
export function relativeTime(target: number | string | null | undefined, nowMs: number): string {
  if (target === null || target === undefined) return "never";
  const diff = Number(target) - nowMs;
  const abs = Math.abs(diff);
  if (abs < MIN_MS) return "just now";
  const [n, unit] = abs >= DAY_MS ? [Math.floor(abs / DAY_MS), "day"] : abs >= HOUR_MS ? [Math.floor(abs / HOUR_MS), "hour"] : [Math.floor(abs / MIN_MS), "minute"];
  const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}
