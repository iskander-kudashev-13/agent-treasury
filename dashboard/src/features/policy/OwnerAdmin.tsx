import { useT, rich } from "@/i18n";
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
  const t = useT();
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
      <CardHeader id="admin-title" title={t("admin.title")} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Field label={t("admin.withdrawNear")} error={n.error} hint={t("admin.withdrawHint")}>
            {(a) => <Input {...a} mono inputMode="decimal" suffix="NEAR" value={near} onChange={(e) => setNear(e.target.value)} />}
          </Field>
          <Button disabled={!canAct || busy || n.yocto === null} onClick={() => n.yocto && void act("withdraw_near", { amount: n.yocto }).then((ok) => ok && setNear(""))} title={t("pol.oneYocto")}>
            {t("admin.withdrawNear")}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <Field label={t("admin.storageDeposit")} error={s.error} hint={t("admin.storageHint", { amount: info ? formatNear(info.storage_deposit_yocto) : "?" })}>
            {(a) => <Input {...a} mono inputMode="decimal" suffix="NEAR" value={storage} onChange={(e) => setStorage(e.target.value)} />}
          </Field>
          <Button disabled={!canAct || busy || s.yocto === null} onClick={() => s.yocto && void act("set_storage_deposit_yocto", { storage_deposit_yocto: s.yocto }).then((ok) => ok && setStorage(""))} title={t("pol.oneYocto")}>
            {t("admin.setStorage")}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <Field label={t("admin.transfer")} hint={info?.proposed_owner ? t("admin.pending", { account: info.proposed_owner }) : t("admin.newMustAccept")} error={next && !nextOk ? t("admin.invalidAccount") : undefined}>
            {(a) => <Input {...a} mono value={next} onChange={(e) => setNext(e.target.value.trim())} placeholder={t("admin.accountPlaceholder")} />}
          </Field>
          <Button variant="danger" disabled={!canAct || busy || !nextOk} onClick={() => setConfirm(true)}>
            {t("admin.propose")}
          </Button>
        </div>
      </div>
      {canAccept && (
        <Callout accent="info" action={<Button variant="primary" disabled={busy} onClick={() => void act("accept_owner")}>{t("admin.accept")}</Button>}>
          {t("admin.proposedYou", { owner: info?.owner_id ?? "" })}
        </Callout>
      )}
      <Modal
        open={confirm}
        danger
        onClose={() => !busy && setConfirm(false)}
        title={t("admin.proposeTitle")}
        footer={
          <>
            {busy && <SigningHint />}
            <Button onClick={() => setConfirm(false)} disabled={busy}>{t("common.cancel")}</Button>
            <Button variant="danger-fill" disabled={busy} onClick={() => void act("propose_owner", { proposed_owner: next }).then((ok) => { if (ok) { setConfirm(false); setNext(""); } })}>
              {t("admin.proposeBtn", { account: next })}
            </Button>
          </>
        }
      >
        {rich("admin.proposeBody", { account: <span className="mono break-all">{next}</span> })}
      </Modal>
    </Card>
  );
}
