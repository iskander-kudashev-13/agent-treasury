import { useT } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Callout, Card, CardHeader, cx, Field, Icons, Input, Select, SigningHint, Skeleton, Stepper } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { botPath, TRADING_LIST_PATH } from "@/lib/agentKind";
import { NETWORK, WORKER_URL } from "@/lib/config";
import { confirmTradingRules, proposeTradingRules, stopSnapshot, stoppedSince, subscribeStops, withOwnerSession, type AgentTokenIssued } from "@/lib/tradingClient";
import { DEFAULT_HARD, hardLimitsOf, midsOf, pickPair } from "@/lib/tradingGuide";
import { issueText, parseRuleSet } from "@/lib/tradingRules";
import {
  agentHardLimits,
  appendAiRules,
  assembleRuleSet,
  defaultLimits,
  issueMessage,
  limitIssues,
  MAX_NAME,
  MAX_RULES,
  nameIssue,
  newBotId,
  normNumber,
  oversizedBuys,
  pairOptions,
  proposeErrorText,
  signErrorText,
  wizardSteps,
  type DraftRule,
  type LimitsForm,
  type TemplateFields,
  type WizMode,
} from "@/lib/tradingWizard";
import { AccountTrustCallout } from "./AccountTrust";
import { AgentConnectStep } from "./AgentConnectStep";
import { RuleBuilder, type AiState } from "./RuleBuilder";
import { RulesView } from "./RulesView";
import { useBots } from "./useBots";
import { tradingKeys, useAccountTrust, useTradingStatus } from "./useTrading";

const LIMIT_FIELDS = [
  { key: "maxPosition", label: "trading.wiz.l.maxPosition", unit: "USDC" },
  { key: "maxOrder", label: "trading.wiz.l.maxOrder", unit: "USDC" },
  { key: "lossStop", label: "trading.wiz.l.lossStop", unit: "USDC" },
  { key: "maxOrders", label: "trading.wiz.l.maxOrders", unit: "" },
] as const;

function ModeCard({ selected, disabled, icon, title, desc, note, onClick }: { selected: boolean; disabled?: boolean; icon: ReactNode; title: string; desc: string; note?: string | null; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex flex-col gap-1.5 rounded-card border p-4 text-left text-ink transition-colors",
        selected ? "border-ok bg-surface-hover" : "border-line bg-surface",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-line-strong",
      )}
    >
      <span className="flex items-center gap-2 text-[15px] font-semibold">
        {icon}
        {title}
        {selected && <Icons.Check size={16} className="ml-auto text-ok" />}
      </span>
      <span className="text-sm text-ink-secondary">{desc}</span>
      {note && <span className="text-xs text-ink-muted">{note}</span>}
    </button>
  );
}

/**
 * `/trading/new`: Name & pair -> Rules (templates or own words) -> Limits -> Review & sign. Creates a NEW worker bot (ADR-0006):
 * the owner signs the NEP-413 confirmation of the exact rule set shown, with `expectNew` so a challenge for an existing bot is
 * refused (audit MM1). The side chat stays for changing existing bots.
 * "Run by an AI agent" (ADR-0007): Name & pair -> Limits -> Review & sign -> Connect. The owner signs only limits (`mode: "agent"`,
 * no rules); the confirm returns the agent's access key once, shown on the Connect step and kept in this component's state only.
 */
