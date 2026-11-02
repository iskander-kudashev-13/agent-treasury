// Mandate sentence generator (DESIGN_AGENTS §5). Pure: no React, no network.
import { chainName } from "../kit/tokens";
import { getLocale, interpolate, intlLocale, t, template, type MessageKey } from "@/i18n";
import { usdcGrouped } from "@/lib/amount";
import type { Mandate } from "./types";

/** A piece of the sentence; `bold` pieces are numbers and chains (rendered with `MandateValue`). */
export interface Seg {
  text: string;
  bold?: boolean;
}

export type RecipientNames = ReadonlyMap<number, string> | Record<number, string | undefined>;

const nameOf = (names: RecipientNames, id: number): string => (names instanceof Map ? names.get(id) : (names as Record<number, string | undefined>)[id]) ?? `#${id}`;

/**
 * Split a translated template at `**` into plain/bold segments, THEN substitute params, so untrusted values
 * (recipient labels) can never inject bold markers.
 */
function segs(key: MessageKey, params: Record<string, string | number> = {}): Seg[] {
  return template(getLocale(), key, params)
    .split("**")
    .map((piece, i): Seg => ({ text: interpolate(piece, params), ...(i % 2 === 1 ? { bold: true } : {}) }))
    .filter((s) => s.text !== "");
}

/** "Base", "Base and Solana", "Base, Solana and Arbitrum" (Intl.ListFormat: localised conjunction). */
export function joinChains(chains: string[]): string {
  const n = chains.map(chainName);
  if (n.length === 0) return t("m.noChains");
  if (n.length === 1) return n[0]!;
  return new Intl.ListFormat(intlLocale(), { style: "long", type: "conjunction" }).format(n);
}

const usdc = (raw: string): string => `${usdcGrouped(raw, 0)} USDC`;

/** UTC date as `2026-12-03`. */
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The recipients clause (without the leading comma). */
export function recipientsClause(m: Mandate, names: RecipientNames): Seg[] {
  if (m.recipients_mode === "Open") return segs("m.toAny");
  if (m.recipients_mode === "Allowlist") return segs("m.toAllow", { count: m.allowlist.length });
  const n = m.recipients.length;
  const first = m.recipients.slice(0, 2).map((id) => nameOf(names, id));
  const extra = n - first.length;
  const list = first.join(", ") + (extra > 0 ? t("m.andMore", { extra }) : "");
  return segs("m.toFixed", { count: n, list: n > 0 ? ` (${list})` : "" });
}

function approvalClause(m: Mandate): Seg[] {
  const t = BigInt(m.approval_threshold);
  if (t === 0n) return segs("m.everyNeeds");
  if (t >= BigInt(m.per_tx_limit)) return segs("m.noneNeeds");
  return segs("m.aboveNeeds", { amount: usdc(m.approval_threshold) });
}

/**
 * Long form (detail page, wizard, review):
 * "Can spend up to **200 USDC per day**, **50 USDC per payment**, on **Base and Solana**, to **any address**.
 *  Payments above **30 USDC** need your approval. Up to **10 payments** per day. Expires on 2026-12-03."
 */
export function mandateSegments(m: Mandate, names: RecipientNames = {}, nowMs: number = Date.now()): Seg[] {
  const out: Seg[] = [
    ...segs("m.head", { daily: usdc(m.daily_limit), perTx: usdc(m.per_tx_limit), chains: joinChains(m.allowed_chains) }),
    ...recipientsClause(m, names),
    { text: "." },
    ...approvalClause(m),
    ...segs("m.perDay", { count: m.max_payments_per_day }),
  ];
  if (m.expires_at) {
    const at = Number(m.expires_at);
    out.push(...segs(at < nowMs ? "m.expired" : "m.expires", { date: isoDate(at) }));
  }
  return out;
}

export const segmentsToText = (segs: Seg[]): string => segs.map((s) => s.text).join("");

export const describeMandate = (m: Mandate, names: RecipientNames = {}, nowMs: number = Date.now()): string => segmentsToText(mandateSegments(m, names, nowMs));

/** Short form for list rows (about 70 characters). */
export function describeMandateShort(m: Mandate): string {
  const cap = t("m.upToPerPayment", { amount: usdcGrouped(m.per_tx_limit, 0) });
  if (m.recipients_mode === "Fixed") return t("m.shortFixed", { count: m.recipients.length });
  if (m.recipients_mode === "Allowlist") return t("m.shortAllow", { count: m.allowlist.length, cap });
  const chains = m.allowed_chains.length > 3 ? t("m.chainsCount", { count: m.allowed_chains.length }) : m.allowed_chains.map(chainName).join(", ");
  return t("m.shortAny", { chains: chains || t("m.noChains"), cap });
}
