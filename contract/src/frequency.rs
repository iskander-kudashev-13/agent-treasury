//! Schedule date rules (ADR-0004 §2). Pure functions, UTC, milliseconds. The dashboard (`lib/frequency.ts`) and the
//! assistant implement the same rules and are tested against the same vectors (`docs/frequency-vectors.json`).
//!
//! Occurrences are `D * DAY_MS + tod` for qualifying days `D` (days since 1970-01-01), where `tod` is the time of day of
//! `start_at`, and only those `>= start_at`. Weekdays: 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday = 4).

use crate::*;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frequency {
    Once,
    Weekly { weekday: u8 },
    Monthly { day: u8 },
    EveryNDays { n: u16 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleEnd {
    Never,
    AfterCount { count: u32 },
    On { at: U64 },
}

impl Frequency {
    pub fn is_valid(&self) -> bool {
        match *self {
            Frequency::Once => true,
            Frequency::Weekly { weekday } => weekday <= 6,
            Frequency::Monthly { day } => (1..=28).contains(&day),
            Frequency::EveryNDays { n } => (1..=365).contains(&n),
        }
    }
}

impl ScheduleEnd {
    pub fn is_valid(&self) -> bool {
        !matches!(self, ScheduleEnd::AfterCount { count: 0 })
    }

    /// May the occurrence at `occ` be paid, given `paid_count` occurrences already paid?
    pub fn allows(&self, occ: u64, paid_count: u32) -> bool {
        match *self {
            ScheduleEnd::Never => true,
            ScheduleEnd::AfterCount { count } => paid_count < count,
            ScheduleEnd::On { at } => occ <= at.0,
        }
    }
}

/// Day of week of day number `d` (days since 1970-01-01), 0 = Sunday.
pub fn weekday(d: u64) -> u8 {
    ((d + 4) % 7) as u8
}

/// Days since 1970-01-01 → (year, month 1..=12, day 1..=31). Howard Hinnant's `civil_from_days`, for `d >= 0`.
pub fn civil_from_days(d: u64) -> (u64, u32, u32) {
    let z = d + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

/// (year >= 1970, month 1..=12, day 1..=31) → days since 1970-01-01. Hinnant's `days_from_civil`.
pub fn days_from_civil(year: u64, month: u32, day: u32) -> u64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = u64::from(if month > 2 { month - 3 } else { month + 9 });
    let doy = (153 * mp + 2) / 5 + u64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Earliest occurrence `>= max(start_at, t)`, ignoring the end rule. `None` only for `Once` in the past (or overflow).
pub fn first_at_or_after(freq: Frequency, start_at: u64, t: u64) -> Option<u64> {
    let t = t.max(start_at);
    let tod = start_at % DAY_MS;
    let at_day = |d: u64| d.checked_mul(DAY_MS).and_then(|v| v.checked_add(tod));
    match freq {
        Frequency::Once => (t == start_at).then_some(start_at),
        Frequency::EveryNDays { n } => {
            let step = u64::from(n).checked_mul(DAY_MS)?;
            let k = (t - start_at).div_ceil(step);
            start_at.checked_add(k.checked_mul(step)?)
        }
        Frequency::Weekly { weekday: w } => {
            let mut d = t / DAY_MS;
            if at_day(d)? < t {
                d += 1;
            }
            let delta = (u64::from(w) + 7 - u64::from(weekday(d))) % 7;
            at_day(d + delta)
        }
        Frequency::Monthly { day } => {
            let (mut y, mut m, _) = civil_from_days(t / DAY_MS);
            let mut candidate = at_day(days_from_civil(y, m, u32::from(day)))?;
            if candidate < t {
                if m == 12 {
                    y += 1;
                    m = 1;
                } else {
                    m += 1;
                }
                candidate = at_day(days_from_civil(y, m, u32::from(day)))?;
            }
            Some(candidate)
        }
    }
}

/// Earliest occurrence strictly after `t`.
pub fn next_after(freq: Frequency, start_at: u64, t: u64) -> Option<u64> {
    first_at_or_after(freq, start_at, t.checked_add(1)?)
}

/// Payable occurrences in `[from, to]`, starting the search at `next_due` with `paid_count` already paid, honoring the
/// end rule, at most `max` items.
/// Reference walk (used by tests; views use `cursor_from` + a merge, which is bounded and exactly sorted).
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn occurrences(
    freq: Frequency,
    start_at: u64,
    end: ScheduleEnd,
    next_due: Option<u64>,
    paid_count: u32,
    from: u64,
    to: u64,
    max: usize,
) -> Vec<u64> {
    let mut out = Vec::new();
    let mut cursor = next_due;
    let mut paid = paid_count;
    while let Some(occ) = cursor {
        if occ > to || out.len() >= max || !end.allows(occ, paid) {
            break;
        }
        if occ >= from {
            out.push(occ);
        }
        paid = paid.saturating_add(1);
        cursor = next_after(freq, start_at, occ);
    }
    out
}

/// First payable occurrence `>= from`, starting at `next_due` with `paid_count` paid, and the paid count at that point.
/// Jumps directly unless the end rule depends on the count (then walks, at most `MAX_CURSOR_STEPS`).
pub fn cursor_from(
    freq: Frequency,
    start_at: u64,
    end: ScheduleEnd,
    next_due: Option<u64>,
    paid_count: u32,
    from: u64,
) -> Option<(u64, u32)> {
    let nd = next_due?;
    match end {
        ScheduleEnd::AfterCount { .. } => {
            let (mut occ, mut paid, mut steps) = (nd, paid_count, 0u32);
            while occ < from {
                if !end.allows(occ, paid) || steps >= MAX_CURSOR_STEPS {
                    return None;
                }
                paid = paid.saturating_add(1);
                occ = next_after(freq, start_at, occ)?;
                steps += 1;
            }
            end.allows(occ, paid).then_some((occ, paid))
        }
        _ => {
            let occ = first_at_or_after(freq, start_at, from.max(nd))?;
            end.allows(occ, paid_count).then_some((occ, paid_count))
        }
    }
}

#[cfg(test)]
mod frequency_tests {
    use super::*;

    const D: u64 = DAY_MS;
    /// 2026-12-01T09:30:00Z (a Tuesday).
    const DEC1: u64 = 1_796_117_400_000;

    fn ymd(ms: u64) -> (u64, u32, u32) {
        civil_from_days(ms / D)
    }

    #[test]
    fn calendar_roundtrip_and_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(weekday(0), 4); // Thursday
        assert_eq!(ymd(DEC1), (2026, 12, 1));
        assert_eq!(weekday(DEC1 / D), 2); // Tuesday
        assert_eq!(days_from_civil(2000, 2, 29), 11_016);
        for d in [0u64, 59, 60, 365, 11_016, 20_000, 30_000, 100_000] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
    }

    #[test]
    fn once() {
        assert_eq!(first_at_or_after(Frequency::Once, DEC1, 0), Some(DEC1));
        assert_eq!(first_at_or_after(Frequency::Once, DEC1, DEC1), Some(DEC1));
        assert_eq!(first_at_or_after(Frequency::Once, DEC1, DEC1 + 1), None);
        assert_eq!(next_after(Frequency::Once, DEC1, DEC1), None);
    }

    #[test]
    fn every_n_days() {
        let f = Frequency::EveryNDays { n: 14 };
        assert_eq!(first_at_or_after(f, DEC1, 0), Some(DEC1));
        assert_eq!(next_after(f, DEC1, DEC1), Some(DEC1 + 14 * D));
        assert_eq!(first_at_or_after(f, DEC1, DEC1 + 14 * D), Some(DEC1 + 14 * D));
        assert_eq!(first_at_or_after(f, DEC1, DEC1 + 14 * D + 1), Some(DEC1 + 28 * D));
    }

    #[test]
    fn weekly_keeps_time_of_day() {
        // Every Monday (1) starting Tue 1 Dec 09:30 → Mon 7 Dec 09:30, then 14 Dec.
        let f = Frequency::Weekly { weekday: 1 };
        let first = first_at_or_after(f, DEC1, 0).unwrap();
        assert_eq!(ymd(first), (2026, 12, 7));
        assert_eq!(first % D, DEC1 % D);
        assert_eq!(next_after(f, DEC1, first), Some(first + 7 * D));
        // Same weekday as start → start itself.
        assert_eq!(first_at_or_after(Frequency::Weekly { weekday: 2 }, DEC1, 0), Some(DEC1));
        // Later the same day but past tod → next week.
        assert_eq!(first_at_or_after(Frequency::Weekly { weekday: 2 }, DEC1, DEC1 + 1), Some(DEC1 + 7 * D));
    }

    #[test]
    fn monthly_rolls_over_year_end() {
        let f = Frequency::Monthly { day: 1 };
        let a = first_at_or_after(f, DEC1, 0).unwrap();
        assert_eq!(a, DEC1);
        let b = next_after(f, DEC1, a).unwrap();
        assert_eq!(ymd(b), (2027, 1, 1));
        let c = next_after(f, DEC1, b).unwrap();
        assert_eq!(ymd(c), (2027, 2, 1));
        // Day 28 from 1 Dec → 28 Dec, then 28 Jan, 28 Feb.
        let f28 = Frequency::Monthly { day: 28 };
        let x = first_at_or_after(f28, DEC1, 0).unwrap();
        assert_eq!(ymd(x), (2026, 12, 28));
        assert_eq!(ymd(next_after(f28, DEC1, x).unwrap()), (2027, 1, 28));
        assert_eq!(x % D, DEC1 % D);
    }

    #[test]
    fn occurrences_respect_end_and_window() {
        let f = Frequency::Monthly { day: 1 };
        let all = occurrences(f, DEC1, ScheduleEnd::Never, Some(DEC1), 0, 0, DEC1 + 100 * D, 10);
        assert_eq!(all.len(), 4); // 1 Dec, 1 Jan, 1 Feb, 1 Mar
        let two = occurrences(f, DEC1, ScheduleEnd::AfterCount { count: 2 }, Some(DEC1), 0, 0, u64::MAX / 2, 10);
        assert_eq!(two.len(), 2);
        let one_left = occurrences(f, DEC1, ScheduleEnd::AfterCount { count: 2 }, Some(DEC1), 1, 0, u64::MAX / 2, 10);
        assert_eq!(one_left.len(), 1);
        let until =
            occurrences(f, DEC1, ScheduleEnd::On { at: U64(DEC1 + 40 * D) }, Some(DEC1), 0, 0, u64::MAX / 2, 10);
        assert_eq!(until.len(), 2);
        let window = occurrences(f, DEC1, ScheduleEnd::Never, Some(DEC1), 0, DEC1 + 1, DEC1 + 40 * D, 10);
        assert_eq!(window.len(), 1); // only 1 Jan
        assert!(occurrences(f, DEC1, ScheduleEnd::Never, None, 0, 0, u64::MAX / 2, 10).is_empty());
    }

    #[test]
    fn validation() {
        assert!(!Frequency::Weekly { weekday: 7 }.is_valid());
        assert!(!Frequency::Monthly { day: 29 }.is_valid());
        assert!(!Frequency::Monthly { day: 0 }.is_valid());
        assert!(!Frequency::EveryNDays { n: 0 }.is_valid());
        assert!(!Frequency::EveryNDays { n: 366 }.is_valid());
        assert!(!ScheduleEnd::AfterCount { count: 0 }.is_valid());
    }
}

#[cfg(test)]
mod shared_vectors {
    //! `docs/frequency-vectors.json` is generated independently (Python `datetime`); the dashboard and the assistant
    //! test against the same file, so all three agree on every date.
    use super::*;

    #[test]
    fn matches_shared_vectors() {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../../docs/frequency-vectors.json")).expect("vectors json");
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() > 100);
        for c in cases {
            let freq: Frequency = serde_json::from_value(c["frequency"].clone()).expect("frequency");
            let start = c["start_at"].as_u64().expect("start_at");
            let t = c["t"].as_u64().expect("t");
            let want = c["first_at_or_after"].as_u64();
            let got = first_at_or_after(freq, start, t);
            assert_eq!(got, want, "first_at_or_after {freq:?} start={start} t={t}");
            if let Some(first) = got {
                assert_eq!(
                    next_after(freq, start, first),
                    c["next_after_first"].as_u64(),
                    "next_after {freq:?} start={start}"
                );
            }
        }
    }
}
