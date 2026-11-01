import { describe, expect, it } from "vitest";
import { checkMandateCompat } from "./mandateCompat";
import type { AgentView, Mandate } from "./types";

const U = (n: number) => String(n * 1_000_000);
const mandate = (o: Partial<Mandate> = {}): Mandate => ({
  daily_limit: U(5000), per_tx_limit: U(1000), approval_threshold: U(800), allowed_chains: ["base"], recipients_mode: "Fixed",
  allowlist: [], recipients: [1], expires_at: null, max_payments_per_day: 10, ...o,
});
const agent = (m: Mandate, status: AgentView["status"] = "Active"): AgentView => ({
  id: "payroll", name: "Payroll", kind: "Tee", account_id: null, public_key: null, account_pinned: false, mandate: m, status, spent_today: "0", day_index: "0",
  created_at: "0", last_request_at: null, failed_transfers: 0, open_approvals: 0, tee: null,
});
const rcp = { id: 1, chain: "base", address: "0xabc" };

describe("checkMandateCompat", () => {
  it("passes a compatible schedule", () => {
    expect(checkMandateCompat({ agent: agent(mandate()), recipient: rcp, amount: U(500) })).toEqual({ errors: [], warnings: [] });
  });
  it("Fixed: recipient not in mandate (red, with action)", () => {
    const r = checkMandateCompat({ agent: agent(mandate()), recipient: { ...rcp, id: 2 }, amount: U(500) });
    expect(r.errors[0]).toMatchObject({ message: "payroll can't pay this recipient (not in its mandate)", action: "Edit payroll's mandate" });
  });
  it("Allowlist and Open modes", () => {
    const al = mandate({ recipients_mode: "Allowlist", allowlist: [{ chain: "base", address: "0xabc", label: null }] });
    expect(checkMandateCompat({ agent: agent(al), recipient: rcp, amount: U(1) }).errors).toEqual([]);
    expect(checkMandateCompat({ agent: agent(al), recipient: { ...rcp, address: "0xdef" }, amount: U(1) }).errors).toHaveLength(1);
    expect(checkMandateCompat({ agent: agent(mandate({ recipients_mode: "Open" })), recipient: { id: null, chain: "base", address: "x" }, amount: U(1) }).errors).toEqual([]);
  });
  it("chain not allowed", () => {
    const r = checkMandateCompat({ agent: agent(mandate({ recipients_mode: "Open" })), recipient: { ...rcp, chain: "sol" }, amount: U(1) });
    expect(r.errors.map((e) => e.code)).toEqual(["CHAIN_NOT_ALLOWED"]);
  });
  it("per-payment limit (red) vs approval threshold (amber)", () => {
    const over = checkMandateCompat({ agent: agent(mandate()), recipient: rcp, amount: U(1500) });
    expect(over.errors.map((e) => e.message)).toContain("Amount exceeds payroll's per-payment limit (1,000)");
    const amber = checkMandateCompat({ agent: agent(mandate()), recipient: rcp, amount: U(900) });
    expect(amber.errors).toEqual([]);
    expect(amber.warnings[0]?.message).toBe("Above payroll's approval threshold (800): each payment will wait for your approval.");
  });
  it("threshold copy uses grouping", () => {
    const m = mandate({ approval_threshold: U(1000), per_tx_limit: U(5000) });
    expect(checkMandateCompat({ agent: agent(m), recipient: rcp, amount: U(1500) }).warnings[0]?.message).toContain("(1,000)");
  });
  it("min payment, revoked and missing agent", () => {
    expect(checkMandateCompat({ agent: agent(mandate()), recipient: rcp, amount: "1", minPayment: U(1) }).errors.map((e) => e.code)).toContain("BELOW_MIN_PAYMENT");
    expect(checkMandateCompat({ agent: agent(mandate(), "Revoked"), recipient: rcp, amount: U(1) }).errors[0]?.code).toBe("AGENT_UNAVAILABLE");
    expect(checkMandateCompat({ agent: undefined, recipient: rcp, amount: U(1) }).errors).toHaveLength(1);
  });
});
