import { describe, expect, it } from "vitest";
import { describeMandate, describeMandateShort, joinChains } from "./describeMandate";
import type { Mandate } from "./types";

const U = (n: number) => String(n * 1_000_000);
const base: Mandate = {
  daily_limit: U(200),
  per_tx_limit: U(50),
  approval_threshold: U(30),
  allowed_chains: ["base"],
  recipients_mode: "Open",
  allowlist: [],
  recipients: [],
  expires_at: null,
  max_payments_per_day: 10,
};
const names = new Map([
  [1, "Maria"],
  [2, "Alex"],
  [3, "Chen"],
  [4, "Dana"],
  [5, "Eli"],
]);

describe("joinChains", () => {
  it("handles one, two and many", () => {
    expect(joinChains(["base"])).toBe("Base");
    expect(joinChains(["base", "sol"])).toBe("Base and Solana");
    expect(joinChains(["base", "sol", "arb"])).toBe("Base, Solana and Arbitrum");
    expect(joinChains([])).toBe("no chains");
  });
});

describe("describeMandate long form", () => {
  it("Open, one chain", () => {
    expect(describeMandate(base)).toBe(
      "Can spend up to 200 USDC per day, 50 USDC per payment, on Base, to any address. Payments above 30 USDC need your approval. At most 10 payments per day.",
    );
  });
  it("Open, two chains, groups thousands", () => {
    const t = describeMandate({ ...base, allowed_chains: ["base", "sol"], daily_limit: U(2000) });
    expect(t).toContain("2,000 USDC per day");
    expect(t).toContain("on Base and Solana,");
  });
  it("Open, many chains", () => {
    expect(describeMandate({ ...base, allowed_chains: ["base", "sol", "arb", "eth"] })).toContain("on Base, Solana, Arbitrum and Ethereum,");
  });
  it("Allowlist", () => {
    const m: Mandate = { ...base, recipients_mode: "Allowlist", allowlist: [{ chain: "base", address: "0x1", label: null }, { chain: "base", address: "0x2", label: null }, { chain: "base", address: "0x3", label: null }] };
    expect(describeMandate(m)).toContain("only to 3 approved addresses.");
    expect(describeMandate({ ...m, allowlist: [m.allowlist[0]!] })).toContain("only to 1 approved address.");
  });
  it("Fixed lists the first two names and the rest as a count", () => {
    const m: Mandate = { ...base, recipients_mode: "Fixed", recipients: [1, 2, 3, 4, 5] };
    expect(describeMandate(m, names)).toContain("only to 5 fixed recipients (Maria, Alex, and 3 more) on their schedule.");
    expect(describeMandate({ ...m, recipients: [1, 2] }, names)).toContain("only to 2 fixed recipients (Maria, Alex) on their schedule.");
    expect(describeMandate({ ...m, recipients: [1] }, names)).toContain("only to 1 fixed recipient (Maria) on its schedule.");
    expect(describeMandate({ ...m, recipients: [9] }, names)).toContain("(#9)");
  });
  it("approval threshold edge cases", () => {
    expect(describeMandate({ ...base, approval_threshold: "0" })).toContain("Every payment needs your approval.");
    expect(describeMandate({ ...base, approval_threshold: U(50) })).toContain("No payment needs your approval.");
  });
  it("payments per day singular", () => {
    expect(describeMandate({ ...base, max_payments_per_day: 1 })).toContain("At most 1 payment per day.");
  });
  it("expiry", () => {
    const at = Date.UTC(2026, 11, 3);
    expect(describeMandate({ ...base, expires_at: String(at) }, names, at - 1000)).toMatch(/Expires on 2026-12-03\.$/);
    expect(describeMandate({ ...base, expires_at: String(at) }, names, at + 1000)).toMatch(/Expired on 2026-12-03\.$/);
  });
});

describe("describeMandateShort", () => {
  it("Open", () => {
    expect(describeMandateShort({ ...base, allowed_chains: ["base", "sol"] })).toBe("Any address on Base, Solana · up to 50 per payment");
    expect(describeMandateShort({ ...base, allowed_chains: ["base", "sol", "arb", "eth"] })).toBe("Any address on 4 chains · up to 50 per payment");
  });
  it("Fixed and Allowlist", () => {
    expect(describeMandateShort({ ...base, recipients_mode: "Fixed", recipients: [1, 2, 3, 4, 5] })).toBe("Pays 5 fixed recipients on schedule");
    const d = { chain: "base", address: "0x", label: null };
    expect(describeMandateShort({ ...base, recipients_mode: "Allowlist", allowlist: [d, d, d], per_tx_limit: U(100) })).toBe("3 approved addresses · up to 100 per payment");
  });
  it("stays short", () => {
    expect(describeMandateShort({ ...base, allowed_chains: ["base", "sol", "arb"] }).length).toBeLessThanOrEqual(70);
  });
});
