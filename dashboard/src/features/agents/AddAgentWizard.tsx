import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Callout, Card, CardHeader, cx, Field, Icons, Input, SigningHint, Stepper } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import {
  DEFAULT_FUND_NEAR,
  isImplicitAccount,
  isNearAccountId,
  planKeyAgentCreate,
  planKeyAgentExisting,
  planTeeSlot,
  slugify,
  subAccountId,
  validateAccountPrefix,
  validateAgentId,
  validateAgentName,
  validateFund,
  envSnippet,
  type RawTx,
} from "@/lib/agentSetup";
import { recipientNames } from "@/lib/agentView";
import { NETWORK, VAULT_ID } from "@/lib/config";
import { mainnetKeyAgentCommands } from "@/lib/tradingView";
import { generateAgentKey, isEd25519PublicKey, type AgentKey } from "@/lib/keygen";
import { DEFAULT_FORM, validateMandateForm, type MandateForm } from "@/lib/mandateForm";
import { useAgents, useRecipients } from "@/lib/useVault";
import { ConnectStep } from "./ConnectStep";
import { MandateEditor, MandatePreview } from "./MandateEditor";
import { MandateText } from "./parts";
import { clearPending, loadPending, savePending, type PendingKeyAgent } from "./pendingKey";
import { useAgentTx } from "./useAgentTx";

type Kind = "Tee" | "Key";
type Setup = "new" | "existing";

const STEPS_BASE = ["Type", "Identity", "Mandate", "Review & sign"];

function TypeCard({ selected, title, badge, onClick, children, icon }: { selected: boolean; title: string; badge: string; onClick: () => void; children: string; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx("relative flex cursor-pointer flex-col gap-2 rounded-card border bg-surface p-5 text-left text-ink transition-colors", selected ? "border-ok" : "border-line hover:border-line-strong")}
    >
      {selected && <Icons.Check size={16} className="absolute top-4 right-4 text-ok" />}
      <span className="flex items-center gap-2 text-[15px] font-semibold">
        {icon}
        {title}
      </span>
      <span className="text-sm text-ink-secondary">{children}</span>
      <span className="mono text-xs text-ink-muted">{badge}</span>
    </button>
  );
}

