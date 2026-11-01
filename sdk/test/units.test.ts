import { describe, expect, it } from "vitest";
import { formatUsdc, parseUsdc, rescale } from "../src/units.js";

describe("USDC amounts", () => {
  it("parses decimals exactly", () => {
    expect(parseUsdc("50")).toBe(50_000_000n);
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("0.1")).toBe(100_000n);
    expect(parseUsdc(" 7.250000 ")).toBe(7_250_000n);
    expect(parseUsdc("340282366920938463463374607431768.211455")).toBe(2n ** 128n - 1n);
  });

  it("is exact where floats are not", () => {
    expect(parseUsdc("0.3")).toBe(300_000n);
    expect(parseUsdc("1.1") + parseUsdc("2.2")).toBe(parseUsdc("3.3"));
    expect(parseUsdc("9007199254740993")).toBe(9007199254740993_000000n);
  });

  it.each(["", "0", "0.0", "-1", "+1", "1e3", "1.0000001", ".5", "1.", "1,5", "abc", "0x10", "1 2", "NaN"])("rejects %j", (s) => {
    expect(() => parseUsdc(s)).toThrow();
  });

  it("rejects values above u128", () => {
    expect(() => parseUsdc("340282366920938463463374607431768.211456")).toThrow(/too large/);
  });

  it("formats without trailing zeros", () => {
    expect(formatUsdc(50_000_000n)).toBe("50");
    expect(formatUsdc(12_500_000n)).toBe("12.5");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(-1_500_000n)).toBe("-1.5");
  });

  it("round-trips", () => {
    for (const s of ["1", "0.000001", "123456.789", "99.99"]) expect(formatUsdc(parseUsdc(s))).toBe(s);
  });

  it("rescales between decimals", () => {
    expect(rescale(1_000_000n, 6, 18)).toBe(10n ** 18n);
    expect(rescale(10n ** 18n, 18, 6)).toBe(1_000_000n);
    expect(rescale(5n, 6, 6)).toBe(5n);
  });
});
