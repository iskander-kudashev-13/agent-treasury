import { useT } from "@/i18n";
import type { ReactNode } from "react";
import { ACCENT_TEXT, Card, cx, Icons, Skeleton, Tile } from "@/kit";
import type { BotMetrics } from "@/lib/tradingClient";
import { fmtMoney, fmtMoneySigned, fmtWinRate } from "@/lib/tradingMetrics";

const tone = (v: string | null) => (v === null || Number(v) === 0 ? "" : Number(v) > 0 ? ACCENT_TEXT.ok : ACCENT_TEXT.danger);

function Metric({ label, value, className, help, sub }: { label: string; value: string; className?: string; help?: ReactNode; sub?: ReactNode }) {
  return (
    <Tile className="group relative">
      <div className="flex items-center gap-1 text-xs text-ink-muted">
        {label}
        {help && (
          <span tabIndex={0} role="note" aria-label={typeof help === "string" ? help : label} className="inline-flex cursor-help outline-offset-2">
            <Icons.Info size={12} />
          </span>
        )}
      </div>
      <div className={cx("mono mt-0.5 text-[17px] font-semibold", className)}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-ink-subtle">{sub}</div>}
      {help && (
        <div role="tooltip" className="pointer-events-none absolute top-full left-0 z-10 mt-1 hidden w-max max-w-[16rem] rounded-tile border border-line-strong bg-surface-raised p-2.5 text-xs leading-relaxed text-ink-secondary shadow-lg group-focus-within:block group-hover:block">
          {help}
        </div>
      )}
    </Tile>
  );
}

/** Six numbers for the chosen range. The worker computes them; the fallback computes them from the account's own fills. */
export function Metrics({ metrics, loading, total }: { metrics: BotMetrics | null; loading: boolean; total: string | null }) {
  const t = useT();
  if (loading && !metrics) return <Skeleton className="h-16" />;
  const m = metrics;
  return (
    <Card aria-label={t("trading.bot.metricsAria")} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Metric
        label={t("trading.bot.mPnl")}
        value={fmtMoneySigned(total)}
        className={tone(total)}
        help={t("trading.bot.pnlDef")}
        sub={m ? `${t("trading.bot.mRealized")} ${fmtMoneySigned(m.realized_usdc)}` : undefined}
      />
      <Metric label={t("trading.bot.mWin")} value={fmtWinRate(m?.win_rate ?? null)} help={t("trading.bot.winDef")} sub={m && m.win_rate === null ? t("trading.bot.winHint") : undefined} />
      <Metric label={t("trading.bot.mAvg")} value={fmtMoneySigned(m?.avg_trade_usdc ?? null)} className={tone(m?.avg_trade_usdc ?? null)} />
      <Metric label={t("trading.bot.mDrawdown")} value={m ? fmtMoney(m.max_drawdown_usdc) : "—"} />
      <Metric label={t("trading.bot.mFees")} value={m ? fmtMoney(m.fees_usdc) : "—"} />
      <Metric label={t("trading.bot.mTrades")} value={m ? String(m.fills) : "—"} />
    </Card>
  );
}
