import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { view } from "@/lib/rpc";
import { formatUsdc, parseUsdc } from "@/lib/amount";
import { formatTime } from "@/lib/format";
import { usdcGrouped } from "@/lib/amount";
import { buildTimeline, timelineSummary } from "@/lib/payoutView";
import { agentTrustLine } from "@/lib/payoutTrust";
import { canCreditRefund, isDepositExpired, isStuckTransfer } from "@/lib/status";
import { credited } from "@/lib/twoPhase";
import type { AgentView, Payout, RecipientView } from "@/lib/types";
import { Button, Card, ChainBadge, Hash, Icons, Input, Pill, SourceTag, Timeline, type TimelineStep } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { ApproveModal } from "./ApproveModal";
import { agentLabel } from "./ApprovalBanner";
import { RejectModal } from "./RejectModal";
import { TwoPhaseAction } from "./TwoPhaseAction";
import { payoutLabel, payoutSource } from "@/lib/payoutView";

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function CreditRefund({ p }: { p: Payout }) {
  const [amt, setAmt] = useState("");
  const { raw, err } = useMemo((): { raw: string | null; err: string | null } => {
    if (!amt.trim()) return { raw: null, err: null };
    try {
      const r = parseUsdc(amt);
      if (BigInt(r) === 0n || BigInt(r) > BigInt(p.amount)) return { raw: null, err: "Amount must be in (0, payout amount]" };
      return { raw: r, err: null };
    } catch (e) {
      return { raw: null, err: e instanceof Error ? e.message : String(e) };
    }
  }, [amt, p.amount]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="!h-8 !w-44" mono inputMode="decimal" placeholder={`full (${formatUsdc(p.amount)})`} value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="partial refund amount" />
        {err && <span className="text-xs text-danger-text">{err}</span>}
      </div>
      <TwoPhaseAction
        key={`${p.id}-${raw ?? "full"}`}
        method="credit_refund"
        args={{ payout_id: p.id, ...(raw ? { amount: raw } : {}) }}
        title="Credit refund"
        startLabel="Credit refund (step 1 of 2)"
        confirmLabel="Confirm credit"
        disabled={err !== null}
        snapshot={async () => ({ refundCredited: (await view<Payout | null>("get_payout", { payout_id: p.id }))?.refund_credited === true })}
        isCredited={(b, a) => credited("refund", b as { refundCredited?: boolean }, a as { refundCredited?: boolean })}
        doneText="Refund credited back to the vault balance."
        notCreditedText="The refund has not been received by the vault yet (or only part of it). Nothing was credited. Wait for the tokens to arrive, then start over."
      />
    </div>
  );
}

