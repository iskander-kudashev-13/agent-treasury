import { useT } from "@/i18n";
import { useState } from "react";
import { usdcGrouped } from "@/lib/amount";
import { isDepositExpired } from "@/lib/status";
import type { Payout } from "@/lib/types";
import { Button, Modal, SigningHint } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

const MAX_APPROVAL_AGE_MS = 72 * 3_600_000;

function Choice({ checked, onSelect, title, children }: { checked: boolean; onSelect: () => void; title: string; children: string }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-tile border p-3 ${checked ? "border-line-strong bg-surface-hover" : "border-line"}`}>
      <input type="radio" name="reject-mode" className="mt-1" checked={checked} onChange={onSelect} />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-[13px] text-ink-muted">{children}</span>
      </span>
    </label>
  );
}

/** Reject a pending approval. Scheduled payouts: keep the date (agent asks again with a fresh quote) or skip it (needs 1 yocto). */
export function RejectModal({ payout, label, onClose }: { payout: Payout; label: string; onClose: () => void }) {
  const t = useT();
  const { canAct, busy, act } = useOwner();
  const [now] = useState(() => Date.now());
  const scheduled = payout.schedule_id !== null;
  // Same default as the contract: skip, except when the payout can no longer be approved.
  const unapprovable = isDepositExpired(payout.deposit_expires_at_ms, now) || now > Number(payout.created_at_ms) + MAX_APPROVAL_AGE_MS;
  const [skip, setSkip] = useState(!unapprovable);

  const go = async () => {
    if (await act("reject_payout", { payout_id: payout.id, skip: scheduled && skip })) onClose();
  };
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={t("rj.title", { amount: usdcGrouped(payout.amount), label })}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={!canAct || busy} onClick={() => void go()}>
            {t("po.reject")}
          </Button>
        </>
      }
    >
      {scheduled ? (
        <div className="flex flex-col gap-2">
          <Choice checked={!skip} onSelect={() => setSkip(false)} title={t("rj.keepTitle")}>
            {t("rj.keepBody")}
          </Choice>
          <Choice checked={skip} onSelect={() => setSkip(true)} title={t("rj.skipTitle")}>
            {t("rj.skipBody")}
          </Choice>
          {unapprovable && <p className="m-0 text-xs text-ink-subtle">{t("rj.unapprovable")}</p>}
        </div>
      ) : (
        <p className="m-0">{t("rj.oneOff")}</p>
      )}
    </Modal>
  );
}
