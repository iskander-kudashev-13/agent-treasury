import { describe, expect, it } from "vitest";
import { flattenBatch, orderBatch, parseProposal, proposalRows, proposalToCall, type BatchItem } from "./proposals";

const validation = { ok: true, errors: [], warnings: [] };
const rawRecipient = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  type: "AddRecipient",
  title: "New recipient",
  summary: "Maria",
  call: { method: "add_recipient", args: { recipient: { label: "Maria", destination_chain: "base", destination_asset: "nep141:x", destination_address: "0xabc" } }, deposit_yocto: "1", gas_tgas: 30 },
  validation,
  predicted_recipient_id: 5,
  ...over,
});
const rawSchedule = (over: Record<string, unknown> = {}) => ({
  id: "p2",
  type: "AddSchedule",
  title: "New scheduled payment",
  summary: "x",
  depends_on: ["p1"],
  next_dates: [Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)],
  call: { method: "add_schedule", args: { schedule: { recipient_id: 5, amount: "1500000000", frequency: { Monthly: { day: 1 } }, start_at: String(Date.UTC(2026, 11, 1, 9)), end: "Never", agent_id: "payroll" } }, deposit_yocto: "1", gas_tgas: 30 },
  validation,
  ...over,
});

describe("parseProposal", () => {
  it("accepts a well-formed proposal and maps it to a call without wire deposit/gas", () => {
    const p = parseProposal(rawSchedule());
    expect(p?.type).toBe("AddSchedule");
    expect(p && proposalToCall(p)).toEqual({ method: "add_schedule", args: (rawSchedule().call as { args: unknown }).args });
    expect(p && Object.keys(proposalToCall(p))).toEqual(["method", "args"]);
  });
  it("rejects unknown types, mismatched methods and non-owner methods", () => {
    expect(parseProposal(rawRecipient({ type: "Withdraw" }))).toBeNull();
    expect(parseProposal(rawRecipient({ call: { method: "withdraw", args: {} } }))).toBeNull();
    expect(parseProposal(rawRecipient({ type: "AddSchedule" }))).toBeNull(); // method/type mismatch
    expect(parseProposal(rawRecipient({ call: { method: "add_recipient", args: { recipient: { label: 1 } } } }))).toBeNull();
    expect(parseProposal("x")).toBeNull();
    expect(parseProposal(rawSchedule({ call: { method: "add_schedule", args: { schedule: { recipient_id: -1 } } } }))).toBeNull();
  });
  it("a card with errors is not queueable even if it says ok", () => {
    const p = parseProposal(rawRecipient({ validation: { ok: true, errors: ["bad"], warnings: [] } }));
    expect(p?.validation.ok).toBe(false);
  });
  it("keeps urgent pause cards", () => {
    const p = parseProposal({ id: "p1", type: "PauseAgent", title: "Pause payroll", summary: "", urgent: true, call: { method: "pause_agent", args: { agent_id: "payroll" } }, validation });
    expect(p?.urgent).toBe(true);
  });
});

describe("proposalRows", () => {
  it("derives schedule rows from typed args", () => {
    const p = parseProposal(rawSchedule());
    const rows = proposalRows(p!, { recipient: (id) => `Maria (#${id})`, agent: (id) => id.toUpperCase() });
    expect(rows).toContainEqual({ label: "Recipient", to: "Maria (#5)" });
    expect(rows).toContainEqual({ label: "Amount", to: "1,500 USDC" });
    expect(rows).toContainEqual({ label: "Frequency", to: "Monthly on the 1st" });
    expect(rows).toContainEqual({ label: "Paid by", to: "PAYROLL" });
    expect(rows.find((r) => r.label === "Next payments")?.to).toBe("1 Dec · 1 Jan");
  });
});

const item = (id: string, over: Partial<BatchItem> = {}): BatchItem => ({ id, calls: [{ method: "pause", args: {} }], depends_on: [], recipientId: null, ...over });

describe("orderBatch", () => {
  it("puts dependencies first even if queued later", () => {
    const { ordered, problems } = orderBatch([item("p2", { depends_on: ["p1"] }), item("p1", { recipientId: 5 })]);
    expect(ordered.map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(problems).toEqual([]);
  });
  it("orders recipient creators by predicted id and checks them against the contract counter", () => {
    const a = item("a", { recipientId: 6 });
    const b = item("b", { recipientId: 5 });
    expect(orderBatch([a, b], new Set(), 5).ordered.map((i) => i.id)).toEqual(["b", "a"]);
    expect(orderBatch([a, b], new Set(), 5).problems).toEqual([]);
    expect(orderBatch([a], new Set(), 5).problems[0]).toMatch(/changed/);
  });
  it("reports a dependency that is not queued, accepts one already signed", () => {
    expect(orderBatch([item("p2", { depends_on: ["p1"], title: "Sched" })]).problems[0]).toMatch(/depends on p1/);
    expect(orderBatch([item("p2", { depends_on: ["p1"] })], new Set(["p1"])).problems).toEqual([]);
  });
  it("detects loops and flattens in order", () => {
    expect(orderBatch([item("a", { depends_on: ["b"] }), item("b", { depends_on: ["a"] })]).problems[0]).toMatch(/loop/);
    const two = item("x", { calls: [{ method: "add_recipient", args: {} }, { method: "add_schedule", args: {} }] });
    expect(flattenBatch([two, item("y")]).map((c) => c.method)).toEqual(["add_recipient", "add_schedule", "pause"]);
  });
  it("keeps queue order when nothing depends", () => {
    expect(orderBatch([item("c"), item("a"), item("b")]).ordered.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });
});
