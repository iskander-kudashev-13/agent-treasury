import { useT, rich } from "@/i18n";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, Card, Dot, Hash, Icons, Pill, cx } from "@/kit";
import { usdcGrouped } from "@/lib/amount";
import { mandateSegments } from "@/lib/describeMandate";
import { formatTime } from "@/lib/format";
import { relativeTime } from "@/lib/relativeTime";
import type { HlAgent, TradingStatus } from "@/lib/tradingClient";
import { apiWalletNameStable, doneCount, MIN_ORDER_USDC, STEP_WALLETS, type StepId, type StepInfo, type StepState } from "@/lib/tradingGuide";
import { fmtDec, hlAppUrl, reasonText, type AccountTrust } from "@/lib/tradingView";
import type { AgentView, Payout } from "@/lib/types";
import { WalletBadge } from "./Intro";
import { MasterField } from "./SetupCard";
import { Sentence } from "./Sentence";

const STATE_ACCENT: Record<StepState, "ok" | "warn" | "neutral" | "info"> = { done: "ok", now: "info", blocked: "warn", later: "neutral" };

/** A numbered step: state pill, one-line why, the wallets it needs. Open while it is Now/Blocked; finished steps fold to one line. */
function StepShell({ info, summary, children, defaultOpen }: { info: StepInfo; summary?: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  const t = useT();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen ?? (info.state === "now" || info.state === "blocked");
  const expandable = children !== undefined && children !== null && children !== false;
  return (
    <li className={cx("rounded-card border bg-surface px-4 py-3", info.state === "now" || info.state === "blocked" ? "border-line-strong" : "border-line", info.state === "later" && "opacity-70")} aria-current={info.state === "now" ? "step" : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={cx("inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", info.state === "done" ? "border-ok/50 bg-ok-tint text-ok" : "border-line-strong text-ink-muted")}>
          {info.state === "done" ? <Icons.Check size={13} strokeWidth={3} /> : info.id}
        </span>
        <h3 className="m-0 min-w-0 flex-1 text-[15px] font-semibold">{t(`trading.step.${info.id}.title`)}</h3>
        {STEP_WALLETS[info.id].map((k) => (
          <WalletBadge key={k} kind={k} />
        ))}
        <Pill accent={STATE_ACCENT[info.state]}>{t(`trading.stepState.${info.state}`)}</Pill>
        {expandable && (
          <button type="button" className="cursor-pointer text-xs text-ink-muted underline" aria-expanded={open} onClick={() => setToggled(!open)}>
            {open ? t("trading.step.hide") : t("trading.step.show")}
          </button>
        )}
      </div>
      {info.state === "done" && summary ? <div className="mt-1.5 ml-9 text-[13px] text-ink-secondary">{summary}</div> : null}
      {open && (
        <div className="mt-3 ml-0 flex flex-col gap-3 md:ml-9">
          {info.state !== "done" && <p className="m-0 text-[13px] text-ink-muted">{t(`trading.step.${info.id}.why`)}</p>}
          {info.note && <Callout accent={info.state === "done" ? "warn" : info.state === "blocked" ? "warn" : "neutral"}>{t(`trading.note.${info.note}`)}</Callout>}
          {children}
        </div>
      )}
    </li>
  );
}

function CopyRow({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx("mono rounded border border-line bg-surface-sunken px-2 py-1 break-all", big ? "text-sm font-semibold" : "text-xs")}>{value}</span>
        <Button
          size="sm"
          icon={<Icons.Copy size={13} />}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
    </div>
  );
}

export interface StepperProps {
  steps: StepInfo[];
  status: TradingStatus | null;
  trader: AgentView | null;
  network: "mainnet" | "testnet";
  trust: AccountTrust | null;
  hlAgents: HlAgent[] | null;
  /** The address typed in step 1 and its setter. */
  master: string;
  setMaster: (v: string) => void;
  /** Step 2 form (or the one-time credentials); null when the agent exists. */
  setup: ReactNode;
  /** Pending hl-trader top-ups waiting for the owner. */
  pendingTopups: Payout[];
  rules: { name: string; hash: string; confirmedAtMs: number } | null;
  /** The signed rules in sentences (or a sign-in button); null when none are signed. */
  rulesBody: ReactNode;
  /** The rules help panel (template chips, examples, can/can't). */
  rulesHelp: ReactNode;
  onChangeRules: (() => void) | null;
  now: number;
}

/** The six steps with live state. Everything here is derived from data the page already reads. */
export function Stepper(p: StepperProps) {
  const t = useT();
  const byId = (id: StepId): StepInfo => p.steps.find((s) => s.id === id)!;
  const s = p.status;
  const account = p.trust?.kind === "ok" ? p.trust.account : null;
  const shownAccount = account ?? s?.hl_account ?? "";

  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t("trading.stepper.aria", { done: doneCount(p.steps) })}>
      {/* 1 */}
      <StepShell info={byId(1)} summary={shownAccount ? rich("trading.step.1.done", { account: <Hash value={shownAccount} short copy={false} className="align-bottom" />, network: p.network, active: s ? (Number(s.balances.equity_usdc) > 0 || Number(s.balances.usdc_total) > 0 ? t("trading.step.1.active") : t("trading.step.1.empty")) : "" }) : undefined}>
        {p.trader === null && (
          <>
            <ol className="m-0 flex flex-col gap-1 pl-5 text-sm text-ink-secondary">
              <li>{rich("trading.step.1.s1", { link: <a href={hlAppUrl(p.network, "")} target="_blank" rel="noreferrer">{hlAppUrl(p.network, "").replace("https://", "").replace(/\/$/, "")} <Icons.ExternalLink size={12} className="inline" /></a> })}</li>
              <li>{t("trading.step.1.s2")}</li>
              <li>{t("trading.step.1.s3")}</li>
            </ol>
            <MasterField master={p.master} setMaster={p.setMaster} now={p.now} />
          </>
        )}
      </StepShell>

      {/* 2 */}
      <StepShell info={byId(2)} defaultOpen={p.setup !== null} summary={p.trader ? <Sentence segs={mandateSegments(p.trader.mandate, {}, p.now)} /> : undefined}>
        {p.setup ?? (p.trader ? <Sentence segs={mandateSegments(p.trader.mandate, {}, p.now)} /> : null)}
      </StepShell>

      {/* 3 */}
      <StepShell
        info={byId(3)}
        summary={
          s ? (
            <>
              {rich("trading.step.3.done", { addr: <Hash value={s.api_wallet.address} short copy={false} className="align-bottom" />, until: s.api_wallet.valid_until_ms ? t("trading.step.3.until", { date: formatTime(s.api_wallet.valid_until_ms), rel: relativeTime(s.api_wallet.valid_until_ms, p.now) }) : "" })}
            </>
          ) : undefined
        }
      >
        {s && p.trader && <ApproveBody status={s} trust={p.trust} hlAgents={p.hlAgents} step={byId(3)} now={p.now} />}
      </StepShell>

      {/* 4 */}
      <StepShell info={byId(4)} summary={s ? t("trading.step.4.done", { amount: fmtDec(s.balances.equity_usdc, 2) }) : undefined}>
        {s && p.trader && <FundBody status={s} pending={p.pendingTopups} />}
      </StepShell>

      {/* 5 */}
      <StepShell
        info={byId(5)}
        defaultOpen={p.rules !== null ? true : undefined}
        summary={
          p.rules ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {rich("trading.step.5.done", { name: <strong>{p.rules.name}</strong> })} <Hash value={p.rules.hash} />
              {p.onChangeRules && (
                <Button size="sm" variant="ghost" onClick={p.onChangeRules}>
                  {t("trading.rules.change")}
                </Button>
              )}
            </span>
          ) : undefined
        }
      >
        {p.rules && (
          <div className="flex flex-col gap-3">
            <span className="text-xs text-ink-muted">{t("trading.rules.confirmedAt", { when: formatTime(p.rules.confirmedAtMs) })}</span>
            {p.rulesBody}
          </div>
        )}
        {p.rulesHelp}
      </StepShell>

      {/* 6 */}
      <StepShell info={byId(6)} defaultOpen={s && (s.state === "error" || s.state === "halted" || s.state === "stopped_today") ? true : undefined} summary={t("trading.step.6.done")}>
        {s && (s.state === "error" || s.state === "halted" || s.state === "stopped_today") && (() => {
          const why = reasonText(s.state_reason, s.state_detail);
          return why ? <Callout accent={s.state === "stopped_today" ? "warn" : "danger"}>{why}</Callout> : null;
        })()}
        <p className="m-0 text-sm text-ink-secondary">{s ? t(`trading.hint.${s.state}`, { sec: 60, lost: fmtDec(s.pnl.today_usdc.replace("-", ""), 2), limit: fmtDec(s.limits.effective.daily_loss_stop_usdc, 2) }) : t("trading.step.6.wait")}</p>
      </StepShell>
    </ol>
  );
}

