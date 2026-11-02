import { useT } from "@/i18n";
import { Button, Callout, Card, CardHeader, Icons } from "@/kit";
import { AI_ENABLED } from "@/lib/config";
import type { BotDetail, TradingStatus } from "@/lib/tradingClient";
import { fmtMoney } from "@/lib/tradingMetrics";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { RulesBody } from "../RulesCard";

/** The agent's rules as plain sentences, its limits next to the account caps, and "Change rules" through the assistant. */
export function Settings({ detail, status, signedIn, signingIn, signIn, error }: { detail: BotDetail; status: TradingStatus; signedIn: boolean; signingIn: boolean; signIn: () => void; error: string | null }) {
  const t = useT();
  const { openWith } = useAssistantPanel();
  const own = detail.limits.bot;
  const acc = detail.limits.account;
  return (
    <Card aria-labelledby="bot-rules" className="flex flex-col gap-3">
      <CardHeader
        id="bot-rules"
        title={t("trading.bot.rulesTitle")}
        actions={
          AI_ENABLED ? (
            <Button size="sm" variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={() => openWith(t("trading.bot.prefillChange", { name: detail.bot.name }))}>
              {t("trading.bot.changeRules")}
            </Button>
          ) : undefined
        }
      />
      <RulesBody status={status} rules={detail.rules} verified signedIn={signedIn} signingIn={signingIn} signIn={signIn} error={error} log={[]} />
      {(own || acc) && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-ink-secondary">
          {own && <li>{t("trading.bot.limitsBot", { position: fmtMoney(own.max_position_usdc), order: fmtMoney(own.max_order_usdc), loss: fmtMoney(own.daily_loss_stop_usdc), orders: own.max_orders_per_day })}</li>}
          {acc && <li className="text-ink-muted">{t("trading.bot.limitsAccount", { position: fmtMoney(acc.max_position_usdc), order: fmtMoney(acc.max_order_usdc), loss: fmtMoney(acc.daily_loss_stop_usdc), orders: acc.max_orders_per_day })}</li>}
          <li className="text-ink-muted">{t("trading.bot.todayLine", { orders: detail.today.orders, loss: fmtMoney(detail.today.loss_usdc) })}</li>
        </ul>
      )}
      {!AI_ENABLED && <Callout accent="info">{t("trading.rules.aiOff")}</Callout>}
    </Card>
  );
}
