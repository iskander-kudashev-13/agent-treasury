import { useState } from "react";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { usePolicy } from "@/lib/useVault";
import { Button, Icons, Modal, SigningHint } from "@/kit";

/**
 * Global kill switch, rendered in the header on every page (UI_PLAN §1: "Pause is always reachable").
 * Pause = vault `pause()` (no payments for ANY agent). Resume needs 1 yocto; pause needs none.
 */
export function PauseAll() {
  const { data: policy } = usePolicy();
  const { accountId, signIn } = useWallet();
  const { canAct, busy, act } = useOwner();
  const [confirm, setConfirm] = useState(false);
  if (!policy) return null;
  const paused = policy.paused;
  const label = paused ? "Resume all agents" : "Pause all agents";
  const guest = accountId !== null && !canAct;

  const go = async () => {
    const ok = await act(paused ? "resume" : "pause");
    if (ok) setConfirm(false);
  };

  return (
    <>
      <Button
        variant={paused ? "primary" : "danger"}
        size="sm"
        icon={paused ? <Icons.Play size={14} /> : <Icons.Pause size={14} />}
        disabled={guest}
        title={guest ? "Only the vault owner can do this" : accountId ? undefined : `Connect wallet to ${paused ? "resume" : "pause"}`}
        onClick={() => (accountId ? setConfirm(true) : signIn())}
      >
        {label}
      </Button>
      <Modal
        open={confirm}
        onClose={() => !busy && setConfirm(false)}
        danger={!paused}
        title={paused ? "Resume all agents?" : "Pause all agents?"}
        footer={
          <>
            {busy && <SigningHint />}
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={paused ? "primary" : "danger-fill"} loading={busy} disabled={!canAct} onClick={() => void go()}>
              {label}
            </Button>
          </>
        }
      >
        {paused
          ? "Agents will be able to request payments again, within their mandates."
          : "No agent can pay anyone until you resume. Payments already sent keep going; scheduled payments wait. You can still withdraw."}
      </Modal>
    </>
  );
}
