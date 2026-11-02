import { describe, expect, it } from "vitest";
import {
  FormatError,
  addDec,
  bandPrice,
  buildCloid,
  cloidMatchesRules,
  cmpDec,
  formatPrice,
  formatSize,
  isValidPrice,
  mulDec,
  normalizeDec,
  parseCloid,
  subDec,
  tryFormatSize,
  withinBand,
} from "../../src/trading/hl/format.js";

const HASH = "ab12cd34ef56a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182930";

describe("formatSize (always rounds down)", () => {
  it("truncates to szDecimals and strips trailing zeros", () => {
    expect(formatSize("1.239", 2)).toBe("1.23");
    expect(formatSize("1.999999", 2)).toBe("1.99");
    expect(formatSize("5", 2)).toBe("5");
    expect(formatSize("5.10", 2)).toBe("5.1");
    expect(formatSize("0.01", 2)).toBe("0.01");
    expect(formatSize("12.5", 0)).toBe("12");
  });
  it("throws when the size rounds to zero, tryFormatSize returns null", () => {
    expect(() => formatSize("0.009", 2)).toThrow(FormatError);
    expect(() => formatSize("0", 2)).toThrow(FormatError);
    expect(tryFormatSize("0.009", 2)).toBeNull();
    expect(tryFormatSize("0.019", 2)).toBe("0.01");
  });
  it("rejects malformed input", () => {
    for (const bad of ["", "-1", "1e3", "1,5", " 1", "0x10", "1."]) expect(() => formatSize(bad, 2)).toThrow(FormatError);
    expect(() => formatSize("1", -1)).toThrow(FormatError);
    expect(() => formatSize("1", 1.5)).toThrow(FormatError);
  });
});

describe("formatPrice (5 significant figures, <= 8 - szDecimals decimals)", () => {
  it("limits to 5 significant figures, direction decides the side", () => {
    expect(formatPrice("83.97951", 2, "down")).toBe("83.979");
    expect(formatPrice("83.97951", 2, "up")).toBe("83.98");
    expect(formatPrice("1.234567", 2, "down")).toBe("1.2345");
    expect(formatPrice("1.234567", 2, "up")).toBe("1.2346");
    expect(formatPrice("0.123456789", 2, "down")).toBe("0.12345");
    expect(formatPrice("0.123456789", 2, "up")).toBe("0.12346");
  });
  it("leaves already valid prices unchanged and strips trailing zeros", () => {
    expect(formatPrice("83.979", 2, "down")).toBe("83.979");
    expect(formatPrice("83.500", 2, "up")).toBe("83.5");
    expect(formatPrice("100", 2, "up")).toBe("100");
    expect(formatPrice("100.000", 2, "down")).toBe("100");
  });
  it("caps decimals at 8 - szDecimals for small prices", () => {
    expect(formatPrice("0.00004205", 0, "down")).toBe("0.00004205");
    expect(formatPrice("0.0000420567", 0, "down")).toBe("0.00004205");
    expect(formatPrice("0.0000420567", 2, "down")).toBe("0.000042");
    expect(formatPrice("0.0000420567", 2, "up")).toBe("0.000043");
    expect(formatPrice("0.123456", 5, "down")).toBe("0.123");
  });
  it("allows integer prices with more than 5 digits and rounds fractions away", () => {
    expect(formatPrice("77035.4", 5, "down")).toBe("77035");
    expect(formatPrice("77035.4", 5, "up")).toBe("77036");
    expect(formatPrice("123456.7", 5, "down")).toBe("123456");
    expect(formatPrice("123456.7", 5, "up")).toBe("123457");
    expect(formatPrice("123456", 5, "up")).toBe("123456");
  });
  it("handles carry into a new magnitude", () => {
    expect(formatPrice("9.999996", 2, "up")).toBe("10");
    expect(formatPrice("99999.5", 2, "up")).toBe("100000");
    expect(formatPrice("0.999996", 2, "up")).toBe("1");
  });
  it("throws for zero, or when rounding down erases the price", () => {
    expect(() => formatPrice("0", 2, "down")).toThrow(FormatError);
    expect(() => formatPrice("0.5", 8, "down")).toThrow(FormatError);
    expect(formatPrice("0.5", 8, "up")).toBe("1");
    expect(() => formatPrice("0.0000001", 2, "down")).toThrow(FormatError);
    expect(() => formatPrice("-1", 2, "down")).toThrow(FormatError);
    expect(() => formatPrice("abc", 2, "down")).toThrow(FormatError);
    expect(() => formatPrice("1", 9, "down")).toThrow(FormatError);
  });
  it("never moves a buy price up or a sell price down (property over a grid)", () => {
    for (const raw of ["0.0123456", "1.23456789", "83.954123", "999.999999", "12345.678", "0.00099999999"]) {
      for (const sz of [0, 2, 4]) {
        const down = formatPrice(raw, sz, "down");
        const up = formatPrice(raw, sz, "up");
        expect(cmpDec(down, raw)).toBeLessThanOrEqual(0);
        expect(cmpDec(up, raw)).toBeGreaterThanOrEqual(0);
        expect(isValidPrice(down, sz)).toBe(true);
        expect(isValidPrice(up, sz)).toBe(true);
      }
    }
  });
});

