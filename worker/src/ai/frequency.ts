/**
 * Schedule date semantics, ADR-0004 §2 (UTC, milliseconds). MUST stay identical to the Rust `frequency.rs` and the
 * dashboard's `lib/frequency.ts`; the shared vectors live in `docs/frequency-vectors.json`.
 *
 * Occurrences are timestamps `D * DAY_MS + tod` for qualifying days `D`, with `tod = start_at mod DAY_MS`, and only
 * those `>= start_at`. Weekday numbering is JS `getUTCDay()` (0 = Sunday ... 6 = Saturday; 1970-01-01 was a Thursday).
 */

export const DAY_MS = 86_400_000;

export type Frequency =
  | { type: "Once" }
  | { type: "Weekly"; weekday: number }
  | { type: "Monthly"; day: number }
  | { type: "EveryNDays"; n: number };

export type EndRule = { type: "Never" } | { type: "AfterCount"; count: number } | { type: "On"; at: number };

const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** Days since 1970-01-01 of the civil date (proleptic Gregorian). Howard Hinnant's algorithm. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`. */
function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Why a frequency/end is malformed, or `null` when it is valid (contract `add_schedule` rules, ADR-0004 §4). */
export function frequencyError(freq: Frequency, end: EndRule): string | null {
  const isInt = Number.isInteger;
  switch (freq.type) {
    case "Weekly":
      if (!isInt(freq.weekday) || freq.weekday < 0 || freq.weekday > 6) return "weekday must be 0 (Sunday) to 6 (Saturday)";
      break;
    case "Monthly":
      if (!isInt(freq.day) || freq.day < 1 || freq.day > 28) return "day of month must be 1 to 28 (use 28 for end of month)";
      break;
    case "EveryNDays":
      if (!isInt(freq.n) || freq.n < 1 || freq.n > 365) return "n must be 1 to 365 days";
      break;
    case "Once":
      break;
  }
  if (end.type === "AfterCount" && (!isInt(end.count) || end.count < 1)) return "payment count must be at least 1";
  return null;
}

/** First occurrence `>= t` (and `>= startAt`), or `null` if there is none. Ignores `end` (see `occurrences`). */
export function firstAtOrAfter(freq: Frequency, startAt: number, t: number): number | null {
  const lo = Math.max(t, startAt);
  const tod = mod(startAt, DAY_MS);
  // Smallest day D with D * DAY_MS + tod >= lo.
  const d0 = Math.ceil((lo - tod) / DAY_MS);
  switch (freq.type) {
    case "Once":
      return startAt >= t ? startAt : null;
    case "Weekly": {
      const d = d0 + mod(freq.weekday - mod(d0 + 4, 7), 7);
      return d * DAY_MS + tod;
    }
    case "Monthly": {
      const { y, m, d } = civilFromDays(d0);
      const day = d <= freq.day ? daysFromCivil(y, m, freq.day) : m === 12 ? daysFromCivil(y + 1, 1, freq.day) : daysFromCivil(y, m + 1, freq.day);
      return day * DAY_MS + tod;
    }
    case "EveryNDays": {
      const step = freq.n * DAY_MS;
      return lo <= startAt ? startAt : startAt + Math.ceil((lo - startAt) / step) * step;
    }
  }
}

/** First occurrence strictly after `t`. */
export function nextAfter(freq: Frequency, startAt: number, t: number): number | null {
  return firstAtOrAfter(freq, startAt, t + 1);
}

/**
 * Unpaid occurrences inside `[from, to]` (inclusive), at most `max`. The first `paidCount` occurrences are the paid
 * ones (missed occurrences are paid one by one, ADR-0004 §3). `AfterCount` bounds the total number of occurrences,
 * `On { at }` keeps only occurrences `<= at`.
 */
