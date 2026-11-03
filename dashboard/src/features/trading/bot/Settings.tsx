import { useT } from "@/i18n";
import { useState } from "react";
import { Button, Callout, Card, CardHeader, Icons } from "@/kit";
import { AI_ENABLED, WORKER_URL } from "@/lib/config";
import type { AgentTokenIssued, BotDetail, TradingStatus } from "@/lib/tradingClient";
import { fmtMoney } from "@/lib/tradingMetrics";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { AgentConnectStep } from "../AgentConnectStep";
import { RulesBody } from "../RulesCard";
import { AgentAccess } from "./AgentAccess";

/**
 * The agent's rules as plain sentences, its limits next to the account caps, and "Change rules" through the assistant.
 * AI-agent bots (ADR-0007): no rules and no "Change rules"; the signed limits, the agent's access, Resume / New key / Revoke.
 */
export function Settings({ detail, status, signedIn, signingIn, signIn, error }: { detail: BotDetail; status: TradingStatus; signedIn: boolean; signingIn: boolean; signIn: () => void; error: string | null }) {
  const t = useT();
  const { openWith } = useAssistantPanel();
  // A new agent key after Resume / New key: React state only, shown once, gone when the owner closes the card.
  const [issued, setIssued] = useState<AgentTokenIssued | null>(null);
  const own = detail.limits.bot;
  const acc = detail.limits.account;
  const agent = detail.kind === "agent";

  if (agent && issued) {
    return <AgentConnectStep botName={detail.bot.name} workerUrl={WORKER_URL} issued={issued} doneLabel={t("trading.agent.done")} onDone={() => setIssued(null)} />;
  }

  return (
    <Card aria-labelledby="bot-rules" className="flex flex-col gap-3">
      <CardHeader
        id="bot-rules"
        title={t(agent ? "trading.agent.settingsTitle" : "trading.bot.rulesTitle")}
        actions={
          AI_ENABLED && !agent ? (
            <Button size="sm" variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={() => openWith(t("trading.bot.prefillChange", { name: detail.bot.name }), detail.bot.id)}>
              {t("trading.bot.changeRules")}
            </Button>
          ) : undefined
        }
      />
      {!detail.rules && !signedIn && <p className="m-0 text-sm text-ink-muted">{t("trading.bot.rulesLocked")}</p>}
      <RulesBody status={status} rules={detail.rules} verified signedIn={signedIn} signingIn={signingIn} signIn={signIn} error={error} log={[]} />
      {(own || acc) && (detail.rules || signedIn) && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-ink-secondary">
          {own && !agent && <li>{t("trading.bot.limitsBot", { position: fmtMoney(own.max_position_usdc), order: fmtMoney(own.max_order_usdc), loss: fmtMoney(own.daily_loss_stop_usdc), orders: own.max_orders_per_day })}</li>}
          {acc && <li className="text-ink-muted">{t("trading.bot.limitsAccount", { position: fmtMoney(acc.max_position_usdc), order: fmtMoney(acc.max_order_usdc), loss: fmtMoney(acc.daily_loss_stop_usdc), orders: acc.max_orders_per_day })}</li>}
          <li className="text-ink-muted">{t("trading.bot.todayLine", { orders: detail.today.orders, loss: fmtMoney(detail.today.loss_usdc) })}</li>
        </ul>
      )}
      {agent && signedIn && <AgentAccess detail={detail} status={status} onIssued={setIssued} />}
      {!AI_ENABLED && !agent && <Callout accent="info">{t("trading.rules.aiOff")}</Callout>}
    </Card>
  );
}
