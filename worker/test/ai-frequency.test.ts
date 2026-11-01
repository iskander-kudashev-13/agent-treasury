import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  describeFrequency,
  endFromWire,
  firstAtOrAfter,
  frequencyError,
  frequencyFromWire,
  nextAfter,
  occurrences,
} from "../src/ai/frequency.js";
import type { Frequency } from "../src/ai/frequency.js";
import { formatUsdc, parseUsdc } from "../src/ai/money.js";

const D = (y: number, m: number, d: number, h = 0): number => Date.UTC(y, m - 1, d, h);
const VECTORS = new URL("../../docs/frequency-vectors.json", import.meta.url);

describe("shared vectors (docs/frequency-vectors.json)", () => {
  it("exists and every case passes", () => {
    expect(existsSync(VECTORS)).toBe(true);
    const file = JSON.parse(readFileSync(VECTORS, "utf8")) as {
      cases: { frequency: unknown; start_at: number; t: number; first_at_or_after: number | null; next_after_first: number | null }[];
    };
    expect(file.cases.length).toBeGreaterThan(100);
    for (const c of file.cases) {
      const f = frequencyFromWire(c.frequency);
      expect(f, JSON.stringify(c)).not.toBeNull();
      const first = firstAtOrAfter(f as Frequency, c.start_at, c.t);
      expect(first, JSON.stringify(c)).toBe(c.first_at_or_after);
      if (first !== null) expect(nextAfter(f as Frequency, c.start_at, first), JSON.stringify(c)).toBe(c.next_after_first);
    }
  });
});

describe("ADR-0004 §2 rules", () => {
  it("Once: only start_at", () => {
    const f: Frequency = { type: "Once" };
    expect(firstAtOrAfter(f, D(2026, 12, 3, 9), 0)).toBe(D(2026, 12, 3, 9));
    expect(firstAtOrAfter(f, D(2026, 12, 3, 9), D(2026, 12, 3, 9) + 1)).toBeNull();
  });

  it("Weekly: Sunday=0, time of day comes from start_at", () => {
    // 1 Dec 2026 is a Tuesday. Weekly Sunday (0) at 09:00 -> 6 Dec 09:00.
    expect(firstAtOrAfter({ type: "Weekly", weekday: 0 }, D(2026, 12, 1, 9), D(2026, 12, 1, 9))).toBe(D(2026, 12, 6, 9));
    expect(firstAtOrAfter({ type: "Weekly", weekday: 2 }, D(2026, 12, 1, 9), D(2026, 12, 1, 9))).toBe(D(2026, 12, 1, 9));
    expect(firstAtOrAfter({ type: "Weekly", weekday: 2 }, D(2026, 12, 1, 9), D(2026, 12, 1, 10))).toBe(D(2026, 12, 8, 9));
    expect(new Date(D(2026, 12, 6)).getUTCDay()).toBe(0);
  });

  it("Monthly: day 1-28, never earlier than start_at, crosses year end", () => {
    const f: Frequency = { type: "Monthly", day: 1 };
    expect(firstAtOrAfter(f, D(2026, 11, 15), D(2026, 11, 15))).toBe(D(2026, 12, 1));
    expect(nextAfter(f, D(2026, 11, 15), D(2026, 12, 1))).toBe(D(2027, 1, 1));
    expect(firstAtOrAfter({ type: "Monthly", day: 28 }, D(2027, 2, 1), D(2027, 2, 1))).toBe(D(2027, 2, 28));
  });

  it("EveryNDays steps from start_at", () => {
    const f: Frequency = { type: "EveryNDays", n: 14 };
    expect(firstAtOrAfter(f, D(2026, 12, 1, 8), D(2026, 12, 2))).toBe(D(2026, 12, 15, 8));
    expect(nextAfter(f, D(2026, 12, 1, 8), D(2026, 12, 15, 8))).toBe(D(2026, 12, 29, 8));
  });

  it("occurrences honours AfterCount (total), paid_count and On (inclusive)", () => {
    const f: Frequency = { type: "Monthly", day: 1 };
    const start = D(2026, 12, 1);
    const far = D(2030, 1, 1);
    expect(occurrences(f, start, { type: "Never" }, 0, start, far, 3)).toEqual([D(2026, 12, 1), D(2027, 1, 1), D(2027, 2, 1)]);
    expect(occurrences(f, start, { type: "AfterCount", count: 3 }, 1, start, far, 10)).toEqual([D(2027, 1, 1), D(2027, 2, 1)]);
    expect(occurrences(f, start, { type: "On", at: D(2027, 1, 1) }, 0, start, far, 10)).toEqual([D(2026, 12, 1), D(2027, 1, 1)]);
    expect(occurrences({ type: "Once" }, start, { type: "Never" }, 0, start, far, 10)).toEqual([start]);
  });

  it("validates parameters", () => {
    expect(frequencyError({ type: "Monthly", day: 29 }, { type: "Never" })).toMatch(/1 to 28/);
    expect(frequencyError({ type: "Weekly", weekday: 7 }, { type: "Never" })).toMatch(/0 \(Sunday\)/);
    expect(frequencyError({ type: "EveryNDays", n: 366 }, { type: "Never" })).toMatch(/365/);
    expect(frequencyError({ type: "Once" }, { type: "AfterCount", count: 0 })).toMatch(/at least 1/);
    expect(frequencyError({ type: "Monthly", day: 28 }, { type: "Never" })).toBeNull();
  });

  it("describeFrequency uses the UI wording", () => {
    expect(describeFrequency({ type: "Monthly", day: 1 })).toBe("Monthly on the 1st");
    expect(describeFrequency({ type: "Monthly", day: 22 })).toBe("Monthly on the 22nd");
    expect(describeFrequency({ type: "Monthly", day: 11 })).toBe("Monthly on the 11th");
    expect(describeFrequency({ type: "Weekly", weekday: 1 })).toBe("Every Monday");
    expect(describeFrequency({ type: "EveryNDays", n: 14 })).toBe("Every 14 days");
    expect(describeFrequency({ type: "Once" }, D(2026, 12, 3))).toBe("Once on 3 Dec");
  });

  it("wire decoding of end", () => {
    expect(endFromWire("Never")).toEqual({ type: "Never" });
    expect(endFromWire({ AfterCount: { count: 6 } })).toEqual({ type: "AfterCount", count: 6 });
    expect(endFromWire({ On: { at: "1796117400000" } })).toEqual({ type: "On", at: 1796117400000 });
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe("USDC money helpers (bigint, 6 decimals)", () => {
  it("parses and formats exactly", () => {
    expect(parseUsdc("1500")).toBe(1_500_000_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("1,500")).toBeNull();
    expect(parseUsdc("1e3")).toBeNull();
    expect(parseUsdc("-1")).toBeNull();
    expect(parseUsdc("1.0000001")).toBeNull();
    expect(formatUsdc(1_500_000_000n)).toBe("1500");
    expect(formatUsdc(12_500_000n)).toBe("12.5");
    expect(formatUsdc(1n)).toBe("0.000001");
  });
});
