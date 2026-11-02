// Mandate editor model: form strings <-> contract `Mandate`, validation mirroring `validate_mandate` (contract/src/agent.rs), diff for update_mandate.
import { t } from "@/i18n";
import { CHAIN_IDS, CHAIN_OPTIONS, chainName } from "../kit/tokens";
import { formatUsdc, parseUsdc, usdcGrouped } from "./amount";
import { normalizeAddress } from "./address";
import { isoDate } from "./describeMandate";
import type { Mandate } from "./types";

export { CHAIN_IDS, CHAIN_OPTIONS };

/** Contract limits (contract/src/lib.rs). */
export const MAX_CHAINS = 16;
export const MAX_ALLOWLIST = 50;
export const MAX_RECIPIENTS = 100;
export const MAX_LABEL_LEN = 64;
export const MAX_ADDRESS_LEN = 128;
const U32_MAX = 4_294_967_295;
const DAY_MS = 86_400_000;

export type RecipientsMode = Mandate["recipients_mode"];
export type ExpiryChoice = "none" | "7d" | "30d" | "custom" | "keep";

export interface AllowRow {
  chain: string;
  address: string;
  label: string;
}
export interface MandateForm {
  daily: string;
  perTx: string;
  threshold: string;
  maxPerDay: string;
  chains: string[];
  mode: RecipientsMode;
  recipients: number[];
  allowlist: AllowRow[];
  expiry: ExpiryChoice;
  /** yyyy-mm-dd, used when expiry is "custom". */
  customDate: string;
  /** Existing `expires_at` (ms string) kept when expiry is "keep". */
  keptExpiry: string | null;
}

export const DEFAULT_FORM: MandateForm = {
  daily: "200",
  perTx: "50",
  threshold: "30",
  maxPerDay: "10",
  chains: ["base"],
  mode: "Open",
  recipients: [],
  allowlist: [],
  expiry: "none",
  customDate: "",
  keptExpiry: null,
};

export interface FormErrors {
  daily?: string;
  perTx?: string;
  threshold?: string;
  maxPerDay?: string;
  chains?: string;
  recipients?: string;
  allowlist?: string;
  /** Per allowlist row index. */
  rows?: Record<number, string>;
  expiry?: string;
}
export interface FormResult {
  errors: FormErrors;
  /** Non-blocking hints (amber). */
  warnings: string[];
  /** Present only when `errors` is empty. */
  mandate: Mandate | null;
}

export interface ValidateCtx {
  /** Ids of vault recipients that exist (Fixed mode). */
  knownRecipients: ReadonlySet<number>;
  nowMs: number;
}

function amount(s: string, what: string): { raw: string } | { error: string } {
  if (s.trim() === "") return { error: t("mf.required", { what }) };
  try {
    const raw = parseUsdc(s.replace(/[\s,]/g, ""));
    return { raw };
  } catch (e) {
    return { error: e instanceof Error && e.message === t("amount.maxDecimals", { n: 6 }) ? t("amount.maxDecimals", { n: 6 }) : t("mf.mustBeNumber", { what }) };
  }
}

/** Expiry in ms from the form, or an error. */
function expiryOf(f: MandateForm, nowMs: number): { at: string | null } | { error: string } {
  if (f.expiry === "none") return { at: null };
  if (f.expiry === "7d") return { at: String(nowMs + 7 * DAY_MS) };
  if (f.expiry === "30d") return { at: String(nowMs + 30 * DAY_MS) };
  if (f.expiry === "keep") return { at: f.keptExpiry };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.customDate)) return { error: t("mf.pickDate") };
  const at = Date.parse(`${f.customDate}T23:59:59Z`);
  if (!Number.isFinite(at)) return { error: t("mf.pickValidDate") };
  if (at <= nowMs) return { error: t("mf.expiryFuture") };
  return { at: String(at) };
}

