import { useMemo, useRef, useState } from "react";
import { Button, Callout, Card, CardHeader, Checkbox, Field, Icons, Input, SecretField, SigningHint, useSecretAck } from "@/kit";
import { clearPending, loadPending, savePending, type PendingKeyAgent } from "@/features/agents/pendingKey";
import { useAgentTx } from "@/features/agents/useAgentTx";
import { useOwner } from "@/features/owner/OwnerProvider";
import { DEFAULT_FUND_NEAR, planKeyAgentCreate, subAccountId, validateAccountPrefix, validateFund } from "@/lib/agentSetup";
import { VAULT_ID } from "@/lib/config";
import { generateAgentKey, type AgentKey } from "@/lib/keygen";
import { TRADER_AGENT_ID } from "@/lib/tradingClient";
import { buildTraderSetup, DEFAULT_DAILY_FUNDING, DEFAULT_TOPUP, TRADER_AGENT_NAME } from "@/lib/tradingView";
import { useNow } from "@/lib/useNow";

/** The pending one-time key of a trader created before a wallet redirect, if any. */
export const pendingTrader = (): PendingKeyAgent | null => {
  const p = loadPending();
  return p?.id === TRADER_AGENT_ID ? p : null;
};

/**
 * One screen to create the trader (ADR-0005 §2): the owner's Hyperliquid account, how much may be sent there per day and per
 * top-up. It creates the Key agent `hl-trader` with an Allowlist mandate through the same transaction builders as the
 * "Add agent" wizard (`planKeyAgentCreate`). The key is generated in this tab and shown once.
 */
export function SetupCard({ created, onCreated, onDone }: { created: PendingKeyAgent | null; onCreated: () => void; onDone: () => void }) {
  const { canAct, busy, sign, accountId } = useAgentTx();
  const { ownerId } = useOwner();
  const now = useNow(60_000);
  const [master, setMaster] = useState("");
  const [daily, setDaily] = useState(DEFAULT_DAILY_FUNDING);
  const [perTx, setPerTx] = useState(DEFAULT_TOPUP);
  const [prefix, setPrefix] = useState(TRADER_AGENT_ID);
  const [fund, setFund] = useState(DEFAULT_FUND_NEAR);
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<PendingKeyAgent | null>(created);
  const key = useRef<AgentKey | null>(null);

  const owner = ownerId ?? accountId ?? "";
  const check = useMemo(() => buildTraderSetup({ master, daily, perTx }, now), [master, daily, perTx, now]);
  const prefixErr = validateAccountPrefix(prefix, owner || "owner");
  const fundErr = validateFund(fund);
  const valid = check.mandate !== null && !prefixErr && !fundErr && owner !== "";

  if (result) return <Credentials p={result} master={master} perTx={perTx} onDone={() => { clearPending(); setResult(null); onDone(); }} />;

  const submit = async () => {
    setTouched(true);
    if (!valid || !check.mandate) return;
    key.current ??= generateAgentKey(); // lives in this tab only
    const k = key.current;
    const account = subAccountId(prefix, owner);
    const pending: PendingKeyAgent = { id: TRADER_AGENT_ID, name: TRADER_AGENT_NAME, account, publicKey: k.publicKey, secretKey: k.secretKey };
    savePending(pending); // survives a wallet redirect
    const txs = planKeyAgentCreate({ id: TRADER_AGENT_ID, name: TRADER_AGENT_NAME, mandate: check.mandate, owner, vault: VAULT_ID, prefix, publicKey: k.publicKey, fundNear: fund });
    const ok = await sign(`Add agent ${TRADER_AGENT_ID}`, txs);
    if (ok) {
      setResult(pending);
      onCreated(); // the agent now exists on chain; the page keeps this card up until the key is saved
    }
    else clearPending();
  };

  const e = touched ? check.errors : {};
  return (
    <Card aria-labelledby="trader-setup" className="flex flex-col gap-4">
      <CardHeader id="trader-setup" title="Set up the trading agent" />
      <p className="m-0 text-sm text-ink-secondary">
        The agent trades spot on Hyperliquid with USDC from your vault. The vault can send money only to the account below, within these limits.
      </p>
      <Field label="Your Hyperliquid account" hint="A dedicated account for the bot, already active on Hyperliquid, not your personal trading account." {...(e.master ? { error: e.master } : {})}>
        {(a11y) => <Input {...a11y} mono placeholder="0x…" value={master} onChange={(ev) => setMaster(ev.target.value)} state={e.master ? "error" : "default"} autoComplete="off" spellCheck={false} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Daily funding limit" hint="Most the vault sends per day." {...(e.daily ? { error: e.daily } : {})}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={daily} onChange={(ev) => setDaily(ev.target.value)} state={e.daily ? "error" : "default"} />}
        </Field>
        <Field label="Per top-up" hint="Sent when the account runs low. At most 2 a day." {...(e.perTx ? { error: e.perTx } : {})}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={perTx} onChange={(ev) => setPerTx(ev.target.value)} state={e.perTx ? "error" : "default"} />}
        </Field>
      </div>
      <details className="text-[13px] text-ink-secondary">
        <summary className="cursor-pointer">Advanced</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Agent account" hint={owner ? subAccountId(prefix || "…", owner) : "Connect the owner wallet"} {...(touched && prefixErr ? { error: prefixErr } : {})}>
            {(a11y) => <Input {...a11y} mono value={prefix} onChange={(ev) => setPrefix(ev.target.value.toLowerCase())} state={touched && prefixErr ? "error" : "default"} />}
          </Field>
          <Field label="Gas funding" hint="NEAR sent to the agent account for fees." {...(touched && fundErr ? { error: fundErr } : {})}>
            {(a11y) => <Input {...a11y} mono suffix="NEAR" value={fund} onChange={(ev) => setFund(ev.target.value)} state={touched && fundErr ? "error" : "default"} />}
          </Field>
        </div>
      </details>
      <p className="m-0 text-xs text-ink-muted">
        Creates the agent <span className="mono">{TRADER_AGENT_ID}</span> with an allowlist of that one address, up to 2 top-ups of {perTx || "…"} USDC a day, expiring in 30 days. You can pause it at any time.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {busy && <SigningHint />}
        {!canAct && <span className="text-xs text-ink-muted">Only the vault owner can set this up</span>}
        <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct || busy} loading={busy} onClick={() => void submit()}>
          Create trading agent
        </Button>
      </div>
    </Card>
  );
}

