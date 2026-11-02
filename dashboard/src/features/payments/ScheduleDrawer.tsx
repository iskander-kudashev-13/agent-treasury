import { useState } from "react";
import { Button, chainName, Drawer, Field, IconButton, Icons, Input, Select, shortId, SigningHint } from "@/kit";
import { usdcGrouped } from "@/lib/amount";
import { shortDate } from "@/lib/frequency";
import type { PlannedCall } from "@/lib/calls";
import {
  buildScheduleInput,
  effectiveCompat,
  emptyScheduleForm,
  localDateInput,
  localTimeInput,
  mandateWithRecipient,
  NOW_LEAD_MS,
  monthlyEquivalent,
  planScheduleSave,
  recipientMissingFromMandate,
  parseLocal,
  scheduleToForm,
  utcDayShift,
  utcOffsetLabel,
  WHEN_PRESETS,
  type MandateTarget,
  type PaymentMode,
  type ScheduleFormState,
} from "@/lib/scheduleForm";
import type { Schedule } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { useAgents, useContractInfo, usePolicy, useRecipients } from "@/lib/useVault";
import { FrequencyControl } from "./FrequencyControl";
import { MandateCompatibility } from "./MandateCompatibility";
import { NextPaymentsPreview } from "./NextPaymentsPreview";
import { RecipientFields, useRecipientDraft } from "./RecipientFields";
import { useOwnerTx } from "./useOwnerTx";

/** A recipient that exists only inside the assistant's unsigned batch. */
export interface PendingRecipient {
  id: number;
  label: string;
  chain: string;
  address: string;
}

export interface ScheduleDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Edit this schedule (update_schedule); otherwise add_schedule. */
  schedule?: Schedule | undefined;
  /** "once" (Pay once) or "recurring". Defaults from the schedule being edited or the prefill. */
  mode?: PaymentMode | undefined;
  /** Initial values (assistant "Edit in form"). */
  prefill?: Partial<ScheduleFormState> | undefined;
  pendingRecipients?: PendingRecipient[] | undefined;
  /** Assistant mode: hand the calls back instead of signing; the card is replaced. `newRecipientId` is set when the calls create one. */
  onPlan?: ((calls: PlannedCall[], info: { newRecipientId: number | null }) => void) | undefined;
}

export function ScheduleDrawer(props: ScheduleDrawerProps) {
  if (!props.open) return null;
  return <Inner {...props} />;
}

/** Wall-clock time of a user action (event handlers only, never during render). */
const clickTime = (): number => Date.now();

function modeOf(p: ScheduleDrawerProps): PaymentMode {
  if (p.schedule) return p.schedule.frequency === "Once" ? "once" : "recurring";
  if (p.prefill?.freq) return p.prefill.freq === "Once" ? "once" : "recurring";
  return p.mode ?? "recurring";
}

