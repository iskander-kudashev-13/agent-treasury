/** View-model helpers for the Scheduled tab: overdue detection, progress text, filters and sort. Pure. */
import { DAY_MS } from "./frequency";
import type { Schedule, ScheduleStatus } from "./types";

/** Next payment time (ms) of a live schedule; null for Ended or when nothing is left. */
export function nextPaymentAt(s: Pick<Schedule, "status" | "next_due_at">): number | null {
  return s.status === "Ended" || s.next_due_at === null ? null : Number(s.next_due_at);
}

/** Past the grace period: the contract will not auto-pay it any more, the owner has to approve. Active schedules only. */
export function overdueDays(s: Pick<Schedule, "status" | "next_due_at">, now: number, graceMs: number): number | null {
  const due = nextPaymentAt(s);
  if (s.status !== "Active" || due === null || now - due <= graceMs) return null;
  return Math.max(1, Math.floor((now - due) / DAY_MS));
}

export function progressText(s: Pick<Schedule, "paid_count" | "end">): string {
  if (typeof s.end === "object" && "AfterCount" in s.end) return `${s.paid_count} of ${s.end.AfterCount.count} paid`;
  return s.paid_count === 1 ? "Paid once" : `Paid ${s.paid_count} times`;
}

export interface ScheduleFilters {
  /** "" = all, "once" = one-time payments, "recurring" = everything else. */
  type: "" | "once" | "recurring";
  agent: string;
  status: ScheduleStatus | "";
  chain: string;
  recipient: number | null;
}
export const NO_FILTERS: ScheduleFilters = { type: "", agent: "", status: "", chain: "", recipient: null };

export function filterSchedules<T extends { schedule: Schedule; chain: string }>(rows: T[], f: ScheduleFilters): T[] {
  return rows.filter(
    (r) =>
      (!f.type || (r.schedule.frequency === "Once") === (f.type === "once")) &&
      (!f.agent || r.schedule.agent_id === f.agent) &&
      (!f.status || r.schedule.status === f.status) &&
      (!f.chain || r.chain === f.chain) &&
      (f.recipient === null || r.schedule.recipient_id === f.recipient),
  );
}

const RANK: Record<ScheduleStatus, number> = { Active: 0, Paused: 1, Ended: 2 };

/** Sort by next payment ascending; paused after active, ended last; ties by id. */
export function sortByNextPayment<T extends { schedule: Schedule }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ra = RANK[a.schedule.status] - RANK[b.schedule.status];
    if (ra !== 0) return ra;
    const na = nextPaymentAt(a.schedule);
    const nb = nextPaymentAt(b.schedule);
    if (na !== nb) return na === null ? 1 : nb === null ? -1 : na - nb;
    return a.schedule.id - b.schedule.id;
  });
}
