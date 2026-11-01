import type { Schedule } from "./types";

/**
 * Per agent: active schedules whose next date is past the overdue grace and have no open approval yet
 * ("Missed 2 scheduled payments", UI_UPDATES §5.2). Dates that already produced a pending approval show in the banner instead.
 */
export function missedByAgent(schedules: Schedule[], graceMs: number, nowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of schedules) {
    if (s.status !== "Active" || s.next_due_at === null || s.open_payout !== null) continue;
    if (nowMs - Number(s.next_due_at) > graceMs) out.set(s.agent_id, (out.get(s.agent_id) ?? 0) + 1);
  }
  return out;
}
