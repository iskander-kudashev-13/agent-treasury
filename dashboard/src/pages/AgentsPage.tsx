import { useT } from "@/i18n";
import { useNavigate } from "react-router-dom";
import { AgentsList, Rejections } from "@/features/agents/Agents";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useRejections } from "@/lib/useVault";
import { Button, Icons, Page } from "@/kit";

/** `/agents` — agent cards (DESIGN_AGENTS §3.1) + the vault-wide refusal log. */
export function AgentsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { canAct } = useOwner();
  const rejections = useRejections();
  return (
    <Page
      title={t("nav.agents")}
      actions={
        <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct} title={canAct ? undefined : t("page.onlyOwnerAddAgents")} onClick={() => navigate("/agents/new")}>
          {t("page.addAgent")}
        </Button>
      }
    >
      <QueryErrors sources={[{ label: t("src.rejections"), ...rejections }]} />
      <AgentsList />
      <Rejections rejections={rejections.data} />
    </Page>
  );
}
