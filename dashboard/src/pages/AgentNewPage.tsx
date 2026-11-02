import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { AddAgentWizard } from "@/features/agents/AddAgentWizard";
import { Page } from "@/kit";

/** `/agents/new` — Type, Identity, Mandate, Review & sign (+ Connect for new key agents). */
export function AgentNewPage() {
  const t = useT();
  return (
    <Page title={t("page.addAgent")} actions={<Link to="/agents">{t("page.backToAgents")}</Link>}>
      <AddAgentWizard />
    </Page>
  );
}
