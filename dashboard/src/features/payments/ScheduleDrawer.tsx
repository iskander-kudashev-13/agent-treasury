import { useState } from "react";
import { Button, chainName, Drawer, Field, IconButton, Icons, Input, Select, shortId, SigningHint } from "@/kit";
import { usdcGrouped } from "@/lib/amount";
import type { PlannedCall } from "@/lib/calls";
import {
  buildScheduleInput,
  effectiveCompat,
  emptyScheduleForm,
  mandateWithRecipient,
  monthlyEquivalent,
  planScheduleSave,
  recipientMissingFromMandate,
  scheduleToForm,
  type MandateTarget,
  type ScheduleFormState,
} from "@/lib/scheduleForm";
import type { Schedule } from "@/lib/types";
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

function Inner({ onClose, schedule, prefill, pendingRecipients = [], onPlan }: ScheduleDrawerProps) {
  const [now] = useState(() => Date.now());
  const { data: recipients } = useRecipients();
  const { data: agents } = useAgents();
  const { data: policy } = usePolicy();
  const { data: info } = useContractInfo();
  const { send, busy, canAct } = useOwnerTx();
  const [form, setForm] = useState<ScheduleFormState>(() => ({ ...(schedule ? scheduleToForm(schedule, now) : emptyScheduleForm(now)), ...prefill }));
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

  const calls = (): PlannedCall[] =>
    !built.input || !target
      ? []
      : planScheduleSave({
          scheduleId: schedule?.id ?? null,
          input: built.input,
          ...(isNew && newDraft.input ? { newRecipient: newDraft.input } : {}),
          ...(addToMandate && agent ? { mandateUpdate: { agentId: agent.id, mandate: mandateWithRecipient(agent.mandate, target) } } : {}),
        });

  const save = async () => {
    const c = calls();
    if (c.length === 0) return;
    if (onPlan) {
      onPlan(c, { newRecipientId: isNew ? (target?.id ?? null) : null });
      onClose();
      return;
    }
    const r = await send(c, schedule ? "Schedule update" : c.length > 1 ? `${c.length} changes` : "Scheduled payment");
    if (r.ok) onClose();
  };

  const lastHandled = schedule ? Math.max(Number(schedule.last_occurrence_paid ?? 0), Number(schedule.last_paid_at ?? 0)) : 0;

  return (
    <Drawer
      open
      onClose={onClose}
      title={schedule ? `Edit scheduled payment #${schedule.id}` : "New scheduled payment"}
      subtitle="The assigned agent pays it on the dates you set."
      width={520}
      footer={
        <>
          {busy && <SigningHint />}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSave} loading={busy} onClick={() => void save()}>
            {onPlan ? "Use these values" : "Save & sign"}
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

        <FrequencyControl value={f} onChange={patch} errors={built.errors} disabled={busy} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts (date, UTC)" error={built.errors.start} className="col-span-1">
            {(a) => <Input {...a} type="date" value={f.startDate} disabled={busy} state={built.errors.start ? "error" : "default"} onChange={(e) => patch({ startDate: e.target.value })} />}
          </Field>
          <Field label="Time (UTC)" hint="Every payment is made at this time of day" className="col-span-1">
            {(a) => <Input {...a} type="time" value={f.startTime} disabled={busy} onChange={(e) => patch({ startTime: e.target.value })} />}
          </Field>
        </div>

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
                <Field label="Last day (UTC)" error={built.errors.endDate} className="w-44">
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
          <NextPaymentsPreview input={built.input} now={now} paidCount={schedule?.paid_count ?? 0} floor={lastHandled > 0 ? lastHandled + 1 : 0} />
          <MandateCompatibility agent={agent} compat={compat} offerAddToMandate={missing} addToMandate={addToMandate} onAddToMandate={(v) => patch({ addToMandate: v })} disabled={busy} />
          {!onPlan && !canAct && <p className="m-0 text-xs text-ink-subtle">Connect the vault owner&apos;s wallet to save.</p>}
        </div>
      </div>
    </Drawer>
  );
}
