import type { MessageKey } from "@/i18n";
/** Pure logic of the schedule drawer (UI_UPDATES §4.2): form state -> validated `ScheduleInput` -> the calls to sign. */
import { t } from "@/i18n";
import { DAY_MS, firstAtOrAfter } from "./frequency";
import { parseUsdc } from "./amount";
import type { PlannedCall } from "./calls";
import { checkMandateCompat, type CompatResult } from "./mandateCompat";
import type { RecipientDraft } from "./recipientForm";
import type { AgentView, Frequency, Mandate, RecipientInput, Schedule, ScheduleEnd, ScheduleInput } from "./types";

export type FreqKind = "Once" | "Monthly" | "Weekly" | "EveryNDays";
export type EndKind = "Never" | "AfterCount" | "On";
/** The two owner paths: a one-time payment, or a recurring schedule. Both are `add_schedule` on the contract. */
export type PaymentMode = "once" | "recurring";
/** One-time payment: as soon as possible, or at a chosen moment. */
export type WhenKind = "now" | "later";

/**
 * "Now" = this far after the moment the owner clicks Save. The contract refuses a `Once` whose start is already in the
 * past when the transaction lands (no payable date), so the start must outlive the wallet confirmation.
 */
export const NOW_LEAD_MS = 2 * 60_000;

export interface ScheduleFormState {
  /** "" (none), a recipient id, or "new" (inline new recipient in `newRecipient`). */
  recipientId: string;
  newRecipient: RecipientDraft;
  amount: string;
  freq: FreqKind;
  day: string;
  /** 0 = Sunday. */
  weekday: string;
  everyN: string;
  /** One-time payments only: pay as soon as possible, or at startDate/startTime. */
  when: WhenKind;
  /** YYYY-MM-DD, the owner's local time zone (stored on chain as UTC ms). */
  startDate: string;
  /** HH:MM, local time. */
  startTime: string;
  endKind: EndKind;
  endCount: string;
  endDate: string;
  agentId: string;
  /** Also add the recipient to the agent's mandate (same batch). */
  addToMandate: boolean;
}

export const MAX_COUNT = 1000;

export function parseUtc(date: string, time: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}
export const toTimeInput = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local date + time inputs -> ms, or null for an impossible date (31 Feb) or a time skipped by a DST jump. */
export function parseLocal(date: string, time: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const v = new Date(y, mo - 1, d, h, mi);
  return v.getFullYear() === y && v.getMonth() === mo - 1 && v.getDate() === d && v.getHours() === h && v.getMinutes() === mi ? v.getTime() : null;
}
/** ms -> YYYY-MM-DD in local time. */
export const localDateInput = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** ms -> HH:MM in local time. */
export const localTimeInput = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Quick picks for "Later". Each returns the local date/time inputs. */
export const WHEN_PRESETS: Array<{ label: string; key: MessageKey; at: (now: number) => number }> = [
  { label: "In 15 min", key: "sf.in15", at: (now) => ceilMinute(now + 15 * 60_000) },
  { label: "In 1 hour", key: "sf.in1h", at: (now) => ceilMinute(now + 60 * 60_000) },
  {
    label: "Tomorrow 09:00",
    key: "sf.tomorrow9",
    at: (now) => {
      const d = new Date(now);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0).getTime();
    },
  },
];
const ceilMinute = (ms: number): number => Math.ceil(ms / 60_000) * 60_000;

/** "UTC+3", "UTC-4:30", "UTC" for the local offset at `ms`. */
export function utcOffsetLabel(ms: number): string {
  const off = -new Date(ms).getTimezoneOffset();
  if (off === 0) return "UTC";
  const a = Math.abs(off);
  return `UTC${off > 0 ? "+" : "-"}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ""}`;
}

/**
 * Recurring dates are counted in UTC days (ADR-0004). When the local start falls on another UTC day, "Monthly on the 1st"
 * means the 1st in UTC, i.e. a different local day. Returns the UTC day the owner should know about, or null if the same.
 */
export function utcDayShift(ms: number): string | null {
  return localDateInput(ms) === new Date(ms).toISOString().slice(0, 10) ? null : new Date(ms).toISOString().slice(0, 10);
}

export function emptyScheduleForm(now: number, defaults: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    recipientId: "",
    newRecipient: { label: "", chain: "", address: "" },
    amount: "",
    freq: "Monthly",
    day: "1",
    weekday: "1",
    everyN: "14",
    when: "now",
    startDate: localDateInput(now + DAY_MS),
    startTime: "09:00",
    endKind: "Never",
    endCount: "6",
    endDate: localDateInput(now + 365 * DAY_MS),
    agentId: "",
    addToMandate: false,
    ...defaults,
  };
}

