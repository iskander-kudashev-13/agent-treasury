import { useT, rich } from "@/i18n";
import { useState } from "react";
import { Callout, Card, EmptyState, Pill, Skeleton } from "@/kit";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { WORKER_URL } from "@/lib/config";
import { TRADER_AGENT_ID } from "@/lib/tradingClient";
import { useAgents } from "@/lib/useVault";
import { ApiWalletCard } from "./ApiWalletCard";
import { KillSwitch } from "./KillSwitch";
import { RulesCard } from "./RulesCard";
import { pendingTrader, SetupCard } from "./SetupCard";
import { StatusCard } from "./StatusCard";
import { AccountTrustCallout } from "./AccountTrust";
import { useAccountTrust, useHlApprovedAgents, useOwnerDetails, useTradingStatus } from "./useTrading";

/** `/trading`: set up, approve the bot's wallet, see status and rules, stop. Calm and linear (docs/research: one-screen setup). */
export function Trading() {
  const t = useT();
  const agents = useAgents();
  const { status, loading, error, refresh } = useTradingStatus();
  const details = useOwnerDetails();
  const [recovered] = useState(pendingTrader);
  const [creating, setCreating] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const trader = agents.data.find((a) => a.id === TRADER_AGENT_ID && a.status !== "Revoked") ?? null;
  const recoveredNow = recovered !== null && !dismissed && trader?.account_id === recovered.account;
  const showSetup = !agents.loading && (trader === null || creating || recoveredNow);
  const live = status?.enabled ? status : null;
  const { trust, trusted } = useAccountTrust(live);
  const hlAgents = useHlApprovedAgents(live?.hl_network ?? "testnet", live && trust?.kind === "ok" ? trusted : null);
  const accountOk = trust?.kind === "ok";

  return (
    <div className="flex flex-col gap-4">
      <QueryErrors sources={[{ label: t("src.agents"), error: agents.error, refresh: agents.refresh }]} />

      {showSetup && <SetupCard created={recoveredNow ? recovered : null} onCreated={() => setCreating(true)} onDone={() => { setCreating(false); setDismissed(true); }} />}

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
      ) : live ? (
        <>
          <AccountTrustCallout trust={trust} />
          {(!live.api_wallet.approved || live.state === "awaiting_api_wallet") && <ApiWalletCard status={live} accountOk={accountOk} hlAgents={hlAgents} />}
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
          <RulesCard status={live} rules={details.rules} verified={details.rulesVerified} signedIn={details.signedIn} signingIn={details.signingIn} signIn={() => void details.signIn()} error={details.authError ?? details.error} />
          {live.api_wallet.approved && live.api_wallet.address && <ApiWalletCard status={live} accountOk={accountOk} hlAgents={hlAgents} />}
          <KillSwitch status={live} />
        </>
      ) : null}
    </div>
  );
}
