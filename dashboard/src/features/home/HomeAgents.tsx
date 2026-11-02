import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { usdcGrouped } from "@/lib/amount";
import { agentPath } from "@/lib/agentKind";
import { spendNumbers, stateOf } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { Button, Card, CardHeader, EmptyState, Pill, SpendBar, StatusPill } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

/** Agents: active / paused counts and one compact row each. Trading agents join here via `agentPath`. */
export function HomeAgents({ agents, vaultPaused }: { agents: AgentView[]; vaultPaused: boolean }) {
  const t = useT();
  const { canAct } = useOwner();
  const live = agents.filter((a) => a.status !== "Revoked");
  const paused = live.filter((a) => a.status === "Paused").length;
  return (
    <Card aria-labelledby="h-agents" className="flex flex-col gap-3">
      <CardHeader
        id="h-agents"
        title={t("treasury.agentsTitle")}
        badge={
          live.length > 0 && (
            <>
              <Pill accent="ok">{t("home.activeN", { n: live.length - paused })}</Pill>
              {paused > 0 && <Pill accent="warn">{t("home.pausedN", { n: paused })}</Pill>}
            </>
          )
        }
        actions={<Link to="/agents" className="text-[13px]">{t("treasury.viewAll")}</Link>}
      />
      {live.length === 0 ? (
        <EmptyState
          title={t("treasury.noAgents")}
          action={canAct ? <Link to="/agents/new"><Button variant="primary">{t("page.addAgent")}</Button></Link> : undefined}
        >
          {t("treasury.noAgentsHint")}
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {live.slice(0, 5).map((a) => {
            const { spent, limit } = spendNumbers(a);
            return (
              <li key={a.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Link to={agentPath(a)} className="min-w-0 flex-1 truncate font-medium text-ink">{a.name}</Link>
                  {a.open_approvals > 0 && <Pill accent="warn">{t("treasury.toApprove", { n: a.open_approvals })}</Pill>}
                  {vaultPaused ? <StatusPill state="paused" label={t("treasury.vaultPaused")} /> : <StatusPill state={stateOf(a)} />}
                </div>
                <SpendBar scope="agent" label={t("ag.today")} spent={spent} limit={limit} spentText={usdcGrouped(a.spent_today, 0)} limitText={`${usdcGrouped(a.mandate.daily_limit, 0)} USDC`} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
