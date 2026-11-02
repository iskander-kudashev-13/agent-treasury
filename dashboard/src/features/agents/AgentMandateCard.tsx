import { useT } from "@/i18n";
import { useMemo, useState } from "react";
import { Button, Callout, Card, CardHeader, Modal, SigningHint } from "@/kit";
import { recipientNames } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { diffMandate, mandateToForm, validateMandateForm, type MandateForm } from "@/lib/mandateForm";
import { useRecipients } from "@/lib/useVault";
import { MandateEditor, MandatePreview } from "./MandateEditor";
import { MandateText } from "./parts";
import { useAgentTx } from "./useAgentTx";

/** Mandate sentence + editor. Save shows a diff and signs update_mandate (1 yocto). */
export function AgentMandateCard({ agent }: { agent: AgentView }) {
  const t = useT();
  const { canAct, busy, call } = useAgentTx();
  const recipients = useRecipients();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState<MandateForm>(() => mandateToForm(agent.mandate));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const names = useMemo(() => recipientNames(recipients.data), [recipients.data]);
  const knownRecipients = useMemo(() => new Set(recipients.data.map((r) => r.id)), [recipients.data]);
  const result = useMemo(() => validateMandateForm(form, { knownRecipients, nowMs }), [form, knownRecipients, nowMs]);
  const diff = result.mandate ? diffMandate(agent.mandate, result.mandate, (id) => names.get(id) ?? `#${id}`) : [];
  const revoked = agent.status === "Revoked";
  const lowersBelowSpend = result.mandate !== null && BigInt(result.mandate.daily_limit) <= BigInt(agent.spent_today) && BigInt(agent.mandate.daily_limit) > BigInt(agent.spent_today);

  const start = () => {
    setForm(mandateToForm(agent.mandate));
    setNowMs(Date.now());
    setEditing(true);
  };

  return (
    <Card aria-labelledby="mandate-title" className="flex flex-col gap-4" decorated>
      <CardHeader
        id="mandate-title"
        title={t("ag.mandate")}
        actions={
          !revoked &&
          !editing && (
            <Button size="sm" disabled={!canAct} title={canAct ? undefined : t("ag.onlyOwnerEdit")} onClick={start}>
              {t("ag.editMandate")}
            </Button>
          )
        }
      />
      <MandateText mandate={agent.mandate} names={names} />
      {editing && (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <MandateEditor form={form} onChange={setForm} result={result} recipients={recipients.data} disabled={busy} />
          <MandatePreview result={result} recipients={recipients.data} nowMs={nowMs} />
          {lowersBelowSpend && <Callout accent="info">{t("ag.lowerThanSpent")}</Callout>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setEditing(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={!canAct || !result.mandate || diff.length === 0} onClick={() => setConfirm(true)}>
              {t("ag.reviewChanges")}
            </Button>
          </div>
        </div>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("ag.updateMandate")}
        footer={
          <>
            {busy && <SigningHint />}
            <Button onClick={() => setConfirm(false)}>{t("common.back")}</Button>
            <Button
              variant="primary"
              disabled={busy || !result.mandate}
              onClick={() =>
                void call("update_mandate", { agent_id: agent.id, mandate: result.mandate }).then((ok) => {
                  if (ok) {
                    setConfirm(false);
                    setEditing(false);
                  }
                })
              }
            >
              {t("ag.signInWallet")}
            </Button>
          </>
        }
      >
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
          {diff.map((d) => (
            <li key={d} className="mono text-[13px]">
              {d}
            </li>
          ))}
        </ul>
        <p className="mb-0 text-xs text-ink-muted">{t("ag.spendingKept")}</p>
      </Modal>
    </Card>
  );
}
