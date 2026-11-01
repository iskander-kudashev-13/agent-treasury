import { useState } from "react";
import { Link } from "react-router-dom";
import { ApprovalBanner, PayoutList } from "@/features/payouts/Payouts";
import { AgentsSummary } from "@/features/treasury/AgentsSummary";
import { BalanceHero } from "@/features/treasury/BalanceHero";
import { DepositModal, WithdrawModal } from "@/features/treasury/FundsModals";
import { SurplusAction } from "@/features/treasury/SurplusCard";
import { UpcomingPayments } from "@/features/treasury/UpcomingPayments";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { missedByAgent } from "@/lib/overdue";
import { useAgents, useBalance, usePayouts, usePendingApprovals, usePolicy, useRecipients, useSchedules, useWorker } from "@/lib/useVault";
import { Page } from "@/kit";

/** `/` — balance hero, spending policy, upcoming payments, agents summary, approvals, latest payouts. */
export function TreasuryPage() {
  const policy = usePolicy();
  const balance = useBalance();
  const recipients = useRecipients();
  const agents = useAgents();
  const pending = usePendingApprovals();
  const payouts = usePayouts();
  const schedules = useSchedules();
  const worker = useWorker();
  const [modal, setModal] = useState<"deposit" | "withdraw" | null>(null);
  const [now] = useState(() => Date.now());
  const missed = missedByAgent(schedules.data, policy.data ? Number(policy.data.overdue_grace_ms) : Number.POSITIVE_INFINITY, now);

  return (
    <Page title="Treasury">
      <QueryErrors sources={[{ label: "balance", ...balance }, { label: "policy", ...policy }, { label: "agents", ...agents }, { label: "recipients", ...recipients }, { label: "payouts", ...payouts }, { label: "schedules", ...schedules }, { label: "approvals", ...pending }]} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <BalanceHero balance={balance.data} policy={policy.data} onDeposit={() => setModal("deposit")} onWithdraw={() => setModal("withdraw")} />
          <UpcomingPayments recipients={recipients.data} agents={agents.data} balance={balance.data} policy={policy.data} onDeposit={() => setModal("deposit")} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <AgentsSummary agents={agents.data} paused={policy.data?.paused ?? false} missed={missed} worker={worker.status} workerError={worker.error} />
          <SurplusAction />
        </div>
      </div>
      <ApprovalBanner pending={pending.data} recipients={recipients.data} agents={agents.data} />
      <PayoutList
        title="Payouts"
        payouts={payouts.data.list.slice(0, 10)}
        recipients={recipients.data}
        agents={agents.data}
        emptyHint="The agents haven't paid anyone yet."
        actions={<Link to="/payouts">View all history →</Link>}
      />
      <DepositModal open={modal === "deposit"} onClose={() => setModal(null)} />
      <WithdrawModal open={modal === "withdraw"} onClose={() => setModal(null)} balance={balance.data?.balance ?? null} />
    </Page>
  );
}
