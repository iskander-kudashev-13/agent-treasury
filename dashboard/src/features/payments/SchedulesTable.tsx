import { useT } from "@/i18n";
import type { PaymentMode } from "@/lib/scheduleForm";
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
  onNew: (mode: PaymentMode) => void;
  onAsk?: (() => void) | undefined;
}

/** One row per schedule (UI_UPDATES §4.1). Labels and agent names are untrusted: plain text only. */
export function SchedulesTable({ schedules, recipients, agents, now, overdueGraceMs, filters, onFilters, onEdit, onNew, onAsk }: SchedulesTableProps) {
  const t = useT();
  const { send, busy, canAct } = useOwnerTx();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const recipientOf = new Map(recipients.map((r) => [r.id, r]));
  const agentOf = new Map(agents.map((a) => [a.id, a]));

  const all = schedules.map((schedule) => ({ schedule, chain: recipientOf.get(schedule.recipient_id)?.destination_chain ?? "" }));
  const chains = [...new Set(all.map((r) => r.chain).filter(Boolean))].sort();
  const rows = sortByNextPayment(filterSchedules(all, filters));
  const filtered = filters.type !== "" || filters.agent !== "" || filters.status !== "" || filters.chain !== "" || filters.recipient !== null;

  const run = (calls: PlannedCall[], label: string) => void send(calls, label);
  const dis = !canAct || busy;

  if (schedules.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          title={t("sched.noPayments")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" disabled={!canAct} onClick={() => onNew("once")}>
                {t("page.payOnce")}
              </Button>
              <Button disabled={!canAct} onClick={() => onNew("recurring")}>
                {t("page.addRecurring")}
              </Button>
              {onAsk && (
                <Button variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={onAsk}>
                  {t("page.askAssistant")}
                </Button>
              )}
            </div>
          }
        >
          {t("sched.noPaymentsHint")}
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card padding="none">
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t("sched.type")}
          <Select className="h-9 w-36" value={filters.type} onChange={(e) => onFilters({ ...filters, type: e.target.value as ScheduleFilters["type"] })} aria-label={t("sched.filterType")}>
            <option value="">{t("sched.allTypes")}</option>
            <option value="once">{t("sched.oneTime")}</option>
            <option value="recurring">{t("sched.recurring")}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t("sched.agent")}
          <Select className="h-9 w-44" value={filters.agent} onChange={(e) => onFilters({ ...filters, agent: e.target.value })} aria-label={t("sched.filterAgent")}>
            <option value="">{t("sched.allAgents")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t("sched.status")}
          <Select className="h-9 w-36" value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value as ScheduleStatus | "" })} aria-label={t("sched.filterStatus")}>
            <option value="">{t("sched.allStatuses")}</option>
            <option value="Active">{t("pill.active")}</option>
            <option value="Paused">{t("pill.paused")}</option>
            <option value="Ended">{t("pill.ended")}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t("sched.chain")}
          <Select className="h-9 w-36" value={filters.chain} onChange={(e) => onFilters({ ...filters, chain: e.target.value })} aria-label={t("sched.filterChain")}>
            <option value="">{t("sched.allChains")}</option>
            {chains.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
        {filters.recipient !== null && (
          <span className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong px-3 text-[13px]">
            {t("sched.recipientFilter", { name: recipientOf.get(filters.recipient)?.label ?? `#${filters.recipient}` })}
            <button type="button" aria-label={t("sched.clearRecipient")} className="cursor-pointer border-0 bg-transparent p-0 text-ink-muted hover:text-ink" onClick={() => onFilters({ ...filters, recipient: null })}>
              <Icons.X size={14} />
            </button>
          </span>
        )}
        <span className="grow" />
        <span className="pb-2 text-xs text-ink-subtle">{t("sched.sorted")}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={t("sched.noMatch")}
          action={
            filtered ? (
              <Button size="sm" onClick={() => onFilters(NO_FILTERS)}>
                {t("page.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("sched.colRecipient")}</Th>
              <Th align="right">{t("sched.colAmount")}</Th>
              <Th>{t("sched.colFrequency")}</Th>
              <Th>{t("sched.colNext")}</Th>
              <Th>{t("sched.colPaidBy")}</Th>
              <Th>{t("sched.colProgress")}</Th>
              <Th>{t("sched.colStatus")}</Th>
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
                      <span>{r?.label ?? t("sched.removedRecipient", { id: s.recipient_id })}</span>
                      {r && <ChainBadge chain={r.destination_chain} />}
                    </div>
                  </Td>
                  <Td align="right" mono>
                    {usdcGrouped(s.amount, 0)} <span className="font-sans text-xs text-ink-muted">USDC</span>
                  </Td>
                  <Td>{describeFrequency(s.frequency, s.start_at)}</Td>
                  <Td>
                    {next === null ? (
                      <span className="text-ink-subtle">{s.status === "Ended" ? "—" : t("sched.noneLeft")}</span>
                    ) : (
                      <div className="flex flex-col">
                        <span className="mono">{fmtDate(next, now)}</span>
                        {late !== null ? (
                          <span className="text-xs text-warn">
                            {t("sched.overdue", { count: late })}
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
                        {t("sched.edit")}
                      </Button>
                    )}
                    {s.status === "Active" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => run([{ method: "pause_schedule", args: { schedule_id: s.id } }], t("sched.pauseLbl"))}>
                        {t("sched.pause")}
                      </Button>
                    )}
                    {s.status === "Paused" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => run([{ method: "resume_schedule", args: { schedule_id: s.id } }], t("sched.resumeLbl"))}>
                        {t("sched.resume")}
                      </Button>
                    )}
                    {s.status !== "Ended" && (
                      <Button size="sm" variant="ghost" disabled={dis} onClick={() => setConfirm({ kind: "end", schedule: s })}>
                        {t("sched.end")}
                      </Button>
                    )}
                    {s.status === "Ended" && (
                      <Button size="sm" variant="ghost" disabled={dis || s.open_payout !== null} title={s.open_payout !== null ? t("sched.openPayout") : undefined} onClick={() => setConfirm({ kind: "remove", schedule: s })}>
                        {t("sched.remove")}
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
        title={confirm?.kind === "end" ? t("sched.endTitle") : t("sched.removeTitle")}
        footer={
          <>
            {busy && <SigningHint />}
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger-fill"
              loading={busy}
              disabled={!canAct}
              onClick={() => {
                if (!confirm) return;
                const id = confirm.schedule.id;
                void send([confirm.kind === "end" ? { method: "end_schedule", args: { schedule_id: id } } : { method: "remove_schedule", args: { schedule_id: id } }], confirm.kind === "end" ? t("sched.endLbl") : t("sched.removeLbl")).then((r) => r.ok && setConfirm(null));
              }}
            >
              {confirm?.kind === "end" ? t("sched.endBtn") : t("sched.remove")}
            </Button>
          </>
        }
      >
        {confirm?.kind === "end" ? (
          <p className="m-0">
            {t("sched.endBody", { who: recipientOf.get(confirm.schedule.recipient_id)?.label ?? t("sched.recipientN", { id: confirm.schedule.recipient_id }), amount: usdcGrouped(confirm.schedule.amount, 0), freq: describeFrequency(confirm.schedule.frequency, confirm.schedule.start_at) })}
          </p>
        ) : (
          <p className="m-0">{t("sched.removeBody")}</p>
        )}
      </Modal>
    </Card>
  );
}
