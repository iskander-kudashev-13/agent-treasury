import { useT } from "@/i18n";
import { useState } from "react";
import { usdcGrouped } from "@/lib/amount";
import { dailyPaidOut } from "@/lib/overview";
import type { BalanceView, Payout, PolicyView } from "@/lib/types";
import { Button, Card, Icons, Overline, Pill, Segmented, Sparkline } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

/** Balance, Deposit / Withdraw, and a paid-out sparkline (7 / 30 days, from the payout log). */
export function HomeBalance({ balance, policy, payouts, now, onDeposit, onWithdraw }: { balance: BalanceView | null; policy: PolicyView | null; payouts: Payout[]; now: number; onDeposit: () => void; onWithdraw: () => void }) {
  const t = useT();
  const { canAct } = useOwner();
  const [range, setRange] = useState<"7" | "30">("7");
  const paid = dailyPaidOut(payouts, Number(range), now);
  const empty = balance !== null && BigInt(balance.balance) === 0n && BigInt(balance.in_flight) === 0n;
  return (
    <Card decorated foil padding="lg" aria-labelledby="h-balance" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Overline id="h-balance">{t("home.balance")}</Overline>
        {policy?.paused && <Pill accent="danger">{t("agentStatus.Paused")}</Pill>}
      </div>
      {balance ? (
        <div className="flex flex-wrap items-baseline gap-2.5">
          <span className="mono text-balance font-semibold">{usdcGrouped(balance.balance)}</span>
          <span className="text-[15px] text-ink-muted">USDC</span>
          {BigInt(balance.in_flight) > 0n && <Pill>+{usdcGrouped(balance.in_flight)} {t("treasury.inFlight")}</Pill>}
        </div>
      ) : (
        <p className="m-0 text-ink-muted">{t("common.loading")}</p>
      )}
      {empty && <Pill accent="warn">{t("treasury.depositToStart")}</Pill>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="lg" icon={<Icons.ArrowDown size={16} />} onClick={onDeposit}>
          {t("treasury.deposit")}
        </Button>
        <Button size="lg" icon={<Icons.ArrowUp size={16} />} onClick={onWithdraw} disabled={!canAct} title={canAct ? undefined : t("common.ownerOnly")}>
          {t("treasury.withdraw")}
        </Button>
      </div>
      <div className="flex flex-col gap-2 border-t border-track pt-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-sm text-ink-muted">{t("home.paidOut")}</span>
          <span className="mono font-semibold">{usdcGrouped(paid.total)}</span>
          <div className="grow" />
          <Segmented label={t("upcoming.range")} value={range} onChange={setRange} options={[{ value: "7", label: t("upcoming.d7") }, { value: "30", label: t("upcoming.d30") }]} />
        </div>
        <Sparkline values={paid.values} label={t("home.paidOutChart", { n: range })} />
      </div>
    </Card>
  );
}
