// Mandate sentence generator (DESIGN_AGENTS §5). Pure: no React, no network.
import { chainName } from "../kit/tokens";
import { usdcGrouped } from "@/lib/amount";
import type { Mandate } from "./types";

/** A piece of the sentence; `bold` pieces are numbers and chains (rendered with `MandateValue`). */
export interface Seg {
  text: string;
  bold?: boolean;
}

export type RecipientNames = ReadonlyMap<number, string> | Record<number, string | undefined>;

const nameOf = (names: RecipientNames, id: number): string => (names instanceof Map ? names.get(id) : (names as Record<number, string | undefined>)[id]) ?? `#${id}`;

/** "Base", "Base and Solana", "Base, Solana and Arbitrum". */
export function joinChains(chains: string[]): string {
  const n = chains.map(chainName);
  if (n.length === 0) return "no chains";
  if (n.length === 1) return n[0]!;
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

const usdc = (raw: string): string => `${usdcGrouped(raw, 0)} USDC`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** UTC date as `2026-12-03`. */
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The recipients clause (without the leading comma). */
export function recipientsClause(m: Mandate, names: RecipientNames): Seg[] {
  if (m.recipients_mode === "Open") return [{ text: "to " }, { text: "any address", bold: true }];
  if (m.recipients_mode === "Allowlist") return [{ text: "only to " }, { text: plural(m.allowlist.length, "approved address", "approved addresses"), bold: true }];
  const n = m.recipients.length;
  const first = m.recipients.slice(0, 2).map((id) => nameOf(names, id));
  const extra = n - first.length;
  const list = first.join(", ") + (extra > 0 ? `, and ${extra} more` : "");
  return [{ text: "only to " }, { text: plural(n, "fixed recipient", "fixed recipients"), bold: true }, { text: `${n > 0 ? ` (${list})` : ""} ${n === 1 ? "on its" : "on their"} schedule` }];
}

function approvalClause(m: Mandate): Seg[] {
  const t = BigInt(m.approval_threshold);
  if (t === 0n) return [{ text: " " }, { text: "Every payment", bold: true }, { text: " needs your approval." }];
  if (t >= BigInt(m.per_tx_limit)) return [{ text: " No payment needs your approval." }];
  return [{ text: " Payments above " }, { text: usdc(m.approval_threshold), bold: true }, { text: " need your approval." }];
}

/**
 * Long form (detail page, wizard, review):
 * "Can spend up to **200 USDC per day**, **50 USDC per payment**, on **Base and Solana**, to **any address**.
 *  Payments above **30 USDC** need your approval. Up to **10 payments** per day. Expires on 2026-12-03."
 */
export function mandateSegments(m: Mandate, names: RecipientNames = {}, nowMs: number = Date.now()): Seg[] {
  const segs: Seg[] = [
    { text: "Can spend up to " },
    { text: `${usdc(m.daily_limit)} per day`, bold: true },
    { text: ", " },
    { text: `${usdc(m.per_tx_limit)} per payment`, bold: true },
    { text: ", on " },
    { text: joinChains(m.allowed_chains), bold: true },
    { text: ", " },
    ...recipientsClause(m, names),
    { text: "." },
    ...approvalClause(m),
    { text: " At most " },
    { text: plural(m.max_payments_per_day, "payment", "payments"), bold: true },
    { text: " per day." },
  ];
  if (m.expires_at) {
    const at = Number(m.expires_at);
    segs.push({ text: at < nowMs ? ` Expired on ${isoDate(at)}.` : ` Expires on ${isoDate(at)}.` });
  }
  return segs;
}

export const segmentsToText = (segs: Seg[]): string => segs.map((s) => s.text).join("");

export const describeMandate = (m: Mandate, names: RecipientNames = {}, nowMs: number = Date.now()): string => segmentsToText(mandateSegments(m, names, nowMs));

/** Short form for list rows (about 70 characters). */
export function describeMandateShort(m: Mandate): string {
  const cap = `up to ${usdcGrouped(m.per_tx_limit, 0)} per payment`;
  if (m.recipients_mode === "Fixed") return `Pays ${plural(m.recipients.length, "fixed recipient", "fixed recipients")} on schedule`;
  if (m.recipients_mode === "Allowlist") return `${plural(m.allowlist.length, "approved address", "approved addresses")} · ${cap}`;
  const chains = m.allowed_chains.length > 3 ? `${m.allowed_chains.length} chains` : m.allowed_chains.map(chainName).join(", ");
  return `Any address on ${chains || "no chains"} · ${cap}`;
}