export function NewStrategyWizard() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { canAct } = useOwner();
  const { accountId, signMessage } = useWallet();
  const { status, loading: statusLoading } = useTradingStatus();
  const live = status?.enabled ? status : null;
  const { trust, trusted } = useAccountTrust(live);
  const { data: botsLoad } = useBots();
  useSyncExternalStore(subscribeStops, stopSnapshot);

  const agentOn = live?.agent_trading?.enabled === true;
  const [modePick, setModePick] = useState<WizMode>("rules");
  // Chosen on the first step and kept after it (a status poll must not flip the steps under the owner; the worker re-checks).
  const [step, setStep] = useState(0);
  const mode: WizMode = modePick === "agent" && (agentOn || step > 0) ? "agent" : "rules";
  const accountHard = hardLimitsOf(live) ?? DEFAULT_HARD;
  const hard = mode === "agent" ? agentHardLimits(accountHard, live?.agent_trading?.max_orders_per_day) : accountHard;
  const bots = botsLoad?.bots ?? [];
  const pairs = pairOptions(pickPair({ status: live, network: live?.hl_network ?? (NETWORK === "mainnet" ? "mainnet" : "testnet") }), bots.flatMap((b) => b.pairs));

  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [pairPick, setPairPick] = useState<string | null>(null);
  const pair = pairPick !== null && pairs.includes(pairPick) ? pairPick : (pairs[0] ?? "");
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [editing, setEditing] = useState<{ index: number | null; fields: TemplateFields } | null>(null);
  const [ai, setAi] = useState<AiState>({ text: "", busy: false, note: null });
  const aiAbort = useRef<AbortController | null>(null);
  const [limitsEdit, setLimitsEdit] = useState<LimitsForm | null>(null);
  const limits = limitsEdit ?? defaultLimits(hard);
  const [reviewAt, setReviewAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The agent's access key after a successful agent-mode confirm. React state only (ADR-0007 §3: shown once, never stored).
  const [issued, setIssued] = useState<{ token: AgentTokenIssued; botId: string; name: string } | null>(null);

  const limitErr = limitIssues(limits, hard);
  const maxOrderNum = Number(normNumber(limits.maxOrder));
  const orderCap = limitErr.maxOrder ? hard.maxOrder : Math.min(maxOrderNum, hard.maxOrder);
  const oversized = oversizedBuys(rules, limitErr.maxOrder ? String(Math.floor(hard.maxOrder)) : normNumber(limits.maxOrder));
  const nErr = nameIssue(name);

  const ruleSet = useMemo(() => assembleRuleSet({ name, pair, limits, rules, mode }), [name, pair, limits, rules, mode]);
  const parsed = useMemo(() => parseRuleSet(ruleSet), [ruleSet]);
  const takenIds = bots.map((b) => b.id);
  const botId = newBotId(name, takenIds);
  // MM2: a Stop (all, or this id) after the owner reached the review step: signing stays off until they review again.
  const stopped = reviewAt !== null && stoppedSince(botId, reviewAt);

  const stepKeys = wizardSteps(mode);
  const cur = stepKeys[step] ?? "name";
  const reviewIdx = stepKeys.indexOf("review");
  const STEP_LABEL = { name: t("trading.wiz.step.name"), rules: t("trading.wiz.step.rules"), limits: t("trading.wiz.step.limits"), review: t("wiz.stepReview"), connect: t("trading.agent.step.connect") } as const;
  const steps = stepKeys.map((k) => STEP_LABEL[k]);
  // Agent mode has no rules, so drafted rules (if the owner switched modes) never block it.
  const tooBig = mode === "rules" && oversized.length > 0;
  const stepOk = { name: nErr === null && pair !== "", rules: rules.length > 0 && editing === null && !tooBig, limits: Object.keys(limitErr).length === 0 && !tooBig, review: true, connect: true }[cur];

  const next = () => {
    const to = Math.min(reviewIdx, step + 1);
    if (to === reviewIdx) setReviewAt(Date.now());
    setError(null);
    setStep(to);
  };
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  const propose = async () => {
    if (accountId === null || ai.busy) return;
    const text = ai.text.trim();
    if (!text) return;
    aiAbort.current?.abort();
    const ctl = new AbortController();
    aiAbort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), 95_000);
    setAi((a) => ({ ...a, busy: true, note: null }));
    try {
      const r = await withOwnerSession(accountId, signMessage, (token) => proposeTradingRules(token, text, ctl.signal));
      if (r.rules.length === 0) {
        setAi((a) => ({ ...a, busy: false, note: { kind: "error", text: t("trading.wiz.ai.noRules") } }));
        return;
      }
      const res = appendAiRules(rules, r.rules, pair);
      setRules(res.list);
      const added = res.list.length - rules.length;
      setAi({ text: "", busy: false, note: { kind: "ok", text: res.dropped > 0 ? t("trading.wiz.ai.dropped", { n: MAX_RULES }) : t("trading.wiz.ai.added", { count: added }) } });
    } catch (e) {
      setAi((a) => ({ ...a, busy: false, note: { kind: "error", text: proposeErrorText(e) } }));
    } finally {
      clearTimeout(timer);
    }
  };

  const signBlocked = !parsed.ok || live === null || trust?.kind !== "ok" || !canAct || accountId === null || botsLoad === null || stopped || busy;
  const submit = async () => {
    if (signBlocked || accountId === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await confirmTradingRules(ruleSet, { accountId, signMessage, trustedHlAccount: trusted, botId, botName: ruleSet.name, expectNew: true });
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      if (r.agent_token) {
        setIssued({ token: r.agent_token, botId: r.bot?.id ?? botId, name: ruleSet.name });
        setStep(stepKeys.indexOf("connect"));
        return;
      }
      navigate(botPath(r.bot?.id ?? botId));
    } catch (e) {
      setError(signErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  /* ───────── not available ───────── */
  if (WORKER_URL === "" || (status !== null && !status.enabled)) return <Callout accent="neutral">{t("trading.err.off")}</Callout>;
  if (statusLoading) return <Skeleton className="h-48" />;

  if (issued) {
    return (
      <div className="flex flex-col gap-4">
        <Stepper steps={steps} current={stepKeys.indexOf("connect")} />
        <AgentConnectStep botName={issued.name} workerUrl={WORKER_URL} issued={issued.token} doneLabel={t("trading.agent.savedDone")} onDone={() => navigate(botPath(issued.botId))} />
      </div>
    );
  }

  // At most one warning per screen: the most important one wins.
  const reviewNote = !canAct ? (
    <Callout accent="neutral">{t("trading.wiz.ownerOnly")}</Callout>
  ) : stopped ? (
    <Callout accent="warn">{t("as.rulesStopped")}</Callout>
  ) : !parsed.ok ? (
    <Callout accent="danger">{t("trading.wiz.err.local", { text: parsed.errors.map(issueText).join("; ") })}</Callout>
  ) : trust && trust.kind !== "ok" ? (
    <AccountTrustCallout trust={trust} />
  ) : error ? (
    <Callout accent="danger">{error}</Callout>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <Stepper steps={steps} current={step} />
      {!canAct && step < reviewIdx && <Callout accent="neutral">{t("trading.wiz.ownerOnly")}</Callout>}

      {cur === "name" && (
        <Card className="flex flex-col gap-3" aria-labelledby="new-strategy-how">
          <h2 id="new-strategy-how" className="m-0 text-[13px] font-medium text-ink-secondary">
            {t("trading.agent.how")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ModeCard selected={mode === "rules"} icon={<Icons.TrendingUp size={18} className="text-info" />} title={t("trading.agent.byRules")} desc={t("trading.agent.byRulesHint")} onClick={() => setModePick("rules")} />
            <ModeCard
              selected={mode === "agent"}
              disabled={!agentOn}
              icon={<Icons.Sparkles size={18} className="text-info" />}
              title={t("trading.agent.byAgent")}
              desc={t("trading.agent.byAgentHint")}
              note={agentOn ? null : t("trading.agent.off")}
              onClick={() => setModePick("agent")}
            />
          </div>
        </Card>
      )}

      {cur === "name" && (
        <Card className="grid gap-4 sm:grid-cols-2">
          <Field label={t("trading.wiz.name")} error={nameTouched && nErr ? issueMessage(nErr) : null}>
            {(a11y) => (
              <Input
                {...a11y}
                value={name}
                maxLength={MAX_NAME}
                placeholder={t("trading.wiz.namePlaceholder", { base: pair.split("/")[0] || "PURR" })}
                state={nameTouched && nErr ? "error" : "default"}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
              />
            )}
          </Field>
          <Field label={t("trading.wiz.pair")}>
            {(a11y) =>
              pairs.length > 1 ? (
                <Select {...a11y} value={pair} onChange={(e) => setPairPick(e.target.value)}>
                  {pairs.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input {...a11y} mono readOnly value={pair} />
              )
            }
          </Field>
        </Card>
      )}

      {cur === "rules" && (
        <Card className="flex flex-col gap-4">
          <RuleBuilder
            rules={rules}
            pair={pair}
            maxOrder={orderCap}
            editing={editing}
            setEditing={setEditing}
            onChange={setRules}
            ai={ai}
            setAiText={(text) => setAi((a) => ({ ...a, text }))}
            onPropose={() => void propose()}
          />
          {oversized.length > 0 && <p className="m-0 text-xs text-danger-text">{t("trading.wiz.err.oversized", { n: orderCap })}</p>}
        </Card>
      )}

      {cur === "limits" && (
        <Card className="flex flex-col gap-4">
          {mode === "agent" && <p className="m-0 text-sm text-ink-secondary">{t("trading.agent.limitsHint")}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            {LIMIT_FIELDS.map((f) => {
              const issue = limitErr[f.key];
              const max = { maxPosition: hard.maxPosition, maxOrder: hard.maxOrder, lossStop: hard.lossStop, maxOrders: Math.min(50, hard.maxOrders) }[f.key];
              return (
                <Field key={f.key} label={t(f.label)} hint={t("trading.wiz.l.upTo", { n: max })} error={issue ? issueMessage(issue) : null}>
                  {(a11y) => (
                    <Input
                      {...a11y}
                      mono
                      inputMode={f.key === "maxOrders" ? "numeric" : "decimal"}
                      {...(f.unit ? { suffix: f.unit } : {})}
                      value={limits[f.key]}
                      state={issue ? "error" : "default"}
                      onChange={(e) => setLimitsEdit({ ...limits, [f.key]: e.target.value.replace(f.key === "maxOrders" ? /[^\d]/g : /[^\d.,]/g, "") })}
                    />
                  )}
                </Field>
              );
            })}
          </div>
          {tooBig && <p className="m-0 text-xs text-danger-text">{t("trading.wiz.err.oversized", { n: limitErr.maxOrder ? Math.floor(hard.maxOrder) : maxOrderNum })}</p>}
        </Card>
      )}

      {cur === "review" && (
        <Card className="flex flex-col gap-4" aria-labelledby="new-strategy-review">
          <CardHeader id="new-strategy-review" title={t("wiz.stepReview")} />
          <RulesView rules={ruleSet} {...(live ? { mids: midsOf(live) } : {})} />
          {reviewNote}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {busy && <SigningHint />}
        <span className="grow" />
        {step > 0 ? (
          <Button onClick={back} disabled={busy}>
            {t("common.back")}
          </Button>
        ) : (
          <Button onClick={() => navigate(TRADING_LIST_PATH)}>{t("common.cancel")}</Button>
        )}
        {step < reviewIdx ? (
          <Button
            variant="primary"
            disabled={!stepOk}
            onClick={() => {
              if (step === 0) setNameTouched(true);
              next();
            }}
          >
            {t("common.next")}
          </Button>
        ) : (
          <Button variant="primary" disabled={signBlocked} loading={busy} onClick={() => void submit()}>
            {t(mode === "agent" ? "trading.agent.sign" : "trading.wiz.sign")}
          </Button>
        )}
      </div>
    </div>
  );
}