describe("isValidPrice", () => {
  it("accepts only canonical tick-valid prices", () => {
    expect(isValidPrice("83.979", 2)).toBe(true);
    expect(isValidPrice("83.9791", 2)).toBe(false);
    expect(isValidPrice("83.90", 2)).toBe(false); // not normalized
    expect(isValidPrice("100000", 2)).toBe(true);
    expect(isValidPrice("0", 2)).toBe(false);
    expect(isValidPrice("x", 2)).toBe(false);
  });
});

describe("bandPrice / withinBand", () => {
  it("buy limit rounds down, sell limit rounds up, both inside the band", () => {
    expect(bandPrice("100", "buy", 100, 2)).toBe("101");
    expect(bandPrice("100", "sell", 100, 2)).toBe("99");
    expect(bandPrice("83.954", "buy", 100, 2)).toBe("84.793"); // 84.79354 down
    expect(bandPrice("83.954", "sell", 100, 2)).toBe("83.115"); // 83.11446 up
  });
  it("rounding never leaves the band", () => {
    for (const mid of ["83.954", "0.0000421", "77034.5", "1.00001"]) {
      for (const bps of [10, 100, 200]) {
        expect(withinBand(bandPrice(mid, "buy", bps, 2), mid, "buy", bps)).toBe(true);
        expect(withinBand(bandPrice(mid, "sell", bps, 2), mid, "sell", bps)).toBe(true);
      }
    }
  });
  it("withinBand is exact at the edge and rejects outside", () => {
    expect(withinBand("101", "100", "buy", 100)).toBe(true);
    expect(withinBand("101.01", "100", "buy", 100)).toBe(false);
    expect(withinBand("99", "100", "sell", 100)).toBe(true);
    expect(withinBand("98.99", "100", "sell", 100)).toBe(false);
    expect(withinBand("50", "100", "buy", 100)).toBe(true); // a buy far below mid is inside by definition
  });
  it("rejects a bad band", () => {
    expect(() => bandPrice("100", "buy", -1, 2)).toThrow(FormatError);
    expect(() => bandPrice("100", "buy", 10_000, 2)).toThrow(FormatError);
    expect(() => bandPrice("100", "buy", 1.5, 2)).toThrow(FormatError);
  });
});

describe("decimal arithmetic", () => {
  it("is exact", () => {
    expect(mulDec("83.97", "0.12")).toBe("10.0764");
    expect(mulDec("0.1", "0.2")).toBe("0.02");
    expect(addDec("0.1", "0.2")).toBe("0.3");
    expect(subDec("1", "0.0001")).toBe("0.9999");
    expect(subDec("5.5", "5.5")).toBe("0");
    expect(() => subDec("1", "2")).toThrow(FormatError);
    expect(cmpDec("1.0", "1")).toBe(0);
    expect(cmpDec("1.01", "1.1")).toBe(-1);
    expect(cmpDec("10", "9.999")).toBe(1);
    expect(normalizeDec("007.5000")).toBe("7.5");
    expect(normalizeDec("0.0")).toBe("0");
  });
});

describe("cloid", () => {
  it("is 0x + 8 bytes of rules hash + big-endian u64 counter (16 bytes)", () => {
    const c = buildCloid(HASH, 1);
    expect(c).toBe("0xab12cd34ef56a1b20000000000000001");
    expect(c).toHaveLength(34);
    expect(buildCloid(HASH, 255n)).toBe("0xab12cd34ef56a1b200000000000000ff");
    expect(buildCloid(HASH.toUpperCase(), 0)).toBe("0xab12cd34ef56a1b20000000000000000");
    expect(buildCloid(HASH, (1n << 64n) - 1n)).toBe("0xab12cd34ef56a1b2ffffffffffffffff");
  });
  it("rejects bad hashes and counters", () => {
    expect(() => buildCloid("abcd", 1)).toThrow(FormatError);
    expect(() => buildCloid(`${HASH}0`, 1)).toThrow(FormatError);
    expect(() => buildCloid("zz".repeat(32), 1)).toThrow(FormatError);
    expect(() => buildCloid(HASH, -1)).toThrow(FormatError);
    expect(() => buildCloid(HASH, 1n << 64n)).toThrow(FormatError);
  });
  it("round-trips and links orders to a rule set", () => {
    const c = buildCloid(HASH, 77);
    expect(parseCloid(c)).toEqual({ hashPrefix: "ab12cd34ef56a1b2", counter: 77n });
    expect(parseCloid("0x1234")).toBeNull();
    expect(cloidMatchesRules(c, HASH)).toBe(true);
    expect(cloidMatchesRules(c, "00".repeat(32))).toBe(false);
    expect(cloidMatchesRules(null, HASH)).toBe(false);
    expect(cloidMatchesRules("0x0000000000000000000001a19c81f165", HASH)).toBe(false);
  });
});
