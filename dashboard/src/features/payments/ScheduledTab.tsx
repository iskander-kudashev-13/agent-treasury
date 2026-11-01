import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NO_FILTERS, type ScheduleFilters } from "@/lib/schedulesView";
import type { Schedule } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { useAgents, usePolicy, useRecipients, useSchedules } from "@/lib/useVault";
import { SchedulesTable } from "./SchedulesTable";

/** Scheduled tab: data + filters (the recipient filter lives in the URL so the Recipients tab can link to it). */
export function ScheduledTab({ onEdit, onNew, onAsk }: { onEdit: (s: Schedule) => void; onNew: () => void; onAsk?: (() => void) | undefined }) {
  const [params, setParams] = useSearchParams();
  const { data: schedules } = useSchedules();
  const { data: recipients } = useRecipients();
  const { data: agents } = useAgents();
  const { data: policy } = usePolicy();
  const now = useNow();
  const [local, setLocal] = useState<Omit<ScheduleFilters, "recipient">>({ agent: "", status: "", chain: "" });
  const rec = params.get("recipient");
  const recipient = rec !== null && /^\d+$/.test(rec) ? Number(rec) : null;
  const filters: ScheduleFilters = { ...NO_FILTERS, ...local, recipient };

  return (
    <SchedulesTable
      schedules={schedules}
      recipients={recipients}
      agents={agents}
      now={now}
      overdueGraceMs={Number(policy?.overdue_grace_ms ?? 3 * 86_400_000)}
      filters={filters}
      onFilters={(f) => {
        setLocal({ agent: f.agent, status: f.status, chain: f.chain });
        if (f.recipient !== recipient) {
          const next = new URLSearchParams(params);
          if (f.recipient === null) next.delete("recipient");
          else next.set("recipient", String(f.recipient));
          setParams(next, { replace: true });
        }
      }}
      onEdit={onEdit}
      onNew={onNew}
      onAsk={onAsk}
    />
  );
}
