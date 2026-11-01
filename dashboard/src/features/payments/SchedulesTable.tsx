import { useState } from "react";
import { Avatar, Button, Card, ChainBadge, EmptyState, Modal, Select, StatusPill, Table, Td, Th, Tr, SigningHint, Icons } from "@/kit";
import { describeFrequency, shortDate } from "@/lib/frequency";
import { usdcGrouped } from "@/lib/amount";
import type { PlannedCall } from "@/lib/calls";
import { relativeTime } from "@/lib/relativeTime";
import { filterSchedules, nextPaymentAt, NO_FILTERS, overdueDays, progressText, sortByNextPayment, type ScheduleFilters } from "@/lib/schedulesView";
import type { AgentView, RecipientView, Schedule, ScheduleStatus } from "@/lib/types";
import { useOwnerTx } from "./useOwnerTx";

const STATE = { Active: "active", Paused: "paused", Ended: "ended" } as const;

function fmtDate(ms: number, now: number): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date(now).getUTCFullYear();
  return sameYear ? shortDate(ms) : `${shortDate(ms)} ${new Date(ms).getUTCFullYear()}`;
}

type Confirm = { kind: "end" | "remove"; schedule: Schedule } | null;

export interface SchedulesTableProps {
  schedules: Schedule[];
  recipients: RecipientView[];
  agents: AgentView[];
  now: number;
  overdueGraceMs: number;
  filters: ScheduleFilters;
  onFilters: (f: ScheduleFilters) => void;
  onEdit: (s: Schedule) => void;
  onNew: () => void;
  onAsk?: (() => void) | undefined;
}

