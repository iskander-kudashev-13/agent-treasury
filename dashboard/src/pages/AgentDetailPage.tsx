import { useT } from "@/i18n";
import { Link, useParams } from "react-router-dom";
import { AgentDetail } from "@/features/agents/AgentDetail";
import { Page } from "@/kit";

/** `/agents/:id` — header, mandate, budget, trust, activity, danger zone (DESIGN_AGENTS §3.3). */
export function AgentDetailPage() {
  const t = useT();
  const { id = "" } = useParams();
  return (
    <Page actions={<Link to="/agents">{t("page.allAgents")}</Link>}>
      <AgentDetail id={id} />
    </Page>
  );
}
