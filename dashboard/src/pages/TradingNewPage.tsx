import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { NewStrategyWizard } from "@/features/trading/NewStrategyWizard";
import { Icons, Page } from "@/kit";
import { TRADING_LIST_PATH } from "@/lib/agentKind";

/** `/trading/new`: create a trading strategy step by step (templates or own words), then sign it. */
export function TradingNewPage() {
  const t = useT();
  return (
    <Page
      title={t("trading.bots.newStrategy")}
      actions={
        <Link to={TRADING_LIST_PATH} className="inline-flex items-center gap-1 text-sm text-ink-muted no-underline hover:text-ink">
          <Icons.ChevronLeft size={14} /> {t("trading.bots.backToList")}
        </Link>
      }
    >
      <NewStrategyWizard />
    </Page>
  );
}
