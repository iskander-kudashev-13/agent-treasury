import { useT, rich } from "@/i18n";
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
  const t = useT();
  const STEPS_BASE = [t("wiz.stepType"), t("wiz.stepIdentity"), t("wiz.stepMandate"), t("wiz.stepReview")];
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
  const faErr = faKey.trim() !== "" && !isEd25519PublicKey(faKey) ? t("wiz.expectedKey") : null;
  const newAccount = owner && !prefixErr ? subAccountId(effectivePrefix, owner) : "";
  const accountTaken = (acc: string) => agents.data.some((a) => a.account_id === acc && a.status !== "Revoked");
  const exAccErr = existingAccount === "" ? t("wiz.enterAccount") : !isNearAccountId(existingAccount.trim()) ? t("wiz.notValidAccount") : accountTaken(existingAccount.trim()) ? t("wiz.accountUsed") : null;
  const exKeyErr = existingKey.trim() !== "" && !isEd25519PublicKey(existingKey) ? t("wiz.expectedKey") : null;
  const pinErr = pinned.trim() === "" ? null : !isImplicitAccount(pinned.trim()) ? t("wiz.implicitOnly") : accountTaken(pinned.trim()) ? t("wiz.accountUsed") : null;

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
  const steps = kind === "Key" && setup === "new" ? [...STEPS_BASE, t("wiz.stepConnect")] : STEPS_BASE;

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
    const ok = await sign(t("wiz.signLabel", { id }), txs);
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
        <Stepper steps={[...STEPS_BASE, t("wiz.stepConnect")]} current={4} />
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
        <CardHeader id="done-title" title={done.kind === "tee" ? t("wiz.teeCreated", { name: done.name }) : t("wiz.agentRegistered", { name: done.name })} badge={<Icons.Check size={16} className="text-ok" />} />
        {done.kind === "tee" ? (
          <ol className="m-0 flex flex-col gap-2 pl-5 text-sm text-ink-secondary">
            <li>
              {rich("wiz.done1", { agentId: <span className="mono">AGENT_ID={done.id}</span>, vaultId: <span className="mono">VAULT_CONTRACT_ID={VAULT_ID}</span> })}
            </li>
            <li>
              {rich("wiz.done2", { policy: <Link to="/policy">{t("nav.policy")}</Link> })}
            </li>
            <li>
              {rich("wiz.done3", { pin: <strong>{t("ag.pinAccount")}</strong> })}
            </li>
          </ol>
        ) : (
          <>
            <p className="m-0 text-sm text-ink-secondary">
              {rich("wiz.doneKey", { account: done.account, id: <span className="mono">{done.id}</span> })}
            </p>
            <pre className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs">{envSnippet({ vault: VAULT_ID, network: NETWORK, account: done.account ?? "", privateKey: t("wiz.keyYouHold") })}</pre>
          </>
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => navigate(`/agents/${done.id}`)}>
            {t("wiz.openAgent")}
          </Button>
        </div>
      </Card>
    );
  }

  /* ───────── steps ───────── */
  return (
    <div className="flex flex-col gap-4">
      <Stepper steps={steps} current={step} />
      {!canAct && <Callout accent="info">{t("wiz.connectOwner")}</Callout>}
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
              {t("wiz.discard")}
            </Button>
          }
        >
          {rich("wiz.earlierSetup", { id: <span className="mono">{pendingOld.id}</span> })}
        </Callout>
      )}

      {step === 0 && (
        <Card className="flex flex-col gap-5" aria-label={t("wiz.agentType")}>
          <div role="radiogroup" aria-label={t("wiz.agentType")} className="grid gap-3 md:grid-cols-2">
            <TypeCard selected={kind === "Tee"} onClick={() => pickKind("Tee")} title={t("wiz.teeTitle")} badge={t("wiz.teeBadge")} icon={<Icons.ShieldCheck size={18} className="text-ok" />}>
              {t("wiz.teeDesc")}
            </TypeCard>
            <TypeCard selected={kind === "Key"} onClick={() => pickKind("Key")} title={t("wiz.keyTitle")} badge={t("wiz.keyBadge")} icon={<Icons.KeyRound size={18} className="text-ink-muted" />}>
              {t("wiz.keyDesc")}
            </TypeCard>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("wiz.name")} hint={t("wiz.nameHint")} error={nameErr}>
              {(a11y) => <Input {...a11y} value={name} maxLength={32} placeholder="procurement" state={nameErr ? "error" : "default"} onChange={(e) => onName(e.target.value)} />}
            </Field>
            <Field label={t("wiz.agentId")} hint={t("wiz.agentIdHint")} error={idErr}>
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
        <Card className="flex flex-col gap-4" aria-label={t("wiz.teeIdentity")}>
          <p className="m-0 text-sm text-ink-secondary">
            {rich("wiz.teeSlotExplain", { slot: <strong>{t("wiz.slot")}</strong>, id: <span className="mono">{id}</span> })}
          </p>
          <Field label={t("wiz.pinOptional")} hint={t("wiz.pinOptionalHint")} error={pinErr}>
            {(a11y) => <Input {...a11y} mono value={pinned} placeholder={t("wiz.pinPlaceholder")} state={pinErr ? "error" : "default"} onChange={(e) => setPinned(e.target.value.trim().toLowerCase())} />}
          </Field>
          <Callout accent="info">
            {rich("wiz.teeUnpinnedInfo", { policy: <Link to="/policy">{t("nav.policy")}</Link> })}
          </Callout>
        </Card>
      )}

      {step === 1 && kind === "Key" && (
        <Card className="flex flex-col gap-4" aria-label={t("wiz.keyIdentity")}>
          <div role="radiogroup" aria-label={t("wiz.accountSetup")} className="grid gap-3 md:grid-cols-2">
            <TypeCard selected={setup === "new"} onClick={() => setSetup("new")} title={t("wiz.newTitle")} badge={t("wiz.recommended")} icon={<Icons.Plus size={16} />}>
              {t("wiz.newDesc")}
            </TypeCard>
            <TypeCard selected={setup === "existing"} onClick={() => setSetup("existing")} title={t("wiz.existingTitle")} badge={t("wiz.youHoldKey")} icon={<Icons.KeyRound size={16} />}>
              {t("wiz.existingDesc")}
            </TypeCard>
          </div>
          {setup === "new" ? (
            <>
              <Field label={t("wiz.accountName")} hint={newAccount ? rich("wiz.creates", { account: <span className="mono">{newAccount}</span> }) : t("wiz.subOfOwner")} error={prefixErr}>
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
              <Field label={t("wiz.fund")} hint={t("wiz.fundHint")} error={fundErr}>
                {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="NEAR" value={fund} state={fundErr ? "error" : "default"} onChange={(e) => setFund(e.target.value.replace(/[^\d.]/g, ""))} />}
              </Field>
              <Field label={t("wiz.faKey")} hint={t("wiz.faKeyHint")} error={faErr}>
                {(a11y) => <Input {...a11y} mono placeholder="ed25519:…" value={faKey} state={faErr ? "error" : "default"} onChange={(e) => setFaKey(e.target.value.trim())} />}
              </Field>
              <Callout accent="info">{t("wiz.keyGenInfo")}</Callout>
            </>
          ) : (
            <>
              <Field label={t("wiz.agentAccount")} error={exAccErr && existingAccount !== "" ? exAccErr : null}>
                {(a11y) => <Input {...a11y} mono placeholder="bot.example.near" value={existingAccount} state={exAccErr && existingAccount !== "" ? "error" : "default"} onChange={(e) => setExistingAccount(e.target.value.trim().toLowerCase())} />}
              </Field>
              <Field label={t("wiz.pubKeyOptional")} hint={t("wiz.pubKeyHint")} error={exKeyErr}>
                {(a11y) => <Input {...a11y} mono placeholder="ed25519:…" value={existingKey} state={exKeyErr ? "error" : "default"} onChange={(e) => setExistingKey(e.target.value.trim())} />}
              </Field>
              <Callout accent="warn">
                {rich("wiz.addFcKey", { vault: <span className="mono">{VAULT_ID}</span>, methods: <span className="mono">request_payment, report_payout_status</span> })}
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
          <CardHeader id="review-title" title={t("wiz.review", { name: name.trim() || id })} />
          <MandateText mandate={mandateResult.mandate} names={recipientNames(recipients.data)} nowMs={nowMs} />
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-muted">{t("wiz.trust")}</dt>
            <dd className="m-0">{kind === "Tee" ? t("wiz.trustTee") : setup === "new" ? t("wiz.trustKeyNew") : t("wiz.trustKeyOwn")}</dd>
            <dt className="text-ink-muted">{t("wiz.account")}</dt>
            <dd className="mono m-0 break-all">{kind === "Tee" ? pinned || t("wiz.boundAtReg") : setup === "new" ? newAccount : existingAccount}</dd>
            {key && setup === "new" && kind === "Key" && (
              <>
                <dt className="text-ink-muted">{t("wiz.publicKey")}</dt>
                <dd className="mono m-0 break-all">{key.publicKey}</dd>
              </>
            )}
          </dl>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-ink-secondary">{t("wiz.willSign", { count: txs?.length ?? 0 })}</div>
            <ol className="m-0 flex flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
              {txs?.map((tx, i) => (
                <li key={i}>{tx.description}</li>
              ))}
            </ol>
          </div>
          {cliCommands && (
            <>
              <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
                {t("wiz.mainnetCli")}
              </Callout>
              <pre tabIndex={0} aria-label={t("wiz.cliAria")} className="mono m-0 overflow-auto rounded-input border border-line bg-surface-sunken p-3 text-xs break-all whitespace-pre-wrap">
                {cliCommands}
              </pre>
            </>
          )}
          {kind === "Key" && setup === "new" && !cliOnly && (
            <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
              {t("wiz.keyShownOnce")}
            </Callout>
          )}
          {!canAct && <Callout accent="info">{t("wiz.onlyOwnerSign")}</Callout>}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {busy && <SigningHint />}
        <span className="grow" />
        {step > 0 ? (
          <Button onClick={back} disabled={busy}>
            {t("common.back")}
          </Button>
        ) : (
          <Button onClick={() => navigate("/agents")}>{t("common.cancel")}</Button>
        )}
        {step < 3 ? (
          <Button variant="primary" disabled={!stepOk} onClick={next}>
            {t("common.next")}
          </Button>
        ) : (
          <Button variant="primary" disabled={!canAct || busy || !txs || cliOnly} loading={busy} onClick={() => void submit()}>
            {t("wiz.signInWallet")}
          </Button>
        )}
      </div>
    </div>
  );
}
