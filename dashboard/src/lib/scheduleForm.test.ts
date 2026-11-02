import { describe, expect, it } from "vitest";
import type { AgentView, Mandate } from "./types";
import {
  buildScheduleInput,
  effectiveCompat,
  emptyScheduleForm,
  localDateInput,
  localTimeInput,
  mandateWithRecipient,
  monthlyEquivalent,
  NOW_LEAD_MS,
  parseLocal,
  parseUtc,
  planScheduleSave,
  previewFirst,
  recipientMissingFromMandate,
  scheduleToForm,
  utcDayShift,
  WHEN_PRESETS,
} from "./scheduleForm";

/** Local wall-clock time -> ms (the form takes local time; expectations must not depend on the machine's zone). */
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo, d, h, mi).getTime();

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  daily_limit: "5000000000",
  per_tx_limit: "1000000000",
  approval_threshold: "1000000000",
  allowed_chains: ["base"],
  recipients_mode: "Fixed",
  allowlist: [],
  recipients: [1],
  expires_at: null,
  max_payments_per_day: 5,
  ...over,
});
const agent = (m: Mandate): AgentView => ({ id: "payroll", name: "payroll", kind: "Tee", account_id: null, public_key: null, account_pinned: false, mandate: m, status: "Active", spent_today: "0", day_index: "0", created_at: "0", last_request_at: null, failed_transfers: 0, open_approvals: 0, tee: null });
const REC = { id: 7, chain: "base", address: "0xabc", label: "Maria" };

describe("buildScheduleInput", () => {
  const base = emptyScheduleForm(NOW, { recipientId: "7", amount: "1500", agentId: "payroll", startDate: "2026-12-01", startTime: "09:00" });
  it("builds a monthly schedule with wire shapes", () => {
    const r = buildScheduleInput(base, { now: NOW, recipientId: 7, editing: false });
    expect(r.errors).toEqual({});
    expect(r.input).toEqual({
      recipient_id: 7,
      amount: "1500000000",
      frequency: { Monthly: { day: 1 } },
      start_at: String(local(2026, 11, 1, 9, 0)),
      end: "Never",
      agent_id: "payroll",
    });
  });
  it("limits monthly day to 1..28", () => {
    expect(buildScheduleInput({ ...base, day: "29" }, { now: NOW, recipientId: 7, editing: false }).errors.day).toMatch(/28/);
    expect(buildScheduleInput({ ...base, day: "0" }, { now: NOW, recipientId: 7, editing: false }).input).toBeNull();
  });
  it("validates amount, recipient, agent", () => {
    const r = buildScheduleInput({ ...base, amount: "", agentId: "" }, { now: NOW, recipientId: null, editing: false });
    expect(r.input).toBeNull();
    expect(r.empty.sort()).toEqual(["agent", "amount", "recipient"]);
    expect(buildScheduleInput({ ...base, amount: "0" }, { now: NOW, recipientId: 7, editing: false }).errors.amount).toMatch(/greater/);
    expect(buildScheduleInput({ ...base, amount: "1.2345678" }, { now: NOW, recipientId: 7, editing: false }).errors.amount).toMatch(/decimal/);
  });
  it("Once must be in the future when adding", () => {
    const f = { ...base, freq: "Once" as const, when: "later" as const, startDate: "2026-10-01" };
    expect(buildScheduleInput(f, { now: NOW, recipientId: 7, editing: false }).errors.start).toBeDefined();
    expect(buildScheduleInput(f, { now: NOW, recipientId: 7, editing: true }).errors.start).toBeUndefined();
  });
  it("end rules", () => {
    const c = buildScheduleInput({ ...base, endKind: "AfterCount", endCount: "6" }, { now: NOW, recipientId: 7, editing: false });
    expect(c.input?.end).toEqual({ AfterCount: { count: 6 } });
    const on = buildScheduleInput({ ...base, endKind: "On", endDate: "2027-01-01" }, { now: NOW, recipientId: 7, editing: false });
    expect(on.input?.end).toEqual({ On: { at: String(local(2027, 0, 1, 23, 59) + 59_999) } });
    expect(buildScheduleInput({ ...base, endKind: "On", endDate: "2026-11-30" }, { now: NOW, recipientId: 7, editing: false }).errors.endDate).toMatch(/before/);
    expect(buildScheduleInput({ ...base, endKind: "AfterCount", endCount: "0" }, { now: NOW, recipientId: 7, editing: false }).errors.endCount).toBeDefined();
  });
  it("every n days and weekly", () => {
    expect(buildScheduleInput({ ...base, freq: "EveryNDays", everyN: "14" }, { now: NOW, recipientId: 7, editing: false }).input?.frequency).toEqual({ EveryNDays: { n: 14 } });
    expect(buildScheduleInput({ ...base, freq: "Weekly", weekday: "0" }, { now: NOW, recipientId: 7, editing: false }).input?.frequency).toEqual({ Weekly: { weekday: 0 } });
    expect(buildScheduleInput({ ...base, freq: "EveryNDays", everyN: "400" }, { now: NOW, recipientId: 7, editing: false }).input).toBeNull();
  });
});