function Inner(props: ScheduleDrawerProps) {
  const { onClose, schedule, prefill, pendingRecipients = [], onPlan } = props;
  const mode = modeOf(props);
  const once = mode === "once";
  const [now] = useState(() => Date.now());
  const liveNow = useNow(15_000);
  const { data: recipients } = useRecipients();
  const { data: agents } = useAgents();
  const { data: policy } = usePolicy();
  const { data: info } = useContractInfo();
  const { send, busy, canAct } = useOwnerTx();
  const [form, setForm] = useState<ScheduleFormState>(() => {
    const init = { ...(schedule ? scheduleToForm(schedule, now) : emptyScheduleForm(now)), ...prefill };
    // An assistant prefill carries an exact start: keep it instead of "now".
    if (prefill?.startDate) init.when = "later";
    if (once) init.freq = "Once";
    else if (init.freq === "Once") init.freq = "Monthly";
    return init;
  });
  const patch = (p: Partial<ScheduleFormState>) => setForm((f) => ({ ...f, ...p }));

  const payers = agents.filter((a) => a.status !== "Revoked");
  const agentId = form.agentId || (payers.length === 1 ? (payers[0]?.id ?? "") : "");
  const f: ScheduleFormState = { ...form, agentId };
  const agent = agents.find((a) => a.id === agentId);

  const isNew = f.recipientId === "new";
  // In assistant mode the batch may already create recipients; a new one comes after them.
  const nextRecipientId = info ? info.next_recipient_id + (onPlan ? pendingRecipients.length : 0) : null;
  const newDraft = useRecipientDraft(f.newRecipient, recipients);
  const existing = !isNew && f.recipientId !== "" ? recipients.find((r) => String(r.id) === f.recipientId) : undefined;
  const pending = !isNew && !existing && f.recipientId !== "" ? pendingRecipients.find((r) => String(r.id) === f.recipientId) : undefined;

  const target: MandateTarget | null = existing
    ? { id: existing.id, chain: existing.destination_chain, address: existing.destination_address, label: existing.label }
    : pending
      ? { id: pending.id, chain: pending.chain, address: pending.address, label: pending.label }
      : isNew && nextRecipientId !== null && newDraft.check.address
        ? { id: nextRecipientId, chain: f.newRecipient.chain, address: newDraft.check.address, label: f.newRecipient.label.trim() }
        : null;

  const built = buildScheduleInput(f, { now, recipientId: target?.id ?? null, editing: schedule !== undefined });
  const amountRaw = built.input?.amount ?? "0";
  const missing = target !== null && recipientMissingFromMandate(agent, target);
  const addToMandate = f.addToMandate && missing;
  const compat = target && agent ? effectiveCompat({ agent, rec: target, amount: amountRaw, minPayment: policy?.min_payment ?? "0", addToMandate }) : { errors: [], warnings: [] };
  // "Not in mandate" is offered as a fix below; the red line stays only until the box is ticked.
  const monthly = built.input && built.input.frequency !== "Once" ? monthlyEquivalent(built.input.amount, built.input.frequency) : null;

  const show = (k: string): string | undefined => (built.empty.includes(k) ? undefined : built.errors[k]);
  const recipientReady = !isNew || (newDraft.input !== null && nextRecipientId !== null);
  const canSave = built.input !== null && target !== null && recipientReady && compat.errors.length === 0 && (onPlan !== undefined || canAct) && !busy;

  const calls = (input: NonNullable<typeof built.input>): PlannedCall[] =>
    !target
      ? []
      : planScheduleSave({
          scheduleId: schedule?.id ?? null,
          input,
          ...(isNew && newDraft.input ? { newRecipient: newDraft.input } : {}),
          ...(addToMandate && agent ? { mandateUpdate: { agentId: agent.id, mandate: mandateWithRecipient(agent.mandate, target) } } : {}),
        });

  const save = async () => {
    // "Now" is fixed at the click, not when the drawer opened.
    const fresh = buildScheduleInput(f, { now: clickTime(), recipientId: target?.id ?? null, editing: schedule !== undefined });
    const c = fresh.input && target ? calls(fresh.input) : [];
    if (c.length === 0) return;
    if (onPlan) {
      onPlan(c, { newRecipientId: isNew ? (target?.id ?? null) : null });
      onClose();
      return;
    }
    const r = await send(c, schedule ? "Payment update" : c.length > 1 ? `${c.length} changes` : once ? "One-time payment" : "Recurring payment");
    if (r.ok) onClose();
  };

  const lastHandled = schedule ? Math.max(Number(schedule.last_occurrence_paid ?? 0), Number(schedule.last_paid_at ?? 0)) : 0;

  return (
    <Drawer
      open
      onClose={onClose}
      title={schedule ? `Edit ${once ? "one-time" : "recurring"} payment #${schedule.id}` : once ? "Pay once" : "New recurring payment"}
      subtitle={once ? "The agent pays it once, now or at the time you pick." : "The agent pays it on every date of the schedule."}
      width={520}
      footer={
        <>
          {busy && <SigningHint />}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSave} loading={busy} onClick={() => void save()}>
            {onPlan ? "Use these values" : once && !schedule ? "Create & sign" : "Save & sign"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-end gap-2">
          <Field label="Recipient" error={show("recipient")} className="flex-1">
            {(a) => (
              <Select {...a} value={f.recipientId} disabled={busy} onChange={(e) => patch({ recipientId: e.target.value, addToMandate: false })}>
                <option value="">Select recipient…</option>
                {recipients.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.label} — {chainName(r.destination_chain)}, {shortId(r.destination_address)}
                  </option>
                ))}
                {pendingRecipients.map((r) => (
                  <option key={`p${r.id}`} value={String(r.id)}>
                    {r.label} — {chainName(r.chain)}, {shortId(r.address)} (new, in your batch)
                  </option>
                ))}
                {isNew && <option value="new">New recipient…</option>}
              </Select>
            )}
          </Field>
          <IconButton label="New recipient" disabled={busy} onClick={() => patch({ recipientId: "new", addToMandate: false })} className="mb-0.5 border border-line-strong">
            <Icons.Plus size={16} />
          </IconButton>
        </div>

        {isNew && (
          <div className="rounded-tile border border-line bg-surface-sunken p-4">
            <h3 className="m-0 mb-3 text-[13px] font-semibold">New recipient (created in the same transaction)</h3>
            <RecipientFields draft={f.newRecipient} onChange={(p) => patch({ newRecipient: { ...f.newRecipient, ...p } })} draftState={newDraft} disabled={busy} />
          </div>
        )}

        <Field label="Amount" error={show("amount")} hint={monthly !== null ? `≈ ${usdcGrouped(monthly.toString(), 0)} USDC / month` : undefined}>
          {(a) => <Input {...a} mono inputMode="decimal" placeholder="1500" suffix="USDC" value={f.amount} disabled={busy} state={show("amount") ? "error" : "default"} onChange={(e) => patch({ amount: e.target.value })} />}
        </Field>

        {once ? (
          <WhenControl form={f} onChange={patch} error={built.errors.start} disabled={busy} editing={schedule !== undefined} />
        ) : (
          <>
            <FrequencyControl value={f} onChange={patch} errors={built.errors} disabled={busy} />
            <LocalDateTime label="First payment" date={f.startDate} time={f.startTime} error={built.errors.start} disabled={busy} onChange={patch} hint="Every payment is made at this time of day" recurring />
          </>
        )}

        {f.freq !== "Once" && (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 p-0 text-[13px] font-medium text-ink-secondary">Ends</legend>
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="ends" className="accent-[var(--color-ok)]" checked={f.endKind === "Never"} disabled={busy} onChange={() => patch({ endKind: "Never" })} />
              Never
            </label>
            <div className="flex min-h-10 flex-wrap items-center gap-3">
              <label className="flex w-36 cursor-pointer items-center gap-2 text-sm">
                <input type="radio" name="ends" className="accent-[var(--color-ok)]" checked={f.endKind === "AfterCount"} disabled={busy} onChange={() => patch({ endKind: "AfterCount" })} />
                After N payments
              </label>
              {f.endKind === "AfterCount" && (
                <Field label="Payments" error={built.errors.endCount} className="w-44">
                  {(a) => <Input {...a} type="number" inputMode="numeric" min={1} value={f.endCount} disabled={busy} state={built.errors.endCount ? "error" : "default"} onChange={(e) => patch({ endCount: e.target.value })} />}
                </Field>
              )}
            </div>
            <div className="flex min-h-10 flex-wrap items-center gap-3">
              <label className="flex w-36 cursor-pointer items-center gap-2 text-sm">
                <input type="radio" name="ends" className="accent-[var(--color-ok)]" checked={f.endKind === "On"} disabled={busy} onChange={() => patch({ endKind: "On" })} />
                On a date
              </label>
              {f.endKind === "On" && (
                <Field label="Last day" error={built.errors.endDate} className="w-44">
                  {(a) => <Input {...a} type="date" value={f.endDate} disabled={busy} state={built.errors.endDate ? "error" : "default"} onChange={(e) => patch({ endDate: e.target.value })} />}
                </Field>
              )}
            </div>
          </fieldset>
        )}

        <Field label="Paid by" error={show("agent")} hint={payers.length === 0 ? "Create an agent first (Agents)." : undefined}>
          {(a) => (
            <Select {...a} value={agentId} disabled={busy} onChange={(e) => patch({ agentId: e.target.value, addToMandate: false })}>
              <option value="">Select agent…</option>
              {payers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.status === "Paused" ? " (paused)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          {once && f.when === "now" && !schedule ? (
            <p className="m-0 text-[13px] text-ink-secondary">The agent pays it on its first run after {localTimeInput(liveNow + NOW_LEAD_MS)} (2 minutes after you sign).</p>
          ) : (
            <NextPaymentsPreview input={built.input} now={now} paidCount={schedule?.paid_count ?? 0} floor={lastHandled > 0 ? lastHandled + 1 : 0} />
          )}
          <MandateCompatibility agent={agent} compat={compat} offerAddToMandate={missing} addToMandate={addToMandate} onAddToMandate={(v) => patch({ addToMandate: v })} disabled={busy} />
          {!onPlan && !canAct && <p className="m-0 text-xs text-ink-subtle">Connect the vault owner&apos;s wallet to save.</p>}
        </div>
      </div>
    </Drawer>
  );
}

