import { useT } from "@/i18n";
import { useState } from "react";
import { Button, Drawer, SigningHint } from "@/kit";
import type { PlannedCall } from "@/lib/calls";
import type { RecipientDraft } from "@/lib/recipientForm";
import { useRecipients } from "@/lib/useVault";
import type { RecipientView } from "@/lib/types";
import { RecipientFields, useRecipientDraft } from "./RecipientFields";
import { useOwnerTx } from "./useOwnerTx";

export interface RecipientDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Edit this entry (update_recipient); otherwise add_recipient. */
  recipient?: RecipientView | undefined;
  /** Initial values (assistant "Edit in form"). */
  prefill?: Partial<RecipientDraft> | undefined;
  /** Assistant mode: hand the calls back instead of signing; the card is replaced. */
  onPlan?: ((calls: PlannedCall[]) => void) | undefined;
}

export function RecipientDrawer(props: RecipientDrawerProps) {
  if (!props.open) return null;
  return <Inner {...props} />;
}

function Inner({ onClose, recipient, prefill, onPlan }: RecipientDrawerProps) {
  const t = useT();
  const { data: recipients } = useRecipients();
  const { send, busy, canAct } = useOwnerTx();
  const [draft, setDraft] = useState<RecipientDraft>({
    label: recipient?.label ?? prefill?.label ?? "",
    chain: recipient?.destination_chain ?? prefill?.chain ?? "",
    address: recipient?.destination_address ?? prefill?.address ?? "",
  });
  const state = useRecipientDraft(draft, recipients, recipient?.id ?? null);
  const valid = state.input !== null;

  const calls = (): PlannedCall[] =>
    !state.input ? [] : [recipient ? { method: "update_recipient", args: { recipient_id: recipient.id, recipient: state.input } } : { method: "add_recipient", args: { recipient: state.input } }];

  const save = async () => {
    const c = calls();
    if (onPlan) {
      onPlan(c);
      onClose();
      return;
    }
    const r = await send(c, recipient ? t("pay.updateRecipientLbl") : t("pay.addRecipientLbl"));
    if (r.ok) onClose();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={recipient ? t("pay.editRecipient", { label: recipient.label }) : t("pay.newRecipient")}
      subtitle={t("pay.recipientSubtitle")}
      width={480}
      footer={
        <>
          {busy && <SigningHint />}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!valid || (!onPlan && !canAct) || busy} loading={busy} onClick={() => void save()}>
            {onPlan ? t("pay.useValues") : t("pay.saveSign")}
          </Button>
        </>
      }
    >
      <RecipientFields draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} draftState={state} disabled={busy} />
      {!onPlan && !canAct && <p className="mt-4 mb-0 text-xs text-ink-subtle">{t("pay.connectToSave")}</p>}
    </Drawer>
  );
}
