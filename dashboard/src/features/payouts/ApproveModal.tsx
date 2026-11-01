import { useState } from "react";
import { VAULT_ID } from "@/lib/config";
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

const REASON: Record<string, string> = {
  ABOVE_THRESHOLD: "Above the agent's approval threshold",
  OVERDUE_NEEDS_APPROVAL: "Overdue: the agent was offline past the grace period",
};

/** Review before approving. Approve stays disabled until the 1Click quote check passes (or the status API is unreachable and the owner confirms). */
export function ApproveModal({ payout, label, agentName, onClose }: { payout: Payout; label: string; agentName: string; onClose: () => void }) {
  const { canAct, busy, act } = useOwner();
  const q = useQuoteStatus(payout.deposit_address, true);
  const [override, setOverride] = useState(false);
  const [now] = useState(() => Date.now());
  const fetched = q.isFetching ? undefined : q.data;
  const gate = evaluateGate(payout, VAULT_ID, fetched, fetched?.kind === "ok" ? fetched.fetchedAt : now);
  const expired = isDepositExpired(payout.deposit_expires_at_ms, now);
  const allowed = canApprove(gate, override) && !expired;

  const approve = async () => {
    // Re-evaluate at click time: the quote deadline may have passed while the dialog was open.
    const latest = evaluateGate(payout, VAULT_ID, q.data, Date.now());
    if (!canApprove(latest, override) || isDepositExpired(payout.deposit_expires_at_ms, Date.now())) return;
    if (await act("approve_payout", { payout_id: payout.id })) onClose();
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      width={600}
      title={`Approve ${usdcGrouped(payout.amount)} USDC to ${label}?`}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="approve"
            disabled={!canAct || busy || !allowed}
            onClick={() => void approve()}
            title={!canAct ? "Only the vault owner can approve" : !allowed ? "Blocked until the quote check passes" : "1 yocto, 100 TGas; the contract re-checks all limits"}
          >
            Approve
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-ink-muted">Requested by</dt>
          <dd className="m-0">{agentName}</dd>
          <dt className="text-ink-muted">Amount</dt>
          <dd className="mono m-0">{usdcGrouped(payout.amount)} USDC</dd>
          <dt className="text-ink-muted">Destination</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2 break-all">
            <ChainBadge chain={payout.chain} arrow />
            <span className="mono text-xs">{payout.address}</span>
          </dd>
          {payout.approval_reason && (
            <>
              <dt className="text-ink-muted">Why approval</dt>
              <dd className="m-0">{REASON[payout.approval_reason] ?? payout.approval_reason}</dd>
            </>
          )}
          {payout.memo && (
            <>
              <dt className="text-ink-muted">Memo</dt>
              <dd className="m-0 break-words whitespace-pre-wrap">{payout.memo}</dd>
            </>
          )}
          {payout.deposit_address && (
            <>
              <dt className="text-ink-muted">Deposit address</dt>
              <dd className="m-0 break-all">
                <span className="mono text-xs">{payout.deposit_address}</span>{" "}
                <a href={intentsTrackUrl(payout.deposit_address)} target="_blank" rel="noreferrer">
                  Intents explorer ↗
                </a>
              </dd>
            </>
          )}
          {payout.deposit_expires_at_ms && (
            <>
              <dt className="text-ink-muted">Valid until</dt>
              <dd className={`m-0 ${expired ? "text-danger-text" : ""}`}>
                {formatTime(payout.deposit_expires_at_ms)}
                {expired ? " (expired: reject it, the date stays payable)" : ""}
              </dd>
            </>
          )}
        </dl>
        <QuoteCheckPanel gate={gate} override={override} onOverride={setOverride} onRecheck={() => void q.refetch()} />
        <p className="m-0 text-xs text-ink-subtle">
          Approving sends {usdcGrouped(payout.amount)} USDC from the vault to the deposit address, which pays out on {chainName(payout.chain)}. You will confirm in your wallet.
        </p>
      </div>
    </Modal>
  );
}
