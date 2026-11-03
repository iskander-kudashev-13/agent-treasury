import { useT } from "@/i18n";
import { useEffect, useState } from "react";
import { Button, Callout, Card, CardHeader, Checkbox, Icons, SecretField, Tabs, useSecretAck } from "@/kit";
import { formatTime } from "@/lib/format";
import { claudeCodeCommand, mcpJson, workerUrlUsable } from "@/lib/tradingAgentSetup";
import type { AgentTokenIssued } from "@/lib/tradingClient";

type Target = "code" | "json";

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    copy: (key: string, text: string) =>
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      }),
  };
}

/**
 * ADR-0007 §7: the AI agent's access key is shown ONCE, right after the owner signed the limits (new bot, Resume or New key).
 * The key lives only in the caller's React state: it is never stored, put in a URL or logged. Modelled on the key-agent
 * Connect step (`features/agents/ConnectStep.tsx`).
 */
export function AgentConnectStep({ botName, workerUrl, issued, doneLabel, onDone }: { botName: string; workerUrl: string; issued: AgentTokenIssued; doneLabel: string; onDone: () => void }) {
  const t = useT();
  const { canFinish, acked, setAcked } = useSecretAck(3000);
  const [target, setTarget] = useState<Target>("code");
  const { copied, copy } = useCopy();

  // Leaving the page loses the key for good: ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const input = { workerUrl, token: issued.token };
  const snippet = target === "code" ? claudeCodeCommand(input) : mcpJson(input);

  return (
    <Card aria-labelledby="agent-connect-title" className="flex flex-col gap-4">
      <CardHeader id="agent-connect-title" title={t("trading.agent.ready", { name: botName })} badge={<Icons.Check size={16} className="text-ok" />} />
      <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
        {t("trading.agent.saveToken")}
      </Callout>
      <SecretField value={issued.token} label={t("trading.agent.tokenLabel")} />
      <p className="m-0 text-xs text-ink-muted">{t("trading.agent.expires", { date: formatTime(issued.expires_at_ms) })}</p>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink-secondary">{t("trading.agent.connectIt")}</span>
        <Tabs
          label={t("trading.agent.connectTarget")}
          value={target}
          onChange={setTarget}
          items={[
            { value: "code", label: "Claude Code" },
            { value: "json", label: t("trading.agent.tabJson") },
          ]}
        />
        <pre tabIndex={0} aria-label={t("trading.agent.configAria")} className="secret mono m-0 max-h-64 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
          {snippet}
        </pre>
        <p className="m-0 text-xs text-ink-muted">{workerUrlUsable(workerUrl) ? t("trading.agent.pathHint") : t("trading.agent.urlNotSafe")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Icons.Copy size={13} />} onClick={() => copy("snippet", snippet)}>
            {copied === "snippet" ? t("common.copied") : t("cs.copyConfig")}
          </Button>
          <Button size="sm" icon={<Icons.Copy size={13} />} onClick={() => copy("key", issued.token)}>
            {copied === "key" ? t("common.copied") : t("cs.copyKey")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Checkbox checked={acked} onChange={setAcked} label={t("cs.savedKey")} />
        <span className="grow" />
        <Button variant="primary" disabled={!canFinish} onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </Card>
  );
}
