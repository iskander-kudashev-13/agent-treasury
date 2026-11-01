import { describe, expect, it } from "vitest";
import { buildDepositTx, checkAmount, DEFAULT_STORAGE_MIN_YOCTO, formatNear, isRegistered, parseNear } from "./vaultFunds";

describe("checkAmount", () => {
  it("empty is neither value nor error", () => expect(checkAmount("  ", "100")).toEqual({ raw: null, error: null }));
  it("parses to raw units", () => expect(checkAmount("1.5", "2000000")).toEqual({ raw: "1500000", error: null }));
  it("rejects zero, too many decimals and over-max", () => {
    expect(checkAmount("0", null).error).toMatch(/greater than zero/);
    expect(checkAmount("1.1234567", null).error).toMatch(/decimal/);
    expect(checkAmount("3", "2000000", "vault balance").error).toBe("Amount exceeds the vault balance");
    expect(checkAmount("abc", null).error).toMatch(/Invalid/);
  });
});

describe("buildDepositTx", () => {
  it("ft_transfer_call to the vault with empty msg and 1 yocto", () => {
    const tx = buildDepositTx({ usdcId: "usdc.testnet", vaultId: "vault.testnet", amount: "5000000" });
    expect(tx.receiverId).toBe("usdc.testnet");
    expect(tx.actions).toEqual([{ type: "FunctionCall", method: "ft_transfer_call", args: { receiver_id: "vault.testnet", amount: "5000000", msg: "" }, deposit: "1", gas: "100000000000000" }]);
  });
  it("registers the vault first in the same transaction when needed", () => {
    const tx = buildDepositTx({ usdcId: "u", vaultId: "v", amount: "1", registerVaultYocto: DEFAULT_STORAGE_MIN_YOCTO });
    expect(tx.actions.map((a) => (a as { method: string }).method)).toEqual(["storage_deposit", "ft_transfer_call"]);
    expect(tx.actions[0]).toMatchObject({ args: { account_id: "v", registration_only: true }, deposit: DEFAULT_STORAGE_MIN_YOCTO });
    const gas = tx.actions.reduce((s, a) => s + BigInt(a.gas), 0n);
    expect(gas <= 300n * 10n ** 12n).toBe(true);
  });
});

describe("near amounts", () => {
  it("round trip", () => {
    expect(parseNear("0.00125")).toBe(DEFAULT_STORAGE_MIN_YOCTO);
    expect(formatNear(DEFAULT_STORAGE_MIN_YOCTO)).toBe("0.00125");
    expect(formatNear("2000000000000000000000000")).toBe("2");
    expect(() => parseNear("-1")).toThrow();
  });
  it("registration", () => {
    expect(isRegistered(null)).toBe(false);
    expect(isRegistered({ total: "1" })).toBe(true);
  });
});