export function scheduleToForm(s: Schedule, now: number): ScheduleFormState {
  return inputToForm(s, now);
}

/** A schedule (existing, or the args of a proposal) as form state. */
export function inputToForm(s: ScheduleInput, now: number): ScheduleFormState {
  const f = s.frequency;
  const start = Number(s.start_at);
  return emptyScheduleForm(now, {
    recipientId: String(s.recipient_id),
    amount: formatAmountInput(s.amount),
    freq: f === "Once" ? "Once" : "Monthly" in f ? "Monthly" : "Weekly" in f ? "Weekly" : "EveryNDays",
    day: typeof f === "object" && "Monthly" in f ? String(f.Monthly.day) : "1",
    weekday: typeof f === "object" && "Weekly" in f ? String(f.Weekly.weekday) : "1",
    everyN: typeof f === "object" && "EveryNDays" in f ? String(f.EveryNDays.n) : "14",
    when: "later",
    startDate: localDateInput(start),
    startTime: localTimeInput(start),
    endKind: s.end === "Never" ? "Never" : "AfterCount" in s.end ? "AfterCount" : "On",
    endCount: typeof s.end === "object" && "AfterCount" in s.end ? String(s.end.AfterCount.count) : "6",
    endDate: typeof s.end === "object" && "On" in s.end ? localDateInput(Number(s.end.On.at)) : localDateInput(now + 365 * DAY_MS),
    agentId: s.agent_id,
  });
}

