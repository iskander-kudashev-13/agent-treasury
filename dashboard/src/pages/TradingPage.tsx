import { useT } from "@/i18n";
import { Trading } from "@/features/trading/Trading";
import { Page } from "@/kit";

/** `/trading` — Hyperliquid spot trading agent (ADR-0005): setup, status, rules, kill switch. */
export function TradingPage() {
  const t = useT();
  return (
    <Page title={t("page.tradingAgent")}>
      <Trading />
    </Page>
  );
}
