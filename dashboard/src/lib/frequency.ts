/**
 * Schedule date rules, ADR-0004 §2. UTC only; Sunday = 0; time of day comes from `start_at`.
 * Must match contract/src/frequency.rs and docs/frequency-vectors.json exactly.
 * Timestamps are ms since epoch as `number` (safe: far below 2^53).
 */
import { getLocale, intlLocale, t } from "@/i18n";
import type { Frequency, ScheduleEnd } from "./types";

export const DAY_MS = 86_400_000;

const weekdayOfDay = (d: number): number => (d + 4) % 7;

/** Days since 1970-01-01 -> [year, month 1..12, day 1..31] (Hinnant civil_from_days). */
function civilFromDays(d: number): [number, number, number] {
  const z = d + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
}

/** (year, month 1..12, day) -> days since 1970-01-01 (Hinnant days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Earliest occurrence >= max(startAt, t), ignoring the end rule. null only for `Once` in the past. */
export function firstAtOrAfter(freq: Frequency, startAt: number, t: number): number | null {
  const tt = Math.max(t, startAt);
  const tod = startAt % DAY_MS;
  const atDay = (d: number): number => d * DAY_MS + tod;
  if (freq === "Once") return tt === startAt ? startAt : null;
  if ("EveryNDays" in freq) {
    const step = freq.EveryNDays.n * DAY_MS;
    return startAt + Math.ceil((tt - startAt) / step) * step;
  }
  if ("Weekly" in freq) {
    let d = Math.floor(tt / DAY_MS);
    if (atDay(d) < tt) d += 1;
    const delta = (freq.Weekly.weekday + 7 - weekdayOfDay(d)) % 7;
    return atDay(d + delta);
  }
  let [y, m] = civilFromDays(Math.floor(tt / DAY_MS));
  let candidate = atDay(daysFromCivil(y, m, freq.Monthly.day));
  if (candidate < tt) {
    if (m === 12) {
      y += 1;
      m = 1;
    } else m += 1;
    candidate = atDay(daysFromCivil(y, m, freq.Monthly.day));
  }
  return candidate;
}

/** Earliest occurrence strictly after t. */
export const nextAfter = (freq: Frequency, startAt: number, t: number): number | null => firstAtOrAfter(freq, startAt, t + 1);

/** Does the end rule allow paying occurrence `occ` when `paidCount` were already paid? */
export function endAllows(end: ScheduleEnd, occ: number, paidCount: number): boolean {
  if (end === "Never") return true;
  if ("AfterCount" in end) return paidCount < end.AfterCount.count;
  return occ <= Number(end.On.at);
}

export interface ScheduleLike {
  frequency: Frequency;
  start_at: string | number;
  end: ScheduleEnd;
  /** For existing schedules: earliest unpaid occurrence (use when set). */
  next_due_at?: string | number | null;
  paid_count?: number;
}

/** Next `n` payable occurrences (live form preview and schedule lists). Starts at `from` (default: the schedule's start). */
export function nextOccurrences(s: ScheduleLike, n = 3, from?: number): number[] {
  const start = Number(s.start_at);
  let paid = s.paid_count ?? 0;
  let cursor: number | null =
    s.next_due_at !== undefined ? (s.next_due_at === null ? null : Number(s.next_due_at)) : firstAtOrAfter(s.frequency, start, start);
  const out: number[] = [];
  while (cursor !== null && out.length < n && endAllows(s.end, cursor, paid)) {
    if (from === undefined || cursor >= from) out.push(cursor);
    paid += 1;
    cursor = nextAfter(s.frequency, start, cursor);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "3 Dec" (UTC). */
export function shortDate(ms: number): string {
  if (getLocale() !== "en") return new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(ms);
  const [, m, d] = civilFromDays(Math.floor(ms / DAY_MS));
  return `${d} ${MONTHS[m - 1]}`;
}

export function describeFrequency(freq: Frequency, startAt: string | number): string {
  if (freq === "Once") return t("freq.once", { date: shortDate(Number(startAt)) });
  if ("Weekly" in freq) return t(`freq.weekly.${freq.Weekly.weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6}` as const);
  if ("Monthly" in freq) return t("freq.monthly", { day: freq.Monthly.day, ordinal: ordinal(freq.Monthly.day) });
  const n = freq.EveryNDays.n;
  return n === 1 ? t("freq.everyDay") : t("freq.everyNDays", { count: n });
}
