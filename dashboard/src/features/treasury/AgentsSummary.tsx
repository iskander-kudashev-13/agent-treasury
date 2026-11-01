import { Link } from "react-router-dom";
import { fraction, usdcGrouped } from "@/lib/amount";
import type { AgentView, WorkerStatus } from "@/lib/types";
import { ACCENT_HEX, Avatar, Button, Card, CardHeader, Dot, EmptyState, limitTone, Pill } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

function MiniBar({ pct }: { pct: number }) {
  const w = Math.min(1, Math.max(0, pct)) * 100;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)} aria-label="Spent today">
      <div className="fill-transition h-full rounded-full" style={{ width: `${w}%`, background: ACCENT_HEX[limitTone(pct, "agent")] }} />
    </div>
  );
}

const STATUS_DOT = { Active: "ok", Paused: "warn", Revoked: "neutral" } as const;

/** Agents summary card (DESIGN_AGENTS §4): up to 3 compact rows, "View all", worker footer. Replaces the single agent card. */
export function AgentsSummary({ agents, paused, missed, worker, workerError }: { agents: AgentView[]; paused: boolean; missed: Map<string, number>; worker: WorkerStatus | null; workerError: string | null }) {
  const { canAct } = useOwner();
  const live = agents.filter((a) => a.status !== "Revoked");
  const shown = live.slice(0, 3);
  return (
    <Card aria-labelledby="t-agents" className="flex flex-col gap-3">
      <CardHeader
        id="t-agents"
        title={`Agents${live.length ? ` (${live.length})` : ""}`}
        actions={
          <Link to="/agents" className="text-[13px]">
            View all →
          </Link>
        }
      />
      {shown.length === 0 ? (
        <EmptyState
          title="No agents yet"
          action={
            canAct ? (
              <Link to="/agents/new">
                <Button variant="primary">Add agent</Button>
              </Link>
            ) : undefined
          }
        >
          Connect your first agent — it will only be able to spend within the limits you set.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {shown.map((a) => {
            const pct = fraction(a.spent_today, a.mandate.daily_limit);
            const miss = missed.get(a.id) ?? 0;
            return (
              <li key={a.id} className="flex items-center gap-3">
                <Avatar name={a.name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={`/agents/${encodeURIComponent(a.id)}`} className="truncate font-medium text-ink">
                      {a.name}
                    </Link>
                    <Dot accent={paused ? "danger" : STATUS_DOT[a.status]} />
                    <span className="text-xs text-ink-muted">{paused ? "Vault paused" : a.status}</span>
                    {a.open_approvals > 0 && <Pill accent="warn">{a.open_approvals} to approve</Pill>}
                  </div>
                  <MiniBar pct={pct} />
                  <div className="mono mt-0.5 text-xs text-ink-muted">
                    {usdcGrouped(a.spent_today)} / {usdcGrouped(a.mandate.daily_limit)}
                  </div>
                  {miss > 0 && <div className="text-xs text-warn">Missed {miss} scheduled payment{miss === 1 ? "" : "s"}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {live.length > shown.length && <p className="m-0 text-xs text-ink-muted">+ {live.length - shown.length} more</p>}
      <p className="m-0 border-t border-track pt-3 text-xs text-ink-muted">
        Worker: {workerError ? "offline" : worker ? (worker.mode === "tee" ? "running in TEE" : "running locally (dev, not TEE)") : "…"}
      </p>
    </Card>
  );
}
