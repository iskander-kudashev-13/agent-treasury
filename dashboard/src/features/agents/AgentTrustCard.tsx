import { useT, rich } from "@/i18n";
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
  const t = useT();
  const acc = agent.account_id;
  const pk = agent.public_key;
  const q = useQuery({ queryKey: ["agent-access-key", NETWORK, acc, pk], queryFn: () => viewAccessKey(acc!, pk!), enabled: Boolean(acc && pk), refetchInterval: 30_000, retry: false });
  const key = q.data;
  return (
    <>
      <Facts>
        <Fact label={t("ag.account")}>
          {acc ? (
            <a className="mono text-xs break-all" href={explorerAddressUrl(acc)} target="_blank" rel="noreferrer">
              {acc}
            </a>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label={t("ag.publicKey")}>{pk ? <Hash value={pk} /> : t("ag.notRecorded")}</Fact>
        <Fact label={t("ag.allowedMethods")}>
          {rich("ag.methodsOn", { methods: <span className="mono text-xs">{KEY_AGENT_METHODS.join(", ")}</span>, vault: <span className="mono text-xs">{VAULT_ID}</span> })}
        </Fact>
        {key?.state === "function-call" && (
          <Fact label={t("ag.allowanceLeft")}>{key.allowanceYocto ? `${formatNear(key.allowanceYocto)} NEAR` : t("ag.unlimited")}</Fact>
        )}
      </Facts>
      {key?.state === "missing" && agent.status !== "Revoked" && <Callout accent="warn">{t("ag.keyMissing")}</Callout>}
      {key?.state === "full-access" && <Callout accent="warn">{t("ag.keyFull")}</Callout>}
      {key?.state === "function-call" && key.receiverId !== VAULT_ID && <Callout accent="warn">{t("ag.keyWrongReceiver", { receiver: key.receiverId })}</Callout>}
      {q.isError && <p className="m-0 text-xs text-ink-muted">{t("ag.keyCheckFailed")}</p>}
    </>
  );
}

function TeeProof({ agent }: { agent: AgentView }) {
  const t = useT();
  const { canAct, busy, call } = useAgentTx();
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const tee = agent.tee;
  const revoked = agent.status === "Revoked";
  const bound = agent.account_id !== null;
  return (
    <>
      {!tee || !bound ? (
        <Callout accent="warn">
          {rich("ag.teeWaiting", { agentId: <span className="mono">AGENT_ID={agent.id}</span> })}
        </Callout>
      ) : (
        <ShieldProof
          title={t("ag.enclaveMeasurements")}
          hash={measurementsLabel(tee.measurements)}
          approved={tee.valid}
          link={tee.valid ? t("ag.attValid") : t("ag.attInvalid")}
        />
      )}
      <Facts>
        <Fact label={t("ag.boundAccount")}>{bound ? <Hash value={agent.account_id!} /> : t("ag.noneYet")}</Fact>
        <Fact label={t("ag.accountPinned")}>{agent.account_pinned ? <Pill accent="ok">{t("ag.pinned")}</Pill> : <Pill accent={bound ? "warn" : "neutral"}>{t("ag.notPinned")}</Pill>}</Fact>
        {tee && (
          <>
            <Fact label="PPID">
              <span className="mono text-xs" title={tee.ppid}>
                {shortId(tee.ppid, 10, 6)}
              </span>
            </Fact>
            <Fact label={t("ag.validUntil")}>{formatTime(tee.valid_until_ms)}</Fact>
            <Fact label={t("ag.measurements")}>
              <details>
                <summary className="cursor-pointer text-xs text-ink-secondary">{t("ag.showAll")}</summary>
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
            <Button size="sm" disabled={!canAct || busy} onClick={() => void call("pin_agent", { agent_id: agent.id })} title={t("ag.pinTitle")}>
              {t("ag.pinAccount")}
            </Button>
          }
        >
          {rich("ag.pinHint", { account: <span className="mono break-all">{agent.account_id}</span> })}
        </Callout>
      )}
      {bound && !revoked && (
        <div>
          <Button size="sm" disabled={!canAct || busy} onClick={() => setConfirmUnbind(true)}>
            {t("ag.unbindAccount")}
          </Button>
          <Modal
            open={confirmUnbind}
            onClose={() => setConfirmUnbind(false)}
            title={t("ag.unbindTitle", { name: agent.name })}
            footer={
              <>
                {busy && <SigningHint />}
                <Button onClick={() => setConfirmUnbind(false)}>{t("common.cancel")}</Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void call("unbind_agent", { agent_id: agent.id }).then((ok) => {
                      if (ok) setConfirmUnbind(false);
                    })
                  }
                >
                  {t("ag.unbind")}
                </Button>
              </>
            }
          >
            {rich("ag.unbindBody", { account: <span className="mono break-all">{agent.account_id}</span> })}
          </Modal>
        </div>
      )}
    </>
  );
}

/** Trust and proof (DESIGN_AGENTS §3.3): TEE measurements, PPID, validity and Pin/Unbind; Key account, public key and allowance. */
export function AgentTrustCard({ agent }: { agent: AgentView }) {
  const t = useT();
  const trust = trustOf(agent);
  return (
    <Card aria-labelledby="trust-title" className="flex flex-col gap-3">
      <CardHeader id="trust-title" title={agent.kind === "Tee" ? t("ag.verifiedTee") : t("ag.connectedKey")} badge={<TrustLine trust={trust} />} />
      {agent.kind === "Tee" ? <TeeProof agent={agent} /> : <KeyAgentProof agent={agent} />}
    </Card>
  );
}
