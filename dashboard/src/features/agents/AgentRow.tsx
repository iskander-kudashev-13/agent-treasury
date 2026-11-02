import { useT } from "@/i18n";
import { relativeTime } from "@/lib/relativeTime";
import { Link } from "react-router-dom";
import { Card, cx, Icons, Pill, SpendBar, StatusPill } from "@/kit";
import { formatUsdc } from "@/lib/amount";
import { rejectionsToday, spendNumbers, stateOf, trustOf } from "@/lib/agentView";
import { describeMandateShort } from "@/lib/describeMandate";
import type { AgentView, Rejection } from "@/lib/types";
import { PauseResume } from "./PauseResume";
import { TrustLine } from "./parts";

/** One agent on `/agents` (DESIGN_AGENTS §3.1). Revoked rows are dimmed. */
export function AgentRow({ agent, rejections, missed, vaultPaused, nowMs }: { agent: AgentView; rejections: readonly Rejection[]; missed: number; vaultPaused: boolean; nowMs: number }) {
  const t = useT();
  const trust = trustOf(agent);
  const revoked = agent.status === "Revoked";
  const { spent, limit } = spendNumbers(agent);
  const refused = rejectionsToday(rejections, agent.id, nowMs);
  const Icon = trust.kind === "tee" ? Icons.ShieldCheck : Icons.KeyRound;
  const iconTone = trust.tone === "ok" ? "text-ok" : trust.tone === "warn" ? "text-warn" : "text-ink-muted";
  return (
    <Card as="article" aria-label={t("ag.agentAria", { name: agent.name })} className={cx("flex flex-col gap-3", revoked && "opacity-60")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Icon size={20} className={cx("mt-0.5 shrink-0", iconTone)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link to={`/agents/${agent.id}`} className="text-[15px] font-semibold text-ink no-underline hover:underline">
              {agent.name}
            </Link>
            {agent.name !== agent.id && <span className="mono text-xs text-ink-muted">{agent.id}</span>}
          </div>
          <TrustLine trust={trust} />
        </div>
        {vaultPaused && !revoked ? <StatusPill state="paused" label={t("treasury.vaultPaused")} /> : <StatusPill state={stateOf(agent)} />}
      </div>

      {revoked ? (
        <p className="m-0 text-sm text-ink-muted">{t("ag.revokedNote")}</p>
      ) : (
        <>
          <p className="m-0 text-sm text-ink-secondary">{describeMandateShort(agent.mandate)}</p>
          <SpendBar scope="agent" label={t("ag.today")} spent={spent} limit={limit} spentText={formatUsdc(agent.spent_today, 0)} limitText={`${formatUsdc(agent.mandate.daily_limit, 0)} USDC`} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {agent.open_approvals > 0 && (
          <Pill accent="warn" icon={<Icons.Clock size={12} />}>
            {t("ag.waitingPill", { count: agent.open_approvals })}
          </Pill>
        )}
        {refused > 0 && <Pill>{t("ag.refusedToday", { n: refused })}</Pill>}
        {missed > 0 && <Pill accent="warn">{t("treasury.missed", { count: missed })}</Pill>}
        {agent.failed_transfers > 0 && <Pill accent="warn">{t("ag.failedPill", { count: agent.failed_transfers })}</Pill>}
        {!revoked && <span className="text-xs text-ink-muted">{t("ag.lastRequest", { when: relativeTime(agent.last_request_at, nowMs) })}</span>}
        <span className="grow" />
        <PauseResume agent={agent} vaultPaused={vaultPaused} />
        <Link to={`/agents/${agent.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-input border border-line-strong px-3 text-[13px] font-medium text-ink no-underline hover:bg-surface-sunken">
          {t("ag.open")} <Icons.ChevronRight size={14} />
        </Link>
      </div>
    </Card>
  );
}