/** `/agents/new`: Type -> Identity -> Mandate -> Review & sign (-> Connect for new Key agents). DESIGN_AGENTS §3.2 adapted to ADR-0003. */
export function AddAgentWizard() {
  const navigate = useNavigate();
  const { canAct, busy, sign, accountId } = useAgentTx();
  const { ownerId } = useOwner();
  const agents = useAgents();
  const recipients = useRecipients();

  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [setup, setSetup] = useState<Setup>("new");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [fund, setFund] = useState(DEFAULT_FUND_NEAR);
  const [faKey, setFaKey] = useState("");
  const [existingAccount, setExistingAccount] = useState("");
  const [existingKey, setExistingKey] = useState("");
  const [pinned, setPinned] = useState("");
  const [form, setForm] = useState<MandateForm>(DEFAULT_FORM);
  const [key, setKey] = useState<AgentKey | null>(null);
  const [doneState, setDone] = useState<null | { kind: "connect"; pending: PendingKeyAgent } | { kind: "tee" | "existing"; id: string; name: string; account: string | null }>(null);
  const [pendingOld, setPendingOld] = useState<PendingKeyAgent | null>(() => loadPending());
  const [nowMs] = useState(() => Date.now());

  const owner = ownerId ?? accountId ?? "";
  const existingIds = agents.data.map((a) => a.id);
  const knownRecipients = useMemo(() => new Set(recipients.data.map((r) => r.id)), [recipients.data]);
  const mandateResult = useMemo(() => validateMandateForm(form, { knownRecipients, nowMs }), [form, knownRecipients, nowMs]);

  // Recover the one-time key after a wallet redirect: once the agent exists on chain, show its key again.
  const recovered = pendingOld !== null && agents.data.some((x) => x.id === pendingOld.id && x.account_id === pendingOld.account);
  const done = doneState ?? (recovered && pendingOld ? ({ kind: "connect", pending: pendingOld } as const) : null);

  const effectivePrefix = prefixTouched ? prefix : id;
  const nameErr = name === "" ? null : validateAgentName(name);
  const idErr = id === "" ? null : validateAgentId(id, existingIds);
  const prefixErr = kind === "Key" && setup === "new" ? validateAccountPrefix(effectivePrefix, owner || "owner") : null;
  const fundErr = kind === "Key" && setup === "new" ? validateFund(fund) : null;
  const faErr = faKey.trim() !== "" && !isEd25519PublicKey(faKey) ? "Expected ed25519:<base58 public key>" : null;
  const newAccount = owner && !prefixErr ? subAccountId(effectivePrefix, owner) : "";
  const accountTaken = (acc: string) => agents.data.some((a) => a.account_id === acc && a.status !== "Revoked");
  const exAccErr = existingAccount === "" ? "Enter the agent's NEAR account" : !isNearAccountId(existingAccount.trim()) ? "Not a valid NEAR account id" : accountTaken(existingAccount.trim()) ? "Another agent already uses this account" : null;
  const exKeyErr = existingKey.trim() !== "" && !isEd25519PublicKey(existingKey) ? "Expected ed25519:<base58 public key>" : null;
  const pinErr = pinned.trim() === "" ? null : !isImplicitAccount(pinned.trim()) ? "A TEE account is implicit: 64 lowercase hex characters" : accountTaken(pinned.trim()) ? "Another agent already uses this account" : null;

  const typeOk = kind !== null && validateAgentName(name) === null && id !== "" && validateAgentId(id, existingIds) === null;
  const identityOk = kind === "Tee" ? pinErr === null : setup === "new" ? !prefixErr && !fundErr && !faErr && effectivePrefix !== "" && owner !== "" : !exAccErr && !exKeyErr;
  // Mainnet: no key is ever generated in the browser; a Key agent with a new account is created by the CLI.
  const cliOnly = NETWORK === "mainnet" && kind === "Key" && setup === "new";
  const cliCommands = useMemo(() => {
    if (!cliOnly || !mandateResult.mandate || !typeOk || !identityOk) return null;
    return mainnetKeyAgentCommands({
      owner,
      vault: VAULT_ID,
      name: effectivePrefix,
      agentId: id,
      displayName: name.trim(),
      fundNear: fund,
      mandateFile: `mandate.${id}.json`,
      mandateScript: `cat > mandate.${id}.json <<'EOF'\n${JSON.stringify(mandateResult.mandate, null, 2)}\nEOF`,
    });
  }, [cliOnly, mandateResult.mandate, typeOk, identityOk, owner, effectivePrefix, id, name, fund]);
  const stepOk = [typeOk, identityOk, mandateResult.mandate !== null, true][step] ?? false;
  const steps = kind === "Key" && setup === "new" ? [...STEPS_BASE, "Connect"] : STEPS_BASE;

  const txs: RawTx[] | null = useMemo(() => {
    const mandate = mandateResult.mandate;
    if (!kind || !mandate || !typeOk || !identityOk) return null;
    const base = { id, name, mandate };
    if (kind === "Tee") return planTeeSlot({ ...base, vault: VAULT_ID, pinnedAccount: pinned.trim() || null });
    if (setup === "existing") return planKeyAgentExisting({ ...base, vault: VAULT_ID, accountId: existingAccount.trim(), publicKey: existingKey.trim() || null });
    if (!key) return null;
    return planKeyAgentCreate({ ...base, owner, vault: VAULT_ID, prefix: effectivePrefix, publicKey: key.publicKey, fundNear: fund, ownerFullAccessKey: faKey.trim() || null });
  }, [kind, mandateResult.mandate, typeOk, identityOk, id, name, pinned, setup, existingAccount, existingKey, key, owner, effectivePrefix, fund, faKey]);

  const onName = (v: string) => {
    setName(v);
    if (!idTouched) setId(slugify(v));
  };
  const pickKind = (k: Kind) => {
    setKind(k);
    setForm((f) => (f.recipients.length === 0 && f.allowlist.length === 0 ? { ...f, mode: k === "Tee" ? "Fixed" : "Open" } : f));
  };

  const next = () => {
    if (step === 2 && kind === "Key" && setup === "new" && !key && NETWORK !== "mainnet") setKey(generateAgentKey()); // key exists from the review step on
    setStep((s) => Math.min(3, s + 1));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const submit = async () => {
    if (!txs || !kind) return;
    let pending: PendingKeyAgent | null = null;
    if (kind === "Key" && setup === "new" && key) {
      pending = { id, name: name.trim(), account: newAccount, publicKey: key.publicKey, secretKey: key.secretKey };
      savePending(pending); // survives a wallet redirect
    }
    const ok = await sign(`Add agent ${id}`, txs);
    if (!ok) {
      if (pending) clearPending();
      return;
    }
    if (pending) setDone({ kind: "connect", pending });
    else if (kind === "Tee") setDone({ kind: "tee", id, name: name.trim(), account: pinned.trim() || null });
    else setDone({ kind: "existing", id, name: name.trim(), account: existingAccount.trim() });
  };

  /* ───────── after success ───────── */
  if (done?.kind === "connect") {
    const p = done.pending;
    return (
      <div className="flex flex-col gap-4">
        <Stepper steps={[...STEPS_BASE, "Connect"]} current={4} />
        <ConnectStep
          agentName={p.name}
          connect={{ vault: VAULT_ID, network: NETWORK, account: p.account, privateKey: p.secretKey }}
          onDone={() => navigate(`/agents/${p.id}`)}
        />
      </div>
    );
  }
  if (done) {
    return (
      <Card aria-labelledby="done-title" className="flex flex-col gap-4">
        <CardHeader id="done-title" title={done.kind === "tee" ? `TEE slot "${done.name}" created` : `Agent "${done.name}" registered`} badge={<Icons.Check size={16} className="text-ok" />} />
        {done.kind === "tee" ? (
          <ol className="m-0 flex flex-col gap-2 pl-5 text-sm text-ink-secondary">
            <li>
              Deploy the worker with <span className="mono">AGENT_ID={done.id}</span> and <span className="mono">VAULT_CONTRACT_ID={VAULT_ID}</span>. It generates its own key inside the enclave and registers itself.
            </li>
            <li>
              Approve its measurements and hardware (PPID) on <Link to="/policy">Policy</Link>. Registration is refused until both are approved.
            </li>
            <li>
              Wait for registration: the agent shows &quot;waiting for registration&quot; until then. Once it has registered, check the account it was bound to and <strong>Pin</strong> it on the agent page so no other instance can take over the slot.
            </li>
          </ol>
        ) : (
          <>
            <p className="m-0 text-sm text-ink-secondary">
              {done.account} is registered as <span className="mono">{done.id}</span>. Give the agent its own key (you keep the private key). Configuration for the MCP server:
            </p>
            <pre className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs">{envSnippet({ vault: VAULT_ID, network: NETWORK, account: done.account ?? "", privateKey: "ed25519:<the key you hold>" })}</pre>
          </>
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => navigate(`/agents/${done.id}`)}>
            Open agent
          </Button>
        </div>
      </Card>
    );
  }

  /* ───────── steps ───────── */
  return (
    <div className="flex flex-col gap-4">
      <Stepper steps={steps} current={step} />
      {!canAct && <Callout accent="info">Connect the vault owner&apos;s wallet to add agents. You can look around, but signing is disabled.</Callout>}
      {pendingOld && !done && (
        <Callout
          accent="warn"
          action={
            <Button
              size="sm"
              onClick={() => {
                clearPending();
                setPendingOld(null);
              }}
            >
              Discard
            </Button>
          }
        >
          An earlier setup of <span className="mono">{pendingOld.id}</span> didn&apos;t finish (the agent isn&apos;t in the vault). Its key is kept in this tab until you discard it.
        </Callout>
      )}

      {step === 0 && (
        <Card className="flex flex-col gap-5" aria-label="Agent type">
          <div role="radiogroup" aria-label="Agent type" className="grid gap-3 md:grid-cols-2">
            <TypeCard selected={kind === "Tee"} onClick={() => pickKind("Tee")} title="Verified agent" badge="Highest trust" icon={<Icons.ShieldCheck size={18} className="text-ok" />}>
              Runs in a secure enclave. The vault checks its attestation before it can pay. Best for agents you run long-term.
            </TypeCard>
            <TypeCard selected={kind === "Key"} onClick={() => pickKind("Key")} title="Connected agent" badge="Fastest" icon={<Icons.KeyRound size={18} className="text-ink-muted" />}>
              Any agent: Claude, IronClaw, your own script. Gets a key that can only ask this vault for payments. Set up in 2 minutes.
            </TypeCard>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="2–32 characters" error={nameErr}>
              {(a11y) => <Input {...a11y} value={name} maxLength={32} placeholder="procurement" state={nameErr ? "error" : "default"} onChange={(e) => onName(e.target.value)} />}
            </Field>
            <Field label="Agent id" hint="a–z, 0–9 and -. Can't be changed later." error={idErr}>
              {(a11y) => (
                <Input
                  {...a11y}
                  mono
                  value={id}
                  maxLength={32}
                  state={idErr ? "error" : "default"}
                  onChange={(e) => {
                    setIdTouched(true);
                    setId(e.target.value.toLowerCase());
                  }}
                />
              )}
            </Field>
          </div>
        </Card>
      )}

      {step === 1 && kind === "Tee" && (
        <Card className="flex flex-col gap-4" aria-label="TEE identity">
          <p className="m-0 text-sm text-ink-secondary">
            This creates a <strong>slot</strong> for <span className="mono">{id}</span>. You don&apos;t need a code hash or an account now: the enclave generates its own key at boot and registers itself with its attestation. Then you check the account it got and pin it.
          </p>
          <Field label="Pin to an account (optional)" hint="Only if you already know the enclave's account (64 hex characters). Otherwise leave empty and pin after the first registration." error={pinErr}>
            {(a11y) => <Input {...a11y} mono value={pinned} placeholder="64 lowercase hex characters" state={pinErr ? "error" : "default"} onChange={(e) => setPinned(e.target.value.trim().toLowerCase())} />}
          </Field>
          <Callout accent="info">
            Until the account is pinned, the first valid enclave to register takes the slot, and another one may replace it once the attestation expires. Measurements and hardware are approved on <Link to="/policy">Policy</Link>.
          </Callout>
        </Card>
      )}

      {step === 1 && kind === "Key" && (
        <Card className="flex flex-col gap-4" aria-label="Key identity">
          <div role="radiogroup" aria-label="Account setup" className="grid gap-3 md:grid-cols-2">
            <TypeCard selected={setup === "new"} onClick={() => setSetup("new")} title="Create a new agent account for me" badge="Recommended" icon={<Icons.Plus size={16} />}>
              A sub-account of your own account, with a key limited to this vault.
            </TypeCard>
            <TypeCard selected={setup === "existing"} onClick={() => setSetup("existing")} title="Use an existing account" badge="You hold the key" icon={<Icons.KeyRound size={16} />}>
              Bring your own account and key. The vault only records the account.
            </TypeCard>
          </div>
          {setup === "new" ? (
            <>
              <Field label="Account name" hint={newAccount ? <>Creates <span className="mono">{newAccount}</span></> : "Sub-account of the vault owner"} error={prefixErr}>
                {(a11y) => (
                  <Input
                    {...a11y}
                    mono
                    value={effectivePrefix}
                    state={prefixErr ? "error" : "default"}
                    onChange={(e) => {
                      setPrefixTouched(true);
                      setPrefix(e.target.value.toLowerCase());
                    }}
                  />
                )}
              </Field>
              <Field label="Fund the account with" hint="Pays the agent's gas (about 0.015 NEAR per payment). The key's allowance is capped at 0.25 NEAR." error={fundErr}>
                {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="NEAR" value={fund} state={fundErr ? "error" : "default"} onChange={(e) => setFund(e.target.value.replace(/[^\d.]/g, ""))} />}
              </Field>
              <Field label="Your own full-access key on the agent account (optional)" hint="Public key you control, e.g. from a CLI. It lets you delete the agent's access key later. Leave empty and the account has only the agent key; revoking in the vault still stops all payments." error={faErr}>
                {(a11y) => <Input {...a11y} mono placeholder="ed25519:…" value={faKey} state={faErr ? "error" : "default"} onChange={(e) => setFaKey(e.target.value.trim())} />}
              </Field>
              <Callout accent="info">The key pair is generated in this browser at the next step. The private key is shown once after you sign.</Callout>
            </>
          ) : (
            <>
              <Field label="Agent account" error={exAccErr && existingAccount !== "" ? exAccErr : null}>
                {(a11y) => <Input {...a11y} mono placeholder="bot.example.near" value={existingAccount} state={exAccErr && existingAccount !== "" ? "error" : "default"} onChange={(e) => setExistingAccount(e.target.value.trim().toLowerCase())} />}
              </Field>
              <Field label="Public key (optional)" hint="For display only. The contract checks the calling account, and the key must be restricted to this vault on that account." error={exKeyErr}>
                {(a11y) => <Input {...a11y} mono placeholder="ed25519:…" value={existingKey} state={exKeyErr ? "error" : "default"} onChange={(e) => setExistingKey(e.target.value.trim())} />}
              </Field>
              <Callout accent="warn">
                Add a function-call key yourself: receiver <span className="mono">{VAULT_ID}</span>, methods <span className="mono">request_payment, report_payout_status</span>, an allowance of about 0.25 NEAR. A full-access key lets the agent do anything the account can.
              </Callout>
            </>
          )}
        </Card>
      )}

      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="order-2 lg:order-1">
            <Card className="flex flex-col gap-4">
              <MandateEditor form={form} onChange={setForm} result={mandateResult} recipients={recipients.data} />
            </Card>
          </div>
          <div className="order-1 lg:sticky lg:top-20 lg:order-2 lg:self-start">
            <MandatePreview result={mandateResult} recipients={recipients.data} nowMs={nowMs} />
          </div>
        </div>
      )}

      {step === 3 && mandateResult.mandate && (
        <Card className="flex flex-col gap-4" aria-labelledby="review-title">
          <CardHeader id="review-title" title={`Review ${name.trim() || id}`} />
          <MandateText mandate={mandateResult.mandate} names={recipientNames(recipients.data)} nowMs={nowMs} />
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-muted">Trust</dt>
            <dd className="m-0">{kind === "Tee" ? "TEE slot: the enclave registers itself, you approve measurements on Policy and pin the account" : setup === "new" ? "Key: new account with a function-call key" : "Key: your own account"}</dd>
            <dt className="text-ink-muted">Account</dt>
            <dd className="mono m-0 break-all">{kind === "Tee" ? pinned || "bound at registration" : setup === "new" ? newAccount : existingAccount}</dd>
            {key && setup === "new" && kind === "Key" && (
              <>
                <dt className="text-ink-muted">Public key</dt>
                <dd className="mono m-0 break-all">{key.publicKey}</dd>
              </>
            )}
          </dl>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-ink-secondary">Your wallet will be asked to sign {txs?.length ?? 0} transaction{txs?.length === 1 ? "" : "s"}</div>
            <ol className="m-0 flex flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
              {txs?.map((t, i) => (
                <li key={i}>{t.description}</li>
              ))}
            </ol>
          </div>
          {cliCommands && (
            <>
              <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
                On mainnet the agent key is created in your terminal, not in this page. Run these commands in the repository root; the script prints the agent key once.
              </Callout>
              <pre tabIndex={0} aria-label="Mainnet agent setup commands" className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
                {cliCommands}
              </pre>
            </>
          )}
          {kind === "Key" && setup === "new" && !cliOnly && (
            <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
              After signing you will see the agent&apos;s private key once. Don&apos;t close the tab before you saved it. If your wallet redirects you away, the key is kept in this tab until you come back.
            </Callout>
          )}
          {!canAct && <Callout accent="info">Only the vault owner can sign this.</Callout>}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {busy && <SigningHint />}
        <span className="grow" />
        {step > 0 ? (
          <Button onClick={back} disabled={busy}>
            Back
          </Button>
        ) : (
          <Button onClick={() => navigate("/agents")}>Cancel</Button>
        )}
        {step < 3 ? (
          <Button variant="primary" disabled={!stepOk} onClick={next}>
            Next
          </Button>
        ) : (
          <Button variant="primary" disabled={!canAct || busy || !txs || cliOnly} loading={busy} onClick={() => void submit()}>
            Sign in wallet
          </Button>
        )}
      </div>
    </div>
  );
}