/** Raw USDC -> plain decimal text for an input ("1500000000" -> "1500"). */
export function formatAmountInput(raw: string): string {
  const v = BigInt(raw);
  const whole = (v / 1_000_000n).toString();
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export interface BuiltSchedule {
  /** field -> message. */
  errors: Record<string, string>;
  /** Fields that are merely not filled yet (the UI does not shout about them). */
  empty: string[];
  input: ScheduleInput | null;
}

const isInt = (s: string, min: number, max: number): boolean => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

export function buildFrequency(f: ScheduleFormState): Frequency | null {
  switch (f.freq) {
    case "Once":
      return "Once";
    case "Monthly":
      return isInt(f.day, 1, 28) ? { Monthly: { day: Number(f.day) } } : null;
    case "Weekly":
      return isInt(f.weekday, 0, 6) ? { Weekly: { weekday: Number(f.weekday) } } : null;
    case "EveryNDays":
      return isInt(f.everyN, 1, 365) ? { EveryNDays: { n: Number(f.everyN) } } : null;
  }
}

/**
 * Validate the form. `recipientId` is the id the schedule will use (existing id, or `next_recipient_id` for an inline new
 * recipient), or null when none is selected. `editing`: existing schedules may keep a start in the past.
 */
export function buildScheduleInput(f: ScheduleFormState, ctx: { now: number; recipientId: number | null; editing: boolean }): BuiltSchedule {
  const errors: Record<string, string> = {};
  const empty: string[] = [];
  if (ctx.recipientId === null) {
    errors.recipient = t("sf.selectRecipient");
    empty.push("recipient");
  }
  let amount = "";
  if (!f.amount.trim()) {
    errors.amount = t("sf.enterAmount");
    empty.push("amount");
  } else {
    try {
      amount = parseUsdc(f.amount);
      if (BigInt(amount) <= 0n) errors.amount = t("sf.amountPositive");
    } catch (e) {
      errors.amount = e instanceof Error ? e.message : t("amount.invalidShort");
    }
  }
  const frequency = buildFrequency(f);
  if (!frequency) {
    errors[f.freq === "Monthly" ? "day" : f.freq === "Weekly" ? "weekday" : "everyN"] =
      f.freq === "Monthly" ? t("sf.dayRange") : f.freq === "Weekly" ? t("sf.pickWeekday") : t("sf.daysRange");
  }
  // "Now" is resolved against ctx.now, so the drawer passes the click time on save.
  const asap = f.freq === "Once" && f.when === "now" && !ctx.editing;
  const start = asap ? ctx.now + NOW_LEAD_MS : parseLocal(f.startDate, f.startTime);
  if (start === null) errors.start = t("sf.validDateTime");
  else if (!ctx.editing && f.freq === "Once" && start <= ctx.now) errors.start = t("sf.oncePast");

  let end: ScheduleEnd = "Never";
  if (f.freq !== "Once") {
    if (f.endKind === "AfterCount") {
      if (isInt(f.endCount, 1, MAX_COUNT)) end = { AfterCount: { count: Number(f.endCount) } };
      else errors.endCount = t("sf.countRange", { max: MAX_COUNT });
    } else if (f.endKind === "On") {
      const day = parseLocal(f.endDate, "23:59");
      if (day === null) errors.endDate = t("sf.validEnd");
      else {
        const at = day + 59_999; // the whole local end day still counts
        if (start !== null && at < start) errors.endDate = t("sf.endBeforeStart");
        else end = { On: { at: String(at) } };
      }
    }
  }
  if (!f.agentId) {
    errors.agent = t("sf.selectAgent");
    empty.push("agent");
  }
  if (Object.keys(errors).length > 0 || ctx.recipientId === null || frequency === null || start === null) return { errors, empty, input: null };
  return { errors, empty, input: { recipient_id: ctx.recipientId, amount, frequency, start_at: String(start), end, agent_id: f.agentId } };
}

/** First payable date for a form that is being typed (contract: `max(start_at, now)`). Null when none (a past `Once`). */
export function previewFirst(input: Pick<ScheduleInput, "frequency" | "start_at">, now: number, floor = 0): number | null {
  const start = Number(input.start_at);
  return firstAtOrAfter(input.frequency, start, Math.max(start, now, floor));
}

/** Approximate monthly cost in raw USDC (Monthly exact, Weekly x 365/84, every n days x 365/(12 n)). Null for `Once`. */
export function monthlyEquivalent(amount: string, freq: Frequency): bigint | null {
  const a = BigInt(amount);
  if (freq === "Once") return null;
  if ("Monthly" in freq) return a;
  if ("Weekly" in freq) return (a * 365n) / 84n;
  return (a * 365n) / (12n * BigInt(freq.EveryNDays.n));
}

export interface MandateTarget {
  id: number;
  chain: string;
  address: string;
  label: string;
}

/** Does the mandate (Fixed / Allowlist) need an entry for this recipient before it can pay it? Open never does. */
export function recipientMissingFromMandate(agent: AgentView | undefined, rec: MandateTarget): boolean {
  if (!agent || agent.mandate.recipients_mode === "Open") return false;
  return checkMandateCompat({ agent, recipient: { id: rec.id, chain: rec.chain, address: rec.address }, amount: "0" }).errors.some((e) => e.code === "RECIPIENT_NOT_IN_MANDATE");
}

export function mandateWithRecipient(m: Mandate, rec: MandateTarget): Mandate {
  if (m.recipients_mode === "Fixed") return m.recipients.includes(rec.id) ? m : { ...m, recipients: [...m.recipients, rec.id] };
  if (m.recipients_mode === "Allowlist") {
    return m.allowlist.some((d) => d.chain === rec.chain && d.address === rec.address) ? m : { ...m, allowlist: [...m.allowlist, { chain: rec.chain, address: rec.address, label: rec.label }] };
  }
  return m;
}

/** The compat check as the user will experience it: with the mandate update applied when the box is ticked. */
export function effectiveCompat(args: { agent: AgentView | undefined; rec: MandateTarget; amount: string; minPayment?: string; addToMandate: boolean }): CompatResult {
  const agent = args.agent && args.addToMandate ? { ...args.agent, mandate: mandateWithRecipient(args.agent.mandate, args.rec) } : args.agent;
  return checkMandateCompat({ agent, recipient: { id: args.rec.id, chain: args.rec.chain, address: args.rec.address }, amount: args.amount, ...(args.minPayment !== undefined ? { minPayment: args.minPayment } : {}) });
}

/**
 * The calls to sign, in contract order: add_recipient (the schedule and the mandate refer to its id), update_mandate
 * (add_schedule is validated against the mandate), then add_schedule / update_schedule.
 */
export function planScheduleSave(a: {
  scheduleId: number | null;
  input: ScheduleInput;
  newRecipient?: RecipientInput;
  mandateUpdate?: { agentId: string; mandate: Mandate };
}): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (a.newRecipient) calls.push({ method: "add_recipient", args: { recipient: a.newRecipient } });
  if (a.mandateUpdate) calls.push({ method: "update_mandate", args: { agent_id: a.mandateUpdate.agentId, mandate: a.mandateUpdate.mandate } });
  calls.push(a.scheduleId === null ? { method: "add_schedule", args: { schedule: a.input } } : { method: "update_schedule", args: { schedule_id: a.scheduleId, schedule: a.input } });
  return calls;
}
