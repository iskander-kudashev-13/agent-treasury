import { useT, rich } from "@/i18n";
import { useMemo, useState } from "react";
import { Callout, Card, EmptyState, Pill, Skeleton } from "@/kit";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { AI_ENABLED, NETWORK, WORKER_URL } from "@/lib/config";
import { TRADER_AGENT_ID } from "@/lib/tradingClient";
import { DEFAULT_HARD, deriveSteps, hardLimitsOf, pickPair } from "@/lib/tradingGuide";
import { buildTraderSetup, DEFAULT_DAILY_FUNDING, DEFAULT_TOPUP } from "@/lib/tradingView";
import { useNow } from "@/lib/useNow";
import { useAgents, usePendingApprovals } from "@/lib/useVault";
import { GuideLinks } from "./Intro";
import { KillSwitch } from "./KillSwitch";
import { RulesBody, RulesCard } from "./RulesCard";
import { RulesHelp } from "./RulesHelp";
import { pendingTrader, SetupCard } from "./SetupCard";
import { SetupRow, Stepper } from "./Steps";
import { StatusCard } from "./StatusCard";
import { AccountTrustCallout } from "./AccountTrust";
import { useAccountTrust, useHlApprovedAgents, useOwnerDetails, useTradingStatus } from "./useTrading";

/**
 * `/trading`: an intro (what it is, where the money goes, what is protected, which wallet is which), a six-step setup with live
 * state, and, once rules are signed, the running view (status, event feed, rules in sentences) and the kill switch.
 */
export function Trading() {
  const t = useT();
  const agents = useAgents();
  const pendingApprovals = usePendingApprovals();
  const { status, loading, error, refresh } = useTradingStatus();
  const details = useOwnerDetails();
  const { openWith } = useAssistantPanel();
  const now = useNow(30_000);
  const [recovered] = useState(pendingTrader);
  const [creating, setCreating] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [master, setMaster] = useState("");

  const trader = agents.data.find((a) => a.id === TRADER_AGENT_ID && a.status !== "Revoked") ?? null;
  const recoveredNow = recovered !== null && !dismissed && trader?.account_id === recovered.account;
  const showSetup = !agents.loading && (trader === null || creating || recoveredNow);
  const live = status?.enabled ? status : null;
  const { trust, trusted } = useAccountTrust(live);
  const hlAgents = useHlApprovedAgents(live?.hl_network ?? "testnet", live && trust?.kind === "ok" ? trusted : null);
  const network = live?.hl_network ?? (NETWORK === "mainnet" ? "mainnet" : "testnet");
  const formAddress = useMemo(() => buildTraderSetup({ master, daily: DEFAULT_DAILY_FUNDING, perTx: DEFAULT_TOPUP }, now).master, [master, now]);
  const hard = hardLimitsOf(live) ?? DEFAULT_HARD;
  const pair = pickPair({ status: live, rulesPairs: details.rules?.rules.pairs, network });

  const steps = deriveSteps({
    workerConfigured: WORKER_URL !== "",
    trader: trader ? { status: trader.status } : null,
    onchainAccount: trusted,
    formAddress,
    status: live,
    trust,
    hlAgents,
    aiEnabled: AI_ENABLED,
    nowMs: now,
  });
  const allDone = steps.every((s) => s.state === "done");
  const running = live !== null && live.active_rules !== null;
  const help = <RulesHelp pair={pair} hard={hard} />;
  const pendingTopups = pendingApprovals.data.filter((p) => p.agent_id === TRADER_AGENT_ID);

  const stepper = (
    <Stepper
      steps={steps}
      status={live}
      trader={trader}
      network={network}
      trust={trust}
      hlAgents={hlAgents}
      master={trusted ?? master}
      setMaster={setMaster}
      setup={showSetup ? <SetupCard created={recoveredNow ? recovered : null} onCreated={() => setCreating(true)} onDone={() => { setCreating(false); setDismissed(true); }} master={master} ready={formAddress !== null} /> : null}
      pendingTopups={pendingTopups}
      rules={live?.active_rules ? { name: live.active_rules.name, hash: live.active_rules.hash, confirmedAtMs: live.active_rules.confirmed_at_ms } : null}
      rulesBody={live?.active_rules ? <RulesBody status={live} rules={details.rules} verified={details.rulesVerified} signedIn={details.signedIn} signingIn={details.signingIn} signIn={() => void details.signIn()} error={details.authError ?? details.error} log={details.log} /> : null}
      rulesHelp={help}
      onChangeRules={AI_ENABLED ? () => openWith(t("trading.rules.prefillChange")) : null}
      now={now}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <QueryErrors sources={[{ label: t("src.agents"), error: agents.error, refresh: agents.refresh }]} />

      <GuideLinks />

      {WORKER_URL === "" ? (
        <EmptyState title={t("trading.page.workerNotConfigured")}>{t("trading.page.setWorkerUrl")}</EmptyState>
      ) : loading ? (
        <Card className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : error ? (
        <Callout accent="danger" action={<button type="button" className="cursor-pointer text-sm underline" onClick={() => void refresh()}>{t("common.retry")}</button>}>
          {t("trading.page.cantReach", { error })}
        </Callout>
      ) : status && !status.enabled ? (
        <Card className="flex flex-col gap-2">
          <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold">
            {t("trading.page.workerOff")} <Pill>{t("trading.page.off")}</Pill>
          </h2>
          <p className="m-0 text-sm text-ink-secondary">
            {rich("trading.page.workerOffBody", { flag: <span className="mono">TRADING_ENABLED=true</span>, env: <span className="mono">.env</span> })}
          </p>
        </Card>
      ) : null}

      {live && <AccountTrustCallout trust={trust} />}

      {running && live && (
        <>
          <StatusCard
            status={live}
            log={details.log}
            logLoading={details.loading}
            logHint={
              details.signedIn ? (
                t("trading.page.noDecisions")
              ) : (
                <button type="button" className="cursor-pointer underline" disabled={details.signingIn} onClick={() => void details.signIn()}>
                  {details.signingIn ? t("common.confirmInWallet") : t("trading.page.signInDecisions")}
                </button>
              )
            }
          />
          <RulesCard status={live} rules={details.rules} verified={details.rulesVerified} signedIn={details.signedIn} signingIn={details.signingIn} signIn={() => void details.signIn()} error={details.authError ?? details.error} pair={pair} help={help} log={details.log} />
        </>
      )}

      {allDone && running ? (
        <SetupRow steps={steps}>{stepper}</SetupRow>
      ) : (
        <section aria-labelledby="trading-stepper" className="flex flex-col gap-2">
          <h2 id="trading-stepper" className="m-0 text-[15px] font-semibold">
            {t("trading.stepper.title")}
          </h2>
          {stepper}
        </section>
      )}

      {live && trader && <KillSwitch status={live} />}
    </div>
  );
}
