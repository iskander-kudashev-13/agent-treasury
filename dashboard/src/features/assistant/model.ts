/** State model of the chat (pure, unit-tested): items, history sent to the worker, data payload parsing. */
import type { DataKind } from "@/lib/assistantClient";
import { isAssistantMethod, type PlannedCall } from "@/lib/calls";
import { previewFirst } from "@/lib/scheduleForm";
import { nextOccurrences } from "@/lib/frequency";
import type { BatchItem, Proposal } from "@/lib/proposals";
import type { TradingRulesProposal } from "@/lib/tradingClient";
import type { ScheduleInput } from "@/lib/types";

export type CardStatus = "draft" | "queued" | "signed" | "discarded";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | { kind: "question"; id: string; text: string; options: string[]; answered: boolean }
  | { kind: "data"; id: string; dataKind: DataKind; payload: unknown }
  | {
      kind: "proposal";
      id: string;
      /** Assistant turn number: worker proposal ids ("p1") are only unique within a turn. */
      turn: number;
      proposal: Proposal;
      /** What will be signed. Defaults to the proposal's call; replaced when the owner edits the card in the form. */
      calls: PlannedCall[];
      status: CardStatus;
      edited: boolean;
      /** Recipient id this card creates when signed in id order (AddRecipient). */
      recipientId: number | null;
      hash: string | null;
    }
  | {
      /** Trading rules (ADR-0005): confirmed with a NEP-413 signature, never part of a transaction batch. */
      kind: "trading_rules";
      id: string;
      proposal: TradingRulesProposal;
      status: "draft" | "signed" | "discarded";
      /** When the worker accepted the signed rules. */
      confirmedAt: number | null;
    }
  | { kind: "notice"; id: string; text: string; tone: "error" | "info" };

export type ProposalItem = Extract<ChatItem, { kind: "proposal" }>;
export type TradingRulesItem = Extract<ChatItem, { kind: "trading_rules" }>;
export const isTradingRulesItem = (i: ChatItem): i is TradingRulesItem => i.kind === "trading_rules";
export const isProposalItem = (i: ChatItem): i is ProposalItem => i.kind === "proposal";

