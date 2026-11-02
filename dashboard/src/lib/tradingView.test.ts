import { describe, expect, it } from "vitest";
import { apiWalletName, buildTraderSetup, fmtDec, fmtSigned, hlAppUrl, pnlAccent, ratio, reasonText } from "./tradingView";

const NOW = 1_800_000_000_000;
const HL = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

describe("buildTraderSetup", () => {
  it("builds the ADR-0005 mandate", () => {
    const r = buildTraderSetup({ master: HL, daily: "50", perTx: "25" }, NOW);
    expect(r.errors).toEqual({});
    expect(r.master).toBe(HL.toLowerCase());
    expect(r.mandate).toEqual({
      daily_limit: "50000000",
      per_tx_limit: "25000000",
      approval_threshold: "25000000",
      allowed_chains: ["hypercore"],
      recipients_mode: "Allowlist",
      allowlist: [{ chain: "hypercore", address: HL.toLowerCase(), label: "Owner HL" }],
      recipients: [],
      expires_at: String(NOW + 30 * 86_400_000),
      max_payments_per_day: 2,
    });
  });
  it("reports field errors and no mandate", () => {
    expect(buildTraderSetup({ master: "", daily: "50", perTx: "25" }, NOW).errors.master).toBeDefined();
    expect(buildTraderSetup({ master: "0x12", daily: "50", perTx: "25" }, NOW).errors.master).toMatch(/EVM/);
    expect(buildTraderSetup({ master: HL, daily: "20", perTx: "25" }, NOW).errors.perTx).toMatch(/daily/i);
    expect(buildTraderSetup({ master: HL, daily: "50", perTx: "1" }, NOW).errors.perTx).toMatch(/minimum/);
    expect(buildTraderSetup({ master: HL, daily: "x", perTx: "25" }, NOW).errors.daily).toBeDefined();
    expect(buildTraderSetup({ master: HL, daily: "50", perTx: "1" }, NOW).mandate).toBeNull();
  });
});

describe("number helpers", () => {
  it("formats decimal strings without float drift", () => {
    expect(fmtDec("12.345")).toBe("12.35");
    expect(fmtDec("1234567.891")).toBe("1,234,567.89");
    expect(fmtDec("-0.004")).toBe("0.00");
    expect(fmtDec("-3.5")).toBe("-3.50");
    expect(fmtDec("7", 0)).toBe("7");
    expect(fmtDec("abc")).toBe("abc");
  });
  it("signs and colors P&L", () => {
    expect(fmtSigned("1.5")).toBe("+1.50");
    expect(fmtSigned("-1.5")).toBe("-1.50");
    expect(fmtSigned("0")).toBe("0.00");
    expect(pnlAccent("-1")).toBe("danger");
    expect(pnlAccent("2")).toBe("ok");
    expect(pnlAccent("0")).toBe("neutral");
  });
  it("ratio is safe", () => {
    expect(ratio("5", "10")).toBe(0.5);
    expect(ratio("5", "0")).toBe(0);
  });
});

describe("Hyperliquid helpers", () => {
  it("links the right app and names the API wallet with a 30 day expiry", () => {
    expect(hlAppUrl("mainnet")).toBe("https://app.hyperliquid.xyz/API");
    expect(hlAppUrl("testnet")).toBe("https://app.hyperliquid-testnet.xyz/API");
    expect(apiWalletName(NOW)).toBe(`agent-treasury valid_until ${NOW + 30 * 86_400_000}`);
  });
  it("explains known halt reasons", () => {
    expect(reasonText("PERP_POSITION_DETECTED", null)).toMatch(/spot only/);
    expect(reasonText(null, null)).toBeNull();
    expect(reasonText("OTHER", "x")).toBe("OTHER x");
  });
});
