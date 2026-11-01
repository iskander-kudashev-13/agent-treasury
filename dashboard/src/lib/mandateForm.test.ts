import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, diffMandate, mandateToForm, validateMandateForm, type MandateForm } from "./mandateForm";

const NOW = Date.UTC(2026, 10, 1, 12);
const ctx = { knownRecipients: new Set([1, 2]), nowMs: NOW };
const form = (p: Partial<MandateForm> = {}): MandateForm => ({ ...DEFAULT_FORM, ...p });
const EVM = "0xAbCdEf0123456789aBcDeF0123456789abCDef01";

describe("validateMandateForm", () => {
  it("accepts the defaults and builds a contract mandate", () => {
    const r = validateMandateForm(form(), ctx);
    expect(r.errors).toEqual({});
    expect(r.mandate).toEqual({
      daily_limit: "200000000",
      per_tx_limit: "50000000",
      approval_threshold: "30000000",
      allowed_chains: ["base"],
      recipients_mode: "Open",
      allowlist: [],
      recipients: [],
      expires_at: null,
      max_payments_per_day: 10,
    });
    expect(r.warnings.join(" ")).toMatch(/pay anyone/);
  });
  it("per tx must not exceed daily", () => {
    expect(validateMandateForm(form({ perTx: "300" }), ctx).errors.perTx).toMatch(/higher than the daily/);
  });
  it("requires positive amounts and parses decimals", () => {
    expect(validateMandateForm(form({ daily: "" }), ctx).errors.daily).toBeTruthy();
    expect(validateMandateForm(form({ daily: "0" }), ctx).errors.daily).toBeTruthy();
    expect(validateMandateForm(form({ daily: "abc" }), ctx).errors.daily).toBeTruthy();
    expect(validateMandateForm(form({ daily: "1.1234567" }), ctx).errors.daily).toMatch(/6 decimal/);
    expect(validateMandateForm(form({ daily: "1 000.5", perTx: "10" }), ctx).mandate?.daily_limit).toBe("1000500000");
  });
  it("warns (does not block) when the threshold is above per tx", () => {
    const r = validateMandateForm(form({ threshold: "80" }), ctx);
    expect(r.mandate).not.toBeNull();
    expect(r.warnings.join(" ")).toMatch(/ever wait/);
  });
  it("needs at least one known chain id", () => {
    expect(validateMandateForm(form({ chains: [] }), ctx).errors.chains).toMatch(/at least one/);
    expect(validateMandateForm(form({ chains: ["solana"] }), ctx).errors.chains).toMatch(/Unknown chain/);
  });
  it("max payments per day >= 1 and integer", () => {
    expect(validateMandateForm(form({ maxPerDay: "0" }), ctx).errors.maxPerDay).toMatch(/at least 1/);
    expect(validateMandateForm(form({ maxPerDay: "2.5" }), ctx).errors.maxPerDay).toBeTruthy();
    expect(validateMandateForm(form({ maxPerDay: "" }), ctx).errors.maxPerDay).toBeTruthy();
  });
  it("Fixed needs known recipients", () => {
    expect(validateMandateForm(form({ mode: "Fixed" }), ctx).errors.recipients).toMatch(/at least one/);
    expect(validateMandateForm(form({ mode: "Fixed", recipients: [9] }), ctx).errors.recipients).toMatch(/doesn't exist/);
    expect(validateMandateForm(form({ mode: "Fixed", recipients: [1, 2, 1] }), ctx).mandate?.recipients).toEqual([1, 2]);
  });
  it("Allowlist needs entries, lowercases EVM addresses, rejects bad ones and duplicates", () => {
    expect(validateMandateForm(form({ mode: "Allowlist" }), ctx).errors.allowlist).toMatch(/at least one/);
    const ok = validateMandateForm(form({ mode: "Allowlist", allowlist: [{ chain: "base", address: EVM, label: " Acme " }] }), ctx);
    expect(ok.mandate?.allowlist).toEqual([{ chain: "base", address: EVM.toLowerCase(), label: "Acme" }]);
    const bad = validateMandateForm(form({ mode: "Allowlist", allowlist: [{ chain: "base", address: "0x123", label: "" }, { chain: "base", address: EVM, label: "" }, { chain: "base", address: EVM.toLowerCase(), label: "" }] }), ctx);
    expect(bad.errors.rows?.[0]).toMatch(/Invalid EVM/);
    expect(bad.errors.rows?.[2]).toMatch(/Duplicate/);
    expect(bad.mandate).toBeNull();
  });
  it("expiry choices", () => {
    expect(validateMandateForm(form({ expiry: "7d" }), ctx).mandate?.expires_at).toBe(String(NOW + 7 * 86_400_000));
    expect(validateMandateForm(form({ expiry: "custom", customDate: "" }), ctx).errors.expiry).toBeTruthy();
    expect(validateMandateForm(form({ expiry: "custom", customDate: "2026-10-01" }), ctx).errors.expiry).toMatch(/future/);
    expect(validateMandateForm(form({ expiry: "custom", customDate: "2026-12-31" }), ctx).mandate?.expires_at).toBe(String(Date.UTC(2026, 11, 31, 23, 59, 59)));
  });
});

describe("mandateToForm + diffMandate", () => {
  it("round-trips an existing mandate unchanged", () => {
    const m = validateMandateForm(form({ expiry: "30d", chains: ["base", "sol"] }), ctx).mandate!;
    const back = validateMandateForm(mandateToForm(m), ctx).mandate!;
    expect(back).toEqual(m);
    expect(diffMandate(m, back)).toEqual([]);
  });
  it("describes changes", () => {
    const a = validateMandateForm(form(), ctx).mandate!;
    const b = validateMandateForm(form({ daily: "500", chains: ["base", "sol"], maxPerDay: "3" }), ctx).mandate!;
    expect(diffMandate(a, b)).toEqual(["Daily limit 200 → 500 USDC", "Payments per day 10 → 3", "Chains added: Solana"]);
  });
});
