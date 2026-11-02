import { t, useT } from "@/i18n";
import { useState } from "react";
import { shortDate } from "@/lib/frequency";
import { usdcGrouped } from "@/lib/amount";
import { chainName } from "@/kit";
import type { AgentView, Payout, RecipientView } from "@/lib/types";
import { Button, Icons } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { ApproveModal } from "./ApproveModal";
import { RejectModal } from "./RejectModal";
import { payoutLabel } from "@/lib/payoutView";

export const recipientLabel = (recipients: RecipientView[], id: number | null): string =>
  id === null ? t("po.adHoc") : (recipients.find((r) => r.id === id)?.label ?? t("call.recipientN", { id }));
export const agentLabel = (agents: AgentView[], id: string): string => agents.find((a) => a.id === id)?.name ?? id;

/** "Waiting for your approval" (UI_UPDATES §5.2): requesting agent, memo (plain text), overdue line, Approve / Reject. */
export function ApprovalBanner({ pending, recipients, agents }: { pending: Payout[]; recipients: RecipientView[]; agents: AgentView[] }) {
  const t = useT();
  const { canAct } = useOwner();
  const [review, setReview] = useState<{ id: string; mode: "approve" | "reject" } | null>(null);
  const rows = pending.filter((p) => p.status === "PendingApproval");
  if (rows.length === 0) return null;
  const current = review ? rows.find((p) => p.id === review.id) : undefined;
  return (
    <section aria-labelledby="approve-title" className="flex flex-col gap-2.5 rounded-card border border-warn-line bg-warn-soft p-4">
      <div className="flex items-center gap-2 text-warn">
        <Icons.AlertTriangle size={16} />
        <h2 id="approve-title" className="m-0 text-sm font-semibold">
          {t("po.waitingTitle")}
        </h2>
      </div>
      {rows.map((p) => {
        const label = payoutLabel(p, recipients, agents);
        const agent = agentLabel(agents, p.agent_id);
        const overdue = p.approval_reason === "OVERDUE_NEEDS_APPROVAL";
        return (
          <div key={p.id} className="row-in flex flex-wrap items-center gap-3 rounded-tile border border-line bg-surface px-3 py-2.5">
            <div className="min-w-[200px] flex-1">
              <div className="font-semibold">{label}</div>
              <div className="text-xs text-ink-muted">
                {agent} · <span className="mono">{usdcGrouped(p.amount)}</span> USDC → {chainName(p.chain)}
                {p.memo && <span className="break-words"> · “{p.memo.length > 80 ? `${p.memo.slice(0, 80)}…` : p.memo}”</span>}
              </div>
              {overdue && (
                <div className="mt-0.5 text-xs text-warn">
                  {t("po.overdueSince", { date: p.occurrence_at ? shortDate(Number(p.occurrence_at)) : t("po.itsDueDate") })}
                </div>
              )}
              {!overdue && p.approval_reason === "ABOVE_THRESHOLD" && <div className="mt-0.5 text-xs text-ink-subtle">{t("po.aboveThreshold")}</div>}
            </div>
            <span className="mono text-base font-semibold">{usdcGrouped(p.amount)}</span>
            <div className="flex gap-2">
              <Button onClick={() => setReview({ id: p.id, mode: "reject" })} title={canAct ? undefined : t("po.onlyOwnerReject")}>
                {t("po.reject")}
              </Button>
              <Button variant="approve" onClick={() => setReview({ id: p.id, mode: "approve" })}>
                {t("po.approve")}
              </Button>
            </div>
          </div>
        );
      })}
      {current && review?.mode === "approve" && <ApproveModal payout={current} label={payoutLabel(current, recipients, agents)} agentName={agentLabel(agents, current.agent_id)} onClose={() => setReview(null)} />}
      {current && review?.mode === "reject" && <RejectModal payout={current} label={payoutLabel(current, recipients, agents)} onClose={() => setReview(null)} />}
    </section>
  );
}
