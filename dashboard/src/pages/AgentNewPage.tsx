import { Link } from "react-router-dom";
import { AddAgentWizard } from "@/features/agents/AddAgentWizard";
import { Page } from "@/kit";

/** `/agents/new` — Type, Identity, Mandate, Review & sign (+ Connect for new key agents). */
export function AgentNewPage() {
  return (
    <Page title="Add agent" actions={<Link to="/agents">← Back to agents</Link>}>
      <AddAgentWizard />
    </Page>
  );
}
