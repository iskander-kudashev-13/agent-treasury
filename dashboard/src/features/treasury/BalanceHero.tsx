import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { fraction, usdcGrouped } from "@/lib/amount";
import type { BalanceView, PolicyView } from "@/lib/types";
import { Button, Card, Icons, Overline, Pill, RingGauge, SpendBar, Tile } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { usdcNumber } from "@/lib/amount";

/** Balance hero (Main.dc.html): balance, availability today, Deposit / Withdraw, daily-limit ring; spend bar below. */
export function BalanceHero({ balance, policy, onDeposit, onWithdraw }: { balance: BalanceView | null; policy: PolicyView | null; onDeposit: () => void; onWithdraw: () => void }) {
  const t = useT();
  const { canAct } = useOwner();
  const frac = balance && policy ? fraction(balance.spent_today, policy.daily_limit) : 0;
  const empty = balance !== null && BigInt(balance.balance) === 0n && BigInt(balance.in_flight) === 0n;
  return (
    <div className="flex flex-col gap-4">
      <Card decorated foil padding="lg" aria-labelledby="t-treasury">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
            <Overline id="t-treasury">{t("treasury.vaultBalance")}</Overline>
            {balance ? (
              <>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="mono text-balance font-semibold">{usdcGrouped(balance.balance)}</span>
                  <span className="text-[15px] text-ink-muted">USDC</span>
                  {policy?.paused && <Pill accent="danger">{t("agentStatus.Paused")}</Pill>}
                </div>
                {BigInt(balance.in_flight) > 0n && <p className="m-0 text-xs text-ink-muted">+ <span className="mono">{usdcGrouped(balance.in_flight)}</span> {t("treasury.inFlight")}</p>}
                {policy && (
                  <p className="m-0 text-ink-muted">
                    {t("treasury.availableToday")} <span className="mono font-semibold text-ink">{usdcGrouped(balance.remaining_today)}</span> {t("treasury.ofLimit")} <span className="mono">{usdcGrouped(policy.daily_limit)}</span>
                  </p>
                )}
              </>
            ) : (
              <p className="m-0 text-ink-muted">{t("treasury.loadingBalance")}</p>
            )}
            {empty && <p className="m-0 text-warn">{t("treasury.depositToStart")}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="lg" icon={<Icons.ArrowDown size={16} />} onClick={onDeposit}>
                {t("treasury.deposit")}
              </Button>
              <Button size="lg" icon={<Icons.ArrowUp size={16} />} onClick={onWithdraw} disabled={!canAct} title={canAct ? undefined : t("treasury.onlyOwnerWithdraw")}>
                {t("treasury.withdraw")}
              </Button>
            </div>
          </div>
          {policy && balance && <RingGauge pct={frac} />}
        </div>
      </Card>

      {policy && balance && (
        <Card aria-labelledby="t-policy" className="flex flex-col gap-3.5">
          <div className="flex items-center gap-2">
            <h2 id="t-policy" className="m-0 text-[15px] font-semibold">
              {t("treasury.spendingPolicy")}
            </h2>
            <div className="grow" />
            <Link to="/policy" className="text-[13px]">
              {t("treasury.editPolicy")}
            </Link>
          </div>
          <SpendBar
            label={t("treasury.vaultDailyLimit")}
            spent={usdcNumber(balance.spent_today)}
            limit={usdcNumber(policy.daily_limit)}
            spentText={usdcGrouped(balance.spent_today)}
            limitText={`${usdcGrouped(policy.daily_limit)} USDC`}
            marker80
          />
          <div className="grid grid-cols-3 gap-3">
            <Tile>
              <div className="text-xs text-ink-muted">{t("treasury.dailyLimit")}</div>
              <div className="mono mt-0.5 text-base font-semibold">{usdcGrouped(policy.daily_limit)}</div>
            </Tile>
            <Tile>
              <div className="text-xs text-ink-muted">{t("treasury.minPayment")}</div>
              <div className="mono mt-0.5 text-base font-semibold">{usdcGrouped(policy.min_payment)}</div>
            </Tile>
            <Tile>
              <div className="text-xs text-ink-muted">{t("treasury.remainingToday")}</div>
              <div className="mono mt-0.5 text-base font-semibold">{usdcGrouped(balance.remaining_today)}</div>
            </Tile>
          </div>
          <p className="m-0 text-xs text-ink-subtle">{t("treasury.onTopOfAgent")}</p>
        </Card>
      )}
    </div>
  );
}
