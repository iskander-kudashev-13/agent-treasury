// Mandate editor model: form strings <-> contract `Mandate`, validation mirroring `validate_mandate` (contract/src/agent.rs), diff for update_mandate.
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
  if (s.trim() === "") return { error: `${what} is required` };
  try {
    const raw = parseUsdc(s.replace(/[\s,]/g, ""));
    return { raw };
  } catch (e) {
    return { error: e instanceof Error && /decimal/.test(e.message) ? "At most 6 decimal places" : `${what} must be a number` };
  }
}

/** Expiry in ms from the form, or an error. */
function expiryOf(f: MandateForm, nowMs: number): { at: string | null } | { error: string } {
  if (f.expiry === "none") return { at: null };
  if (f.expiry === "7d") return { at: String(nowMs + 7 * DAY_MS) };
  if (f.expiry === "30d") return { at: String(nowMs + 30 * DAY_MS) };
  if (f.expiry === "keep") return { at: f.keptExpiry };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.customDate)) return { error: "Pick a date" };
  const at = Date.parse(`${f.customDate}T23:59:59Z`);
  if (!Number.isFinite(at)) return { error: "Pick a valid date" };
  if (at <= nowMs) return { error: "The expiry date must be in the future" };
  return { at: String(at) };
}

/** Validate the form the way the contract does, with plain-words messages. */
export function validateMandateForm(f: MandateForm, ctx: ValidateCtx): FormResult {
  const errors: FormErrors = {};
  const warnings: string[] = [];

  const daily = amount(f.daily, "Daily limit");
  const perTx = amount(f.perTx, "Per payment limit");
  const threshold = amount(f.threshold, "Approval threshold");
  if ("error" in daily) errors.daily = daily.error;
  else if (BigInt(daily.raw) === 0n) errors.daily = "Daily limit must be above 0";
  if ("error" in perTx) errors.perTx = perTx.error;
  else if (BigInt(perTx.raw) === 0n) errors.perTx = "Per payment limit must be above 0";
  if ("error" in threshold) errors.threshold = threshold.error;
  if (!errors.daily && !errors.perTx && BigInt((perTx as { raw: string }).raw) > BigInt((daily as { raw: string }).raw)) {
    errors.perTx = "Per payment limit can't be higher than the daily limit";
  }
  if (!errors.perTx && !errors.threshold && BigInt((threshold as { raw: string }).raw) > BigInt((perTx as { raw: string }).raw)) {
    warnings.push("The approval threshold is above the per payment limit, so no payment will ever wait for your approval.");
  }

  const maxPerDay = Number(f.maxPerDay);
  if (f.maxPerDay.trim() === "" || !Number.isInteger(maxPerDay)) errors.maxPerDay = "Enter a whole number";
  else if (maxPerDay < 1) errors.maxPerDay = "Payments per day must be at least 1";
  else if (maxPerDay > U32_MAX) errors.maxPerDay = "That is too many payments per day";

  if (f.chains.length === 0) errors.chains = "Pick at least one chain";
  else if (f.chains.length > MAX_CHAINS) errors.chains = `At most ${MAX_CHAINS} chains`;
  else if (f.chains.some((c) => !CHAIN_IDS.includes(c))) errors.chains = "Unknown chain id (use base, eth, arb, sol or near)";

  let allowlist: Mandate["allowlist"] = [];
  let recipients: number[] = [];
  if (f.mode === "Fixed") {
    recipients = [...new Set(f.recipients)];
    if (recipients.length === 0) errors.recipients = "Pick at least one recipient. A fixed agent pays only its scheduled payments.";
    else if (recipients.length > MAX_RECIPIENTS) errors.recipients = `At most ${MAX_RECIPIENTS} recipients`;
    else if (recipients.some((id) => !ctx.knownRecipients.has(id))) errors.recipients = "One of the recipients doesn't exist any more";
  } else if (f.mode === "Allowlist") {
    if (f.allowlist.length === 0) errors.allowlist = "Add at least one address";
    else if (f.allowlist.length > MAX_ALLOWLIST) errors.allowlist = `At most ${MAX_ALLOWLIST} addresses`;
    const rows: Record<number, string> = {};
    const out: Mandate["allowlist"] = [];
    const seen = new Set<string>();
    f.allowlist.forEach((row, i) => {
      const label = row.label.trim();
      try {
        if (!CHAIN_IDS.includes(row.chain)) throw new Error("Pick a chain");
        if (row.address.trim() === "") throw new Error("Enter an address");
        const address = normalizeAddress(row.chain, row.address);
        if (address.length > MAX_ADDRESS_LEN) throw new Error("Address is too long");
        if (label.length > MAX_LABEL_LEN) throw new Error(`Label is longer than ${MAX_LABEL_LEN} characters`);
        const key = `${row.chain}:${address}`;
        if (seen.has(key)) throw new Error("Duplicate address");
        seen.add(key);
        if (!f.chains.includes(row.chain)) warnings.push(`${address.slice(0, 10)}… is on ${chainName(row.chain)}, which isn't one of the selected chains, so it can never be paid.`);
        out.push({ chain: row.chain, address, label: label === "" ? null : label });
      } catch (e) {
        rows[i] = e instanceof Error ? e.message : String(e);
      }
    });
    if (Object.keys(rows).length > 0) errors.rows = rows;
    allowlist = out;
  } else if (f.chains.length > 0) {
    warnings.push("The agent can pay anyone on the selected chains, within the limits above.");
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
const MODE_LABEL: Record<RecipientsMode, string> = { Fixed: "only its scheduled payments", Allowlist: "only approved addresses", Open: "any address" };
const setKey = (xs: Mandate["allowlist"]): Set<string> => new Set(xs.map((d) => `${d.chain}:${d.address}`));

/** Human lines for the update_mandate confirmation: "Daily limit 200 -> 500 USDC". Empty when nothing changed. */
export function diffMandate(a: Mandate, b: Mandate, recipientName: (id: number) => string = (id) => `#${id}`): string[] {
  const out: string[] = [];
  const amt = (label: string, x: string, y: string) => x !== y && out.push(`${label} ${usdcGrouped(x, 0)} → ${usdc(y)}`);
  amt("Daily limit", a.daily_limit, b.daily_limit);
  amt("Per payment limit", a.per_tx_limit, b.per_tx_limit);
  amt("Approval threshold", a.approval_threshold, b.approval_threshold);
  if (a.max_payments_per_day !== b.max_payments_per_day) out.push(`Payments per day ${a.max_payments_per_day} → ${b.max_payments_per_day}`);
  const ca = [...a.allowed_chains].sort().join(",");
  const cb = [...b.allowed_chains].sort().join(",");
  if (ca !== cb) {
    const added = b.allowed_chains.filter((c) => !a.allowed_chains.includes(c)).map(chainName);
    const removed = a.allowed_chains.filter((c) => !b.allowed_chains.includes(c)).map(chainName);
    if (added.length) out.push(`Chains added: ${added.join(", ")}`);
    if (removed.length) out.push(`Chains removed: ${removed.join(", ")}`);
  }
  if (a.recipients_mode !== b.recipients_mode) out.push(`Can pay ${MODE_LABEL[a.recipients_mode]} → ${MODE_LABEL[b.recipients_mode]}`);
  const ra = new Set(a.recipients);
  const rb = new Set(b.recipients);
  const rAdd = b.recipients.filter((r) => !ra.has(r)).map(recipientName);
  const rDel = a.recipients.filter((r) => !rb.has(r)).map(recipientName);
  if (rAdd.length) out.push(`Recipients added: ${rAdd.join(", ")}`);
  if (rDel.length) out.push(`Recipients removed: ${rDel.join(", ")}`);
  const la = setKey(a.allowlist);
  const lb = setKey(b.allowlist);
  const lAdd = [...lb].filter((k) => !la.has(k)).length;
  const lDel = [...la].filter((k) => !lb.has(k)).length;
  if (lAdd) out.push(`${lAdd} address${lAdd === 1 ? "" : "es"} added to the allowlist`);
  if (lDel) out.push(`${lDel} address${lDel === 1 ? "" : "es"} removed from the allowlist`);
  if (a.expires_at !== b.expires_at) out.push(`Expires ${a.expires_at ? isoDate(Number(a.expires_at)) : "never"} → ${b.expires_at ? isoDate(Number(b.expires_at)) : "never"}`);
  return out;
}