describe("one-time payment", () => {
  const once = emptyScheduleForm(NOW, { recipientId: "7", amount: "6", agentId: "payroll", freq: "Once" });
  it("defaults to Now", () => {
    expect(once.when).toBe("now");
  });
  it("Now starts NOW_LEAD_MS after the click, ignoring the date fields", () => {
    const r = buildScheduleInput({ ...once, startDate: "2020-01-01" }, { now: NOW, recipientId: 7, editing: false });
    expect(r.errors).toEqual({});
    expect(r.input).toMatchObject({ frequency: "Once", start_at: String(NOW + NOW_LEAD_MS), end: "Never" });
  });
  it("Later uses the local date and time", () => {
    const r = buildScheduleInput({ ...once, when: "later", startDate: "2026-11-03", startTime: "14:30" }, { now: NOW, recipientId: 7, editing: false });
    expect(r.input?.start_at).toBe(String(local(2026, 10, 3, 14, 30)));
  });
  it("editing an existing one-time payment keeps its date (no Now)", () => {
    const r = buildScheduleInput({ ...once, when: "now", startDate: "2026-11-03", startTime: "14:30" }, { now: NOW, recipientId: 7, editing: true });
    expect(r.input?.start_at).toBe(String(local(2026, 10, 3, 14, 30)));
  });
  it("presets land in the future on whole minutes", () => {
    for (const p of WHEN_PRESETS) {
      const at = p.at(NOW + 12_345);
      expect(at).toBeGreaterThan(NOW);
      expect(at % 60_000).toBe(0);
    }
    const tomorrow = WHEN_PRESETS.find((p) => p.label.startsWith("Tomorrow"))?.at(NOW) ?? 0;
    expect(localTimeInput(tomorrow)).toBe("09:00");
  });
});

