import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFrequency, firstAtOrAfter, nextAfter, nextOccurrences, ordinal } from "./frequency";
import type { Frequency } from "./types";

interface Vector {
  frequency: Frequency;
  start_at: number;
  t: number;
  first_at_or_after: number | null;
  next_after_first: number | null;
}
const vectors = JSON.parse(readFileSync(resolve(__dirname, "../../../docs/frequency-vectors.json"), "utf8")) as { cases: Vector[] };

describe("shared vectors (docs/frequency-vectors.json)", () => {
  it("has the expected number of cases", () => expect(vectors.cases.length).toBe(240));
  it("matches every case", () => {
    for (const c of vectors.cases) {
      const first = firstAtOrAfter(c.frequency, c.start_at, c.t);
      expect(first, JSON.stringify(c)).toBe(c.first_at_or_after);
      const next = first === null ? null : nextAfter(c.frequency, c.start_at, first);
      expect(next, JSON.stringify(c)).toBe(c.next_after_first);
    }
  });
});

const DEC1 = 1_796_117_400_000; // 2026-12-01T09:30Z

describe("nextOccurrences", () => {
  it("previews monthly dates", () => {
    const dates = nextOccurrences({ frequency: { Monthly: { day: 1 } }, start_at: DEC1, end: "Never" });
    expect(dates.map((d) => new Date(d).toISOString())).toEqual(["2026-12-01T09:30:00.000Z", "2027-01-01T09:30:00.000Z", "2027-02-01T09:30:00.000Z"]);
  });
  it("honors AfterCount with paid_count and next_due_at", () => {
    const s = { frequency: { EveryNDays: { n: 14 } } as Frequency, start_at: DEC1, end: { AfterCount: { count: 3 } } as const };
    expect(nextOccurrences(s, 5)).toHaveLength(3);
    expect(nextOccurrences({ ...s, paid_count: 2, next_due_at: DEC1 + 28 * 86_400_000 }, 5)).toEqual([DEC1 + 28 * 86_400_000]);
    expect(nextOccurrences({ ...s, paid_count: 3, next_due_at: null })).toEqual([]);
  });
  it("honors On end and Once", () => {
    expect(nextOccurrences({ frequency: "Once", start_at: DEC1, end: "Never" })).toEqual([DEC1]);
    const s = { frequency: { EveryNDays: { n: 1 } } as Frequency, start_at: DEC1, end: { On: { at: String(DEC1 + 86_400_000) } } as const };
    expect(nextOccurrences(s, 10)).toEqual([DEC1, DEC1 + 86_400_000]);
  });
});

describe("describeFrequency", () => {
  it("matches the UI copy", () => {
    expect(describeFrequency({ Monthly: { day: 1 } }, DEC1)).toBe("Monthly on the 1st");
    expect(describeFrequency({ Monthly: { day: 22 } }, DEC1)).toBe("Monthly on the 22nd");
    expect(describeFrequency({ Weekly: { weekday: 1 } }, DEC1)).toBe("Every Monday");
    expect(describeFrequency({ Weekly: { weekday: 0 } }, DEC1)).toBe("Every Sunday");
    expect(describeFrequency({ EveryNDays: { n: 14 } }, DEC1)).toBe("Every 14 days");
    expect(describeFrequency("Once", DEC1 + 2 * 86_400_000)).toBe("Once on 3 Dec");
  });
  it("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 28].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "28th"]);
  });
});
