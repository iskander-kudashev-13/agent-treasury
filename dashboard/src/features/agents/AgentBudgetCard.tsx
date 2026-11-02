import { useT } from "@/i18n";
import { Card, CardHeader, Skeleton, SpendBar, Stat, Tile } from "@/kit";
import { formatUsdc } from "@/lib/amount";
import { usdcGrouped } from "@/lib/amount";
import type { AgentView } from "@/lib/types";
import { useAgentBudget } from "./useAgentData";

/** Spend today against the agent's own limit, and what is left (get_agent_budget). */
export function AgentBudgetCard({ agent }: { agent: AgentView }) {
  const t = useT();
  const b = useAgentBudget(agent.id);
  const spent = Number(agent.spent_today) / 1e6;
  const limit = Number(agent.mandate.daily_limit) / 1e6;
  const over = BigInt(agent.spent_today) >= BigInt(agent.mandate.daily_limit);
  return (
    <Card aria-labelledby="budget-title" className="flex flex-col gap-3">
      <CardHeader id="budget-title" title={t("ag.budgetToday")} />
      <SpendBar scope="agent" label={t("treasury.spentToday")} spent={spent} limit={limit} spentText={formatUsdc(agent.spent_today, 0)} limitText={`${formatUsdc(agent.mandate.daily_limit, 0)} USDC`} />
      {over && <p className="m-0 text-xs text-ink-muted">{t("ag.noMoreToday")}</p>}
      {b.loading ? (
        <Skeleton className="h-16" />
      ) : b.data ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile>
            <Stat size="sm" label={t("ag.canStillSpend")} value={`${usdcGrouped(b.data.remaining_today, 0)} USDC`} sub={BigInt(b.data.vault_remaining_today) < BigInt(agent.mandate.daily_limit) ? t("ag.limitedByVault") : undefined} />
          </Tile>
          <Tile>
            <Stat size="sm" label={t("ag.paymentsToday")} value={`${b.data.payments_today} / ${b.data.max_payments_per_day}`} />
          </Tile>
          <Tile>
            <Stat size="sm" label={t("ag.perPayment")} value={`${usdcGrouped(b.data.per_tx_limit, 0)} USDC`} />
          </Tile>
          <Tile>
            <Stat size="sm" label={t("ag.requestsWaiting")} value={String(agent.open_approvals)} sub={t("ag.forApproval")} />
          </Tile>
        </div>
      ) : null}
      {b.data?.vault_paused && <p className="m-0 text-xs text-warn">{t("ag.vaultPausedNoPay")}</p>}
      {agent.failed_transfers > 0 && <p className="m-0 text-xs text-ink-muted">{t("ag.failedConsecutive", { n: agent.failed_transfers })}</p>}
    </Card>
  );
}