export function occurrences(freq: Frequency, startAt: number, end: EndRule, paidCount: number, from: number, to: number, max: number): number[] {
  const out: number[] = [];
  let index = 0;
  let cursor = firstAtOrAfter(freq, startAt, startAt);
  while (cursor !== null && out.length < max) {
    if (end.type === "AfterCount" && index >= end.count) break;
    if (end.type === "On" && cursor > end.at) break;
    if (cursor > to) break;
    if (index >= paidCount && cursor >= from) out.push(cursor);
    index += 1;
    cursor = nextAfter(freq, startAt, cursor);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${(["th", "st", "nd", "rd"] as const)[n % 10 > 3 ? 0 : n % 10] ?? "th"}`;
}

/** "3 Dec" (UTC); with `withYear`, "3 Dec 2026". */
export function formatDate(ms: number, withYear = false): string {
  const { y, m, d } = civilFromDays(Math.floor(ms / DAY_MS));
  return `${d} ${MONTHS[m - 1] ?? "?"}${withYear ? ` ${y}` : ""}`;
}

/** Same wording as the dashboard: "Monthly on the 1st", "Every Monday", "Every 14 days", "Once on 3 Dec". */
export function describeFrequency(freq: Frequency, startAt?: number): string {
  switch (freq.type) {
    case "Once":
      return startAt === undefined ? "Once" : `Once on ${formatDate(startAt)}`;
    case "Weekly":
      return `Every ${WEEKDAYS[freq.weekday] ?? "?"}`;
    case "Monthly":
      return `Monthly on the ${ordinal(freq.day)}`;
    case "EveryNDays":
      return freq.n === 1 ? "Every day" : `Every ${freq.n} days`;
  }
}

export function describeEnd(end: EndRule): string {
  switch (end.type) {
    case "Never":
      return "no end";
    case "AfterCount":
      return `ends after ${end.count} payment${end.count === 1 ? "" : "s"}`;
    case "On":
      return `ends on ${formatDate(end.at, true)}`;
  }
}

// --- wire format (serde externally tagged, as the contract serializes it) --------------------------------------

export type FrequencyWire = "Once" | { Weekly: { weekday: number } } | { Monthly: { day: number } } | { EveryNDays: { n: number } };
export type EndWire = "Never" | { AfterCount: { count: number } } | { On: { at: string } };

export function frequencyToWire(f: Frequency): FrequencyWire {
  switch (f.type) {
    case "Once":
      return "Once";
    case "Weekly":
      return { Weekly: { weekday: f.weekday } };
    case "Monthly":
      return { Monthly: { day: f.day } };
    case "EveryNDays":
      return { EveryNDays: { n: f.n } };
  }
}

export function endToWire(e: EndRule): EndWire {
  switch (e.type) {
    case "Never":
      return "Never";
    case "AfterCount":
      return { AfterCount: { count: e.count } };
    case "On":
      return { On: { at: String(e.at) } };
  }
}

export function frequencyFromWire(w: unknown): Frequency | null {
  if (w === "Once") return { type: "Once" };
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === "number" ? x : null);
  const inner = (k: string): Record<string, unknown> | null => (typeof o[k] === "object" && o[k] !== null ? (o[k] as Record<string, unknown>) : null);
  const weekly = inner("Weekly");
  if (weekly && num(weekly.weekday) !== null) return { type: "Weekly", weekday: weekly.weekday as number };
  const monthly = inner("Monthly");
  if (monthly && num(monthly.day) !== null) return { type: "Monthly", day: monthly.day as number };
  const every = inner("EveryNDays");
  if (every && num(every.n) !== null) return { type: "EveryNDays", n: every.n as number };
  return null;
}

export function endFromWire(w: unknown): EndRule | null {
  if (w === "Never") return { type: "Never" };
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const after = o.AfterCount;
  if (typeof after === "object" && after !== null && typeof (after as { count?: unknown }).count === "number") {
    return { type: "AfterCount", count: (after as { count: number }).count };
  }
  const on = o.On;
  if (typeof on === "object" && on !== null) {
    const at = (on as { at?: unknown }).at;
    if (typeof at === "string" && /^\d+$/.test(at)) return { type: "On", at: Number(at) };
    if (typeof at === "number") return { type: "On", at };
  }
  return null;
}
