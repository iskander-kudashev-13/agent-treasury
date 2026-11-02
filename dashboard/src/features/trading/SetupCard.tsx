import { useT, rich } from "@/i18n";
import { useMemo, useRef, useState } from "react";
import { Sentence } from "./Sentence";
import { mandateSegments } from "@/lib/describeMandate";
import { Button, Callout, Card, CardHeader, Checkbox, Field, Icons, Input, SecretField, SigningHint, useSecretAck } from "@/kit";
import { clearPending, loadPending, savePending, type PendingKeyAgent } from "@/features/agents/pendingKey";
import { useAgentTx } from "@/features/agents/useAgentTx";
import { useOwner } from "@/features/owner/OwnerProvider";
import { DEFAULT_FUND_NEAR, planKeyAgentCreate, subAccountId, validateAccountPrefix, validateFund } from "@/lib/agentSetup";
import { NETWORK, VAULT_ID } from "@/lib/config";
import { generateAgentKey, type AgentKey } from "@/lib/keygen";
import { TRADER_AGENT_ID } from "@/lib/tradingClient";
import { buildTraderSetup, DEFAULT_DAILY_FUNDING, DEFAULT_TOPUP, mainnetSetupCommands, SESSION_LIMIT_USDC, TRADER_AGENT_NAME } from "@/lib/tradingView";
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
export function SetupCard({ created, onCreated, onDone, master, ready }: { created: PendingKeyAgent | null; onCreated: () => void; onDone: () => void; master: string; ready: boolean }) {
  const t = useT();
  const { canAct, busy, sign, accountId } = useAgentTx();
  const { ownerId } = useOwner();
  const now = useNow(60_000);
  const mainnet = NETWORK === "mainnet";
  const [daily, setDaily] = useState(mainnet ? SESSION_LIMIT_USDC : DEFAULT_DAILY_FUNDING);
  const [perTx, setPerTx] = useState(mainnet ? SESSION_LIMIT_USDC : DEFAULT_TOPUP);
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

  if (mainnet) return <MainnetSetup master={check.master} owner={owner} prefix={prefix} setPrefix={setPrefix} prefixErr={prefixErr} fund={fund} setFund={setFund} fundErr={fundErr} />;

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
    const ok = await sign(t("trading.setupCard.signLabel", { id: TRADER_AGENT_ID }), txs);
    if (ok) {
      setResult(pending);
      onCreated(); // the agent now exists on chain; the page keeps this card up until the key is saved
    }
    else clearPending();
  };

  const e = touched ? check.errors : {};
  return (
    <div aria-labelledby="trader-setup" className="flex flex-col gap-4">
      <p className="m-0 text-sm text-ink-secondary">{t("trading.setupCard.intro")}</p>
      {!ready && <Callout accent="neutral">{t("trading.setupCard.needAddress")}</Callout>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("trading.setupCard.daily")} hint={t("trading.setupCard.dailyHint")} {...(e.daily ? { error: e.daily } : {})}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={daily} onChange={(ev) => setDaily(ev.target.value)} state={e.daily ? "error" : "default"} />}
        </Field>
        <Field label={t("trading.setupCard.perTopup")} hint={t("trading.setupCard.perTopupHint")} {...(e.perTx ? { error: e.perTx } : {})}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={perTx} onChange={(ev) => setPerTx(ev.target.value)} state={e.perTx ? "error" : "default"} />}
        </Field>
      </div>
      <details className="text-[13px] text-ink-secondary">
        <summary className="cursor-pointer">{t("trading.setupCard.advanced")}</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label={t("trading.setupCard.agentAccount")} hint={owner ? subAccountId(prefix || "…", owner) : t("trading.setupCard.connectOwner")} {...(touched && prefixErr ? { error: prefixErr } : {})}>
            {(a11y) => <Input {...a11y} mono value={prefix} onChange={(ev) => setPrefix(ev.target.value.toLowerCase())} state={touched && prefixErr ? "error" : "default"} />}
          </Field>
          <Field label={t("trading.setupCard.gas")} hint={t("trading.setupCard.gasHint")} {...(touched && fundErr ? { error: fundErr } : {})}>
            {(a11y) => <Input {...a11y} mono suffix="NEAR" value={fund} onChange={(ev) => setFund(ev.target.value)} state={touched && fundErr ? "error" : "default"} />}
          </Field>
        </div>
      </details>
      {check.mandate ? (
        <p className="m-0 rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5 text-sm text-ink-secondary">
          <span className="mb-1 block text-xs text-ink-muted">{rich("trading.setupCard.creates", { id: <span className="mono">{TRADER_AGENT_ID}</span> })}</span>
          <Sentence segs={mandateSegments(check.mandate, {}, now)} />
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {busy && <SigningHint />}
        {!canAct && <span className="text-xs text-ink-muted">{t("trading.setupCard.onlyOwner")}</span>}
        <Button variant="primary" icon={<Icons.Plus size={14} />} disabled={!canAct || busy || !ready} loading={busy} onClick={() => void submit()}>
          {t("trading.setupCard.create")}
        </Button>
      </div>
    </div>
  );
}

/** Step 1 field: the owner's Hyperliquid (EVM) address. Lives in the page so step 1 can turn green before the agent exists. */
export function MasterField({ master, setMaster, now }: { master: string; setMaster: (v: string) => void; now: number }) {
  const t = useT();
  const [touched, setTouched] = useState(false);
  const check = useMemo(() => buildTraderSetup({ master, daily: DEFAULT_DAILY_FUNDING, perTx: DEFAULT_TOPUP }, now), [master, now]);
  const err = touched ? check.errors.master : undefined;
  return (
    <Field label={t("trading.setupCard.account")} hint={t("trading.setupCard.accountHint")} {...(err ? { error: err } : {})}>
      {(a11y) => <Input {...a11y} mono placeholder="0x…" value={master} onChange={(ev) => setMaster(ev.target.value)} onBlur={() => setTouched(true)} state={err ? "error" : "default"} autoComplete="off" spellCheck={false} />}
    </Field>
  );
}

