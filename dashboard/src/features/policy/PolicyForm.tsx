import { useState } from "react";
import { policyToDraft, validatePolicy, type GraceUnit, type PolicyDraft } from "@/lib/policyForm";
import type { PolicyView } from "@/lib/types";
import { Button, Card, CardHeader, Field, Input, Pill, Select, SigningHint } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { PauseAll } from "@/features/layout/PauseAll";

/** Vault policy: daily limit, minimum payment, overdue grace. Re-keyed on server values so it resets after a refresh. */
export function PolicyCard({ policy }: { policy: PolicyView | null }) {
  const key = policy ? `${policy.daily_limit}-${policy.min_payment}-${policy.overdue_grace_ms}` : "none";
  return <PolicyFormInner key={key} policy={policy} />;
}

function PolicyFormInner({ policy }: { policy: PolicyView | null }) {
  const { canAct, busy, act } = useOwner();
  const [d, setD] = useState<PolicyDraft>(() => (policy ? policyToDraft(policy) : { daily: "", min: "", graceValue: "3", graceUnit: "days" }));
  const { policy: next, errors: draftErrors } = validatePolicy(d);
  const errors = policy ? draftErrors : {}; // no validation noise while the policy has not loaded
  const pristine = policy ? JSON.stringify(d) === JSON.stringify(policyToDraft(policy)) : true;
  const set = (patch: Partial<PolicyDraft>) => setD((x) => ({ ...x, ...patch }));
  return (
    <Card aria-labelledby="policy-title" className="flex flex-col gap-4">
      <CardHeader id="policy-title" title="Vault policy" badge={policy && (policy.paused ? <Pill accent="danger">Paused</Pill> : <Pill accent="ok">Active</Pill>)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Vault daily limit (USDC)" error={errors.daily} hint="Applies on top of every agent's own limit.">
          {(a) => <Input {...a} mono inputMode="decimal" value={d.daily} onChange={(e) => set({ daily: e.target.value })} />}
        </Field>
        <Field label="Minimum payment (USDC)" error={errors.min}>
          {(a) => <Input {...a} mono inputMode="decimal" value={d.min} onChange={(e) => set({ min: e.target.value })} />}
        </Field>
        <Field label="Overdue grace" error={errors.grace} hint="A scheduled payment missed by more than this needs your approval before it is paid. 1 hour to 30 days." className="sm:col-span-2">
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono inputMode="decimal" className="max-w-32" value={d.graceValue} onChange={(e) => set({ graceValue: e.target.value })} />
              <Select aria-label="Grace unit" className="max-w-32" value={d.graceUnit} onChange={(e) => set({ graceUnit: e.target.value as GraceUnit })}>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </Select>
            </div>
          )}
        </Field>
      </div>
      <p className="m-0 text-xs text-ink-subtle">Per-payment limit, approval threshold, chains and recipients are set in each agent&apos;s mandate.</p>
      <div className="flex flex-wrap items-center gap-3">
        {busy && <SigningHint />}
        <Button variant="primary" disabled={!canAct || busy || !policy || next === null || pristine} onClick={() => next && void act("set_policy", { policy: next })} title="1 yocto">
          Save policy
        </Button>
        <div className="grow" />
        <PauseAll />
      </div>
    </Card>
  );
}