/** Step 3: approve the bot wallet on Hyperliquid's API page. Matches the real page: name field, address field, "Authorize API Wallet". */
function ApproveBody({ status, trust, hlAgents, step, now }: { status: TradingStatus; trust: AccountTrust | null; hlAgents: HlAgent[] | null; step: StepInfo; now: number }) {
  const t = useT();
  const w = status.api_wallet;
  const url = hlAppUrl(status.hl_network);
  const urlText = url.replace("https://", "");
  const mine = w.address.toLowerCase();
  const others = (hlAgents ?? status.other_approved_agents).filter((a) => a.address.toLowerCase() !== mine);
  const accountOk = trust?.kind === "ok";
  const name = apiWalletNameStable(now);
  if (w.address === "") return null;
  if (!accountOk) return <Callout accent="danger">{t("trading.wallet.notShown")}</Callout>;
  return (
    <>
      {others.length > 0 && (
        <Callout accent="warn">
          {t("trading.wallet.others", { count: others.length })}
          <span className="mt-1 flex flex-col gap-1">
            {others.map((a) => (
              <span key={a.address} className="mono text-xs break-all">
                {a.address}
                {a.name ? ` (${a.name})` : ""}
              </span>
            ))}
          </span>
        </Callout>
      )}
      {step.state !== "done" || !w.approved ? (
        <>
          <CopyRow big label={t("trading.step.3.botAddress")} value={w.address} />
          <Callout accent="info" icon={<Icons.AlertTriangle size={16} />}>
            {t("trading.step.3.notNear")}
          </Callout>
          <ol className="m-0 flex flex-col gap-2.5 pl-5 text-sm text-ink-secondary">
            <li>
              {rich("trading.wallet.step1", {
                link: (
                  <a href={url} target="_blank" rel="noreferrer">
                    {urlText} <Icons.ExternalLink size={12} className="inline" />
                  </a>
                ),
                account: <Hash value={status.hl_account} short copy={false} className="align-bottom" />,
              })}
            </li>
            <li className="flex flex-col gap-1.5">
              {t("trading.wallet.stepName")}
              <CopyRow label={t("trading.wallet.fieldName")} value={name} />
            </li>
            <li className="flex flex-col gap-1.5">
              {t("trading.wallet.stepAddress")}
              <CopyRow label={t("trading.wallet.fieldAddress")} value={w.address} />
            </li>
            <li>{rich("trading.wallet.stepNoGenerate", { generate: <strong>Generate</strong> })}</li>
            <li>{rich("trading.wallet.stepAuthorize", { authorize: <strong>Authorize API Wallet</strong> })}</li>
            <li>{t("trading.wallet.stepBack")}</li>
          </ol>
          <p className="m-0 text-xs text-ink-subtle">{t("trading.wallet.caveat")}</p>
        </>
      ) : (
        <>
          <p className="m-0 text-xs text-ink-muted">{t("trading.wallet.approvedLine")}</p>
          <p className="m-0 text-xs text-ink-subtle">{t("trading.wallet.caveat")}</p>
        </>
      )}
    </>
  );
}

