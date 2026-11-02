import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { formatDay } from "@/lib/dates";
import { usdcGrouped } from "@/lib/amount";
import { checkFunding } from "@/lib/funding";
import type { BalanceView, PolicyView, RecipientView } from "@/lib/types";
import { useUpcoming } from "@/lib/useVault";
import { Card, CardHeader, ChainBadge, Pill, Skeleton } from "@/kit";

/** Next three scheduled payments (next 30 days). */
export function HomeNext({ recipients, balance, policy }: { recipients: RecipientView[]; balance: BalanceView | null; policy: PolicyView | null }) {
  const t = useT();
  const up = useUpcoming(30);
  const items = up.data.slice(0, 3);
  const funding = balance && policy ? checkFunding(up.data, balance.balance, policy.daily_limit) : null;
  return (
    <Card aria-labelledby="h-next" className="flex flex-col gap-3">
      <CardHeader id="h-next" title={t("home.next")} actions={<Link to="/payments" className="text-[13px]">{t("home.all")}</Link>} />
      {up.loading ? (
        <Skeleton className="h-16" />
      ) : items.length === 0 ? (
        <p className="m-0 text-sm text-ink-muted">{t("home.nothingNext")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {items.map((u) => {
            const r = recipients.find((x) => x.id === u.recipient_id);
            return (
              <li key={`${u.schedule_id}-${u.due_at}`} className="flex items-center gap-3 text-sm">
                <span className="w-16 shrink-0 text-ink-muted">{formatDay(u.due_at)}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{r?.label ?? t("upcoming.recipientN", { id: u.recipient_id })}</span>
                {r && <ChainBadge chain={r.destination_chain} />}
                <span className="mono font-semibold">{usdcGrouped(u.amount)}</span>
                {u.will_need_approval && <Pill accent="warn">{t("home.approval")}</Pill>}
              </li>
            );
          })}
        </ul>
      )}
      {funding?.messages.map((m) => (
        <p key={m.message} className="m-0 text-xs text-warn">{m.message}</p>
      ))}
    </Card>
  );
}