/** `/payouts/:id` body: header, timeline (PayoutDetail.dc.html), facts, owner actions. */
export function PayoutDetail({ payout: p, recipients, agents }: { payout: Payout; recipients: RecipientView[]; agents: AgentView[] }) {
  const { canAct, busy, act } = useOwner();
  const [now] = useState(() => Date.now());
  const [dlg, setDlg] = useState<"approve" | "reject" | null>(null);
  const agent = agents.find((a) => a.id === p.agent_id);
  const steps = buildTimeline(p, agent);
  const sum = timelineSummary(steps, p.status);
  const label = payoutLabel(p, recipients, agents);
  const kitSteps: TimelineStep[] = steps.map((s) => ({
    state: s.state,
    title: (
      <span className="flex items-baseline gap-2">
        <span>{s.title}</span>
        <span className="grow" />
        {s.atMs !== undefined && <span className="mono text-xs text-ink-subtle">{clock(s.atMs)}</span>}
      </span>
    ),
    detail: (
      <>
        {s.lines.map((l, i) => (
          <div key={i} className="break-words whitespace-pre-wrap">
            {l}
          </div>
        ))}
        {s.links.map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="mono mt-1 mr-3 inline-flex items-center gap-1 text-xs">
            {l.label} <Icons.ExternalLink size={11} />
          </a>
        ))}
      </>
    ),
  }));
  const trust = agentTrustLine(agent);
  const expired = isDepositExpired(p.deposit_expires_at_ms, now);

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <Link to="/payouts" className="text-[13px]">
        ← Back to payouts
      </Link>
      <Card padding="none" className={p.status === "Confirmed" ? "shadow-[0_0_0_1px_#2ECC71,0_0_22px_rgba(46,204,113,0.35)]" : ""}>
        <div className="flex flex-col gap-2.5 border-b border-line px-5 py-5">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span>Payout</span>
            <span className="mono">#{p.id}</span>
            <SourceTag source={payoutSource(p)} />
          </div>
          <h2 className="m-0 text-xl font-semibold">{label}</h2>
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[32px] leading-tight font-semibold tracking-tight">{usdcGrouped(p.amount)}</span>
            <span className="text-ink-muted">USDC</span>
            <ChainBadge chain={p.chain} arrow />
            <span className="grow" />
            <Pill accent={sum.tone}>{sum.text}</Pill>
          </div>
        </div>
        <div className="px-5 py-5">
          <Timeline steps={kitSteps} />
        </div>
        <div className="flex items-center gap-2.5 border-t border-line px-5 py-3.5">
          <Icons.ShieldCheck size={16} className={trust.tone === "ok" ? "text-ok" : "text-ink-muted"} />
          <span className="text-xs text-ink-muted">{trust.text}</span>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <h3 className="m-0 text-[15px] font-semibold">Details</h3>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-ink-muted">Requested by</dt>
          <dd className="m-0">
            <Link to={`/agents/${encodeURIComponent(p.agent_id)}`}>{agentLabel(agents, p.agent_id)}</Link>
          </dd>
          <dt className="text-ink-muted">Destination</dt>
          <dd className="m-0 break-all">
            <span className="mono text-xs">{p.address}</span>
          </dd>
          {p.deposit_address && (
            <>
              <dt className="text-ink-muted">Deposit address</dt>
              <dd className="m-0">
                <Hash value={p.deposit_address} />
              </dd>
            </>
          )}
          {p.deposit_expires_at_ms && (
            <>
              <dt className="text-ink-muted">Deposit valid until</dt>
              <dd className={`m-0 ${expired ? "text-danger-text" : ""}`}>
                {formatTime(p.deposit_expires_at_ms)}
                {expired && p.status === "PendingApproval" ? " (expired: reject it)" : ""}
              </dd>
            </>
          )}
          {p.tx_hash && (
            <>
              <dt className="text-ink-muted">Destination tx</dt>
              <dd className="m-0">
                <Hash value={p.tx_hash} />
              </dd>
            </>
          )}
          {p.memo && (
            <>
              <dt className="text-ink-muted">Memo</dt>
              <dd className="m-0 break-words whitespace-pre-wrap">{p.memo}</dd>
            </>
          )}
          <dt className="text-ink-muted">Created</dt>
          <dd className="m-0">{formatTime(p.created_at_ms)}</dd>
          <dt className="text-ink-muted">Updated</dt>
          <dd className="m-0">{formatTime(p.updated_at_ms)}</dd>
        </dl>
      </Card>

      {(p.status === "PendingApproval" || canCreditRefund(p) || isStuckTransfer(p, now)) && (
        <Card className="flex flex-col gap-3">
          <h3 className="m-0 text-[15px] font-semibold">Owner actions</h3>
          {p.status === "PendingApproval" && (
            <div className="flex gap-2">
              <Button onClick={() => setDlg("reject")}>Reject</Button>
              <Button variant="approve" onClick={() => setDlg("approve")}>
                Approve
              </Button>
            </div>
          )}
          {canCreditRefund(p) && <CreditRefund p={p} />}
          {isStuckTransfer(p, now) && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-[13px] text-ink-muted">The transfer has been in flight for over an hour and its callback never ran. Check the deposit address on a NEAR explorer, then settle it.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!canAct || busy} onClick={() => void act("force_settle_transfer", { payout_id: p.id, sent: true })} title="1 yocto: tokens reached the deposit address">
                  Tokens left, mark Sent
                </Button>
                <Button size="sm" variant="danger" disabled={!canAct || busy} onClick={() => void act("force_settle_transfer", { payout_id: p.id, sent: false })} title="1 yocto: tokens did not leave">
                  Release, mark Failed
                </Button>
              </div>
            </div>
          )}
          {!canAct && <p className="m-0 text-xs text-ink-subtle">Only the vault owner can use these actions.</p>}
        </Card>
      )}
      {dlg === "approve" && <ApproveModal payout={p} label={label} agentName={agentLabel(agents, p.agent_id)} onClose={() => setDlg(null)} />}
      {dlg === "reject" && <RejectModal payout={p} label={label} onClose={() => setDlg(null)} />}
    </div>
  );
}