/** One-time credentials for the worker `.env` (the private key is shown once). */
function Credentials({ p, master, perTx, onDone }: { p: PendingKeyAgent; master: string; perTx: string; onDone: () => void }) {
  const { canFinish, acked, setAcked } = useSecretAck(3000);
  const [copied, setCopied] = useState(false);
  const env = `TRADING_ENABLED=true\nTRADER_AGENT_ID=${p.id}\nTRADER_NEAR_ACCOUNT_ID=${p.account}\nTRADER_NEAR_PRIVATE_KEY=${p.secretKey}\n${master.trim() ? `HL_MASTER_ADDRESS=${master.trim().toLowerCase()}\n` : "HL_MASTER_ADDRESS=<your Hyperliquid account>\n"}${perTx.trim() ? `TRADING_TOPUP_USDC=${perTx.trim()}\n` : ""}`;
  return (
    <Card aria-labelledby="trader-creds" className="flex flex-col gap-4">
      <CardHeader id="trader-creds" title="Trading agent created" badge={<Icons.Check size={16} className="text-ok" />} />
      <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
        Save this key now. You won&apos;t see it again. It exists only in this browser tab.
      </Callout>
      <SecretField value={p.secretKey} />
      <p className="m-0 text-xs text-ink-muted">
        The key can only call <span className="mono">request_payment</span> and <span className="mono">report_payout_status</span> on your vault, and the vault enforces the limits you set. Add these lines to the worker&apos;s <span className="mono">.env</span> and restart it:
      </p>
      <pre tabIndex={0} aria-label="Worker configuration with the private key (focus to reveal)" className="secret mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
        {env}
      </pre>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button
          size="sm"
          icon={<Icons.Copy size={13} />}
          onClick={() =>
            void navigator.clipboard?.writeText(env).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : "Copy config"}
        </Button>
        <Checkbox checked={acked} onChange={setAcked} label="I saved the key" />
        <span className="grow" />
        <Button variant="primary" disabled={!canFinish} onClick={onDone}>
          I saved it → Continue
        </Button>
      </div>
    </Card>
  );
}
