/**
 * Assistant proposals (worker/src/ai/proposals.ts) -> owner calls. The worker is a model: everything it sends is parsed
 * defensively, only the ten known types/methods are accepted, and deposit/gas from the wire are ignored (calls.ts decides).
 * Free text (title, summary, labels) is only ever rendered as plain text.
 */
import { describeFrequency, shortDate } from "./frequency";
import { usdcGrouped } from "@/lib/amount";
import { isAssistantMethod, type AssistantMethod, type PlannedCall } from "./calls";

export type ProposalType =
  | "AddRecipient"
  | "AddSchedule"
  | "UpdateSchedule"
  | "PauseSchedule"
  | "EndSchedule"
  | "UpdateMandate"
  | "PauseAgent"
  | "ResumeAgent"
  | "PauseVault"
  | "ResumeVault";

/** Each proposal type maps to exactly one contract method (UI_UPDATES §6.3). */
export const TYPE_METHOD: Record<ProposalType, AssistantMethod> = {
  AddRecipient: "add_recipient",
  AddSchedule: "add_schedule",
  UpdateSchedule: "update_schedule",
  PauseSchedule: "pause_schedule",
  EndSchedule: "end_schedule",
  UpdateMandate: "update_mandate",
  PauseAgent: "pause_agent",
  ResumeAgent: "resume_agent",
  PauseVault: "pause",
  ResumeVault: "resume",
};