/** One-time credentials for the worker `.env` (the private key is shown once). */
function Credentials({ p, master, perTx, onDone }: { p: PendingKeyAgent; master: string; perTx: string; onDone: () => void }) {
  const t = useT();
  const { canFinish, acked, setAcked } = useSecretAck(3000);
  const [copied, setCopied] = useState(false);
  const env = `TRADING_ENABLED=true\nTRADER_AGENT_ID=${p.id}\nTRADER_NEAR_ACCOUNT_ID=${p.account}\nTRADER_NEAR_PRIVATE_KEY=${p.secretKey}\n${master.trim() ? `HL_MASTER_ADDRESS=${master.trim().toLowerCase()}\n` : "HL_MASTER_ADDRESS=<your Hyperliquid account>\n"}${perTx.trim() ? `TRADING_TOPUP_USDC=${perTx.trim()}\n` : ""}`;
  return (
    <Card aria-labelledby="trader-creds" className="flex flex-col gap-4">
      <CardHeader id="trader-creds" title={t("trading.creds.title")} badge={<Icons.Check size={16} className="text-ok" />} />
      <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
        {t("trading.creds.saveKey")}
      </Callout>
      <SecretField value={p.secretKey} label={t("cs.secretLabel")} />
      <p className="m-0 text-xs text-ink-muted">
        {rich("trading.creds.keyScope", { a: <span className="mono">request_payment</span>, b: <span className="mono">report_payout_status</span>, env: <span className="mono">.env</span> })}
      </p>
      <pre tabIndex={0} aria-label={t("trading.creds.configAria")} className="secret mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
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
          {copied ? t("common.copied") : t("trading.creds.copyConfig")}
        </Button>
        <Checkbox checked={acked} onChange={setAcked} label={t("trading.creds.saved")} />
        <span className="grow" />
        <Button variant="primary" disabled={!canFinish} onClick={onDone}>
          {t("trading.creds.continue")}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Mainnet: the trader's NEAR key is NOT generated in the browser (audit 2026-11-03 M6; a script in the page could read it).
 * The dashboard only shows the exact CLI commands with the session mandate; the script prints the key once in the terminal.
 */
function MainnetSetup(p: {
  master: string | null;
  owner: string;
  prefix: string;
  setPrefix: (v: string) => void;
  prefixErr: string | null;
  fund: string;
  setFund: (v: string) => void;
  fundErr: string | null;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const ready = p.master !== null && p.owner !== "" && !p.prefixErr && !p.fundErr;
  const commands = ready && p.master ? mainnetSetupCommands({ owner: p.owner, vault: VAULT_ID, master: p.master, name: p.prefix, fundNear: p.fund }) : null;
  return (
    <div aria-labelledby="trader-setup" className="flex flex-col gap-4">
      <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
        {t("trading.main.cli")}
      </Callout>
      <details className="text-[13px] text-ink-secondary">
        <summary className="cursor-pointer">{t("trading.setupCard.advanced")}</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label={t("trading.setupCard.agentAccount")} hint={p.owner ? subAccountId(p.prefix || "…", p.owner) : t("trading.setupCard.connectOwner")} {...(p.prefixErr ? { error: p.prefixErr } : {})}>
            {(a11y) => <Input {...a11y} mono value={p.prefix} onChange={(ev) => p.setPrefix(ev.target.value.toLowerCase())} state={p.prefixErr ? "error" : "default"} />}
          </Field>
          <Field label={t("trading.setupCard.gas")} hint={t("trading.setupCard.gasHint")} {...(p.fundErr ? { error: p.fundErr } : {})}>
            {(a11y) => <Input {...a11y} mono suffix="NEAR" value={p.fund} onChange={(ev) => p.setFund(ev.target.value)} state={p.fundErr ? "error" : "default"} />}
          </Field>
        </div>
      </details>
      <p className="m-0 text-xs text-ink-muted">
        {t("trading.main.mandate", { limit: SESSION_LIMIT_USDC })}
      </p>
      {commands ? (
        <>
          <p className="m-0 text-xs text-ink-muted">
            {rich("trading.main.run", { ownerKey: <span className="mono">OWNER_PRIVATE_KEY</span>, env: <span className="mono">.env</span>, tk: <span className="mono">TRADER_NEAR_PRIVATE_KEY</span>, acc: <span className="mono">TRADER_NEAR_ACCOUNT_ID={subAccountId(p.prefix, p.owner)}</span>, hl: <span className="mono">HL_MASTER_ADDRESS={p.master}</span> })}
          </p>
          <pre tabIndex={0} aria-label={t("trading.main.cmdAria")} className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
            {commands}
          </pre>
          <div>
            <Button
              size="sm"
              icon={<Icons.Copy size={13} />}
              onClick={() =>
                void navigator.clipboard?.writeText(commands).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? t("common.copied") : t("trading.main.copyCommands")}
            </Button>
          </div>
        </>
      ) : (
        <p className="m-0 text-xs text-ink-subtle">{t("trading.main.enterValid", { more: p.owner === "" ? t("trading.main.andConnect") : "" })}</p>
      )}
    </div>
  );
}
