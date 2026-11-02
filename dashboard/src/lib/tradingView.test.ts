import { describe, expect, it } from "vitest";
import type { AgentView } from "./types";
import { apiWalletName, buildTraderSetup, checkHlAccount, mainnetSetupCommands, trustedHlAccount, fmtDec, fmtSigned, hlAppUrl, pnlAccent, ratio, reasonText } from "./tradingView";

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
    expect(apiWalletName(NOW)).toBe(`agent-treasury valid_until ${NOW + 47 * 3_600_000}`);
  });
  it("explains known halt reasons", () => {
    expect(reasonText("PERP_POSITION_DETECTED", null)).toMatch(/spot only/);
    expect(reasonText(null, null)).toBeNull();
    expect(reasonText("OTHER", "x")).toBe("OTHER x");
  });
});

const trader = (allowlist: { chain: string; address: string; label: string | null }[], extra: Record<string, unknown> = {}): AgentView => ({ id: "hl-trader", status: "Active", mandate: { recipients_mode: "Allowlist", allowed_chains: ["hypercore"], allowlist, ...extra } }) as unknown as AgentView;

describe("checkHlAccount (audit M7)", () => {
  const t = trader([{ chain: "hypercore", address: HL.toLowerCase(), label: null }]);
  it("accepts the account in the on-chain allowlist, case-insensitively", () => {
    expect(checkHlAccount(HL, t)).toEqual({ kind: "ok", account: HL.toLowerCase() });
    expect(trustedHlAccount(t)).toBe(HL.toLowerCase());
  });
  it("flags a different account reported by the worker", () => {
    const other = "0x" + "11".repeat(20);
    expect(checkHlAccount(other, t)).toEqual({ kind: "mismatch", reported: other, onchain: HL.toLowerCase() });
  });
  it("cannot verify without an agent or with several HL addresses", () => {
    expect(checkHlAccount(HL, null).kind).toBe("unverified");
    expect(checkHlAccount(HL, trader([{ chain: "hypercore", address: HL, label: null }], { recipients_mode: "Open" })).kind).toBe("unverified");
    expect(checkHlAccount(HL, trader([{ chain: "hypercore", address: HL, label: null }], { allowed_chains: [] })).kind).toBe("unverified");
    expect(checkHlAccount(HL, trader([{ chain: "hypercore", address: HL, label: null }], { allowed_chains: ["hypercore", "base"] })).kind).toBe("unverified");
    expect(checkHlAccount(HL, trader([])).kind).toBe("unverified");
    expect(checkHlAccount(HL, trader([{ chain: "hypercore", address: "0x" + "22".repeat(20), label: null }, { chain: "hypercore", address: HL, label: null }])).kind).toBe("unverified");
  });
});

describe("mainnetSetupCommands (audit M6)", () => {
  const cmd = mainnetSetupCommands({ owner: "owner.near", vault: "vault.near", master: HL.toLowerCase(), name: "hl-trader", fundNear: "0.35" });
  it("uses the CLI with --confirm-mainnet and the session mandate", () => {
    expect(cmd).toContain("--confirm-mainnet");
    expect(cmd).toContain("--network mainnet");
    expect(cmd).toContain('"approval_threshold": "0"');
    expect(cmd).toContain('"daily_limit": "25000000"');
    expect(cmd).toContain('"per_tx_limit": "25000000"');
    expect(cmd).toContain('"max_payments_per_day": 1');
    expect(cmd).toContain(`"address": "${HL.toLowerCase()}"`);
    expect(cmd).toContain("169200000");
  });
  it("never contains a key", () => {
    expect(cmd).not.toContain("OWNER_PRIVATE_KEY=ed25519");
    expect(cmd).toContain("--dry-run");
    expect(cmd.indexOf("--dry-run")).toBeLessThan(cmd.indexOf("--confirm-mainnet"));
    expect(cmd).toContain("jq -r .private_key");
    expect(cmd).not.toContain("setup-key-agent -- ");
    expect(cmd).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
  });
});
