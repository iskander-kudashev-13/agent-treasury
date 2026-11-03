import { useT } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Callout, Card, CardHeader, Field, Input, Select, SigningHint, Skeleton, Stepper } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { botPath, TRADING_LIST_PATH } from "@/lib/agentKind";
import { NETWORK, WORKER_URL } from "@/lib/config";
import { confirmTradingRules, proposeTradingRules, stopSnapshot, stoppedSince, subscribeStops, withOwnerSession } from "@/lib/tradingClient";
import { DEFAULT_HARD, hardLimitsOf, midsOf, pickPair } from "@/lib/tradingGuide";
import { issueText, parseRuleSet } from "@/lib/tradingRules";
import {
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
  type DraftRule,
  type LimitsForm,
  type TemplateFields,
} from "@/lib/tradingWizard";
import { AccountTrustCallout } from "./AccountTrust";
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

/**
 * `/trading/new`: Name & pair -> Rules (templates or own words) -> Limits -> Review & sign. Creates a NEW worker bot (ADR-0006):
 * the owner signs the NEP-413 confirmation of the exact rule set shown, with `expectNew` so a challenge for an existing bot is
 * refused (audit MM1). The side chat stays for changing existing bots.
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

  const hard = hardLimitsOf(live) ?? DEFAULT_HARD;
  const bots = botsLoad?.bots ?? [];
  const pairs = pairOptions(pickPair({ status: live, network: live?.hl_network ?? (NETWORK === "mainnet" ? "mainnet" : "testnet") }), bots.flatMap((b) => b.pairs));

  const [step, setStep] = useState(0);
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

  const limitErr = limitIssues(limits, hard);
  const maxOrderNum = Number(normNumber(limits.maxOrder));
  const orderCap = limitErr.maxOrder ? hard.maxOrder : Math.min(maxOrderNum, hard.maxOrder);
  const oversized = oversizedBuys(rules, limitErr.maxOrder ? String(Math.floor(hard.maxOrder)) : normNumber(limits.maxOrder));
  const nErr = nameIssue(name);

  const ruleSet = useMemo(() => assembleRuleSet({ name, pair, limits, rules }), [name, pair, limits, rules]);
  const parsed = useMemo(() => parseRuleSet(ruleSet), [ruleSet]);
  const takenIds = bots.map((b) => b.id);
  const botId = newBotId(name, takenIds);
  // MM2: a Stop (all, or this id) after the owner reached the review step: signing stays off until they review again.
  const stopped = reviewAt !== null && stoppedSince(botId, reviewAt);

  const steps = [t("trading.wiz.step.name"), t("trading.wiz.step.rules"), t("trading.wiz.step.limits"), t("wiz.stepReview")];
  const stepOk = [nErr === null && pair !== "", rules.length > 0 && editing === null && oversized.length === 0, Object.keys(limitErr).length === 0 && oversized.length === 0, true][step] ?? false;

  const next = () => {
    const to = Math.min(3, step + 1);
    if (to === 3) setReviewAt(Date.now());
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
      {!canAct && step < 3 && <Callout accent="neutral">{t("trading.wiz.ownerOnly")}</Callout>}

      {step === 0 && (
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

      {step === 1 && (
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

      {step === 2 && (
        <Card className="flex flex-col gap-4">
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
          {oversized.length > 0 && <p className="m-0 text-xs text-danger-text">{t("trading.wiz.err.oversized", { n: limitErr.maxOrder ? Math.floor(hard.maxOrder) : maxOrderNum })}</p>}
        </Card>
      )}

      {step === 3 && (
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
        {step < 3 ? (
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
            {t("trading.wiz.sign")}
          </Button>
        )}
      </div>
    </div>
  );
}
