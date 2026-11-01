import { useNavigate } from "react-router-dom";
import { Button, Callout, Card, EmptyState, Icons, Skeleton } from "@/kit";
import { sortAgents } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { useAgents, usePolicy, useRejections } from "@/lib/useVault";
import { useOwner } from "@/features/owner/OwnerProvider";
import { AgentRow } from "./AgentRow";
import { useMissedByAgent } from "./useAgentData";
import { useNow } from "@/lib/useNow";

/** `/agents` body: one card per agent, revoked ones dimmed at the bottom. */
export function AgentsList() {
  const navigate = useNavigate();
  const { canAct } = useOwner();
  const agents = useAgents();
  const rejections = useRejections();
  const policy = usePolicy();
  const missed = useMissedByAgent();
  const nowMs = useNow();
  const list = sortAgents(agents.data as AgentView[]);

  if (agents.loading && list.length === 0) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    );
  }
  if (agents.error && list.length === 0) return <Callout accent="danger">Couldn&apos;t load agents: {agents.error}</Callout>;
  if (list.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          title="No agents yet"
          action={
            <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct} onClick={() => navigate("/agents/new")}>
              Add agent
            </Button>
          }
        >
          No agents yet. Connect your first agent — it will only be able to spend within the limits you set.
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {list.map((a) => (
        <AgentRow key={a.id} agent={a} rejections={rejections.data} missed={missed.get(a.id) ?? 0} vaultPaused={policy.data?.paused === true} nowMs={nowMs} />
      ))}
    </div>
  );
}
