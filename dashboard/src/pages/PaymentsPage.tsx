import type { PaymentMode } from "@/lib/scheduleForm";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { RecipientDrawer } from "@/features/payments/RecipientDrawer";
import { RecipientsTable } from "@/features/payments/RecipientsTable";
import { ScheduledTab } from "@/features/payments/ScheduledTab";
import { ScheduleDrawer } from "@/features/payments/ScheduleDrawer";
import { useOwner } from "@/features/owner/OwnerProvider";
import { AI_ENABLED } from "@/lib/config";
import type { RecipientView, Schedule } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { useRecipients, useSchedules } from "@/lib/useVault";
import { Button, Icons, Page, Tabs } from "@/kit";

type Tab = "scheduled" | "recipients";
const isTab = (v: string | null): v is Tab => v === "scheduled" || v === "recipients";

/** `/payments?tab=scheduled|recipients` (UI_UPDATES §4). Tab state lives in the URL. */
export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = isTab(raw) ? raw : "scheduled";
  const recipients = useRecipients();
  const schedules = useSchedules();
  const { canAct } = useOwner();
  const assistant = useAssistantPanel();
  const [sched, setSched] = useState<{ schedule?: Schedule; mode?: PaymentMode } | null>(null);
  const [rec, setRec] = useState<{ recipient?: RecipientView } | null>(null);
  const now = useNow();
  const ask = AI_ENABLED ? () => assistant.openWith("Add a scheduled payment: ") : undefined;

  return (
    <Page
      title="Payments"
      actions={
        tab === "scheduled" ? (
          <div className="flex flex-wrap gap-2">
            {ask && (
              <Button variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={ask}>
                Ask assistant
              </Button>
            )}
            <Button variant="primary" disabled={!canAct} onClick={() => setSched({ mode: "once" })}>
              Pay once
            </Button>
            <Button disabled={!canAct} onClick={() => setSched({ mode: "recurring" })}>
              + Recurring payment
            </Button>
          </div>
        ) : undefined
      }
    >
      <QueryErrors sources={[{ label: "recipients", ...recipients }, { label: "scheduled payments", ...schedules }]} />
      <p className="m-0 text-ink-muted">Scheduled payments are paid by the agent you assign, on the dates you set. Agents can also pay on demand within their mandate — see Agents.</p>
      <Tabs
        label="Payments"
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        items={[
          { value: "scheduled", label: "Scheduled", count: schedules.data.length },
          { value: "recipients", label: "Recipients", count: recipients.data.length },
        ]}
      />
      {tab === "scheduled" ? (
        <ScheduledTab onEdit={(s) => setSched({ schedule: s })} onNew={(mode) => setSched({ mode })} onAsk={ask} />
      ) : (
        <RecipientsTable recipients={recipients.data} now={now} onAdd={() => setRec({})} onEdit={(r) => setRec({ recipient: r })} />
      )}
      <ScheduleDrawer open={sched !== null} onClose={() => setSched(null)} schedule={sched?.schedule} mode={sched?.mode} />
      <RecipientDrawer open={rec !== null} onClose={() => setRec(null)} recipient={rec?.recipient} />
    </Page>
  );
}
