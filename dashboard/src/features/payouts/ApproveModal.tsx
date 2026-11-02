import { useT } from "@/i18n";
import { useState } from "react";
import type { MessageKey } from "@/i18n";
import { ONECLICK_SIMULATED, VAULT_ID } from "@/lib/config";
import { usdcGrouped } from "@/lib/amount";
import { canApprove, evaluateGate } from "@/lib/oneclickStatus";
import { chainName } from "@/kit";
import { intentsTrackUrl } from "@/lib/payoutView";
import { isDepositExpired } from "@/lib/status";
import { formatTime } from "@/lib/format";
import type { Payout } from "@/lib/types";
import { Button, ChainBadge, Modal, SigningHint } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { QuoteCheckPanel } from "./QuoteCheckPanel";
import { useQuoteStatus } from "./useQuoteStatus";

const REASON: Record<string, MessageKey> = {
  ABOVE_THRESHOLD: "po.aboveThreshold",
  OVERDUE_NEEDS_APPROVAL: "po.overdueReason",
};

/** Review before approving. Approve stays disabled until the 1Click quote check passes (or the status API is unreachable and the owner confirms). */
export function ApproveModal({ payout, label, agentName, onClose }: { payout: Payout; label: string; agentName: string; onClose: () => void }) {
  const t = useT();
  const { canAct, busy, act } = useOwner();
  const q = useQuoteStatus(payout.deposit_address, true);
  // One checkbox serves two different acknowledgements (unreachable API / simulated): the tick is bound to the phase it
  // was given for, so it no longer counts once the phase changes.
  const [ackPhase, setAckPhase] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const fetched = q.isFetching ? undefined : q.data;
  const gate = evaluateGate(payout, VAULT_ID, fetched, fetched?.kind === "ok" ? fetched.fetchedAt : now, { simulated: ONECLICK_SIMULATED });
  const override = ackPhase === gate.phase;
  const setOverride = (v: boolean) => setAckPhase(v ? gate.phase : null);
  const expired = isDepositExpired(payout.deposit_expires_at_ms, now);
  const allowed = canApprove(gate, override) && !expired;

  const approve = async () => {
    // Re-evaluate at click time: the quote deadline may have passed while the dialog was open.
    const latest = evaluateGate(payout, VAULT_ID, q.data, Date.now(), { simulated: ONECLICK_SIMULATED });
    if (!canApprove(latest, ackPhase === latest.phase) || isDepositExpired(payout.deposit_expires_at_ms, Date.now())) return;
    if (await act("approve_payout", { payout_id: payout.id })) onClose();
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      width={600}
      title={t("po.approveTitle", { amount: usdcGrouped(payout.amount), label })}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="approve"
            disabled={!canAct || busy || !allowed}
            onClick={() => void approve()}
            title={!canAct ? t("po.onlyOwnerApprove") : !allowed ? t("po.blockedUntil") : t("po.approveGas")}
          >
            {t("po.approve")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-ink-muted">{t("po.requestedBy")}</dt>
          <dd className="m-0">{agentName}</dd>
          <dt className="text-ink-muted">{t("po.amount")}</dt>
          <dd className="mono m-0">{usdcGrouped(payout.amount)} USDC</dd>
          <dt className="text-ink-muted">{t("po.destination")}</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2 break-all">
            <ChainBadge chain={payout.chain} arrow />
            <span className="mono text-xs">{payout.address}</span>
          </dd>
          {payout.approval_reason && (
            <>
              <dt className="text-ink-muted">{t("po.whyApproval")}</dt>
              <dd className="m-0">{REASON[payout.approval_reason] ? t(REASON[payout.approval_reason]!) : payout.approval_reason}</dd>
            </>
          )}
          {payout.memo && (
            <>
              <dt className="text-ink-muted">{t("po.memo")}</dt>
              <dd className="m-0 break-words whitespace-pre-wrap">{payout.memo}</dd>
            </>
          )}
          {payout.deposit_address && (
            <>
              <dt className="text-ink-muted">{t("po.depositAddress")}</dt>
              <dd className="m-0 break-all">
                <span className="mono text-xs">{payout.deposit_address}</span>{" "}
                {gate.phase !== "simulated" && (
                  <a href={intentsTrackUrl(payout.deposit_address)} target="_blank" rel="noreferrer">
                    {t("po.intentsExplorer")}
                  </a>
                )}
              </dd>
            </>
          )}
          {payout.deposit_expires_at_ms && (
            <>
              <dt className="text-ink-muted">{t("po.validUntil")}</dt>
              <dd className={`m-0 ${expired ? "text-danger-text" : ""}`}>
                {formatTime(payout.deposit_expires_at_ms)}
                {expired ? t("po.expiredReject") : ""}
              </dd>
            </>
          )}
        </dl>
        <QuoteCheckPanel gate={gate} override={override} onOverride={setOverride} onRecheck={() => void q.refetch()} />
        <p className="m-0 text-xs text-ink-subtle">
          {t("po.approveNote", { amount: usdcGrouped(payout.amount), chain: chainName(payout.chain) })}
        </p>
      </div>
    </Modal>
  );
}
