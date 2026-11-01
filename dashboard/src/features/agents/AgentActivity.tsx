import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardHeader, ChainBadge, EmptyState, Icons, Pill, ReasonChip, Skeleton, SourceTag, Tabs } from "@/kit";
import { formatUsdc } from "@/lib/amount";
import { formatTime } from "@/lib/format";
import { refusedTitle } from "@/lib/reasonCodes";
import { payoutStatusInfo, toneAccent } from "@/lib/status";
import { shortId } from "@/kit/tokens";
import type { Payout, Rejection } from "@/lib/types";
import { useAgentPayouts, useAgentRejections } from "./useAgentData";

type Filter = "all" | "paid" | "pending" | "rejected";

type Item = { kind: "payout"; at: number; payout: Payout } | { kind: "rejection"; at: number; rejection: Rejection };

/** Merge the agent's payouts and refusals, newest first (pure, exported for tests). */
export function mergeActivity(payouts: readonly Payout[], rejections: readonly Rejection[]): Item[] {
  const items: Item[] = [...payouts.map((p) => ({ kind: "payout" as const, at: Number(p.created_at_ms), payout: p })), ...rejections.map((r) => ({ kind: "rejection" as const, at: Number(r.at), rejection: r }))];
  return items.sort((a, b) => b.at - a.at);
}

export function filterActivity(items: Item[], f: Filter): Item[] {
  if (f === "all") return items;
  return items.filter((i) => {
    if (f === "rejected") return i.kind === "rejection" || (i.kind === "payout" && i.payout.status === "Rejected");
    if (i.kind === "rejection") return false;
    if (f === "pending") return i.payout.status === "PendingApproval";
    return ["Transferring", "Sent", "Confirmed"].includes(i.payout.status);
  });
}

function Row({ item }: { item: Item }) {
  if (item.kind === "rejection") {
    const r = item.rejection;
    return (
      <li className="flex gap-3 border-t border-track py-3 first:border-t-0">
        <Icons.Pause size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{refusedTitle(r.reason)}</span>
            <ReasonChip code={r.reason} />
            <span className="mono ml-auto text-sm">{formatUsdc(r.amount)} USDC</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <ChainBadge chain={r.chain} />
            <span className="mono" title={r.address}>
              {shortId(r.address, 8, 6)}
            </span>
            <span>{formatTime(r.at)}</span>
          </div>
          {r.detail && <p className="m-0 mt-1 text-xs text-ink-secondary">{r.detail}</p>}
        </div>
      </li>
    );
  }
  const p = item.payout;
  const info = payoutStatusInfo(p.status);
  return (
    <li className="flex gap-3 border-t border-track py-3 first:border-t-0">
      {p.status === "PendingApproval" ? <Icons.Clock size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" /> : p.status === "Confirmed" ? <Icons.Check size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" /> : <Icons.Send size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link to={`/payouts/${p.id}`} className="mono font-medium">
            #{p.id}
          </Link>
          <Pill accent={toneAccent(info.tone)} title={info.hint}>
            {info.label}
          </Pill>
          <SourceTag source={p.schedule_id !== null ? "scheduled" : "on-demand"} />
          <span className="mono ml-auto text-sm">{formatUsdc(p.amount)} USDC</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <ChainBadge chain={p.chain} arrow />
          <span className="mono" title={p.address}>
            {shortId(p.address, 8, 6)}
          </span>
          <span>{formatTime(p.created_at_ms)}</span>
        </div>
        {p.memo && <p className="m-0 mt-1 text-xs text-ink-secondary italic">{p.memo}</p>}
        {p.status === "PendingApproval" && (
          <p className="m-0 mt-1 text-xs">
            <Link to={`/payouts/${p.id}`}>Review and approve or reject →</Link>
          </p>
        )}
      </div>
    </li>
  );
}

/** Unified timeline of this agent's requests, newest first (DESIGN_AGENTS §3.3). */
export function AgentActivity({ agentId }: { agentId: string }) {
  const payouts = useAgentPayouts(agentId);
  const rejections = useAgentRejections(agentId);
  const [filter, setFilter] = useState<Filter>("all");
  const all = useMemo(() => mergeActivity(payouts.list, rejections.list), [payouts.list, rejections.list]);
  const shown = useMemo(() => filterActivity(all, filter), [all, filter]);
  const pendingCount = all.filter((i) => i.kind === "payout" && i.payout.status === "PendingApproval").length;
  return (
    <Card aria-labelledby="activity-title" padding="none">
      <CardHeader className="px-5 pt-4" id="activity-title" title="Activity" />
      <div className="px-5">
        <Tabs
          label="Activity filter"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All" },
            { value: "paid", label: "Paid" },
            { value: "pending", label: "Pending", count: pendingCount },
            { value: "rejected", label: "Rejected" },
          ]}
        />
      </div>
      {payouts.loading && rejections.loading && all.length === 0 ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState title={all.length === 0 ? "No activity yet" : "Nothing in this filter"}>{all.length === 0 ? "Requests from this agent, paid or refused, will appear here." : undefined}</EmptyState>
      ) : (
        <ul className="m-0 list-none px-5 pb-2">
          {shown.map((i) => (
            <Row key={i.kind === "payout" ? `p${i.payout.id}` : `r${i.rejection.at}-${i.rejection.reason}-${i.rejection.amount}-${i.rejection.address}`} item={i} />
          ))}
        </ul>
      )}
      {payouts.hasMore && (
        <div className="border-t border-track px-5 py-3">
          <Button size="sm" onClick={payouts.loadMore}>
            Load older payments ({payouts.total - payouts.list.length} more)
          </Button>
        </div>
      )}
    </Card>
  );
}
