import { useState } from "react";
import { Button, Callout, Card, CardHeader, Field, Icons, Input, Modal, SigningHint } from "@/kit";
import { deleteKeyCommand, planDeleteAgentKey } from "@/lib/agentSetup";
import type { AgentView } from "@/lib/types";
import { NETWORK } from "@/lib/config";
import { useAgentTx } from "./useAgentTx";

function RevokeDialog({ agent, open, onClose }: { agent: AgentView; open: boolean; onClose: () => void }) {
  const { busy, call } = useAgentTx();
  const [typed, setTyped] = useState("");
  const ok = typed.trim() === agent.id;
  return (
    <Modal
      open={open}
      onClose={onClose}
      danger
      title={`Revoke ${agent.name}?`}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose}>Cancel</Button>
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
            Revoke {agent.name}
          </Button>
        </>
      }
    >
      <p className="mt-0">
        {agent.name} will never be able to request payments again. Pending approvals from this agent will be rejected. This can&apos;t be undone. Needs 1 yoctoNEAR.
      </p>
      <Field label={<>Type <span className="mono">{agent.id}</span> to confirm</>}>{(a11y) => <Input {...a11y} mono value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />}</Field>
    </Modal>
  );
}

function DeleteKeyDialog({ agent, open, onClose }: { agent: AgentView; open: boolean; onClose: () => void }) {
  const { busy, sign, accountId } = useAgentTx();
  const account = agent.account_id!;
  const pk = agent.public_key!;
  const canSignHere = accountId === account; // the wallet is logged in as the agent account itself
  const cmd = deleteKeyCommand(account, pk, NETWORK);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete access key"
      width={520}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="danger"
            disabled={!canSignHere || busy}
            title={canSignHere ? undefined : `Your wallet is logged in as ${accountId ?? "nobody"}, not as ${account}`}
            onClick={() => void sign("Delete access key", [planDeleteAgentKey(account, pk)], { requireOwner: false }).then((ok) => ok && onClose())}
          >
            Delete key in wallet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          Removes <span className="mono break-all">{pk}</span> from <span className="mono break-all">{account}</span>. This is a separate transaction from the revoke, and the vault already refuses the agent either way. Deleting the key also stops it from spending gas.
        </p>
        <Callout accent="warn">
          A key can only be deleted by a signature from <strong>{account}</strong> itself, with a full-access key of that account. For an account created by this dashboard that is the full-access key you added (if you added one). Your owner wallet cannot sign for a sub-account unless you are logged in as it.
        </Callout>
        <div>
          <div className="mb-1 text-[13px] font-medium text-ink-secondary">Or from a terminal (near-cli-rs)</div>
          <pre className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs whitespace-pre-wrap break-all">{cmd}</pre>
          <Button size="sm" className="mt-2" icon={<Icons.Copy size={13} />} onClick={() => void navigator.clipboard?.writeText(cmd)}>
            Copy command
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Danger zone: Revoke (type-to-confirm, 1 yocto) and, for key agents, the separate "Delete access key" transaction. */
export function AgentDanger({ agent }: { agent: AgentView }) {
  const { canAct } = useAgentTx();
  const [revoke, setRevoke] = useState(false);
  const [del, setDel] = useState(false);
  const revoked = agent.status === "Revoked";
  const hasKey = agent.kind === "Key" && agent.account_id !== null && agent.public_key !== null;
  if (revoked && !hasKey) return null;
  return (
    <Card aria-labelledby="danger-title" className="flex flex-col gap-3 border-danger/40">
      <CardHeader id="danger-title" title="Danger zone" />
      {!revoked && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-56 flex-1 text-sm text-ink-secondary">Revoke is permanent: the agent can never request payments again. Create a new agent instead.</p>
          <Button variant="danger" disabled={!canAct} title={canAct ? undefined : "Only the vault owner can do this"} onClick={() => setRevoke(true)}>
            Revoke agent
          </Button>
        </div>
      )}
      {hasKey && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-56 flex-1 text-sm text-ink-secondary">
            {revoked ? "The agent is revoked. Also delete its access key from its account." : "After revoking, also delete its access key from its account (second transaction)."}
          </p>
          <Button variant="danger" onClick={() => setDel(true)}>
            Delete access key…
          </Button>
        </div>
      )}
      <RevokeDialog agent={agent} open={revoke} onClose={() => setRevoke(false)} />
      {hasKey && <DeleteKeyDialog agent={agent} open={del} onClose={() => setDel(false)} />}
    </Card>
  );
}
