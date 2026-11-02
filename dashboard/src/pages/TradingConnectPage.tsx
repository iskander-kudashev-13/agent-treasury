import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { Connect } from "@/features/trading/Connect";
import { Icons, Page } from "@/kit";

/** `/trading/connect`: connect Hyperliquid once (account, bot wallet, funding) and the account-wide kill switch. */
export function TradingConnectPage() {
  const t = useT();
  return (
    <Page
      title={t("trading.bots.connectTitle")}
      actions={
        <Link to="/agents?kind=trading" className="inline-flex items-center gap-1 text-sm text-ink-muted no-underline hover:text-ink">
          <Icons.ChevronLeft size={14} /> {t("trading.bots.backToList")}
        </Link>
      }
    >
      <Connect />
    </Page>
  );
}
