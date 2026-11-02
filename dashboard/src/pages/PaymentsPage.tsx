import { useT } from "@/i18n";
import type { PaymentMode } from "@/lib/scheduleForm";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { ApprovalBanner } from "@/features/payouts/Payouts";
import { PayoutsHistory } from "@/features/payouts/PayoutsHistory";
import { RecipientDrawer } from "@/features/payments/RecipientDrawer";
import { RecipientsTable } from "@/features/payments/RecipientsTable";
import { ScheduledTab } from "@/features/payments/ScheduledTab";
import { ScheduleDrawer } from "@/features/payments/ScheduleDrawer";
import { useOwner } from "@/features/owner/OwnerProvider";
import { AI_ENABLED } from "@/lib/config";
import type { RecipientView, Schedule } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { useAgents, usePendingApprovals, useRecipients, useSchedules } from "@/lib/useVault";
import { Button, Card, EmptyState, Icons, Page, Tabs } from "@/kit";

type Tab = "scheduled" | "history" | "recipients" | "approvals";
const isTab = (v: string | null): v is Tab => v === "scheduled" || v === "history" || v === "recipients" || v === "approvals";

/** `/payments?tab=scheduled|history|recipients|approvals` — schedules, payout history, address book, approvals. Tab state lives in the URL. */
export function PaymentsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = isTab(raw) ? raw : "scheduled";
  const recipients = useRecipients();
  const schedules = useSchedules();
  const pending = usePendingApprovals();
  const agents = useAgents();
  const waiting = pending.data.filter((p) => p.status === "PendingApproval");
  const { canAct } = useOwner();
  const assistant = useAssistantPanel();
  const [sched, setSched] = useState<{ schedule?: Schedule; mode?: PaymentMode } | null>(null);
  const [rec, setRec] = useState<{ recipient?: RecipientView } | null>(null);
  const now = useNow();
  const ask = AI_ENABLED ? () => assistant.openWith(t("page.addScheduledPrefill")) : undefined;

  return (
    <Page
      title={t("nav.payments")}
      actions={
        tab === "scheduled" ? (
          <div className="flex flex-wrap gap-2">
            {ask && (
              <Button variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={ask}>
                {t("page.askAssistant")}
              </Button>
            )}
            <Button variant="primary" disabled={!canAct} onClick={() => setSched({ mode: "once" })}>
              {t("page.payOnce")}
            </Button>
            <Button disabled={!canAct} onClick={() => setSched({ mode: "recurring" })}>
              {t("page.addRecurring")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <QueryErrors sources={[{ label: t("src.recipients"), ...recipients }, { label: t("src.scheduled"), ...schedules }]} />
      <Tabs
        label={t("nav.payments")}
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        items={[
          { value: "scheduled", label: t("page.tabScheduled"), count: schedules.data.length },
          { value: "history", label: t("page.tabHistory") },
          { value: "recipients", label: t("page.tabRecipients"), count: recipients.data.length },
          { value: "approvals", label: t("page.tabApprovals"), count: waiting.length },
        ]}
      />
      {tab === "scheduled" ? (
        <ScheduledTab onEdit={(s) => setSched({ schedule: s })} onNew={(mode) => setSched({ mode })} onAsk={ask} />
      ) : tab === "history" ? (
        <PayoutsHistory />
      ) : tab === "approvals" ? (
        waiting.length === 0 ? (
          <Card padding="none">
            <EmptyState title={t("page.noApprovals")} />
          </Card>
        ) : (
          <ApprovalBanner pending={pending.data} recipients={recipients.data} agents={agents.data} />
        )
      ) : (
        <RecipientsTable recipients={recipients.data} now={now} onAdd={() => setRec({})} onEdit={(r) => setRec({ recipient: r })} />
      )}
      <ScheduleDrawer open={sched !== null} onClose={() => setSched(null)} schedule={sched?.schedule} mode={sched?.mode} />
      <RecipientDrawer open={rec !== null} onClose={() => setRec(null)} recipient={rec?.recipient} />
    </Page>
  );
}
