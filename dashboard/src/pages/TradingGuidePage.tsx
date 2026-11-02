import { useT } from "@/i18n";
import { TradingGuide } from "@/features/trading/TradingGuide";
import { Page } from "@/kit";

/** `/trading/guide` — how the trading bot works (`#how`) and how to write rules (`#rules`). */
export function TradingGuidePage() {
  const t = useT();
  return (
    <Page title={t("trading.guide.title")}>
      <TradingGuide />
    </Page>
  );
}
