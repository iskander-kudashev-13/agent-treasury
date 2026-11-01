import { useEffect, useState } from "react";
import { Button, Callout, Card, CardHeader, Checkbox, Icons, SecretField, Tabs, useSecretAck } from "@/kit";
import { downloadEnv, envSnippet, mcpConfig, type ConnectInput } from "@/lib/agentSetup";
import { clearPending } from "./pendingKey";

type Target = "env" | "code" | "desktop";

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

/** Wizard step 5 (Key agents): the private key is shown once (DESIGN_AGENTS §3.2). */
export function ConnectStep({ agentName, connect, onDone }: { agentName: string; connect: ConnectInput; onDone: () => void }) {
  const { canFinish, acked, setAcked } = useSecretAck(3000);
  const [target, setTarget] = useState<Target>("env");
  const { copied, copy } = useCopy();

  // Leaving the page loses the key for good: ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const snippet =
    target === "env"
      ? envSnippet(connect)
      : target === "code"
        ? `# .mcp.json (do not commit it), or:\nclaude mcp add agent-treasury -e TREASURY_VAULT=${connect.vault} -e TREASURY_NETWORK=${connect.network} -e TREASURY_AGENT_ACCOUNT=${connect.account} -e TREASURY_AGENT_PRIVATE_KEY=${connect.privateKey} -- node /ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js\n\n${mcpConfig(connect, connect.privateKey)}`
        : mcpConfig(connect, connect.privateKey);

  return (
    <Card aria-labelledby="connect-title" className="flex flex-col gap-4">
      <CardHeader id="connect-title" title={`Agent "${agentName}" is ready`} badge={<Icons.Check size={16} className="text-ok" />} />
      <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
        Save this key now. You won&apos;t see it again. It exists only in this browser tab and is stored nowhere else.
      </Callout>
      <SecretField value={connect.privateKey} />
      <p className="m-0 text-xs text-ink-muted">
        The key can only call <span className="mono">request_payment</span> and <span className="mono">report_payout_status</span> on the vault, with a gas allowance of 0.25 NEAR. What it may spend is capped by the mandate.
      </p>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink-secondary">Connect it</span>
        <Tabs
          label="Connect target"
          value={target}
          onChange={setTarget}
          items={[
            { value: "env", label: ".env" },
            { value: "code", label: "Claude Code" },
            { value: "desktop", label: "Claude Desktop" },
          ]}
        />
        <pre tabIndex={0} aria-label="Config with the private key (focus to reveal)" className="secret mono m-0 max-h-64 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
          {snippet}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Icons.Copy size={13} />} onClick={() => copy("snippet", snippet)}>
            {copied === "snippet" ? "Copied" : "Copy config"}
          </Button>
          <Button size="sm" icon={<Icons.Copy size={13} />} onClick={() => copy("key", connect.privateKey)}>
            {copied === "key" ? "Copied" : "Copy key"}
          </Button>
          <Button size="sm" icon={<Icons.ArrowDown size={13} />} onClick={() => downloadEnv(connect)}>
            Download .env
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Checkbox checked={acked} onChange={setAcked} label="I saved the key" />
        <span className="grow" />
        <Button
          variant="primary"
          disabled={!canFinish}
          onClick={() => {
            clearPending();
            onDone();
          }}
        >
          I saved it → Done
        </Button>
      </div>
    </Card>
  );
}
