import { useT } from "@/i18n";
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
  const t = useT();
  const { canAct, busy, act } = useOwner();
  const [d, setD] = useState<PolicyDraft>(() => (policy ? policyToDraft(policy) : { daily: "", min: "", graceValue: "3", graceUnit: "days" }));
  const { policy: next, errors: draftErrors } = validatePolicy(d);
  const errors = policy ? draftErrors : {}; // no validation noise while the policy has not loaded
  const pristine = policy ? JSON.stringify(d) === JSON.stringify(policyToDraft(policy)) : true;
  const set = (patch: Partial<PolicyDraft>) => setD((x) => ({ ...x, ...patch }));
  return (
    <Card aria-labelledby="policy-title" className="flex flex-col gap-4">
      <CardHeader id="policy-title" title={t("pol.vaultPolicy")} badge={policy && (policy.paused ? <Pill accent="danger">{t("pill.paused")}</Pill> : <Pill accent="ok">{t("pill.active")}</Pill>)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("pol.dailyUsdc")} error={errors.daily} hint={t("pol.dailyHint")}>
          {(a) => <Input {...a} mono inputMode="decimal" value={d.daily} onChange={(e) => set({ daily: e.target.value })} />}
        </Field>
        <Field label={t("pol.minUsdc")} error={errors.min}>
          {(a) => <Input {...a} mono inputMode="decimal" value={d.min} onChange={(e) => set({ min: e.target.value })} />}
        </Field>
        <Field label={t("pol.grace")} error={errors.grace} hint={t("pol.graceHint")} className="sm:col-span-2">
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono inputMode="decimal" className="max-w-32" value={d.graceValue} onChange={(e) => set({ graceValue: e.target.value })} />
              <Select aria-label={t("pol.graceUnit")} className="max-w-32" value={d.graceUnit} onChange={(e) => set({ graceUnit: e.target.value as GraceUnit })}>
                <option value="hours">{t("pol.hours")}</option>
                <option value="days">{t("pol.days")}</option>
              </Select>
            </div>
          )}
        </Field>
      </div>
      <p className="m-0 text-xs text-ink-subtle">{t("pol.perAgentNote")}</p>
      <div className="flex flex-wrap items-center gap-3">
        {busy && <SigningHint />}
        <Button variant="primary" disabled={!canAct || busy || !policy || next === null || pristine} onClick={() => next && void act("set_policy", { policy: next })} title={t("pol.oneYocto")}>
          {t("pol.save")}
        </Button>
        <div className="grow" />
        <PauseAll />
      </div>
    </Card>
  );
}
