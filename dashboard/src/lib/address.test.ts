import { describe, expect, it } from "vitest";
import { normalizeAddress } from "./address";

describe("normalizeAddress", () => {
  it("lowercases valid EVM addresses (mixed-case checksum would be rejected by 1Click)", () => {
    expect(normalizeAddress("base", "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });
  it("rejects malformed EVM addresses", () => {
    expect(() => normalizeAddress("base", "0x123")).toThrow();
    expect(() => normalizeAddress("arb", "abc")).toThrow();
    expect(() => normalizeAddress("eth", "0x" + "g".repeat(40))).toThrow();
  });
  it("validates sol base58 length", () => {
    expect(normalizeAddress("sol", "11111111111111111111111111111111")).toBe("11111111111111111111111111111111");
    expect(() => normalizeAddress("sol", "short")).toThrow();
    expect(() => normalizeAddress("sol", "0".repeat(40))).toThrow();
  });
  it("passes other chains through", () => {
    expect(normalizeAddress("tron", "TXyz")).toBe("TXyz");
  });
});
