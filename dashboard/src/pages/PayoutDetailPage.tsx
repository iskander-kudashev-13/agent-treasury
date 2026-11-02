import { useT } from "@/i18n";
import { Link, useParams } from "react-router-dom";
import { PayoutDetail } from "@/features/payouts/Payouts";
import { ComingSoon } from "@/features/layout/ComingSoon";
import { usePayout } from "@/lib/usePayout";
import { useAgents, useRecipients } from "@/lib/useVault";
import { Page, Skeleton } from "@/kit";

/** `/payouts/:id` — payout timeline and owner actions. */
export function PayoutDetailPage() {
  const t = useT();
  const { id = "" } = useParams();
  const { payout, loading, error, valid } = usePayout(id);
  const recipients = useRecipients();
  const agents = useAgents();
  return (
    <Page>
      {loading ? (
        <Skeleton className="mx-auto h-96 w-full max-w-[640px]" />
      ) : payout ? (
        <PayoutDetail payout={payout} recipients={recipients.data} agents={agents.data} />
      ) : (
        <ComingSoon title={valid ? t("page.payoutNotFound", { id }) : t("page.invalidPayoutId")} action={<Link to="/payouts">{t("page.backToPayouts")}</Link>}>
          {error ?? t("page.mayNotExist")}
        </ComingSoon>
      )}
    </Page>
  );
}
