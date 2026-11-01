import { Link, useParams } from "react-router-dom";
import { AgentDetail } from "@/features/agents/AgentDetail";
import { Page } from "@/kit";

/** `/agents/:id` — header, mandate, budget, trust, activity, danger zone (DESIGN_AGENTS §3.3). */
export function AgentDetailPage() {
  const { id = "" } = useParams();
  return (
    <Page actions={<Link to="/agents">← All agents</Link>}>
      <AgentDetail id={id} />
    </Page>
  );
}