/** "= 11:30 UTC, 3 Nov" under a local date/time, plus the UTC-day caveat for recurring schedules. */
function utcHint(date: string, time: string, recurring: boolean): string | undefined {
  const ms = parseLocal(date, time);
  if (ms === null) return undefined;
  const iso = new Date(ms).toISOString();
  const base = `Your time (${utcOffsetLabel(ms)}) = ${iso.slice(11, 16)} UTC, ${shortDate(ms)}`;
  const shift = recurring ? utcDayShift(ms) : null;
  return shift ? `${base}. Days of the schedule are counted in UTC, so this is ${shift} in UTC.` : base;
}

function LocalDateTime({
  label,
  date,
  time,
  error,
  disabled,
  onChange,
  hint,
  recurring = false,
}: {
  label: string;
  date: string;
  time: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (p: Partial<ScheduleFormState>) => void;
  hint?: string;
  recurring?: boolean;
}) {
  const utc = utcHint(date, time, recurring);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-3">
        <Field label={`${label}: date`} error={error}>
          {(a) => <Input {...a} type="date" value={date} disabled={disabled} state={error ? "error" : "default"} onChange={(e) => onChange({ startDate: e.target.value })} />}
        </Field>
        <Field label="Time" hint={hint}>
          {(a) => <Input {...a} type="time" value={time} disabled={disabled} onChange={(e) => onChange({ startTime: e.target.value })} />}
        </Field>
      </div>
      {utc && <p className="m-0 text-xs text-ink-subtle">{utc}</p>}
    </div>
  );
}

