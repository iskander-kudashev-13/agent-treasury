import { useT } from "@/i18n";
import { Link, useSearchParams } from "react-router-dom";
import { AddAgentWizard } from "@/features/agents/AddAgentWizard";
import { AgentTypeChooser } from "@/features/agents/AgentTypeChooser";
import { Page } from "@/kit";

/** `/agents/new` — first "what will the agent do" (payments or trading); `?type=payments` is the vault-agent wizard. */
export function AgentNewPage() {
  const t = useT();
  const [params] = useSearchParams();
  const payments = params.get("type") === "payments";
  return (
    <Page title={t("page.addAgent")} actions={<Link to={payments ? "/agents/new" : "/agents"}>{payments ? t("common.back") : t("page.backToAgents")}</Link>}>
      {payments ? <AddAgentWizard /> : <AgentTypeChooser />}
    </Page>
  );
}
