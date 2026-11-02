import { useT } from "@/i18n";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HomeAgents } from "@/features/home/HomeAgents";
import { HomeAttention } from "@/features/home/HomeAttention";
import { HomeBalance } from "@/features/home/HomeBalance";
import { HomeNext } from "@/features/home/HomeNext";
import { HomeToday } from "@/features/home/HomeToday";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { DepositModal, WithdrawModal } from "@/features/treasury/FundsModals";
import { missedByAgent } from "@/lib/overdue";
import { paymentsToday } from "@/lib/overview";
import { startOfUtcDay } from "@/lib/agentView";
import { useNow } from "@/lib/useNow";
import { useAgents, useBalance, usePayouts, usePendingApprovals, usePolicy, useRecipients, useRejections, useSchedules } from "@/lib/useVault";
import { Page } from "@/kit";

/** `/` — overview: balance + paid-out chart, today, agents, next payments, and attention items only when there are any. */
export function HomePage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const policy = usePolicy();
  const balance = useBalance();
  const recipients = useRecipients();
  const agents = useAgents();
  const pending = usePendingApprovals();
  const payouts = usePayouts(100);
  const schedules = useSchedules();
  const rejections = useRejections();
  const now = useNow();
  const [modal, setModal] = useState<"deposit" | "withdraw" | null>(params.get("deposit") === "1" ? "deposit" : null);
  const close = () => {
    setModal(null);
    if (params.has("deposit")) setParams({}, { replace: true });
  };
  const grace = policy.data ? Number(policy.data.overdue_grace_ms) : Number.POSITIVE_INFINITY;
  const missed = [...missedByAgent(schedules.data, grace, now).values()].reduce((a, b) => a + b, 0);
  const dayStart = startOfUtcDay(now);
  const refused = rejections.data.filter((r) => Number(r.at) >= dayStart).length;
  return (
    <Page title={t("nav.overview")}>
      <QueryErrors sources={[{ label: t("src.balance"), ...balance }, { label: t("src.policy"), ...policy }, { label: t("src.agents"), ...agents }, { label: t("src.payouts"), ...payouts }, { label: t("src.schedules"), ...schedules }, { label: t("src.approvals"), ...pending }]} />
      <HomeAttention approvals={pending.data.filter((p) => p.status === "PendingApproval").length} missed={missed} refused={refused} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <HomeBalance balance={balance.data} policy={policy.data} payouts={payouts.data.list} now={now} onDeposit={() => setModal("deposit")} onWithdraw={() => setModal("withdraw")} />
        <HomeToday balance={balance.data} policy={policy.data} count={paymentsToday(payouts.data.list, now)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <HomeAgents agents={agents.data} vaultPaused={policy.data?.paused ?? false} />
        <HomeNext recipients={recipients.data} balance={balance.data} policy={policy.data} />
      </div>
      <DepositModal open={modal === "deposit"} onClose={close} />
      <WithdrawModal open={modal === "withdraw"} onClose={close} balance={balance.data?.balance ?? null} />
    </Page>
  );
}
