import { useT } from "@/i18n";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { cx, Icons } from "@/kit";
import { TRADING_CONNECT_PATH, TRADING_NEW_PATH } from "@/lib/agentKind";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useTradingRows } from "@/features/trading/BotRows";

function KindCard({ icon, title, desc, note, disabled, onClick }: { icon: ReactNode; title: string; desc: string; note?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex flex-col gap-2 rounded-card border border-line bg-surface p-5 text-left text-ink transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-line-strong hover:bg-surface-hover",
      )}
    >
      <span className="flex items-center gap-2 text-[15px] font-semibold">
        {icon}
        {title}
        {!disabled && <Icons.ChevronRight size={16} className="ml-auto text-ink-muted" />}
      </span>
      <span className="text-sm text-ink-secondary">{desc}</span>
      {note && <span className="text-xs text-ink-muted">{note}</span>}
    </button>
  );
}

/**
 * `/agents/new` first step: what the agent will do. Payments opens the vault-agent wizard (`?type=payments`). Trading
 * strategies are worker-side bots (ADR-0006): that card opens the strategy wizard (`/trading/new`), or sends the owner to
 * connect Hyperliquid first.
 */
export function AgentTypeChooser() {
  const t = useT();
  const navigate = useNavigate();
  const { canAct } = useOwner();
  const trading = useTradingRows();
  const tradingOn = trading.active;
  const needsConnect = tradingOn && trading.showConnect;
  const startTrading = () => {
    if (needsConnect) {
      navigate(TRADING_CONNECT_PATH);
      return;
    }
    navigate(TRADING_NEW_PATH);
  };
  const tradingNote = !tradingOn ? t("ag.type.trading.unavailable") : needsConnect ? t("ag.type.trading.connect") : t("ag.type.trading.next");
  return (
    <div className="flex flex-col gap-4">
      <h2 className="m-0 text-base font-semibold text-ink">{t("ag.type.question")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <KindCard
          icon={<Icons.Send size={18} className="text-ok" />}
          title={t("ag.type.payments.title")}
          desc={t("ag.type.payments.desc")}
          disabled={!canAct}
          onClick={() => navigate("/agents/new?type=payments")}
        />
        <KindCard
          icon={<Icons.TrendingUp size={18} className="text-info" />}
          title={t("ag.type.trading.title")}
          desc={t("ag.type.trading.desc")}
          note={tradingNote}
          disabled={!canAct || !tradingOn || trading.loading}
          onClick={startTrading}
        />
      </div>
    </div>
  );
}
