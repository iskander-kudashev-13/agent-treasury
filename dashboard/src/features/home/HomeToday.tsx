import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { fraction, usdcGrouped } from "@/lib/amount";
import type { BalanceView, PolicyView } from "@/lib/types";
import { Card, Overline, RingGauge } from "@/kit";

/** Today: spent / daily limit ring and the number of payments. */
export function HomeToday({ balance, policy, count }: { balance: BalanceView | null; policy: PolicyView | null; count: number }) {
  const t = useT();
  return (
    <Card aria-labelledby="h-today" className="flex flex-col items-center gap-3">
      <div className="flex w-full items-center">
        <Overline id="h-today">{t("home.today")}</Overline>
        <div className="grow" />
        <Link to="/settings" className="text-[13px]">{t("home.limits")}</Link>
      </div>
      <RingGauge pct={balance && policy ? fraction(balance.spent_today, policy.daily_limit) : 0} caption={t("home.ofLimit")} size={140} />
      {balance && policy && (
        <p className="m-0 text-center text-sm text-ink-muted">
          <span className="mono font-semibold text-ink">{usdcGrouped(balance.spent_today)}</span> / <span className="mono">{usdcGrouped(policy.daily_limit)}</span> USDC · {t("home.paymentsCount", { count })}
        </p>
      )}
    </Card>
  );
}
