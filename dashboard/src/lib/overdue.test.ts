import { describe, expect, it } from "vitest";
import { missedByAgent } from "./overdue";
import type { Schedule } from "./types";

const s = (o: Partial<Schedule>): Schedule => ({ id: 1, status: "Active", agent_id: "a", next_due_at: "0", open_payout: null, ...o }) as Schedule;
describe("missedByAgent", () => {
  it("counts active, past-grace, unopened schedules per agent", () => {
    const m = missedByAgent([s({}), s({ id: 2 }), s({ id: 3, agent_id: "b" }), s({ id: 4, status: "Paused" }), s({ id: 5, open_payout: "9" }), s({ id: 6, next_due_at: "999" }), s({ id: 7, next_due_at: null })], 100, 1000);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
    expect(m.size).toBe(2);
  });
});