export interface ProposalValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
export interface ProposalDiffRow {
  field: string;
  label: string;
  from: string;
  to: string;
}
export interface Proposal {
  id: string;
  type: ProposalType;
  title: string;
  summary: string;
  urgent: boolean;
  depends_on: string[];
  diff: ProposalDiffRow[];
  call: { method: AssistantMethod; args: Record<string, unknown> };
  validation: ProposalValidation;
  /** AddSchedule / UpdateSchedule: next payment dates (ms). */
  next_dates: number[];
  /** AddRecipient: the id the recipient gets if it is the next one signed. */
  predicted_recipient_id: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Validate untrusted JSON into a Proposal, or null (then the UI shows "ignored a malformed proposal"). */
export function parseProposal(raw: unknown): Proposal | null {
  if (!isObj(raw)) return null;
  const type = raw.type;
  if (typeof type !== "string" || !Object.hasOwn(TYPE_METHOD, type)) return null;
  const t = type as ProposalType;
  if (typeof raw.id !== "string" || raw.id === "" || raw.id.length > 32) return null;
  const call = raw.call;
  if (!isObj(call) || call.method !== TYPE_METHOD[t] || !isAssistantMethod(call.method) || !isObj(call.args)) return null;
  const v = raw.validation;
  if (!isObj(v) || typeof v.ok !== "boolean") return null;
  const errors = strArr(v.errors) ?? [];
  const warnings = strArr(v.warnings) ?? [];
  // A card that claims ok but lists errors is not ok.
  const ok = v.ok && errors.length === 0;
  const diff = Array.isArray(raw.diff)
    ? raw.diff.flatMap((d): ProposalDiffRow[] => (isObj(d) && typeof d.label === "string" ? [{ field: str(d.field, 64), label: str(d.label, 80), from: str(d.from, 300), to: str(d.to, 300) }] : []))
    : [];
  const nextDates = Array.isArray(raw.next_dates) ? raw.next_dates.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(0, 12) : [];
  const p: Proposal = {
    id: raw.id,
    type: t,
    title: str(raw.title, 120),
    summary: str(raw.summary),
    urgent: raw.urgent === true,
    depends_on: strArr(raw.depends_on)?.slice(0, 20) ?? [],
    diff,
    call: { method: call.method, args: call.args },
    validation: { ok, errors, warnings },
    next_dates: nextDates,
    predicted_recipient_id: typeof raw.predicted_recipient_id === "number" && Number.isInteger(raw.predicted_recipient_id) ? raw.predicted_recipient_id : null,
  };
  return argsSane(p) ? p : null;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isU128 = (v: unknown): v is string => typeof v === "string" && /^\d{1,39}$/.test(v);

function scheduleSane(s: unknown): boolean {
  return isObj(s) && isInt(s.recipient_id) && isU128(s.amount) && typeof s.agent_id === "string" && typeof s.start_at === "string" && s.frequency !== undefined && s.end !== undefined;
}

/** Shape check of the args the wallet will be asked to sign. */
function argsSane(p: Proposal): boolean {
  const a = p.call.args;
  switch (p.type) {
    case "AddRecipient": {
      const r = a.recipient;
      return isObj(r) && typeof r.label === "string" && typeof r.destination_chain === "string" && typeof r.destination_asset === "string" && typeof r.destination_address === "string";
    }
    case "AddSchedule":
      return scheduleSane(a.schedule);
    case "UpdateSchedule":
      return isInt(a.schedule_id) && scheduleSane(a.schedule);
    case "PauseSchedule":
    case "EndSchedule":
      return isInt(a.schedule_id);
    case "UpdateMandate":
      return typeof a.agent_id === "string" && isObj(a.mandate);
    case "PauseAgent":
    case "ResumeAgent":
      return typeof a.agent_id === "string";
    case "PauseVault":
    case "ResumeVault":
      return true;
  }
}

export const proposalToCall = (p: Proposal): PlannedCall => ({ method: p.call.method, args: p.call.args });
export const isQueueable = (p: Proposal): boolean => p.validation.ok;

/* ───────────── batch ───────────── */

export interface BatchItem {
  id: string;
  calls: PlannedCall[];
  depends_on: string[];
  /** AddRecipient items: the recipient id this item creates when signed in id order. */
  recipientId: number | null;
  title?: string;
}

export interface OrderedBatch {
  ordered: BatchItem[];
  /** Reasons why the batch must not be signed as is. */
  problems: string[];
}

/**
 * Order the queued items for one transaction: dependencies first (a schedule after the recipient it refers to), items that
 * create recipients in recipient-id order (ids are assigned by the contract in signing order), otherwise queue order.
 * `signed`: ids already signed (their dependencies are satisfied). `nextRecipientId`: the contract's counter now.
 */
export function orderBatch(items: BatchItem[], signed: ReadonlySet<string> = new Set(), nextRecipientId: number | null = null): OrderedBatch {
  const problems: string[] = [];
  const ids = new Set(items.map((i) => i.id));
  for (const it of items) {
    for (const d of it.depends_on) {
      if (!ids.has(d) && !signed.has(d)) problems.push(`"${it.title ?? it.id}" depends on ${d}, which is not queued. Queue it too or discard this change.`);
    }
  }
  // Recipient creators keep their relative order by predicted id.
  const creators = items.filter((i) => i.recipientId !== null).sort((a, b) => (a.recipientId ?? 0) - (b.recipientId ?? 0));
  let ci = 0;
  const queue = items.map((i) => (i.recipientId !== null ? (creators[ci++] as BatchItem) : i));

  const done = new Set<string>();
  const ordered: BatchItem[] = [];
  const pending = [...queue];
  while (pending.length > 0) {
    const idx = pending.findIndex((it) => it.depends_on.every((d) => done.has(d) || signed.has(d) || !ids.has(d)));
    if (idx === -1) {
      problems.push("The changes depend on each other in a loop.");
      ordered.push(...pending);
      break;
    }
    const [it] = pending.splice(idx, 1) as [BatchItem];
    ordered.push(it);
    done.add(it.id);
  }

  if (nextRecipientId !== null) {
    const created = ordered.filter((i) => i.recipientId !== null).map((i) => i.recipientId as number);
    created.forEach((id, n) => {
      if (id !== nextRecipientId + n) problems.push(`The vault's recipient list changed since the assistant prepared this (expected id ${nextRecipientId + n}, got ${id}). Ask the assistant again.`);
    });
  }
  return { ordered, problems: [...new Set(problems)] };
}

export const flattenBatch = (ordered: BatchItem[]): PlannedCall[] => ordered.flatMap((i) => i.calls);

/* ───────────── card rows ───────────── */

export interface RowLookups {
  recipient: (id: number) => string;
  agent: (id: string) => string;
}
export interface CardRow {
  label: string;
  from?: string;
  to: string;
}

const fmtEnd = (end: unknown): string => {
  if (end === "Never") return "No end";
  if (isObj(end) && isObj(end.AfterCount)) return `After ${String(end.AfterCount.count)} payments`;
  if (isObj(end) && isObj(end.On)) return `On ${shortDate(Number(end.On.at))}`;
  return "—";
};

/** Rows of the proposal card, derived from the typed args (not from model prose) wherever the schema allows. */
export function proposalRows(p: Proposal, look: RowLookups): CardRow[] {
  const a = p.call.args;
  const s = (isObj(a.schedule) ? a.schedule : null) as Record<string, unknown> | null;
  const scheduleRows = (): CardRow[] => {
    if (!s) return [];
    const freq = s.frequency as Parameters<typeof describeFrequency>[0];
    const start = Number(s.start_at);
    const rows: CardRow[] = [
      { label: "Recipient", to: look.recipient(Number(s.recipient_id)) },
      { label: "Amount", to: `${usdcGrouped(String(s.amount), 0)} USDC` },
      { label: "Frequency", to: describeFrequency(freq, start) },
      { label: "Starts", to: `${shortDate(start)} ${new Date(start).toISOString().slice(11, 16)} UTC` },
      { label: "Ends", to: fmtEnd(s.end) },
      { label: "Paid by", to: look.agent(String(s.agent_id)) },
    ];
    if (p.next_dates.length > 0) rows.push({ label: "Next payments", to: p.next_dates.map(shortDate).join(" · ") });
    return rows;
  };
  switch (p.type) {
    case "AddRecipient": {
      const r = a.recipient as Record<string, unknown>;
      return [
        { label: "Name", to: String(r.label) },
        { label: "Chain", to: String(r.destination_chain) },
        { label: "Address", to: String(r.destination_address) },
      ];
    }
    case "AddSchedule":
      return scheduleRows();
    case "UpdateSchedule":
      return [{ label: "Schedule", to: `#${String(a.schedule_id)}` }, ...scheduleRows()];
    case "PauseSchedule":
    case "EndSchedule":
      return [{ label: "Schedule", to: `#${String(a.schedule_id)}` }];
    case "UpdateMandate":
      return p.diff.length > 0 ? p.diff.map((d) => ({ label: d.label, from: d.from, to: d.to })) : [{ label: "Agent", to: look.agent(String(a.agent_id)) }];
    case "PauseAgent":
    case "ResumeAgent":
      return [{ label: "Agent", to: look.agent(String(a.agent_id)) }];
    case "PauseVault":
      return [{ label: "Effect", to: "No agent can pay until you resume" }];
    case "ResumeVault":
      return [{ label: "Effect", to: "Agents can pay again" }];
  }
}
