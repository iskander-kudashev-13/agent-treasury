import { useT, rich } from "@/i18n";
import { useState } from "react";
import { Button, Callout, Card, CardHeader, Field, Icons, Input, Modal, SigningHint } from "@/kit";
import { deleteKeyCommand, planDeleteAgentKey } from "@/lib/agentSetup";
import type { AgentView } from "@/lib/types";
import { NETWORK } from "@/lib/config";
import { useAgentTx } from "./useAgentTx";

function RevokeDialog({ agent, open, onClose }: { agent: AgentView; open: boolean; onClose: () => void }) {
  const t = useT();
  const { busy, call } = useAgentTx();
  const [typed, setTyped] = useState("");
  const ok = typed.trim() === agent.id;
  return (
    <Modal
      open={open}
      onClose={onClose}
      danger
      title={t("ag.revokeTitle", { name: agent.name })}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="danger-fill"
            disabled={!ok || busy}
            onClick={() =>
              void call("revoke_agent", { agent_id: agent.id }).then((done) => {
                if (done) {
                  setTyped("");
                  onClose();
                }
              })
            }
          >
            {t("ag.revokeBtn", { name: agent.name })}
          </Button>
        </>
      }
    >
      <p className="mt-0">
        {t("ag.revokeBody", { name: agent.name })}
      </p>
      <Field label={rich("ag.typeToConfirm", { id: <span className="mono">{agent.id}</span> })}>{(a11y) => <Input {...a11y} mono value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />}</Field>
    </Modal>
  );
}

function DeleteKeyDialog({ agent, open, onClose }: { agent: AgentView; open: boolean; onClose: () => void }) {
  const t = useT();
  const { busy, sign, accountId } = useAgentTx();
  const account = agent.account_id!;
  const pk = agent.public_key!;
  const canSignHere = accountId === account; // the wallet is logged in as the agent account itself
  const cmd = deleteKeyCommand(account, pk, NETWORK);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("ag.deleteKeyTitle")}
      width={520}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button
            variant="danger"
            disabled={!canSignHere || busy}
            title={canSignHere ? undefined : t("ag.walletLoggedAs", { who: accountId ?? t("ag.nobody"), account })}
            onClick={() => void sign(t("ag.deleteKeyTitle"), [planDeleteAgentKey(account, pk)], { requireOwner: false }).then((ok) => ok && onClose())}
          >
            {t("ag.deleteKeyWallet")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          {rich("ag.deleteKeyBody", { key: <span className="mono break-all">{pk}</span>, account: <span className="mono break-all">{account}</span> })}
        </p>
        <Callout accent="warn">
          {rich("ag.deleteKeyWarn", { account: <strong>{account}</strong> })}
        </Callout>
        <div>
          <div className="mb-1 text-[13px] font-medium text-ink-secondary">{t("ag.fromTerminal")}</div>
          <pre className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs whitespace-pre-wrap break-all">{cmd}</pre>
          <Button size="sm" className="mt-2" icon={<Icons.Copy size={13} />} onClick={() => void navigator.clipboard?.writeText(cmd)}>
            {t("ag.copyCommand")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Danger zone: Revoke (type-to-confirm, 1 yocto) and, for key agents, the separate "Delete access key" transaction. */
export function AgentDanger({ agent }: { agent: AgentView }) {
  const t = useT();
  const { canAct } = useAgentTx();
  const [revoke, setRevoke] = useState(false);
  const [del, setDel] = useState(false);
  const revoked = agent.status === "Revoked";
  const hasKey = agent.kind === "Key" && agent.account_id !== null && agent.public_key !== null;
  if (revoked && !hasKey) return null;
  return (
    <Card aria-labelledby="danger-title" className="flex flex-col gap-3 border-danger/40">
      <CardHeader id="danger-title" title={t("ag.dangerZone")} />
      {!revoked && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-56 flex-1 text-sm text-ink-secondary">{t("ag.revokePermanent")}</p>
          <Button variant="danger" disabled={!canAct} title={canAct ? undefined : t("common.ownerOnly")} onClick={() => setRevoke(true)}>
            {t("ag.revokeAgent")}
          </Button>
        </div>
      )}
      {hasKey && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-56 flex-1 text-sm text-ink-secondary">
            {revoked ? t("ag.alsoDeleteRevoked") : t("ag.alsoDelete")}
          </p>
          <Button variant="danger" onClick={() => setDel(true)}>
            {t("ag.deleteKeyBtn")}
          </Button>
        </div>
      )}
      <RevokeDialog agent={agent} open={revoke} onClose={() => setRevoke(false)} />
      {hasKey && <DeleteKeyDialog agent={agent} open={del} onClose={() => setDel(false)} />}
    </Card>
  );
}
