import { describe, expect, it } from "vitest";
import { graceToDraft, policyToDraft, validatePolicy } from "./policyForm";

const ok = { daily: "3000", min: "1", graceValue: "3", graceUnit: "days" as const };
describe("validatePolicy", () => {
  it("builds raw units and ms", () => {
    expect(validatePolicy(ok).policy).toEqual({ daily_limit: "3000000000", min_payment: "1000000", overdue_grace_ms: "259200000" });
  });
  it("min must be positive and not exceed daily", () => {
    expect(validatePolicy({ ...ok, min: "0" }).errors.min).toBeDefined();
    expect(validatePolicy({ ...ok, min: "4000" }).errors.min).toMatch(/exceed/);
  });
  it("grace bounds are 1 h .. 30 d", () => {
    expect(validatePolicy({ ...ok, graceValue: "0.5", graceUnit: "hours" }).errors.grace).toBeDefined();
    expect(validatePolicy({ ...ok, graceValue: "1", graceUnit: "hours" }).policy).not.toBeNull();
    expect(validatePolicy({ ...ok, graceValue: "30", graceUnit: "days" }).policy).not.toBeNull();
    expect(validatePolicy({ ...ok, graceValue: "31", graceUnit: "days" }).errors.grace).toBeDefined();
    expect(validatePolicy({ ...ok, graceValue: "", graceUnit: "days" }).errors.grace).toBeDefined();
  });
  it("round trips the stored policy", () => {
    expect(graceToDraft("259200000")).toEqual({ graceValue: "3", graceUnit: "days" });
    expect(graceToDraft("5400000")).toEqual({ graceValue: "1.5", graceUnit: "hours" });
    const d = policyToDraft({ daily_limit: "3000000000", min_payment: "1000000", overdue_grace_ms: "259200000" });
    expect(validatePolicy(d).policy?.daily_limit).toBe("3000000000");
  });
});