/** Validate the form the way the contract does, with plain-words messages. */
export function validateMandateForm(f: MandateForm, ctx: ValidateCtx): FormResult {
  const errors: FormErrors = {};
  const warnings: string[] = [];

  const daily = amount(f.daily, t("mf.daily"));
  const perTx = amount(f.perTx, t("mf.perTx"));
  const threshold = amount(f.threshold, t("mf.threshold"));
  if ("error" in daily) errors.daily = daily.error;
  else if (BigInt(daily.raw) === 0n) errors.daily = t("mf.mustBePositive", { what: t("mf.daily") });
  if ("error" in perTx) errors.perTx = perTx.error;
  else if (BigInt(perTx.raw) === 0n) errors.perTx = t("mf.mustBePositive", { what: t("mf.perTx") });
  if ("error" in threshold) errors.threshold = threshold.error;
  if (!errors.daily && !errors.perTx && BigInt((perTx as { raw: string }).raw) > BigInt((daily as { raw: string }).raw)) {
    errors.perTx = t("mf.perTxOverDaily");
  }
  if (!errors.perTx && !errors.threshold && BigInt((threshold as { raw: string }).raw) > BigInt((perTx as { raw: string }).raw)) {
    warnings.push(t("mf.warnThreshold"));
  }

  const maxPerDay = Number(f.maxPerDay);
  if (f.maxPerDay.trim() === "" || !Number.isInteger(maxPerDay)) errors.maxPerDay = t("mf.wholeNumber");
  else if (maxPerDay < 1) errors.maxPerDay = t("mf.perDayMin");
  else if (maxPerDay > U32_MAX) errors.maxPerDay = t("mf.perDayMax");

  if (f.chains.length === 0) errors.chains = t("mf.pickChain");
  else if (f.chains.length > MAX_CHAINS) errors.chains = t("mf.maxChains", { n: MAX_CHAINS });
  else if (f.chains.some((c) => !CHAIN_IDS.includes(c))) errors.chains = t("mf.unknownChain");

  let allowlist: Mandate["allowlist"] = [];
  let recipients: number[] = [];
  if (f.mode === "Fixed") {
    recipients = [...new Set(f.recipients)];
    if (recipients.length === 0) errors.recipients = t("mf.pickRecipient");
    else if (recipients.length > MAX_RECIPIENTS) errors.recipients = t("mf.maxRecipients", { n: MAX_RECIPIENTS });
    else if (recipients.some((id) => !ctx.knownRecipients.has(id))) errors.recipients = t("mf.recipientGone");
  } else if (f.mode === "Allowlist") {
    if (f.allowlist.length === 0) errors.allowlist = t("mf.addAddress1");
    else if (f.allowlist.length > MAX_ALLOWLIST) errors.allowlist = t("mf.maxAddresses", { n: MAX_ALLOWLIST });
    const rows: Record<number, string> = {};
    const out: Mandate["allowlist"] = [];
    const seen = new Set<string>();
    f.allowlist.forEach((row, i) => {
      const label = row.label.trim();
      try {
        if (!CHAIN_IDS.includes(row.chain)) throw new Error(t("mf.rowPickChain"));
        if (row.address.trim() === "") throw new Error(t("mf.rowEnterAddress"));
        const address = normalizeAddress(row.chain, row.address);
        if (address.length > MAX_ADDRESS_LEN) throw new Error(t("mf.rowAddressLong"));
        if (label.length > MAX_LABEL_LEN) throw new Error(t("mf.rowLabelLong", { n: MAX_LABEL_LEN }));
        const key = `${row.chain}:${address}`;
        if (seen.has(key)) throw new Error(t("mf.rowDuplicate"));
        seen.add(key);
        if (!f.chains.includes(row.chain)) warnings.push(t("mf.warnOffChain", { address: address.slice(0, 10), chain: chainName(row.chain) }));
        out.push({ chain: row.chain, address, label: label === "" ? null : label });
      } catch (e) {
        rows[i] = e instanceof Error ? e.message : String(e);
      }
    });
    if (Object.keys(rows).length > 0) errors.rows = rows;
    allowlist = out;
  } else if (f.chains.length > 0) {
    warnings.push(t("mf.warnOpen"));
  }

  const exp = expiryOf(f, ctx.nowMs);
  if ("error" in exp) errors.expiry = exp.error;

  if (Object.keys(errors).length > 0) return { errors, warnings, mandate: null };
  return {
    errors,
    warnings,
    mandate: {
      daily_limit: (daily as { raw: string }).raw,
      per_tx_limit: (perTx as { raw: string }).raw,
      approval_threshold: (threshold as { raw: string }).raw,
      allowed_chains: f.chains,
      recipients_mode: f.mode,
      allowlist,
      recipients,
      expires_at: (exp as { at: string | null }).at,
      max_payments_per_day: maxPerDay,
    },
  };
}

