import { describe, expect, it } from "vitest";
import { filterSchedules, nextPaymentAt, NO_FILTERS, overdueDays, progressText, sortByNextPayment } from "./schedulesView";
import type { Schedule } from "./types";

const mk = (id: number, over: Partial<Schedule> = {}): Schedule => ({
  id, recipient_id: 1, amount: "1", frequency: "Once", start_at: "0", end: "Never", agent_id: "a", status: "Active",
  last_paid_at: null, last_occurrence_paid: null, paid_count: 0, created_at: "0", next_due_at: "1000", open_payout: null, failed_attempts: 0, ...over,
});
const DAY = 86_400_000;

describe("schedulesView", () => {
  it("overdue only past grace, active only", () => {
    const s = mk(1, { next_due_at: String(10 * DAY) });
    expect(overdueDays(s, 12 * DAY, 3 * DAY)).toBeNull();
    expect(overdueDays(s, 15 * DAY + 1, 3 * DAY)).toBe(5);
    expect(overdueDays({ ...s, status: "Paused" }, 20 * DAY, 3 * DAY)).toBeNull();
    expect(nextPaymentAt(mk(2, { status: "Ended" }))).toBeNull();
  });
  it("progress text", () => {
    expect(progressText({ paid_count: 3, end: { AfterCount: { count: 6 } } })).toBe("3 of 6 paid");
    expect(progressText({ paid_count: 3, end: "Never" })).toBe("Paid 3 times");
    expect(progressText({ paid_count: 1, end: "Never" })).toBe("Paid once");
  });
  it("sorts by next payment, ended last", () => {
    const rows = [mk(1, { next_due_at: "300" }), mk(2, { status: "Ended", next_due_at: null }), mk(3, { next_due_at: "100" }), mk(4, { status: "Paused", next_due_at: "50" })].map((schedule) => ({ schedule, chain: "base" }));
    expect(sortByNextPayment(rows).map((r) => r.schedule.id)).toEqual([3, 1, 4, 2]);
  });
  it("filters", () => {
    const rows = [mk(1), mk(2, { agent_id: "b", recipient_id: 2 })].map((schedule, i) => ({ schedule, chain: i ? "sol" : "base" }));
    expect(filterSchedules(rows, { ...NO_FILTERS, agent: "b" }).map((r) => r.schedule.id)).toEqual([2]);
    expect(filterSchedules(rows, { ...NO_FILTERS, chain: "base" }).map((r) => r.schedule.id)).toEqual([1]);
    expect(filterSchedules(rows, { ...NO_FILTERS, recipient: 2 })).toHaveLength(1);
    expect(filterSchedules(rows, NO_FILTERS)).toHaveLength(2);
  });
});
