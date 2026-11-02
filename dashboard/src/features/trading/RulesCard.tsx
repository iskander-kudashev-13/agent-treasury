import { useT, rich } from "@/i18n";
import { Button, Callout, Card, CardHeader, Hash, Icons } from "@/kit";
import { AI_ENABLED } from "@/lib/config";
import { formatTime } from "@/lib/format";
import type { ConfirmedRules, TradingStatus } from "@/lib/tradingClient";
import { midsOf } from "@/lib/tradingGuide";
import type { ReactNode } from "react";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { RulesView } from "./RulesView";

/** The rules the bot runs: name, hash and who confirmed them from the status; the full text after the owner signs in. */
export function RulesCard({ status, rules, verified, signedIn, signingIn, signIn, error, pair, help }: { status: TradingStatus; rules: ConfirmedRules | null; verified: boolean; signedIn: boolean; signingIn: boolean; signIn: () => void; error: string | null; pair: string; help: ReactNode }) {
  const t = useT();
  const { openWith } = useAssistantPanel();
  const a = status.active_rules;
  return (
    <Card aria-labelledby="trading-rules" className="flex flex-col gap-3">
      <CardHeader id="trading-rules" title={t("trading.rules.title")} />
      {!a ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-ink-secondary">{t("trading.rules.none")}</p>
          {AI_ENABLED ? (
            <div>
              <Button variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={() => openWith(t("trading.rules.prefillNew", { pair }))}>
                {t("trading.rules.describeBtn")}
              </Button>
            </div>
          ) : (
            <p className="m-0 text-xs text-ink-subtle">{t("trading.rules.aiOff")}</p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[15px] font-semibold break-words">{a.name}</span>
            <span className="text-xs text-ink-muted">
              {rich("trading.rules.confirmedBy", { when: formatTime(a.confirmed_at_ms), who: <span className="mono">{a.confirmed_by}</span> })}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <span>{t("trading.rules.hash")}</span>
            <Hash value={a.hash} />
          </div>
          {rules ? (
            <>
              <RulesView rules={rules.rules} mids={midsOf(status)} />
              {rules.hash !== a.hash && <Callout accent="warn">{t("trading.rules.hashMismatch")}</Callout>}
            </>
          ) : !verified ? (
            <Callout accent="danger">{t("trading.rules.unverified")}</Callout>
          ) : signedIn ? (
            <p className="m-0 text-[13px] text-ink-muted">{t("trading.rules.loading")}</p>
          ) : (
            <div>
              <Button size="sm" loading={signingIn} onClick={signIn}>
                {t("trading.rules.signInShow")}
              </Button>
            </div>
          )}
          {error && <Callout accent="danger">{error}</Callout>}
          {AI_ENABLED && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => openWith(t("trading.rules.prefillChange"))}>
                {t("trading.rules.change")}
              </Button>
            </div>
          )}
          <details className="text-[13px]">
            <summary className="cursor-pointer text-ink-secondary">{t("trading.help.summary")}</summary>
            <div className="mt-3">{help}</div>
          </details>
        </>
      )}
    </Card>
  );
}