/** Messages for `POST /ai/chat`: user texts and the assistant's text/questions. Cards, data and notices are not history. */
export function buildHistory(items: ChatItem[], maxMessages = 30): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  const push = (role: "user" | "assistant", content: string) => {
    const t = content.trim();
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${t}`;
    else out.push({ role, content: t });
  };
  for (const i of items) {
    if (i.kind === "user") push("user", i.text);
    else if (i.kind === "text") push("assistant", i.text);
    else if (i.kind === "question") push("assistant", i.text);
  }
  while (out.length > 0 && out[0]?.role !== "user") out.shift();
  return out.slice(-maxMessages);
}

const isScheduleCall = (c: PlannedCall | undefined): c is PlannedCall => c?.method === "add_schedule" || c?.method === "update_schedule";

/**
 * Queued, unsigned cards as batch items (ids qualified by turn so "p1" of two turns never collide). An edited card keeps
 * no dependency from the model: it depends on whichever card creates the recipient it now points to.
 */
export function toBatchItems(items: ChatItem[]): BatchItem[] {
  const cards = items.filter(isProposalItem);
  return cards
    .filter((i) => i.status === "queued")
    .map((i) => {
      let depends = i.proposal.depends_on.map((d) => `t${i.turn}:${d}`);
      const main = i.calls[i.calls.length - 1];
      if (i.edited && isScheduleCall(main) && !i.calls.some((c) => c.method === "add_recipient")) {
        const rid = (main.args.schedule as { recipient_id?: number } | undefined)?.recipient_id;
        depends = cards.filter((c) => c.id !== i.id && c.status !== "signed" && c.status !== "discarded" && c.recipientId !== null && c.recipientId === rid).map((c) => c.id);
      }
      return { id: i.id, calls: i.calls, depends_on: depends, recipientId: i.recipientId, title: i.proposal.title };
    });
}
export const signedIds = (items: ChatItem[]): Set<string> => new Set(items.filter(isProposalItem).filter((i) => i.status === "signed").map((i) => i.id));
export const cardId = (turn: number, proposalId: string): string => `t${turn}:${proposalId}`;

/* ───────────── answer payloads (untrusted: clip everything, render as text) ───────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown, max = 80): string => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");

export interface TableData {
  title: string;
  columns: string[];
  rows: string[][];
}
export function parseTable(p: unknown): TableData | null {
  if (!isObj(p) || !Array.isArray(p.columns) || !Array.isArray(p.rows)) return null;
  const columns = p.columns.slice(0, 5).map((c) => s(c, 40));
  if (columns.length === 0) return null;
  const rows = p.rows.slice(0, 5).map((r) => (Array.isArray(r) ? r.slice(0, columns.length).map((c) => s(c)) : []));
  return { title: s(p.title), columns, rows };
}

export type NumberSource = "balance" | "upcoming" | "payouts" | "schedules" | "agents" | "policy" | "rejections";
export interface NumberData {
  label: string;
  value: string;
  unit: string;
  delta: string;
  source: NumberSource | null;
}
const SOURCES: readonly string[] = ["balance", "upcoming", "payouts", "schedules", "agents", "policy", "rejections"];
export function parseNumber(p: unknown): NumberData | null {
  if (!isObj(p) || typeof p.value !== "string") return null;
  return { label: s(p.label), value: s(p.value, 40), unit: s(p.unit, 10), delta: s(p.delta, 60), source: typeof p.source === "string" && SOURCES.includes(p.source) ? (p.source as NumberSource) : null };
}

/** Where "every number links to its source view" (UI_UPDATES §6.4) goes. HashRouter paths. */
export const SOURCE_ROUTE: Record<NumberSource, string> = {
  balance: "/",
  upcoming: "/payments?tab=scheduled",
  payouts: "/payouts",
  schedules: "/payments?tab=scheduled",
  agents: "/agents",
  policy: "/policy",
  rejections: "/payouts",
};

export interface UpcomingData {
  items: Array<{ label: string; agent: string; amount: string; due: string; approval: boolean }>;
  total: string;
  balance: string;
  shortfall: string | null;
  overLimit: Array<{ date: string; total: string }>;
}
export function parseUpcoming(p: unknown): UpcomingData | null {
  if (!isObj(p) || !Array.isArray(p.items)) return null;
  return {
    items: p.items.slice(0, 50).flatMap((i) =>
      isObj(i)
        ? [{ label: s(i.untrusted_recipient_label, 64) || `Recipient #${s(i.recipient_id)}`, agent: s(i.agent_id, 40), amount: s(i.amount_usdc, 30), due: s(i.due_at, 30), approval: i.will_need_approval === true }]
        : [],
    ),
    total: s(p.total_usdc, 30),
    balance: s(p.balance_usdc, 30),
    shortfall: typeof p.shortfall_usdc === "string" ? s(p.shortfall_usdc, 30) : null,
    overLimit: Array.isArray(p.days_over_vault_daily_limit) ? p.days_over_vault_daily_limit.slice(0, 10).flatMap((d) => (isObj(d) ? [{ date: s(d.date, 30), total: s(d.total_usdc, 30) }] : [])) : [],
  };
}

/** The proposal as the card shows it: after an edit in the form, from the edited calls instead of the model's. */
export function effectiveProposal(i: ProposalItem, now: number): Proposal {
  if (!i.edited) return i.proposal;
  const main = i.calls[i.calls.length - 1];
  if (!main) return i.proposal;
  let next: number[] = [];
  if (isScheduleCall(main)) {
    const s = main.args.schedule as ScheduleInput;
    next = nextOccurrences({ frequency: s.frequency, start_at: s.start_at, end: s.end, next_due_at: previewFirst(s, now) }, 3);
  }
  const call = i.proposal.type === "AddRecipient" ? (i.calls.find((c) => c.method === "add_recipient") ?? main) : main;
  if (!isAssistantMethod(call.method)) return i.proposal;
  return { ...i.proposal, call: { method: call.method, args: call.args }, diff: [], next_dates: next, validation: { ok: true, errors: [], warnings: [] } };
}