export const isValid = (r: FormResult): boolean => r.mandate !== null;

/** Prefill the editor from an existing mandate. */
export function mandateToForm(m: Mandate): MandateForm {
  return {
    daily: formatUsdc(m.daily_limit, 0),
    perTx: formatUsdc(m.per_tx_limit, 0),
    threshold: formatUsdc(m.approval_threshold, 0),
    maxPerDay: String(m.max_payments_per_day),
    chains: [...m.allowed_chains],
    mode: m.recipients_mode,
    recipients: [...m.recipients],
    allowlist: m.allowlist.map((d) => ({ chain: d.chain, address: d.address, label: d.label ?? "" })),
    expiry: m.expires_at ? "keep" : "none",
    customDate: m.expires_at ? isoDate(Number(m.expires_at)) : "",
    keptExpiry: m.expires_at,
  };
}

const usdc = (raw: string): string => `${usdcGrouped(raw, 0)} USDC`;
const modeLabel = (m: RecipientsMode): string => t(`m.mode.${m}`);
const setKey = (xs: Mandate["allowlist"]): Set<string> => new Set(xs.map((d) => `${d.chain}:${d.address}`));

/** Human lines for the update_mandate confirmation: "Daily limit 200 -> 500 USDC". Empty when nothing changed. */
export function diffMandate(a: Mandate, b: Mandate, recipientName: (id: number) => string = (id) => `#${id}`): string[] {
  const out: string[] = [];
  const amt = (label: string, x: string, y: string) => x !== y && out.push(t("diff.change", { label, from: usdcGrouped(x, 0), to: usdc(y) }));
  amt(t("mf.daily"), a.daily_limit, b.daily_limit);
  amt(t("mf.perTx"), a.per_tx_limit, b.per_tx_limit);
  amt(t("mf.threshold"), a.approval_threshold, b.approval_threshold);
  if (a.max_payments_per_day !== b.max_payments_per_day) out.push(t("diff.perDay", { from: a.max_payments_per_day, to: b.max_payments_per_day }));
  const ca = [...a.allowed_chains].sort().join(",");
  const cb = [...b.allowed_chains].sort().join(",");
  if (ca !== cb) {
    const added = b.allowed_chains.filter((c) => !a.allowed_chains.includes(c)).map(chainName);
    const removed = a.allowed_chains.filter((c) => !b.allowed_chains.includes(c)).map(chainName);
    if (added.length) out.push(t("diff.chainsAdded", { list: added.join(", ") }));
    if (removed.length) out.push(t("diff.chainsRemoved", { list: removed.join(", ") }));
  }
  if (a.recipients_mode !== b.recipients_mode) out.push(t("diff.canPay", { from: modeLabel(a.recipients_mode), to: modeLabel(b.recipients_mode) }));
  const ra = new Set(a.recipients);
  const rb = new Set(b.recipients);
  const rAdd = b.recipients.filter((r) => !ra.has(r)).map(recipientName);
  const rDel = a.recipients.filter((r) => !rb.has(r)).map(recipientName);
  if (rAdd.length) out.push(t("diff.recAdded", { list: rAdd.join(", ") }));
  if (rDel.length) out.push(t("diff.recRemoved", { list: rDel.join(", ") }));
  const la = setKey(a.allowlist);
  const lb = setKey(b.allowlist);
  const lAdd = [...lb].filter((k) => !la.has(k)).length;
  const lDel = [...la].filter((k) => !lb.has(k)).length;
  if (lAdd) out.push(t("diff.allowAdded", { count: lAdd }));
  if (lDel) out.push(t("diff.allowRemoved", { count: lDel }));
  if (a.expires_at !== b.expires_at) out.push(t("diff.expires", { from: a.expires_at ? isoDate(Number(a.expires_at)) : t("common.never"), to: b.expires_at ? isoDate(Number(b.expires_at)) : t("common.never") }));
  return out;
}
