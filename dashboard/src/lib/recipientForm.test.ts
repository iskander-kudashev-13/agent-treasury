import { describe, expect, it } from "vitest";
import { findUsdcAsset, parseTokens } from "./oneclickTokens";
import { validateRecipientDraft } from "./recipientForm";

const EVM = "0xAbCDEF0123456789abcdef0123456789ABCDEF01";
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("validateRecipientDraft", () => {
  it("lowercases EVM addresses", () => {
    const r = validateRecipientDraft({ label: "Maria", chain: "base", address: EVM });
    expect(r.errors).toEqual({});
    expect(r.address).toBe(EVM.toLowerCase());
  });
  it("rejects bad EVM and accepts base58 for sol only", () => {
    expect(validateRecipientDraft({ label: "M", chain: "base", address: "0x123" }).errors.address).toMatch(/0x/);
    expect(validateRecipientDraft({ label: "M", chain: "sol", address: EVM }).errors.address).toMatch(/Solana/);
    expect(validateRecipientDraft({ label: "M", chain: "base", address: SOL }).errors.address).toBeDefined();
    expect(validateRecipientDraft({ label: "M", chain: "sol", address: SOL })).toEqual({ errors: {}, address: SOL });
  });
  it("explains Tron", () => {
    expect(validateRecipientDraft({ label: "M", chain: "tron", address: "TXyz" }).errors.chain).toMatch(/only USDT exists on Tron/);
  });
  it("requires a name and detects duplicates", () => {
    expect(validateRecipientDraft({ label: " ", chain: "base", address: EVM }).errors.label).toBeDefined();
    const dup = validateRecipientDraft({ label: "X", chain: "base", address: EVM }, [{ id: 1, label: "Maria", destination_chain: "base", destination_address: EVM.toLowerCase() }]);
    expect(dup.errors.address).toMatch(/Maria/);
    expect(validateRecipientDraft({ label: "X", chain: "base", address: EVM }, [{ id: 1, label: "Maria", destination_chain: "base", destination_address: EVM.toLowerCase() }], 1).errors).toEqual({});
  });
});

describe("1Click tokens", () => {
  const tokens = parseTokens([
    { assetId: "nep141:base-0xabc.omft.near", blockchain: "base", symbol: "USDC", decimals: 6 },
    { assetId: "nep141:tron-usdt.omft.near", blockchain: "tron", symbol: "USDT", decimals: 6 },
    { nope: true },
  ]);
  it("resolves USDC per chain and nothing for Tron", () => {
    expect(tokens).toHaveLength(2);
    expect(findUsdcAsset(tokens, "base")).toBe("nep141:base-0xabc.omft.near");
    expect(findUsdcAsset(tokens, "tron")).toBeNull();
  });
});
