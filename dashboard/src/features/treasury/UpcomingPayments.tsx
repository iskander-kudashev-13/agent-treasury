import { useState } from "react";
import { Link } from "react-router-dom";
import { formatDay } from "@/lib/dates";
import { checkFunding } from "@/lib/funding";
import { usdcGrouped } from "@/lib/amount";
import { chainName } from "@/kit";
import type { AgentView, BalanceView, PolicyView, RecipientView } from "@/lib/types";
import { useUpcoming } from "@/lib/useVault";
import { Button, Callout, Card, ChainBadge, EmptyState, Segmented, Skeleton } from "@/kit";

const VISIBLE = 5;

/** Upcoming payments (UI_UPDATES §5.1): 7 / 30 day toggle, approval tags, total, funding warning with Deposit. */
export function UpcomingPayments({ recipients, agents, balance, policy, onDeposit }: { recipients: RecipientView[]; agents: AgentView[]; balance: BalanceView | null; policy: PolicyView | null; onDeposit: () => void }) {
  const [range, setRange] = useState<"7" | "30">("7");
  const up = useUpcoming(Number(range));
  const items = up.data;
  const funding = balance && policy ? checkFunding(items, balance.balance, policy.daily_limit) : null;
  const total = items.reduce((a, i) => a + BigInt(i.amount), 0n);
  const rec = (id: number) => recipients.find((r) => r.id === id);
  return (
    <Card padding="none" aria-labelledby="t-upcoming">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-5 py-3.5">
        <h2 id="t-upcoming" className="m-0 text-[15px] font-semibold">
          Upcoming
        </h2>
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
          ]}
        />
        <div className="grow" />
        <span className="mono text-base font-semibold">
          {usdcGrouped(total)} <span className="font-sans text-xs font-normal text-ink-muted">USDC · {items.length} payment{items.length === 1 ? "" : "s"}</span>
        </span>
      </div>
      {up.loading ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={`Nothing due in the next ${range} days`}>
          <Link to="/payments">Add a scheduled payment</Link>
        </EmptyState>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.slice(0, VISIBLE).map((u) => {
            const r = rec(u.recipient_id);
            const agent = agents.find((a) => a.id === u.agent_id)?.name ?? u.agent_id;
            return (
              <li key={`${u.schedule_id}-${u.due_at}`} className="row-in grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-track px-5 py-2.5 text-[13px] md:grid-cols-[92px_minmax(0,1fr)_100px_110px_120px]">
                <span className="text-ink-muted">{formatDay(u.due_at)}</span>
                <span className="truncate font-medium">{r?.label ?? `recipient #${u.recipient_id}`}</span>
                <span className="mono text-right font-semibold">{usdcGrouped(u.amount)}</span>
                <span className="hidden md:block">{r ? <ChainBadge chain={r.destination_chain} arrow /> : "—"}</span>
                <span className="col-span-3 text-xs md:col-span-1">
                  {u.will_need_approval ? <span className="text-warn">⏳ approval</span> : <span className="text-ink-muted">{agent}</span>}
                  <span className="text-ink-subtle md:hidden"> · {r ? chainName(r.destination_chain) : ""}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && (
        <div className="flex items-center px-5 py-2.5 text-[13px]">
          <span className="text-ink-muted">{items.length > VISIBLE ? `+ ${items.length - VISIBLE} more` : ""}</span>
          <div className="grow" />
          <Link to="/payments">View schedule →</Link>
        </div>
      )}
      {funding && funding.messages.length > 0 && (
        <div className="flex flex-col gap-2 px-4 pb-3.5">
          {funding.messages.map((m) => (
            <Callout key={m.message} accent="warn" icon={<span aria-hidden="true">⚠</span>} action={m.kind === "balance" ? <Button size="sm" variant="primary" onClick={onDeposit}>Deposit</Button> : undefined}>
              {m.message}
            </Callout>
          ))}
        </div>
      )}
    </Card>
  );
}
