import { describe, expect, it } from "vitest";
import { computeMetrics, feeInUsdc, maxDrawdown, realizedByFill } from "../../src/trading/metrics.js";
import type { HistoryPoint } from "../../src/trading/history.js";
import type { JournalFill } from "../../src/trading/journal.js";
import { fxStr } from "../../src/trading/engine/risk.js";

const NOW = 1_000_000_000;
let n = 0;
const f = (side: "buy" | "sell", px: string, sz: string, o: Partial<JournalFill> = {}): JournalFill => {
  n++;
  return {
    tid: n, oid: n, cloid: null, rule_id: null, time_ms: NOW - 1000 + n, pair: "HYPE/USDC", side, px, sz,
    fee_usdc: "0", fee_token: "USDC", fee_amount: "0", realized_usdc: null, pos_after: "0", ...o,
  };
};
const pt = (t: number, pnl: string, lo = pnl, hi = pnl): HistoryPoint => ({ t, pnl, lo, hi, today: pnl, val: "0", pos: {}, px: {} });
const run = (fills: JournalFill[], points: HistoryPoint[] = [], extra: Partial<Parameters<typeof computeMetrics>[0]> = {}) =>
  computeMetrics({ range: "1d", nowMs: NOW, createdAtMs: 0, fills, points, ...extra });

describe("realized P&L by average cost", () => {
  it("buy then partial sell", () => {
    n = 0;
    const r = realizedByFill([f("buy", "10", "2"), f("buy", "20", "2"), f("sell", "25", "1")]).map((x) => (x === null ? null : fxStr(x)));
    expect(r).toEqual([null, null, "10"]); // avg cost 15, sold 1 at 25
  });

  it("USDC fee on a buy goes into cost, USDC fee on a sell reduces realized", () => {
    n = 0;
    const r = realizedByFill([
      f("buy", "10", "1", { fee_usdc: "0.5", fee_amount: "0.5" }),
      f("sell", "12", "1", { fee_usdc: "0.2", fee_amount: "0.2" }),
    ]);
    expect(fxStr(r[1] ?? 0n)).toBe("1.3"); // 12 - 10.5 - 0.2
  });

  it("base-token fee on a buy shrinks the position and is converted at the fill price", () => {
    n = 0;
    const buy = f("buy", "10", "1", { fee_token: "HYPE", fee_amount: "0.1", fee_usdc: "1" });
    expect(fxStr(feeInUsdc(buy))).toBe("1");
    const r = realizedByFill([buy, f("sell", "11", "0.9")]);
    expect(fxStr(r[1] ?? 0n)).toBe("-0.1"); // position 0.9, cost 10, sold 0.9 at 11 = 9.9
  });

  it("a sell with no known basis is unknown, a partly covered sell is realized for the covered part", () => {
    n = 0;
    const r = realizedByFill([f("sell", "10", "1"), f("buy", "10", "1"), f("sell", "12", "3", { fee_usdc: "0.3", fee_amount: "0.3" })]);
    expect(r[0]).toBeNull();
    expect(fxStr(r[2] ?? 0n)).toBe("1.9"); // covered 1 of 3: 12 - 10 - 0.1
  });
});

