import { describe, expect, it } from "vitest";
import { candleSeries, hexA, lineSeries, pnlSeries, pricePrecision } from "./tradingChart";

const pt = (t: number, pnl: string) => ({ t, pnl, lo: pnl, hi: pnl, today: "0", val: "0", px: {} });

describe("tradingChart", () => {
  it("pnlSeries sorts, dedupes by second and drops bad values", () => {
    const s = pnlSeries([pt(3000, "2"), pt(1000, "1"), pt(1500, "1.5"), pt(2000, "x")]);
    expect(s).toEqual([{ time: 1, value: 1.5 }, { time: 3, value: 2 }]);
  });
  it("candleSeries is ascending and unique", () => {
    const c = (time: number) => ({ time, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect(candleSeries([c(5), c(1), c(5)]).map((x) => x.time)).toEqual([1, 5]);
  });
  it("hexA converts hex only", () => {
    expect(hexA("#2ecc71", 0.5)).toBe("rgba(46, 204, 113, 0.5)");
    expect(hexA("var(--x)", 0.5)).toBe("var(--x)");
  });
  it("lineSeries takes closes", () => {
    const c = (time: number, close: number) => ({ time, open: 1, high: 2, low: 0.5, close });
    expect(lineSeries([c(2, 7), c(1, 5)])).toEqual([{ time: 1, value: 5 }, { time: 2, value: 7 }]);
  });
  it("pricePrecision fits the visible range", () => {
    expect(pricePrecision([2000, 2050])).toBe(2);
    expect(pricePrecision([0.151, 0.158])).toBe(4);
    expect(pricePrecision([])).toBe(2);
    expect(pricePrecision([0.5, 0.5])).toBeGreaterThanOrEqual(2);
  });
});
