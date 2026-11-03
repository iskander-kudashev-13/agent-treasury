import { useT } from "@/i18n";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Callout, Card, EmptyState, Icons, Segmented, Skeleton } from "@/kit";
import { BotRow, BotRowsSkeleton, ConnectHlRow, useTradingRows } from "@/features/trading/BotRows";
import { sortAgents } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { useAgents, usePolicy, useRejections } from "@/lib/useVault";
import { TRADING_NEW_PATH } from "@/lib/agentKind";
import { TRADER_AGENT_ID } from "@/lib/tradingClient";
import { useOwner } from "@/features/owner/OwnerProvider";
import { AgentRow } from "./AgentRow";
import { useMissedByAgent } from "./useAgentData";
import { useNow } from "@/lib/useNow";

type Kind = "all" | "payments" | "trading";
const KINDS: readonly string[] = ["all", "payments", "trading"];

function GroupHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mt-2 flex min-h-9 items-center justify-between gap-3">
      <h2 className="m-0 text-sm font-semibold text-ink-secondary">{title}</h2>
      {action}
    </div>
  );
}

/**
 * `/agents` body in two groups: payment agents (vault agents), then trading strategies (worker bots, ADR-0006). The vault
 * key agent that tops up the Hyperliquid account (`hl-trader`) belongs to trading, so it is listed there while the worker
 * has trading on. Revoked agents are dimmed at the bottom of their group. `?kind=` shows one group.
 */
export function AgentsList() {
  const t = useT();
  const navigate = useNavigate();
  const { canAct } = useOwner();
  const agents = useAgents();
  const rejections = useRejections();
  const policy = usePolicy();
  const missed = useMissedByAgent();
  const nowMs = useNow();
  const list = sortAgents(agents.data as AgentView[]);
  const trading = useTradingRows();
  const [params, setParams] = useSearchParams();
  const raw = params.get("kind") ?? "all";
  const kind: Kind = KINDS.includes(raw) ? (raw as Kind) : "all";
  const setKind = (k: Kind) => setParams(k === "all" ? {} : { kind: k }, { replace: true });
  const showPay = kind !== "trading";
  const showTrade = kind !== "payments" && trading.active;
  const grouped = kind === "all" && trading.active;

  const isFunding = (a: AgentView) => trading.active && a.id === TRADER_AGENT_ID;
  const payAgents = list.filter((a) => !isFunding(a));
  const fundingAgents = list.filter(isFunding);
  const row = (a: AgentView) => <AgentRow key={a.id} agent={a} rejections={rejections.data} missed={missed.get(a.id) ?? 0} vaultPaused={policy.data?.paused === true} nowMs={nowMs} />;

  const filter = trading.active && (
    <Segmented
      label={t("trading.bots.filterAria")}
      value={kind}
      onChange={setKind}
      options={[
        { value: "all", label: t("trading.bots.filterAll") },
        { value: "payments", label: t("trading.bots.filterPayments") },
        { value: "trading", label: t("trading.bots.kind") },
      ]}
    />
  );
  const canCreate = !trading.showConnect && !trading.loading;
  const newStrategy = canCreate && (
    <Button size="sm" variant="secondary" icon={<Icons.Plus size={14} />} disabled={!canAct} onClick={() => navigate(TRADING_NEW_PATH)}>
      {t("trading.bots.newStrategy")}
    </Button>
  );
  const tradingRows = showTrade && (
    <>
      {grouped ? <GroupHeader title={t("ag.group.trading")} action={newStrategy} /> : newStrategy && <div className="flex justify-end">{newStrategy}</div>}
      {trading.loading && <BotRowsSkeleton />}
      {trading.bots.map((b) => (
        <BotRow key={b.id} bot={b} />
      ))}
      {trading.showConnect && <ConnectHlRow />}
      {fundingAgents.length > 0 && (
        <>
          <div className="mt-1 text-xs text-ink-muted">{t("ag.group.funding")}</div>
          {fundingAgents.map(row)}
        </>
      )}
    </>
  );

  const payList = kind === "payments" || !trading.active ? list : payAgents;
  const payEmpty = showPay && payList.length === 0;
  const payHeader = grouped && <GroupHeader title={t("ag.group.payments")} />;
  if (agents.loading && list.length === 0 && showPay) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {filter}
        {payHeader}
        <Skeleton className="h-36" />
        {tradingRows}
      </div>
    );
  }
  if (agents.error && list.length === 0 && showPay) return <Callout accent="danger">{t("ag.couldntLoadAgentsMsg", { msg: agents.error })}</Callout>;
  return (
    <div className="flex flex-col gap-3">
      {filter}
      {showPay && payHeader}
      {showPay && payList.map(row)}
      {payEmpty && grouped && (
        <button
          type="button"
          disabled={!canAct}
          onClick={() => navigate("/agents/new?type=payments")}
          className="flex cursor-pointer items-center gap-3 rounded-card border border-dashed border-line bg-surface p-4 text-left text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Icons.Plus size={16} className="shrink-0 text-ink-muted" />
          <span className="min-w-0 flex-1 text-sm text-ink-secondary">{t("ag.group.paymentsEmpty")}</span>
          <Icons.ChevronRight size={16} className="shrink-0 text-ink-muted" />
        </button>
      )}
      {payEmpty && !grouped && (
        <Card padding="none">
          <EmptyState
            title={t("treasury.noAgents")}
            action={
              <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct} onClick={() => navigate("/agents/new?type=payments")}>
                {t("page.addAgent")}
              </Button>
            }
          >
            {t("ag.noAgentsHint2")}
          </EmptyState>
        </Card>
      )}
      {tradingRows}
    </div>
  );
}