/** One row per schedule (UI_UPDATES §4.1). Labels and agent names are untrusted: plain text only. */
export function SchedulesTable({ schedules, recipients, agents, now, overdueGraceMs, filters, onFilters, onEdit, onNew, onAsk }: SchedulesTableProps) {
  const { send, busy, canAct } = useOwnerTx();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const recipientOf = new Map(recipients.map((r) => [r.id, r]));
  const agentOf = new Map(agents.map((a) => [a.id, a]));

  const all = schedules.map((schedule) => ({ schedule, chain: recipientOf.get(schedule.recipient_id)?.destination_chain ?? "" }));
  const chains = [...new Set(all.map((r) => r.chain).filter(Boolean))].sort();
  const rows = sortByNextPayment(filterSchedules(all, filters));
  const filtered = filters.agent !== "" || filters.status !== "" || filters.chain !== "" || filters.recipient !== null;

  const run = (calls: PlannedCall[], label: string) => void send(calls, label);
  const dis = !canAct || busy;

  if (schedules.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          title="No scheduled payments yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" disabled={!canAct} onClick={onNew}>
                + Scheduled payment
              </Button>
              {onAsk && (
                <Button variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={onAsk}>
                  Ask assistant
                </Button>
              )}
            </div>
          }
        >
          Set up salaries, subscriptions or regular supplier payments — the assigned agent will pay them on time.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card padding="none">
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Agent
          <Select className="h-9 w-44" value={filters.agent} onChange={(e) => onFilters({ ...filters, agent: e.target.value })} aria-label="Filter by agent">
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Status
          <Select className="h-9 w-36" value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value as ScheduleStatus | "" })} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="Active">Active</option>
            <option value="Paused">Paused</option>
            <option value="Ended">Ended</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Chain
          <Select className="h-9 w-36" value={filters.chain} onChange={(e) => onFilters({ ...filters, chain: e.target.value })} aria-label="Filter by chain">
            <option value="">All chains</option>
            {chains.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
        {filters.recipient !== null && (
          <span className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong px-3 text-[13px]">
            Recipient: {recipientOf.get(filters.recipient)?.label ?? `#${filters.recipient}`}
            <button type="button" aria-label="Clear recipient filter" className="cursor-pointer border-0 bg-transparent p-0 text-ink-muted hover:text-ink" onClick={() => onFilters({ ...filters, recipient: null })}>
              <Icons.X size={14} />
            </button>
          </span>
        )}
        <span className="grow" />
        <span className="pb-2 text-xs text-ink-subtle">Sorted by next payment</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No scheduled payments match these filters"
          action={
            filtered ? (
              <Button size="sm" onClick={() => onFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Recipient</Th>
              <Th align="right">Amount</Th>
              <Th>Frequency</Th>
              <Th>Next payment</Th>
              <Th>Paid by</Th>
              <Th>Progress</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ schedule: s }) => {
              const r = recipientOf.get(s.recipient_id);
              const agent = agentOf.get(s.agent_id);
              const next = nextPaymentAt(s);
              const late = overdueDays(s, now, overdueGraceMs);
              return (
                <Tr key={s.id}>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <span>{r?.label ?? `Recipient #${s.recipient_id} (removed)`}</span>
                      {r && <ChainBadge chain={r.destination_chain} />}
                    </div>
                  </Td>
                  <Td align="right" mono>
                    {usdcGrouped(s.amount, 0)} <span className="font-sans text-xs text-ink-muted">USDC</span>
                  </Td>
                  <Td>{describeFrequency(s.frequency, s.start_at)}</Td>
                  <Td>
                    {next === null ? (
                      <span className="text-ink-subtle">{s.status === "Ended" ? "—" : "none left"}</span>
                    ) : (
                      <div className="flex flex-col">
                        <span className="mono">{fmtDate(next, now)}</span>
                        {late !== null ? (
                          <span className="text-xs text-warn">
                            Overdue {late} {late === 1 ? "day" : "days"} — needs approval
                          </span>
                        ) : (
                          <span className="text-xs text-ink-muted">{relativeTime(next, now)}</span>
                        )}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <Avatar name={agent?.name ?? s.agent_id} size={22} />
                      {agent?.name ?? s.agent_id}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-ink-secondary">{progressText(s)}</Td>
                  <Td>
                    <StatusPill state={STATE[s.status]} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {s.status !== "Ended" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => onEdit(s)}>
                        Edit
                      </Button>
                    )}
                    {s.status === "Active" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => run([{ method: "pause_schedule", args: { schedule_id: s.id } }], "Pause")}>
                        Pause
                      </Button>
                    )}
                    {s.status === "Paused" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => run([{ method: "resume_schedule", args: { schedule_id: s.id } }], "Resume")}>
                        Resume
                      </Button>
                    )}
                    {s.status !== "Ended" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => setConfirm({ kind: "end", schedule: s })}>
                        End
                      </Button>
                    )}
                    {s.status === "Ended" && (
                      <Button size="sm" variant="ghost" disabled={dis || s.open_payout !== null} title={s.open_payout !== null ? "A payment of this schedule is still open" : undefined} onClick={() => setConfirm({ kind: "remove", schedule: s })}>
                        Remove
                      </Button>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <Modal
        open={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        danger
        title={confirm?.kind === "end" ? "End this scheduled payment?" : "Remove this ended schedule?"}
        footer={
          <>
            {busy && <SigningHint />}
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger-fill"
              loading={busy}
              disabled={!canAct}
              onClick={() => {
                if (!confirm) return;
                const id = confirm.schedule.id;
                void send([confirm.kind === "end" ? { method: "end_schedule", args: { schedule_id: id } } : { method: "remove_schedule", args: { schedule_id: id } }], confirm.kind === "end" ? "End schedule" : "Remove schedule").then((r) => r.ok && setConfirm(null));
              }}
            >
              {confirm?.kind === "end" ? "End schedule" : "Remove"}
            </Button>
          </>
        }
      >
        {confirm?.kind === "end" ? (
          <p className="m-0">
            {recipientOf.get(confirm.schedule.recipient_id)?.label ?? `Recipient #${confirm.schedule.recipient_id}`}: {usdcGrouped(confirm.schedule.amount, 0)} USDC, {describeFrequency(confirm.schedule.frequency, confirm.schedule.start_at)}. No more payments will be made and this cannot be undone. Use Pause to stop temporarily. Requires 1 yoctoNEAR.
          </p>
        ) : (
          <p className="m-0">The schedule is deleted from the vault. Its payment history stays in Payouts.</p>
        )}
      </Modal>
    </Card>
  );
}
