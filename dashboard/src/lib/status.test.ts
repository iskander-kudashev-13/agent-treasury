import { describe, expect, it } from "vitest";
import { canCreditRefund, isBlockedRecipient, isStuckTransfer, isDepositExpired, payoutStatusInfo } from "./status";

describe("payoutStatusInfo", () => {
  it("maps every contract status", () => {
    const all = ["PendingApproval", "Rejected", "Transferring", "Sent", "Confirmed", "Failed", "Refunded"];
    for (const s of all) expect(payoutStatusInfo(s).label).not.toBe("");
    expect(payoutStatusInfo("Confirmed")).toMatchObject({ tone: "green", terminal: true });
    expect(payoutStatusInfo("PendingApproval")).toMatchObject({ tone: "yellow", terminal: false });
    expect(payoutStatusInfo("Failed").tone).toBe("red");
  });
  it("falls back for unknown statuses", () => {
    expect(payoutStatusInfo("Weird")).toMatchObject({ label: "Weird", tone: "gray" });
  });
  it("credit_refund eligibility", () => {
    expect(canCreditRefund({ status: "Refunded" })).toBe(true);
    expect(canCreditRefund({ status: "Failed", funds_left: true })).toBe(true);
    expect(canCreditRefund({ status: "Failed", funds_left: false })).toBe(false);
    expect(canCreditRefund({ status: "Refunded", refund_credited: true })).toBe(false);
    expect(canCreditRefund({ status: "Confirmed", funds_left: true })).toBe(false);
  });
  it("stuck transfers and blocked recipients", () => {
    const now = 10_000_000_000;
    expect(isStuckTransfer({ status: "Transferring", updated_at_ms: String(now - 3_600_001) }, now)).toBe(true);
    expect(isStuckTransfer({ status: "Transferring", updated_at_ms: String(now - 1000) }, now)).toBe(false);
    expect(isStuckTransfer({ status: "Sent", updated_at_ms: "0" }, now)).toBe(false);
    expect(isBlockedRecipient(3)).toBe(true);
    expect(isBlockedRecipient(2)).toBe(false);
    expect(isBlockedRecipient(undefined)).toBe(false);
  });
});

describe("isDepositExpired", () => {
  it("compares against now", () => {
    expect(isDepositExpired("100", 200)).toBe(true);
    expect(isDepositExpired("300", 200)).toBe(false);
    expect(isDepositExpired(null, 200)).toBe(false);
  });
});

