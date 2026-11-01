import { describe, expect, it } from "vitest";
import { previewMandate } from "../src/mandate.js";
import { budget, EVM, NOW } from "./fakes.js";

const req = (over: Partial<{ chain: string; address: string; amount: bigint }> = {}) => ({
  chain: "base",
  address: EVM,
  amount: 10_000_000n,
  nowMs: NOW,
  ...over,
});
const reason = (b: ReturnType<typeof budget>, r = req()) => previewMandate(b, r).wouldReject?.reason;

describe("mandate preview (AGENT_ACCESS 3.4 order)", () => {
  it("passes a normal request", () => {
    expect(previewMandate(budget(), req())).toEqual({ needsApproval: false });
  });

  it("flags needs_approval strictly above the threshold", () => {
    expect(previewMandate(budget({ per_tx_limit: "500000000" }), req({ amount: 100_000_000n })).needsApproval).toBe(false);
    expect(previewMandate(budget({ per_tx_limit: "500000000" }), req({ amount: 100_000_001n })).needsApproval).toBe(true);
  });

  it("returns the FIRST failing reason when several apply", () => {
    // Every check fails at once; peel them off one by one in spec order.
    const worst = budget({
      vault_paused: true,
      status: "Paused",
      expires_at: String(NOW - 1),
      allowed_chains: ["near"],
      per_tx_limit: "1",
      remaining_today: "1",
      vault_remaining_today: "1",
      balance: "1",
    });
    const order: string[] = [];
    const b = { ...worst };
    order.push(reason(b) ?? "");
    b.vault_paused = false;
    order.push(reason(b) ?? "");
    b.status = "Active";
    order.push(reason(b) ?? "");
    b.expires_at = null;
    order.push(reason(b) ?? "");
    b.allowed_chains = ["base"];
    order.push(reason(b) ?? "");
    b.per_tx_limit = "999999999";
    order.push(reason(b) ?? "");
    b.remaining_today = "999999999";
    order.push(reason(b) ?? "");
    b.vault_remaining_today = "999999999";
    order.push(reason(b) ?? "");
    b.balance = "999999999";
    order.push(reason(b) ?? "none");
    expect(order).toEqual([
      "VAULT_PAUSED",
      "AGENT_PAUSED",
      "AGENT_EXPIRED",
      "CHAIN_NOT_ALLOWED",
      "PER_TX_LIMIT_EXCEEDED",
      "AGENT_DAILY_LIMIT_EXCEEDED",
      "VAULT_DAILY_LIMIT_EXCEEDED",
      "INSUFFICIENT_BALANCE",
      "none",
    ]);
  });

  it("BELOW_MIN_PAYMENT comes before PER_TX; AGENT_DAILY_COUNT_EXCEEDED after the daily amount, before the vault limit", () => {
    expect(reason(budget({ min_payment: "20000000", per_tx_limit: "1" }))).toBe("BELOW_MIN_PAYMENT");
    expect(reason(budget({ payments_today: 10, remaining_today: "1" }))).toBe("AGENT_DAILY_LIMIT_EXCEEDED");
    expect(reason(budget({ payments_today: 10, vault_remaining_today: "1" }))).toBe("AGENT_DAILY_COUNT_EXCEEDED");
    expect(reason(budget({ payments_today: 9 }))).toBeUndefined();
    expect(reason(budget({ min_payment: "10000000" }))).toBeUndefined();
  });

  it("revoked agent", () => {
    expect(reason(budget({ status: "Revoked" }))).toBe("AGENT_REVOKED");
  });

  it("boundaries are inclusive for limits", () => {
    expect(reason(budget({ per_tx_limit: "10000000" }))).toBeUndefined();
    expect(reason(budget({ per_tx_limit: "9999999" }))).toBe("PER_TX_LIMIT_EXCEEDED");
    expect(reason(budget({ remaining_today: "10000000" }))).toBeUndefined();
    expect(reason(budget({ remaining_today: "9999999" }))).toBe("AGENT_DAILY_LIMIT_EXCEEDED");
    expect(reason(budget({ expires_at: String(NOW) }))).toBeUndefined();
  });

  it("allowlist mode matches chain + address (EVM case-insensitive)", () => {
    const b = budget({ recipients_mode: "Allowlist", allowlist: [{ chain: "base", address: EVM.toUpperCase().replace("0X", "0x"), label: null }] });
    expect(reason(b)).toBeUndefined();
    expect(reason(b, req({ address: "0x2222222222222222222222222222222222222222" }))).toBe("RECIPIENT_NOT_ALLOWED");
    expect(reason(b, req({ chain: "sol", address: EVM }))).toBe("RECIPIENT_NOT_ALLOWED");
  });

  it("matches mandate chain aliases against 1Click ids", () => {
    expect(reason(budget({ allowed_chains: ["solana"] }), req({ chain: "sol", address: "So11111111111111111111111111111111111111112" }))).toBeUndefined();
  });

  it("Fixed mandates cannot make free-form payments", () => {
    expect(reason(budget({ recipients_mode: "Fixed" }))).toBe("RECIPIENT_NOT_ALLOWED");
    expect(previewMandate(budget({ recipients_mode: "Fixed" }), req()).wouldReject?.detail).toMatch(/Fixed agents only pay their scheduled payments/);
  });
});
