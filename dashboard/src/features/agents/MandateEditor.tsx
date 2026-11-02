import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import type { TFunction } from "@/i18n";
import { Button, Callout, Card, CardHeader, Checkbox, Chip, Field, Icons, Input, Segmented, Select } from "@/kit";
import { recipientNames } from "@/lib/agentView";
import { CHAIN_OPTIONS, MAX_ALLOWLIST, type AllowRow, type ExpiryChoice, type FormResult, type MandateForm, type RecipientsMode } from "@/lib/mandateForm";
import type { RecipientView } from "@/lib/types";
import { MandateText } from "./parts";

const modes = (t: TFunction): Array<{ value: RecipientsMode; label: string }> => [
  { value: "Fixed", label: t("me.modeFixed") },
  { value: "Allowlist", label: t("me.modeAllow") },
  { value: "Open", label: t("me.modeOpen") },
];

/** Live sentence card: "This agent will be able to…". */
export function MandatePreview({ result, recipients, nowMs }: { result: FormResult; recipients: RecipientView[]; nowMs: number }) {
  const t = useT();
  return (
    <Card aria-labelledby="mandate-preview" className="flex flex-col gap-3">
      <CardHeader id="mandate-preview" title={t("me.previewTitle")} />
      {result.mandate ? <MandateText mandate={result.mandate} names={recipientNames(recipients)} nowMs={nowMs} /> : <p className="m-0 text-sm text-ink-muted">{t("me.fixFields")}</p>}
      {result.warnings.map((w) => (
        <Callout key={w} accent="warn">
          {w}
        </Callout>
      ))}
    </Card>
  );
}

