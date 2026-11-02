import { useT } from "@/i18n";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Callout, Card, EmptyState, Icons, Segmented, Skeleton } from "@/kit";
import { BotRow, BotRowsSkeleton, ConnectHlRow, useTradingRows } from "@/features/trading/BotRows";
import { sortAgents } from "@/lib/agentView";
import type { AgentView } from "@/lib/types";
import { useAgents, usePolicy, useRejections } from "@/lib/useVault";
import { useOwner } from "@/features/owner/OwnerProvider";
import { AgentRow } from "./AgentRow";
import { useMissedByAgent } from "./useAgentData";
import { useNow } from "@/lib/useNow";

type Kind = "all" | "payments" | "trading";
const KINDS: readonly string[] = ["all", "payments", "trading"];

/** `/agents` body: one card per agent (payments, then trading bots), revoked ones dimmed at the bottom. `?kind=` filters. */

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
  const showTrade = kind !== "payments";
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
  const tradingRows = showTrade && (
    <>
      {trading.loading && <BotRowsSkeleton />}
      {trading.bots.map((b) => (
        <BotRow key={b.id} bot={b} />
      ))}
      {trading.showConnect && <ConnectHlRow />}
    </>
  );

  const payEmpty = showPay && list.length === 0 && (kind === "payments" || trading.bots.length === 0);
  if (agents.loading && list.length === 0 && showPay) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {filter}
        <Skeleton className="h-36" />
        {tradingRows}
      </div>
    );
  }
  if (agents.error && list.length === 0 && showPay) return <Callout accent="danger">{t("ag.couldntLoadAgentsMsg", { msg: agents.error })}</Callout>;
  return (
    <div className="flex flex-col gap-3">
      {filter}
      {showPay && list.map((a) => <AgentRow key={a.id} agent={a} rejections={rejections.data} missed={missed.get(a.id) ?? 0} vaultPaused={policy.data?.paused === true} nowMs={nowMs} />)}
      {payEmpty && (
        <Card padding="none">
          <EmptyState
            title={t("treasury.noAgents")}
            action={
              <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct} onClick={() => navigate("/agents/new")}>
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