/** One-time payment: "Now" (default) or "Later" with quick picks and an exact local date/time. */
function WhenControl({
  form,
  onChange,
  error,
  disabled,
  editing,
}: {
  form: ScheduleFormState;
  onChange: (p: Partial<ScheduleFormState>) => void;
  error: string | undefined;
  disabled: boolean;
  editing: boolean;
}) {
  const later = editing || form.when === "later";
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium text-ink-secondary">When</legend>
      {!editing && (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name="when" className="accent-[var(--color-ok)]" checked={!later} disabled={disabled} onChange={() => onChange({ when: "now" })} />
          Now <span className="text-xs text-ink-subtle">— on the agent&apos;s next run, within a few minutes</span>
        </label>
      )}
      {!editing && (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name="when" className="accent-[var(--color-ok)]" checked={later} disabled={disabled} onChange={() => onChange({ when: "later" })} />
          Later
        </label>
      )}
      {later && (
        <div className={editing ? "flex flex-col gap-3" : "ml-6 flex flex-col gap-3"}>
          <div className="flex flex-wrap gap-2">
            {WHEN_PRESETS.map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant="ghost"
                className="border border-line-strong"
                disabled={disabled}
                onClick={() => {
                  const at = p.at(Date.now());
                  onChange({ when: "later", startDate: localDateInput(at), startTime: localTimeInput(at) });
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <LocalDateTime label="Pay on" date={form.startDate} time={form.startTime} error={error} disabled={disabled} onChange={onChange} />
        </div>
      )}
      {!later && error && <p className="m-0 text-xs text-danger-text">{error}</p>}
    </fieldset>
  );
}