describe("helpers", () => {
  it("parseLocal round-trips with the local input formatters and rejects impossible dates", () => {
    const ms = local(2026, 11, 1, 9, 5);
    expect(parseLocal(localDateInput(ms), localTimeInput(ms))).toBe(ms);
    expect(parseLocal("2026-02-30", "09:00")).toBeNull();
    expect(parseLocal("2026-12-01", "24:00")).toBeNull();
  });
  it("utcDayShift reports the UTC day only when it differs from the local one", () => {
    const ms = local(2026, 11, 1, 12, 0);
    const same = localDateInput(ms) === new Date(ms).toISOString().slice(0, 10);
    expect(utcDayShift(ms)).toBe(same ? null : new Date(ms).toISOString().slice(0, 10));
  });
  it("parseUtc rejects impossible dates", () => {
    expect(parseUtc("2026-02-30", "09:00")).toBeNull();
    expect(parseUtc("2026-12-01", "09:00")).toBe(Date.UTC(2026, 11, 1, 9));
  });
  it("monthly equivalent", () => {
    expect(monthlyEquivalent("1500000000", { Monthly: { day: 1 } })).toBe(1500000000n);
    expect(monthlyEquivalent("1500000000", "Once")).toBeNull();
    expect(monthlyEquivalent("100000000", { EveryNDays: { n: 30 } })).toBe((100000000n * 365n) / 360n);
  });
  it("preview starts at max(start, now)", () => {
    const first = previewFirst({ frequency: { Monthly: { day: 1 } }, start_at: String(Date.UTC(2026, 0, 1, 9)) }, NOW);
    expect(first).toBe(Date.UTC(2026, 11, 1, 9));
    expect(previewFirst({ frequency: "Once", start_at: String(NOW - 1000) }, NOW)).toBeNull();
  });
  it("round-trips an existing schedule into the form", () => {
    const f = scheduleToForm(
      { id: 1, recipient_id: 7, amount: "1500500000", frequency: { Weekly: { weekday: 3 } }, start_at: String(local(2026, 11, 1, 9)), end: { AfterCount: { count: 4 } }, agent_id: "payroll", status: "Active", last_paid_at: null, last_occurrence_paid: null, paid_count: 0, created_at: "0", next_due_at: null, open_payout: null, failed_attempts: 0 },
      NOW,
    );
    expect(f).toMatchObject({ recipientId: "7", amount: "1500.5", freq: "Weekly", weekday: "3", endKind: "AfterCount", endCount: "4", startDate: "2026-12-01", startTime: "09:00" });
  });
});

describe("mandate handling", () => {
  it("detects and fixes a Fixed mandate without the recipient", () => {
    const a = agent(mandate());
    expect(recipientMissingFromMandate(a, REC)).toBe(true);
    expect(effectiveCompat({ agent: a, rec: REC, amount: "1", addToMandate: false }).errors.map((e) => e.code)).toContain("RECIPIENT_NOT_IN_MANDATE");
    expect(effectiveCompat({ agent: a, rec: REC, amount: "1", addToMandate: true }).errors).toEqual([]);
    expect(mandateWithRecipient(a.mandate, REC).recipients).toEqual([1, 7]);
    expect(mandateWithRecipient(mandateWithRecipient(a.mandate, REC), REC).recipients).toEqual([1, 7]);
  });
  it("Allowlist adds the destination, Open changes nothing", () => {
    const m = mandate({ recipients_mode: "Allowlist", recipients: [] });
    expect(recipientMissingFromMandate(agent(m), REC)).toBe(true);
    expect(mandateWithRecipient(m, REC).allowlist).toEqual([{ chain: "base", address: "0xabc", label: "Maria" }]);
    expect(recipientMissingFromMandate(agent(mandate({ recipients_mode: "Open" })), REC)).toBe(false);
  });
  it("chain and limit problems still block even when the recipient is added", () => {
    const a = agent(mandate({ allowed_chains: ["sol"] }));
    expect(effectiveCompat({ agent: a, rec: REC, amount: "2000000000", addToMandate: true }).errors.map((e) => e.code).sort()).toEqual(["ABOVE_PER_TX_LIMIT", "CHAIN_NOT_ALLOWED"]);
  });
});

describe("planScheduleSave order", () => {
  const input = { recipient_id: 7, amount: "1", frequency: "Once" as const, start_at: "1", end: "Never" as const, agent_id: "payroll" };
  it("add_recipient, update_mandate, add_schedule in one batch", () => {
    const calls = planScheduleSave({
      scheduleId: null,
      input,
      newRecipient: { label: "Maria", destination_chain: "base", destination_asset: "a", destination_address: "0x1" },
      mandateUpdate: { agentId: "payroll", mandate: mandate() },
    });
    expect(calls.map((c) => c.method)).toEqual(["add_recipient", "update_mandate", "add_schedule"]);
    expect(calls[2]?.args).toEqual({ schedule: input });
  });
  it("edit uses update_schedule with the id", () => {
    expect(planScheduleSave({ scheduleId: 3, input })[0]).toEqual({ method: "update_schedule", args: { schedule_id: 3, schedule: input } });
  });
});