/** Form for a mandate (wizard step 3 and the detail page editor). Fully controlled; validation comes from `validateMandateForm`. */
export function MandateEditor({ form, onChange, result, recipients, disabled }: { form: MandateForm; onChange: (f: MandateForm) => void; result: FormResult; recipients: RecipientView[]; disabled?: boolean }) {
  const t = useT();
  const e = result.errors;
  const set = <K extends keyof MandateForm>(k: K, v: MandateForm[K]) => onChange({ ...form, [k]: v });
  const toggleChain = (id: string) => set("chains", form.chains.includes(id) ? form.chains.filter((c) => c !== id) : [...form.chains, id]);
  const toggleRecipient = (id: number) => set("recipients", form.recipients.includes(id) ? form.recipients.filter((r) => r !== id) : [...form.recipients, id]);
  const setRow = (i: number, p: Partial<AllowRow>) => set("allowlist", form.allowlist.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const num = (v: string) => v.replace(/[^\d.,\s]/g, "");

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("mf.daily")} error={e.daily}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={form.daily} disabled={disabled} state={e.daily ? "error" : "default"} onChange={(ev) => set("daily", num(ev.target.value))} />}
        </Field>
        <Field label={t("mf.perTx")} error={e.perTx}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={form.perTx} disabled={disabled} state={e.perTx ? "error" : "default"} onChange={(ev) => set("perTx", num(ev.target.value))} />}
        </Field>
        <Field label={t("me.needsApproval")} hint={t("me.needsApprovalHint")} error={e.threshold}>
          {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix="USDC" value={form.threshold} disabled={disabled} state={e.threshold ? "error" : "default"} onChange={(ev) => set("threshold", num(ev.target.value))} />}
        </Field>
        <Field label={t("me.maxPerDay")} hint={t("me.maxPerDayHint")} error={e.maxPerDay}>
          {(a11y) => <Input {...a11y} mono inputMode="numeric" value={form.maxPerDay} disabled={disabled} state={e.maxPerDay ? "error" : "default"} onChange={(ev) => set("maxPerDay", ev.target.value.replace(/\D/g, ""))} />}
        </Field>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
        <legend className="mb-1.5 p-0 text-[13px] font-medium text-ink-secondary">{t("me.chains")}</legend>
        <div className="flex flex-wrap gap-2">
          {CHAIN_OPTIONS.map((c) => (
            <Chip key={c.id} selected={form.chains.includes(c.id)} onClick={() => toggleChain(c.id)}>
              {c.label}
            </Chip>
          ))}
        </div>
        {e.chains && <p className="m-0 text-xs text-danger-text">{e.chains}</p>}
      </fieldset>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink-secondary" id="who-label">
          {t("me.whoCanPay")}
        </span>
        <Segmented label={t("me.whoCanPay")} value={form.mode} options={modes(t)} onChange={(m) => set("mode", m)} />
        {form.mode === "Open" && <Callout accent="warn">{t("mf.warnOpen")}</Callout>}

        {form.mode === "Fixed" && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-xs text-ink-subtle">{t("me.fixedHint")}</p>
            {recipients.length === 0 ? (
              <Callout accent="info" action={<Link to="/payments?tab=recipients">{t("me.addRecipients")}</Link>}>
                {t("me.noRecipients")}
              </Callout>
            ) : (
              <ul className="m-0 flex max-h-56 list-none flex-col gap-2 overflow-y-auto p-0">
                {recipients.map((r) => (
                  <li key={r.id}>
                    <Checkbox
                      checked={form.recipients.includes(r.id)}
                      onChange={() => toggleRecipient(r.id)}
                      disabled={disabled}
                      label={
                        <span>
                          {r.label} <span className="mono text-xs text-ink-muted">{r.destination_chain} · {r.destination_address.slice(0, 8)}…</span>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            {e.recipients && <p className="m-0 text-xs text-danger-text">{e.recipients}</p>}
          </div>
        )}

        {form.mode === "Allowlist" && (
          <div className="flex flex-col gap-2">
            {form.allowlist.map((row, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="grid grid-cols-[110px_1fr] gap-2 sm:grid-cols-[110px_1fr_150px_auto]">
                  <Select aria-label={t("me.addrChain", { n: i + 1 })} value={row.chain} disabled={disabled} onChange={(ev) => setRow(i, { chain: ev.target.value })}>
                    {CHAIN_OPTIONS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                  <Input aria-label={t("me.addrN", { n: i + 1 })} mono placeholder="0x…" value={row.address} disabled={disabled} state={e.rows?.[i] ? "error" : "default"} onChange={(ev) => setRow(i, { address: ev.target.value })} />
                  <Input aria-label={t("me.addrLabelN", { n: i + 1 })} placeholder={t("me.labelOptional")} value={row.label} disabled={disabled} onChange={(ev) => setRow(i, { label: ev.target.value })} />
                  <Button variant="ghost" aria-label={t("me.removeAddr", { n: i + 1 })} disabled={disabled} onClick={() => set("allowlist", form.allowlist.filter((_, j) => j !== i))}>
                    <Icons.X size={14} />
                  </Button>
                </div>
                {e.rows?.[i] && <p className="m-0 text-xs text-danger-text">{e.rows[i]}</p>}
              </div>
            ))}
            {e.allowlist && <p className="m-0 text-xs text-danger-text">{e.allowlist}</p>}
            <div>
              <Button size="sm" icon={<Icons.Plus size={13} />} disabled={disabled || form.allowlist.length >= MAX_ALLOWLIST} onClick={() => set("allowlist", [...form.allowlist, { chain: form.chains[0] ?? "base", address: "", label: "" }])}>
                {t("me.addAddress")}
              </Button>
            </div>
            <p className="m-0 text-xs text-ink-subtle">{t("me.evmLower")}</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Field label={t("me.expires")} error={e.expiry}>
          {(a11y) => (
            <div className="flex flex-wrap items-center gap-2">
              <Select {...a11y} className="max-w-48" value={form.expiry} disabled={disabled} onChange={(ev) => set("expiry", ev.target.value as ExpiryChoice)}>
                {form.keptExpiry !== null && <option value="keep">{t("me.keepCurrent")}</option>}
                <option value="none">{t("me.never")}</option>
                <option value="7d">{t("me.in7")}</option>
                <option value="30d">{t("me.in30")}</option>
                <option value="custom">{t("me.onDate")}</option>
              </Select>
              {form.expiry === "custom" && <Input type="date" aria-label={t("me.expiryDate")} className="max-w-44" value={form.customDate} disabled={disabled} onChange={(ev) => set("customDate", ev.target.value)} />}
            </div>
          )}
        </Field>
      </div>
    </div>
  );
}
