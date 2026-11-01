import { useNavigate } from "react-router-dom";
import { AgentsList, Rejections } from "@/features/agents/Agents";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useRejections } from "@/lib/useVault";
import { Button, Icons, Page } from "@/kit";

/** `/agents` — agent cards (DESIGN_AGENTS §3.1) + the vault-wide refusal log. */
export function AgentsPage() {
  const navigate = useNavigate();
  const { canAct } = useOwner();
  const rejections = useRejections();
  return (
    <Page
      title="Agents"
      actions={
        <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct} title={canAct ? undefined : "Only the vault owner can add agents"} onClick={() => navigate("/agents/new")}>
          Add agent
        </Button>
      }
    >
      <QueryErrors sources={[{ label: "rejections", ...rejections }]} />
      <AgentsList />
      <Rejections rejections={rejections.data} />
    </Page>
  );
}
