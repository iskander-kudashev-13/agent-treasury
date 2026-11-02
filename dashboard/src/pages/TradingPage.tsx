import { Trading } from "@/features/trading/Trading";
import { Page } from "@/kit";

/** `/trading` — Hyperliquid spot trading agent (ADR-0005): setup, status, rules, kill switch. */
export function TradingPage() {
  return (
    <Page title="Trading agent">
      <Trading />
    </Page>
  );
}
