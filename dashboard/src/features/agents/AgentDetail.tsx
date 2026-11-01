import { relativeTime } from "@/lib/relativeTime";
import { Link } from "react-router-dom";
import { Button, Callout, Card, EmptyState, Icons, Skeleton, StatusPill } from "@/kit";
import { stateOf, trustOf } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { useAgents, usePolicy } from "@/lib/useVault";
import { AgentActivity } from "./AgentActivity";
import { AgentBudgetCard } from "./AgentBudgetCard";
import { AgentDanger } from "./AgentDanger";
import { AgentMandateCard } from "./AgentMandateCard";
import { AgentTrustCard } from "./AgentTrustCard";
import { PauseResume } from "./PauseResume";
import { TrustLine } from "./parts";
import { useAgentMissed } from "./useAgentData";
import { useAgentTx } from "./useAgentTx";
import { useNow } from "@/lib/useNow";

/** Header of `/agents/:id`: name, status, trust line, Pause/Resume. */
export function AgentHeader({ agent, vaultPaused }: { agent: AgentView; vaultPaused: boolean }) {
  const nowMs = useNow();
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-3">
      {trustOf(agent).kind === "tee" ? <Icons.ShieldCheck size={28} className={trustOf(agent).tone === "ok" ? "text-ok" : "text-warn"} aria-hidden="true" /> : <Icons.KeyRound size={28} className="text-ink-muted" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="m-0 text-xl font-semibold">{agent.name}</h2>
          <span className="mono text-xs text-ink-muted">{agent.id}</span>
          {vaultPaused && agent.status !== "Revoked" ? <StatusPill state="paused" label="Vault paused" /> : <StatusPill state={stateOf(agent)} />}
        </div>
        <TrustLine trust={trustOf(agent)} />
        <div className="text-xs text-ink-muted">last request {relativeTime(agent.last_request_at, nowMs)}</div>
      </div>
      <PauseResume agent={agent} vaultPaused={vaultPaused} size="md" />
    </Card>
  );
}

function ResetFailures({ agent }: { agent: AgentView }) {
  const { canAct, busy, call } = useAgentTx();
  if (agent.failed_transfers === 0) return null;
  return (
    <Callout
      accent="warn"
      action={
        <Button size="sm" disabled={!canAct || busy} onClick={() => void call("reset_agent_failures", { agent_id: agent.id })}>
          Reset failures
        </Button>
      }
    >
      {agent.failed_transfers} transfer{agent.failed_transfers === 1 ? "" : "s"} failed in a row. After 3 this agent&apos;s requests are refused until you reset the counter.
    </Callout>
  );
}

/** `/agents/:id` body (DESIGN_AGENTS §3.3). */
export function AgentDetail({ id }: { id: string }) {
  const agents = useAgents();
  const policy = usePolicy();
  const missed = useAgentMissed(id);
  const agent = (agents.data as AgentView[]).find((a) => a.id === id);

  if (!agent) {
    if (agents.loading) return <Skeleton className="h-48" />;
    return (
      <Card padding="none">
        <EmptyState title={agents.error ? "Couldn't load agents" : "Agent not found"} action={<Link to="/agents">← Back to agents</Link>}>
          {agents.error ?? `There is no agent with id "${id}" in this vault.`}
        </EmptyState>
      </Card>
    );
  }
  const vaultPaused = policy.data?.paused === true;
  const revoked = agent.status === "Revoked";
  return (
    <>
      <AgentHeader agent={agent} vaultPaused={vaultPaused} />
      {agent.status === "Paused" && <Callout accent="warn">{agent.name} is paused. Payments already waiting for your approval stay actionable; nothing new is paid until you resume.</Callout>}
      {agent.open_approvals > 0 && <Callout accent="warn" icon={<Icons.Clock size={15} />} action={<Link to="/payouts">Review</Link>}>{agent.open_approvals} payment{agent.open_approvals === 1 ? " is" : "s are"} waiting for your approval.</Callout>}
      {missed.missed.length > 0 && (
        <Callout accent="warn" action={<Link to="/payments?tab=scheduled">View schedule</Link>}>
          Missed {missed.missed.length} scheduled payment{missed.missed.length === 1 ? "" : "s"}. {agent.name} was offline or couldn&apos;t pay on the due date; overdue payments need your approval.
        </Callout>
      )}
      <ResetFailures agent={agent} />
      <AgentMandateCard agent={agent} />
      {!revoked && <AgentBudgetCard agent={agent} />}
      <AgentTrustCard agent={agent} />
      <AgentActivity agentId={agent.id} />
      <AgentDanger agent={agent} />
    </>
  );
}
