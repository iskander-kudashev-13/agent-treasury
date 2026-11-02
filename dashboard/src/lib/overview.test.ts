import { describe, expect, it } from "vitest";
import { dailyPaidOut, paymentsToday } from "./overview";
import type { Payout } from "./types";

const DAY = 86_400_000;
const NOW = 10 * DAY + 5000;
const p = (amount: string, ageDays: number, status = "Confirmed") => ({ amount, status, created_at_ms: String(NOW - ageDays * DAY) }) as unknown as Payout;

describe("dailyPaidOut", () => {
  it("buckets by UTC day, oldest first, ignores failed and out-of-range", () => {
    const r = dailyPaidOut([p("2000000", 0), p("1000000", 0, "Sent"), p("5000000", 2), p("9000000", 1, "Failed"), p("7000000", 9)], 3, NOW);
    expect(r.values).toEqual([5, 0, 3]);
    expect(r.total).toBe(8000000n);
  });
  it("counts today's payments", () => {
    expect(paymentsToday([p("1", 0), p("1", 0, "Failed"), p("1", 1)], NOW)).toBe(2);
  });
});
