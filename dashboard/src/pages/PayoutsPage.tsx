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
    <Page title="Payouts">
      <QueryErrors sources={[{ label: "payouts", ...payouts }, { label: "recipients", ...recipients }, { label: "agents", ...agents }]} />
      <PayoutList
        title={`Payouts (${isFiltered(filter) ? `${shown.length} of ${payouts.data.total}` : payouts.data.total})`}
        payouts={shown}
        total={payouts.data.total}
        recipients={recipients.data}
        agents={agents.data}
        headerExtra={<PayoutFilters value={filter} onChange={setFilter} agents={agents.data} />}
        emptyHint={isFiltered(filter) ? (more ? "No loaded payout matches these filters. Load older payouts or change the filters." : "No payout matches these filters.") : undefined}
        actions={isFiltered(filter) ? <Button size="sm" variant="ghost" onClick={() => setFilter(NO_FILTER)}>Clear filters</Button> : undefined}
        {...(more ? { onMore: () => setLimit((n) => n + PAYOUT_PAGE) } : {})}
      />
      {isFiltered(filter) && (
        <p className="m-0 text-xs text-ink-subtle">
          Filters apply to the {payouts.data.list.length} newest of {payouts.data.total} payouts loaded so far.
        </p>
      )}
    </Page>
  );
}
