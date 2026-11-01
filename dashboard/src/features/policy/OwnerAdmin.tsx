import { useState } from "react";
import { formatNear, parseNear } from "@/lib/vaultFunds";
import { isAccountId } from "@/lib/trustAnchors";
import type { ContractInfo } from "@/lib/types";
import { Button, Callout, Card, CardHeader, Field, Input, Modal, SigningHint } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

function nearOrError(v: string): { yocto: string | null; error: string | null } {
  if (!v.trim()) return { yocto: null, error: null };
  try {
    return { yocto: parseNear(v), error: null };
  } catch (e) {
    return { yocto: null, error: (e as Error).message };
  }
}

/** Storage deposit, NEAR withdrawal and ownership transfer. */
export function OwnerAdmin({ info }: { info: ContractInfo | null }) {
  const { canAct, busy, act, accountId } = useOwner();
  const [near, setNear] = useState("");
  const [storage, setStorage] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState(false);
  const n = nearOrError(near);
  const s = nearOrError(storage);
  const nextOk = isAccountId(next.trim());
  const canAccept = Boolean(info?.proposed_owner) && accountId === info?.proposed_owner;
  return (
    <Card aria-labelledby="admin-title" className="flex flex-col gap-4">
      <CardHeader id="admin-title" title="Owner admin" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Field label="Withdraw NEAR" error={n.error} hint="Only NEAR not locked for storage can leave.">
            {(a) => <Input {...a} mono inputMode="decimal" suffix="NEAR" value={near} onChange={(e) => setNear(e.target.value)} />}
          </Field>
          <Button disabled={!canAct || busy || n.yocto === null} onClick={() => n.yocto && void act("withdraw_near", { amount: n.yocto }).then((ok) => ok && setNear(""))} title="1 yocto">
            Withdraw NEAR
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <Field label="Storage deposit" error={s.error} hint={`Currently ${info ? formatNear(info.storage_deposit_yocto) : "?"} NEAR per record.`}>
            {(a) => <Input {...a} mono inputMode="decimal" suffix="NEAR" value={storage} onChange={(e) => setStorage(e.target.value)} />}
          </Field>
          <Button disabled={!canAct || busy || s.yocto === null} onClick={() => s.yocto && void act("set_storage_deposit_yocto", { storage_deposit_yocto: s.yocto }).then((ok) => ok && setStorage(""))} title="1 yocto">
            Set storage deposit
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <Field label="Transfer ownership" hint={info?.proposed_owner ? `Pending: ${info.proposed_owner} must accept.` : "The new owner must accept in their wallet."} error={next && !nextOk ? "Not a valid account id" : undefined}>
            {(a) => <Input {...a} mono value={next} onChange={(e) => setNext(e.target.value.trim())} placeholder="account id" />}
          </Field>
          <Button variant="danger" disabled={!canAct || busy || !nextOk} onClick={() => setConfirm(true)}>
            Propose new owner
          </Button>
        </div>
      </div>
      {canAccept && (
        <Callout accent="info" action={<Button variant="primary" disabled={busy} onClick={() => void act("accept_owner")}>Accept ownership</Button>}>
          {info?.owner_id} proposed you as the new owner of this vault.
        </Callout>
      )}
      <Modal
        open={confirm}
        danger
        onClose={() => !busy && setConfirm(false)}
        title="Propose a new owner?"
        footer={
          <>
            {busy && <SigningHint />}
            <Button onClick={() => setConfirm(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger-fill" disabled={busy} onClick={() => void act("propose_owner", { proposed_owner: next }).then((ok) => { if (ok) { setConfirm(false); setNext(""); } })}>
              Propose {next}
            </Button>
          </>
        }
      >
        <span className="mono break-all">{next}</span> will become the owner once it accepts. It can then withdraw funds and change every rule. You stay owner until then.
      </Modal>
    </Card>
  );
}
