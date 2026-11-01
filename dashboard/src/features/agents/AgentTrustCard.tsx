import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Callout, Card, CardHeader, Hash, Modal, Pill, ShieldProof, SigningHint } from "@/kit";
import { formatNear, viewAccessKey } from "@/lib/accessKey";
import { measurementsLabel, trustOf } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { KEY_AGENT_METHODS } from "@/lib/agentSetup";
import { NETWORK, VAULT_ID, explorerAddressUrl } from "@/lib/config";
import { formatTime } from "@/lib/format";
import { teeReasonText } from "@/lib/reasonCodes";
import { shortId } from "@/kit/tokens";
import { Fact, Facts, TrustLine } from "./parts";
import { useAgentTx } from "./useAgentTx";

function KeyAgentProof({ agent }: { agent: AgentView }) {
  const acc = agent.account_id;
  const pk = agent.public_key;
  const q = useQuery({ queryKey: ["agent-access-key", NETWORK, acc, pk], queryFn: () => viewAccessKey(acc!, pk!), enabled: Boolean(acc && pk), refetchInterval: 30_000, retry: false });
  const key = q.data;
  return (
    <>
      <Facts>
        <Fact label="Account">
          {acc ? (
            <a className="mono text-xs break-all" href={explorerAddressUrl(acc)} target="_blank" rel="noreferrer">
              {acc}
            </a>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Public key">{pk ? <Hash value={pk} /> : "not recorded"}</Fact>
        <Fact label="Allowed methods">
          <span className="mono text-xs">{KEY_AGENT_METHODS.join(", ")}</span> on <span className="mono text-xs">{VAULT_ID}</span>
        </Fact>
        {key?.state === "function-call" && (
          <Fact label="Gas allowance left">{key.allowanceYocto ? `${formatNear(key.allowanceYocto)} NEAR` : "unlimited"}</Fact>
        )}
      </Facts>
      {key?.state === "missing" && agent.status !== "Revoked" && <Callout accent="warn">Access key not found on account. The agent can no longer sign requests; create a new agent or add the key again.</Callout>}
      {key?.state === "full-access" && <Callout accent="warn">This key has full access to the account, not just the vault methods. Prefer a function-call key.</Callout>}
      {key?.state === "function-call" && key.receiverId !== VAULT_ID && <Callout accent="warn">This key is restricted to {key.receiverId}, not this vault.</Callout>}
      {q.isError && <p className="m-0 text-xs text-ink-muted">Couldn&apos;t check the access key on chain.</p>}
    </>
  );
}

function TeeProof({ agent }: { agent: AgentView }) {
  const { canAct, busy, call } = useAgentTx();
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const tee = agent.tee;
  const revoked = agent.status === "Revoked";
  const bound = agent.account_id !== null;
  return (
    <>
      {!tee || !bound ? (
        <Callout accent="warn">
          Waiting for the worker to register (no attestation yet). Deploy the worker with <span className="mono">AGENT_ID={agent.id}</span>, and approve its measurements and hardware (PPID) on the Policy page.
        </Callout>
      ) : (
        <ShieldProof
          title="Enclave measurements"
          hash={measurementsLabel(tee.measurements)}
          approved={tee.valid}
          link={tee.valid ? "✓ attestation valid and still approved on Policy" : "Attestation is not valid, payments are refused"}
        />
      )}
      <Facts>
        <Fact label="Bound account">{bound ? <Hash value={agent.account_id!} /> : "none yet"}</Fact>
        <Fact label="Account pinned">{agent.account_pinned ? <Pill accent="ok">pinned</Pill> : <Pill accent={bound ? "warn" : "neutral"}>not pinned</Pill>}</Fact>
        {tee && (
          <>
            <Fact label="PPID">
              <span className="mono text-xs" title={tee.ppid}>
                {shortId(tee.ppid, 10, 6)}
              </span>
            </Fact>
            <Fact label="Valid until">{formatTime(tee.valid_until_ms)}</Fact>
            <Fact label="Measurements">
              <details>
                <summary className="cursor-pointer text-xs text-ink-secondary">Show all</summary>
                <pre className="mono m-0 mt-1 max-h-40 overflow-auto text-[11px] break-all whitespace-pre-wrap">{JSON.stringify(tee.measurements, null, 1)}</pre>
              </details>
            </Fact>
          </>
        )}
      </Facts>
      {tee && !tee.valid && (
        <Callout accent="warn">
          <ul className="m-0 list-disc pl-4">
            {tee.reasons.map((r) => (
              <li key={r}>{teeReasonText(r)}</li>
            ))}
          </ul>
        </Callout>
      )}
      {bound && !agent.account_pinned && !revoked && (
        <Callout
          accent="info"
          action={
            <Button size="sm" disabled={!canAct || busy} onClick={() => void call("pin_agent", { agent_id: agent.id })} title="1 yoctoNEAR">
              Pin account
            </Button>
          }
        >
          Verify that <span className="mono break-all">{agent.account_id}</span> is your enclave&apos;s account, then pin it. While unpinned, another valid enclave can take over this slot once the attestation expires.
        </Callout>
      )}
      {bound && !revoked && (
        <div>
          <Button size="sm" disabled={!canAct || busy} onClick={() => setConfirmUnbind(true)}>
            Unbind account
          </Button>
          <Modal
            open={confirmUnbind}
            onClose={() => setConfirmUnbind(false)}
            title={`Unbind ${agent.name}?`}
            footer={
              <>
                {busy && <SigningHint />}
                <Button onClick={() => setConfirmUnbind(false)}>Cancel</Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void call("unbind_agent", { agent_id: agent.id }).then((ok) => {
                      if (ok) setConfirmUnbind(false);
                    })
                  }
                >
                  Unbind
                </Button>
              </>
            }
          >
            The slot becomes free and the enclave must register again. Payments from <span className="mono break-all">{agent.account_id}</span> waiting for your approval are rejected. Scheduled dates stay payable. Needs 1 yoctoNEAR.
          </Modal>
        </div>
      )}
    </>
  );
}

/** Trust and proof (DESIGN_AGENTS §3.3): TEE measurements, PPID, validity and Pin/Unbind; Key account, public key and allowance. */
export function AgentTrustCard({ agent }: { agent: AgentView }) {
  const trust = trustOf(agent);
  return (
    <Card aria-labelledby="trust-title" className="flex flex-col gap-3">
      <CardHeader id="trust-title" title={agent.kind === "Tee" ? "Verified agent (TEE)" : "Connected agent (key)"} badge={<TrustLine trust={trust} />} />
      {agent.kind === "Tee" ? <TeeProof agent={agent} /> : <KeyAgentProof agent={agent} />}
    </Card>
  );
}