/** Step 4: balance, vault limits, pending top-up and the "wait until credited" check. */
function FundBody({ status, pending }: { status: TradingStatus; pending: Payout[] }) {
  const t = useT();
  const v = status.limits.vault;
  const equity = Number(status.balances.equity_usdc) || 0;
  const credited = equity >= MIN_ORDER_USDC;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact label={t("trading.step.4.free")} value={`${fmtDec(status.balances.usdc_free, 2)} USDC`} />
        <Fact label={t("trading.step.4.perTopup")} value={`${fmtDec(v.per_tx_limit_usdc, 2)} USDC`} />
        <Fact label={t("trading.step.4.left")} value={`${fmtDec(v.remaining_today_usdc, 2)} USDC`} />
        <Fact label={t("trading.step.4.topups")} value={`${v.payments_today} / ${v.max_payments_per_day}`} />
      </div>
      {pending.map((p) => (
        <Callout key={p.id} accent="info" action={<Link to={`/payouts/${p.id}`} className="text-sm underline">{t("trading.step.4.review")}</Link>}>
          {t("trading.step.4.pending", { amount: usdcGrouped(p.amount, 2) })}
        </Callout>
      ))}
      <p className="m-0 text-sm text-ink-secondary">{t("trading.step.4.how")}</p>
      <p className={cx("m-0 flex items-center gap-2 text-sm", credited ? "text-ok" : "text-ink-muted")}>
        <Dot accent={credited ? "ok" : "warn"} live={!credited} />
        {credited ? t("trading.step.4.credited", { amount: fmtDec(status.balances.equity_usdc, 2) }) : t("trading.step.4.wait", { min: MIN_ORDER_USDC })}
      </p>
      {status.warnings.map((w, i) => (
        <Callout key={i} accent="warn">
          {w}
        </Callout>
      ))}
    </>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-xs text-ink-muted">{label}</span>
    <span className="mono text-sm font-semibold">{value}</span>
  </div>
);

/** One-line row for the collapsed stepper once everything is done. */
export function SetupRow({ steps, children }: { steps: StepInfo[]; children: ReactNode }) {
  const t = useT();
  return (
    <Card aria-labelledby="trading-setup-row">
      <details>
        <summary id="trading-setup-row" className="cursor-pointer text-[15px] font-semibold">
          {t("trading.stepper.summary", { done: doneCount(steps), total: steps.length })}
        </summary>
        <div className="mt-3">{children}</div>
      </details>
    </Card>
  );
}
