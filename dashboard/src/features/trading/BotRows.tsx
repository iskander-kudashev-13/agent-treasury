import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { ACCENT_TEXT, Card, cx, Icons, Pill, PnlSparkline, Skeleton, StatusPill, type AgentState } from "@/kit";
import { WORKER_URL } from "@/lib/config";
import type { BotState, BotSummary } from "@/lib/tradingClient";
import { fmtMoneySigned, sparkNumbers } from "@/lib/tradingMetrics";
import { botPath, TRADING_CONNECT_PATH } from "@/lib/agentKind";
import { useBots } from "./useBots";
import { useTradingStatus } from "./useTrading";

const PILL: Record<BotState, AgentState> = { running: "active", stopped_today: "paused", halted: "paused", blocked: "paused", draft: "waiting", archived: "ended" };

export function BotStatePill({ state }: { state: BotState }) {
  const t = useT();
  return <StatusPill state={PILL[state]} label={t(`trading.bots.state.${state}`)} />;
}

/** ADR-0007: "Run by AI agent" (bot page) / "AI agent" (list tag). */
export function AgentPill({ short }: { short?: boolean }) {
  const t = useT();
  return (
    <Pill accent="neutral" icon={<Icons.Sparkles size={12} />}>
      {t(short ? "trading.agent.tag" : "trading.agent.pill")}
    </Pill>
  );
}

const tone = (v: string | null) => (v === null || Number(v) === 0 ? "text-ink-muted" : Number(v) > 0 ? ACCENT_TEXT.ok : ACCENT_TEXT.danger);

/** Signed P&L number in USDC, coloured by sign; an em dash while unknown (public view without the owner session). */
export function PnlValue({ value, className }: { value: string | null; className?: string }) {
  return <span className={cx("mono font-semibold", tone(value), className)}>{fmtMoneySigned(value)}</span>;
}

/** Trading bots for the Agents list and Home: the live ones plus whether to offer "Connect Hyperliquid". */
export function useTradingRows() {
  const load = useBots();
  const bots = (load.data?.bots ?? []).filter((b) => b.state !== "archived");
  const active = WORKER_URL !== "";
  const { status } = useTradingStatus();
  // "Connect Hyperliquid" only while the account is not ready (no API wallet approved yet). With no bots but a ready
  // account, the owner goes straight to the strategy wizard instead of the setup page.
  const live = status?.enabled ? status : null;
  const ready = live !== null && live.api_wallet.approved && live.state !== "not_configured" && live.state !== "awaiting_api_wallet";
  return { bots, loading: active && load.loading, showConnect: active && !load.loading && bots.length === 0 && !ready, active, error: load.error };
}

/** One trading agent in the Agents list (list -> detail, ADR-0006 §9). */
export function BotRow({ bot }: { bot: BotSummary }) {
  const t = useT();
  const values = sparkNumbers(bot.spark);
  const pair = bot.pairs.join(", ");
  return (
    <Link to={botPath(bot.id)} aria-label={t("trading.bots.rowAria", { name: bot.name })} className="block no-underline">
      <Card as="article" className="flex flex-col gap-3 transition-colors hover:bg-surface-hover">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <Icons.TrendingUp size={20} className="mt-0.5 shrink-0 text-info" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[15px] font-semibold break-words text-ink">{bot.name}</span>
              <Pill accent="info">{t("trading.bots.kind")}</Pill>
              {bot.kind === "agent" && <AgentPill short />}
            </div>
            {pair && <div className="mono mt-0.5 text-xs text-ink-muted">{pair}</div>}
          </div>
          <BotStatePill state={bot.state} />
        </div>
        <div className="flex items-end gap-4">
          <div className="flex shrink-0 flex-col">
            <span className="text-xs text-ink-muted">{t("trading.bots.pnl")}</span>
            <PnlValue value={bot.pnl_total_usdc} className="text-xl" />
            <span className="text-xs text-ink-muted">
              {t("trading.bots.today")} <PnlValue value={bot.pnl_today_usdc} className="text-xs" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <PnlSparkline values={values} label={t("trading.bots.sparkAria", { name: bot.name })} />
          </div>
          <Icons.ChevronRight size={16} className="mb-1 shrink-0 text-ink-muted" />
        </div>
      </Card>
    </Link>
  );
}

/** Shown while Hyperliquid is not connected (no trading agent yet). */
export function ConnectHlRow() {
  const t = useT();
  return (
    <Link to={TRADING_CONNECT_PATH} className="block no-underline">
      <Card as="article" className="flex items-center gap-3 border-dashed transition-colors hover:bg-surface-hover">
        <Icons.TrendingUp size={20} className="shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-ink">{t("trading.bots.connectRow")}</div>
          <div className="text-sm text-ink-muted">{t("trading.bots.connectHint")}</div>
        </div>
        <Icons.ChevronRight size={16} className="shrink-0 text-ink-muted" />
      </Card>
    </Link>
  );
}

export const BotRowsSkeleton = () => <Skeleton className="h-28" />;
