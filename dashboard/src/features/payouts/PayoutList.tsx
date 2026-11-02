import { useT } from "@/i18n";
import { useState } from "react";
import { Link } from "react-router-dom";
import { agoText } from "@/lib/dates";
import { ONECLICK_SIMULATED } from "@/lib/config";
import { isSimulatedPayout } from "@/lib/oneclickStatus";
import { usdcGrouped } from "@/lib/amount";
import { intentsTrackUrl, payoutLabel, payoutSource } from "@/lib/payoutView";
import { payoutStatusInfo, toneAccent } from "@/lib/status";
import type { AgentView, Payout, RecipientView } from "@/lib/types";
import { Button, Card, CardHeader, ChainBadge, EmptyState, Pill, SourceTag } from "@/kit";
import { agentLabel } from "./ApprovalBanner";

/** One payout row: desktop = columns, mobile = two stacked lines. Labels, memos and names are untrusted text. */
function Row({ p, recipients, agents, now }: { p: Payout; recipients: RecipientView[]; agents: AgentView[]; now: number }) {
  const t = useT();
  const s = payoutStatusInfo(p.status);
  // Simulated (testnet) payouts never reach Intents: no Track link.
  const tracked = p.deposit_address && !isSimulatedPayout(p, ONECLICK_SIMULATED) && (p.status === "Sent" || p.status === "Confirmed" || p.status === "Refunded");
  return (
    <li className="at-row row-in flex flex-col gap-1.5 border-b border-track px-4 py-3 text-sm last:border-b-0 md:grid md:grid-cols-[130px_minmax(0,1.6fr)_110px_120px_100px_150px] md:items-center md:gap-3 md:px-5">
      <div className="flex items-center gap-2 md:block">
        <Pill accent={toneAccent(s.tone)} title={s.hint}>
          {s.label}
        </Pill>
        <span className="ml-auto text-xs text-ink-muted md:hidden">{agoText(p.updated_at_ms, now)}</span>
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{payoutLabel(p, recipients, agents)}</div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>{agentLabel(agents, p.agent_id)}</span>
          <SourceTag source={payoutSource(p)} />
          {p.memo && <span className="max-w-[240px] truncate">“{p.memo}”</span>}
        </div>
      </div>
      <div className="mono font-semibold md:text-right">{usdcGrouped(p.amount)}</div>
      <div>
        <ChainBadge chain={p.chain} arrow />
      </div>
      <div className="hidden text-[13px] text-ink-muted md:block">{agoText(p.updated_at_ms, now)}</div>
      <div className="flex justify-end gap-3.5 text-[13px]">
        {tracked && (
          <a href={intentsTrackUrl(p.deposit_address ?? "")} target="_blank" rel="noreferrer">
            {t("po.track")}
          </a>
        )}
        <Link to={`/payouts/${p.id}`} className="text-ink">
          {t("po.details")}
        </Link>
      </div>
    </li>
  );
}

/** Payout feed card: latest on Treasury, filtered history on /payouts. */
export function PayoutList({
  title,
  payouts,
  total,
  recipients,
  agents,
  actions,
  onMore,
  emptyHint,
  headerExtra,
}: {
  title: string;
  payouts: Payout[];
  total?: number;
  recipients: RecipientView[];
  agents: AgentView[];
  actions?: React.ReactNode;
  onMore?: () => void;
  emptyHint?: string;
  headerExtra?: React.ReactNode;
}) {
  const t = useT();
  const [now] = useState(() => Date.now());
  return (
    <Card padding="none" aria-labelledby="payouts-title">
      <CardHeader className="px-5 py-4" id="payouts-title" title={title} actions={actions} />
      {headerExtra}
      {payouts.length === 0 ? (
        <EmptyState title={t("po.noPayouts")}>{emptyHint ?? t("page.agentsNoPayouts")}</EmptyState>
      ) : (
        <ul className="m-0 list-none border-t border-track p-0">
          {payouts.map((p) => (
            <Row key={p.id} p={p} recipients={recipients} agents={agents} now={now} />
          ))}
        </ul>
      )}
      {onMore && total !== undefined && (
        <div className="border-t border-track px-5 py-3">
          <Button onClick={onMore}>{t("po.loadOlder")}</Button>
        </div>
      )}
    </Card>
  );
}