describe("metrics", () => {
  it("counts a closed trade per sell order, summing partial fills", () => {
    n = 0;
    const buys = [f("buy", "10", "4")];
    const a1 = f("sell", "12", "1", { oid: 900 }); // +2
    const a2 = f("sell", "9", "1", { oid: 900 }); //  -1  => order 900 = +1 (win)
    const b = f("sell", "8", "1", { oid: 901 }); //   -2  => loss
    const m = run([...buys, a1, a2, b]);
    expect(m.closed_trades).toBe(2);
    expect(m.win_rate).toBe("0.5000");
    expect(m.avg_trade_usdc).toBe("-0.5");
    expect(m.realized_usdc).toBe("-1");
    expect(m.fills).toBe(4);
    expect(m.orders).toBe(3);
    expect(m.turnover_usdc).toBe("69"); // 40 + 12 + 9 + 8
  });

  it("win rate is null and avg trade is null with no closed trades", () => {
    n = 0;
    const m = run([f("buy", "10", "1")]);
    expect(m).toMatchObject({ closed_trades: 0, win_rate: null, avg_trade_usdc: null, realized_usdc: "0", fills: 1 });
    expect(run([]).win_rate).toBeNull();
  });

  it("win rate rounds to 4 decimals", () => {
    n = 0;
    const fs: JournalFill[] = [f("buy", "10", "7")];
    for (let i = 0; i < 7; i++) fs.push(f("sell", i < 4 ? "11" : "9", "1"));
    expect(run(fs).win_rate).toBe("0.5714");
  });

  it("uses cost basis from before the range but counts only in-range fills and trades", () => {
    n = 0;
    const old = f("buy", "10", "2", { time_ms: NOW - 3 * 86_400_000 });
    const oldSell = f("sell", "20", "1", { time_ms: NOW - 2 * 86_400_000 });
    const sell = f("sell", "13", "1");
    const m = run([old, oldSell, sell]);
    expect(m).toMatchObject({ fills: 1, closed_trades: 1, realized_usdc: "3", turnover_usdc: "13", win_rate: "1.0000" });
    expect(run([old, oldSell, sell], [], { range: "1w" }).fills).toBe(3);
  });

  it("fees: USDC fees plus base-token buy fees at the fill price", () => {
    n = 0;
    const m = run([
      f("buy", "30", "1", { fee_token: "HYPE", fee_amount: "0.001", fee_usdc: "0.03" }),
      f("sell", "31", "0.5", { fee_amount: "0.007", fee_usdc: "0.007" }),
    ]);
    expect(m.fees_usdc).toBe("0.037");
  });

  it("turnover is the sum of px*sz", () => {
    n = 0;
    expect(run([f("buy", "30.5", "0.5"), f("sell", "31", "0.25")]).turnover_usdc).toBe("23");
  });

  it("`all` starts at created_at", () => {
    n = 0;
    const a = f("buy", "10", "1", { time_ms: 5_000 });
    const b = f("buy", "10", "1", { time_ms: 6_000 });
    expect(computeMetrics({ range: "all", nowMs: NOW, createdAtMs: 5_500, fills: [a, b], points: [] }).fills).toBe(1);
  });

  it("explicit order count overrides the default", () => {
    n = 0;
    expect(run([f("buy", "10", "1")], [], { orders: 12 }).orders).toBe(12);
  });
});

describe("pnl change and drawdown", () => {
  it("drawdown on a known curve at bucket resolution", () => {
    // peak 5 (bucket 2 hi), then lo -3 in bucket 4 => 8
    const pts = [pt(1, "1", "0", "1"), pt(2, "4", "1", "5"), pt(3, "2", "2", "4"), pt(4, "-1", "-3", "2"), pt(5, "3", "-1", "3")];
    expect(fxStr(maxDrawdown(pts))).toBe("8");
    const m = run([], pts);
    expect(m.max_drawdown_usdc).toBe("8");
    expect(m.pnl_change_usdc).toBe("2"); // 3 - 1
  });

  it("uses only buckets before t: a dip inside the first bucket is not a drawdown", () => {
    expect(fxStr(maxDrawdown([pt(1, "0", "-5", "10")]))).toBe("0");
  });

  it("monotonic rise has zero drawdown; no points -> zeros", () => {
    expect(fxStr(maxDrawdown([pt(1, "1"), pt(2, "2"), pt(3, "3")]))).toBe("0");
    expect(run([], [])).toMatchObject({ max_drawdown_usdc: "0", pnl_change_usdc: "0" });
  });

  it("pnl change handles negative values exactly", () => {
    expect(run([], [pt(1, "0.1"), pt(2, "-0.2")]).pnl_change_usdc).toBe("-0.3");
  });
});
