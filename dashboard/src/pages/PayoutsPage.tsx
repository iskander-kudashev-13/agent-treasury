import { useT } from "@/i18n";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { PayoutFilters, PayoutList } from "@/features/payouts/Payouts";
import { filterPayouts, isFiltered, NO_FILTER, type PayoutFilter, type SourceFilter, type StatusFilter } from "@/lib/payoutView";
import { PAYOUT_PAGE, useAgents, usePayouts, useRecipients } from "@/lib/useVault";
import { Button, Page } from "@/kit";

const STATUSES: StatusFilter[] = ["all", "needs_approval", "in_progress", "confirmed", "failed", "refunded", "rejected"];
const SOURCES: SourceFilter[] = ["all", "scheduled", "on-demand"];

/** `/payouts` — full history with status / agent / source filters (also via `?status=&agent=&source=`). */
export function PayoutsPage() {
  const t = useT();
  const [limit, setLimit] = useState(PAYOUT_PAGE);
  const [params, setParams] = useSearchParams();
  const payouts = usePayouts(limit);
  const recipients = useRecipients();
  const agents = useAgents();

  const status = params.get("status") as StatusFilter | null;
  const source = params.get("source") as SourceFilter | null;
  const filter: PayoutFilter = {
    status: status && STATUSES.includes(status) ? status : "all",
    agent: params.get("agent") ?? "all",
    source: source && SOURCES.includes(source) ? source : "all",
  };
  const setFilter = (f: PayoutFilter) => {
    const next = new URLSearchParams();
    if (f.status !== "all") next.set("status", f.status);
    if (f.agent !== "all") next.set("agent", f.agent);
    if (f.source !== "all") next.set("source", f.source);
    setParams(next, { replace: true });
  };

  const shown = filterPayouts(payouts.data.list, filter);
  const more = payouts.data.list.length < payouts.data.total;
  return (
    <Page title={t("nav.payouts")}>
      <QueryErrors sources={[{ label: t("src.payouts"), ...payouts }, { label: t("src.recipients"), ...recipients }, { label: t("src.agents"), ...agents }]} />
      <PayoutList
        title={isFiltered(filter) ? t("page.payoutsCountFiltered", { shown: shown.length, total: payouts.data.total }) : t("page.payoutsCount", { n: payouts.data.total })}
        payouts={shown}
        total={payouts.data.total}
        recipients={recipients.data}
        agents={agents.data}
        headerExtra={<PayoutFilters value={filter} onChange={setFilter} agents={agents.data} />}
        emptyHint={isFiltered(filter) ? (more ? t("page.noMatchLoaded") : t("page.noMatch")) : undefined}
        actions={isFiltered(filter) ? <Button size="sm" variant="ghost" onClick={() => setFilter(NO_FILTER)}>{t("page.clearFilters")}</Button> : undefined}
        {...(more ? { onMore: () => setLimit((n) => n + PAYOUT_PAGE) } : {})}
      />
      {isFiltered(filter) && (
        <p className="m-0 text-xs text-ink-subtle">
          {t("page.filtersApplyTo", { loaded: payouts.data.list.length, total: payouts.data.total })}
        </p>
      )}
    </Page>
  );
}
