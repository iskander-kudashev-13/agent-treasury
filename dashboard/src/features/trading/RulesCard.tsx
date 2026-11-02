import { Button, Callout, Card, CardHeader, Hash, Icons } from "@/kit";
import { AI_ENABLED } from "@/lib/config";
import { formatTime } from "@/lib/format";
import type { ConfirmedRules, TradingStatus } from "@/lib/tradingClient";
import { useAssistantPanel } from "@/features/layout/AssistantContext";
import { RulesView } from "./RulesView";

/** The rules the bot runs: name, hash and who confirmed them from the status; the full text after the owner signs in. */
export function RulesCard({ status, rules, verified, signedIn, signingIn, signIn, error }: { status: TradingStatus; rules: ConfirmedRules | null; verified: boolean; signedIn: boolean; signingIn: boolean; signIn: () => void; error: string | null }) {
  const { openWith } = useAssistantPanel();
  const a = status.active_rules;
  return (
    <Card aria-labelledby="trading-rules" className="flex flex-col gap-3">
      <CardHeader id="trading-rules" title="Active rules" />
      {!a ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-ink-secondary">No rules are active, so the bot does not trade. Describe a strategy in plain words; you review the rules and sign them.</p>
          {AI_ENABLED ? (
            <div>
              <Button variant="assistant" icon={<Icons.Sparkles size={14} />} onClick={() => openWith("Trade HYPE on Hyperliquid: ")}>
                Describe rules to the assistant
              </Button>
            </div>
          ) : (
            <p className="m-0 text-xs text-ink-subtle">The assistant is switched off in this dashboard (VITE_AI_ENABLED).</p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[15px] font-semibold break-words">{a.name}</span>
            <span className="text-xs text-ink-muted">
              confirmed {formatTime(a.confirmed_at_ms)} by <span className="mono">{a.confirmed_by}</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <span>Hash</span>
            <Hash value={a.hash} />
          </div>
          {rules ? (
            <>
              <RulesView rules={rules.rules} />
              {rules.hash !== a.hash && <Callout accent="warn">The worker returned rules with a different hash than the status shows. Refresh before relying on this text.</Callout>}
            </>
          ) : !verified ? (
            <Callout accent="danger">The rules returned by the worker do not match their signed hash, so they are not shown. Treat the bot as untrusted and use the kill switch if unsure.</Callout>
          ) : signedIn ? (
            <p className="m-0 text-[13px] text-ink-muted">Loading the rules…</p>
          ) : (
            <div>
              <Button size="sm" loading={signingIn} onClick={signIn}>
                Sign in to show the rules
              </Button>
            </div>
          )}
          {error && <Callout accent="danger">{error}</Callout>}
          {AI_ENABLED && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => openWith("Change the trading rules: ")}>
                Change rules
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
