import { describe, expect, it } from "vitest";
import { buildTimeline, destinationTxUrl, filterPayouts, intentsTrackUrl, NO_FILTER, timelineSummary } from "./payoutView";
import type { AgentView, Payout } from "./types";

const base: Payout = {
  id: "42",
  agent_id: "payroll",
  agent_account: "agent.testnet",
  schedule_id: null,
  occurrence_at: null,
  approval_reason: null,
  recipient_id: 1,
  chain: "base",
  address: "0x71C0000000000000000000000000000000a3E9",
  amount: "1200000000",
  memo: "Logo <b>invoice</b>",
  status: "Confirmed",
  deposit_address: "d".repeat(64),
  deposit_expires_at_ms: null,
  tx_hash: "0xa1b2c3d4e5f6a7b8",
  created_at_ms: "1000",
  updated_at_ms: "2000",
  funds_left: true,
  refund_credited: false,
};
const p = (o: Partial<Payout>): Payout => ({ ...base, ...o });
const states = (x: Payout) => buildTimeline(x, undefined).map((s) => s.state);

describe("filterPayouts", () => {
  const list = [p({ id: "1" }), p({ id: "2", status: "PendingApproval", schedule_id: 3, agent_id: "ops" }), p({ id: "3", status: "Sent" }), p({ id: "4", status: "Transferring", agent_id: "ops" })];
  it("no filter keeps all", () => expect(filterPayouts(list, NO_FILTER)).toHaveLength(4));
  it("status groups", () => {
    expect(filterPayouts(list, { ...NO_FILTER, status: "in_progress" }).map((x) => x.id)).toEqual(["3", "4"]);
    expect(filterPayouts(list, { ...NO_FILTER, status: "needs_approval" }).map((x) => x.id)).toEqual(["2"]);
  });
  it("agent and source combine", () => {
    expect(filterPayouts(list, { status: "all", agent: "ops", source: "on-demand" }).map((x) => x.id)).toEqual(["4"]);
    expect(filterPayouts(list, { ...NO_FILTER, source: "scheduled" }).map((x) => x.id)).toEqual(["2"]);
  });
});

describe("links", () => {
  it("destination explorers", () => {
    expect(destinationTxUrl("base", "0xab")).toBe("https://basescan.org/tx/0xab");
    expect(destinationTxUrl("Solana", "S1")).toBe("https://solscan.io/tx/S1");
    expect(destinationTxUrl("btc", "x")).toBeNull();
    expect(intentsTrackUrl("abc")).toBe("https://explorer.near-intents.org/transactions/abc");
  });
});

describe("buildTimeline", () => {
  it("confirmed: every step done, destination link, memo kept as text", () => {
    const t = buildTimeline(base, { name: "Payroll", kind: "Tee" } as AgentView);
    expect(t.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(t[0]?.title).toBe("Requested by Payroll (TEE agent)");
    expect(t[0]?.lines).toContain("Memo: Logo <b>invoice</b>");
    expect(t[4]?.links.map((l) => l.href)).toContain("https://basescan.org/tx/0xa1b2c3d4e5f6a7b8");
    expect(timelineSummary(t, "Confirmed").text).toBe("Money arrived");
  });
  it("pending approval: waiting at step 2, rest todo", () => {
    const x = p({ status: "PendingApproval", approval_reason: "OVERDUE_NEEDS_APPROVAL", tx_hash: null });
    expect(states(x)).toEqual(["done", "active", "todo", "todo", "todo"]);
    expect(buildTimeline(x, undefined)[1]?.lines[0]).toMatch(/Overdue/);
    expect(timelineSummary(buildTimeline(x, undefined), "PendingApproval").text).toBe("In progress · step 2 of 5");
  });
  it("transferring and sent", () => {
    expect(states(p({ status: "Transferring" }))).toEqual(["done", "done", "active", "todo", "todo"]);
    expect(states(p({ status: "Sent" }))).toEqual(["done", "done", "done", "done", "active"]);
  });
  it("approved payouts say so", () => {
    expect(buildTimeline(p({ approval_reason: "ABOVE_THRESHOLD" }), undefined)[1]?.title).toBe("Approved by owner");
  });
  it("rejected stops at step 2", () => expect(states(p({ status: "Rejected" }))).toEqual(["done", "failed", "todo", "todo", "todo"]));
  it("refunded and failed variants", () => {
    expect(states(p({ status: "Refunded" }))).toEqual(["done", "done", "done", "done", "failed"]);
    expect(states(p({ status: "Failed", funds_left: false }))).toEqual(["done", "done", "failed", "todo", "todo"]);
    expect(states(p({ status: "Failed", funds_left: true }))).toEqual(["done", "done", "done", "done", "failed"]);
  });
  it("unknown chain without explorer shows the hash as text", () => {
    const t = buildTimeline(p({ chain: "btc" }), undefined);
    expect(t[4]?.lines.some((l) => l.startsWith("Tx "))).toBe(true);
  });
});

describe("buildTimeline with simulated 1Click", () => {
  it("has no Intents or destination links and says it was simulated", () => {
    const x = p({ status: "Confirmed", deposit_address: "f7d3c4", tx_hash: "simulated-c7adfe26" });
    const final = buildTimeline(x, undefined, { simulated: true })[4];
    expect(final?.links).toEqual([]);
    expect(final?.lines.join(" ")).toMatch(/Simulated 1Click/);
    expect(final?.state).toBe("done");
  });
});

describe("buildTimeline: agent-reported simulated- hash outside simulated mode", () => {
  it("keeps the Intents and destination links (a mainnet agent cannot hide them)", () => {
    const x = p({ status: "Confirmed", chain: "base", deposit_address: "f7d3c4", tx_hash: "simulated-x" });
    const final = buildTimeline(x, undefined, { simulated: false })[4];
    expect(final?.links.some((l) => l.label === "Track on Intents explorer")).toBe(true);
    expect(final?.lines.join(" ")).not.toMatch(/Simulated 1Click/);
  });
});
