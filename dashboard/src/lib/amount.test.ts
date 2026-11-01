import { describe, expect, it } from "vitest";
import { formatUnits, formatUsdc, fraction, parseUsdc, percent, usdcGrouped } from "./amount";

describe("formatUsdc", () => {
  it("formats raw units with 6 decimals, trimming to 2", () => {
    expect(formatUsdc("1500000000")).toBe("1500.00");
    expect(formatUsdc("1")).toBe("0.000001");
    expect(formatUsdc("1234500")).toBe("1.2345");
    expect(formatUsdc("0")).toBe("0.00");
  });
  it("supports fixed 6 decimals", () => {
    expect(formatUsdc("1500000000", 6)).toBe("1500.000000");
  });
  it("handles values above 2^53 without precision loss", () => {
    expect(formatUsdc("9007199254740993000001")).toBe("9007199254740993.000001");
  });
  it("handles bigint and negatives", () => {
    expect(formatUnits(-1_500_000n)).toBe("-1.50");
  });
});

describe("parseUsdc", () => {
  it("parses decimals to raw units", () => {
    expect(parseUsdc("1500")).toBe("1500000000");
    expect(parseUsdc("0.000001")).toBe("1");
    expect(parseUsdc(" 12.5 ")).toBe("12500000");
    expect(parseUsdc("0.1")).toBe("100000");
  });
  it("rejects invalid input", () => {
    expect(() => parseUsdc("")).toThrow();
    expect(() => parseUsdc("-1")).toThrow();
    expect(() => parseUsdc("1e3")).toThrow();
    expect(() => parseUsdc("1.")).toThrow();
    expect(() => parseUsdc("0.0000001")).toThrow(/decimal/);
  });
  it("round-trips", () => {
    for (const raw of ["1", "999999", "1000000", "123456789012345678"]) {
      expect(parseUsdc(formatUsdc(raw, 6))).toBe(raw);
    }
  });
});

describe("percent", () => {
  it("is integer, clamped, and safe on zero total", () => {
    expect(percent("250000", "1000000")).toBe(25);
    expect(percent("2000000", "1000000")).toBe(100);
    expect(percent("1", "0")).toBe(0);
  });
});


describe("usdcGrouped", () => {
  it("groups thousands and keeps 2 decimals", () => {
    expect(usdcGrouped("12480500000")).toBe("12,480.50");
    expect(usdcGrouped("0")).toBe("0.00");
    expect(usdcGrouped("1234567000000")).toBe("1,234,567.00");
    expect(usdcGrouped("1")).toBe("0.000001");
  });
});
describe("fraction", () => {
  it("is spent over limit, 0 for no limit", () => {
    expect(fraction("1500000", "3000000")).toBe(0.5);
    expect(fraction("1", "0")).toBe(0);
    expect(fraction("4000000", "3000000")).toBeGreaterThan(1);
  });
});
