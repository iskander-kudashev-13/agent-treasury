import { describe, expect, it } from "vitest";
import { DAY_MS, computeEquity, lossToday, netFlow, pnlSummary, rollDay, utcDayIndex } from "../../src/trading/engine/pnl.js";
import { fx, fxStr } from "../../src/trading/engine/risk.js";
import type { HlLedgerEntry } from "../../src/trading/types.js";

const DAY0 = 20_000 * DAY_MS;
const led = (timeMs: number, kind: HlLedgerEntry["kind"], usdc: string): HlLedgerEntry => ({ timeMs, kind, usdc });

describe("computeEquity", () => {
  it("sums USDC and priced base balances, free = total - hold", () => {
    const e = computeEquity(
      [
        { coin: "USDC", total: "50", hold: "12" },
        { coin: "HYPE", total: "2", hold: "0.5" },
      ],
      { "HYPE/USDC": "40" },
    );
    expect(fxStr(e.equity)).toBe("130");
    expect(fxStr(e.usdcFree)).toBe("38");
    expect(e.positions).toHaveLength(1);
    expect(fxStr(e.positions[0]?.free ?? 0n)).toBe("1.5");
    expect(e.unpriced).toEqual([]);
  });
  it("values a coin without a mid at zero and reports it", () => {
    const e = computeEquity([{ coin: "USDC", total: "10", hold: "0" }, { coin: "PURR", total: "5", hold: "0" }, { coin: "ZERO", total: "0", hold: "0" }], {});
    expect(fxStr(e.equity)).toBe("10");
    expect(e.unpriced).toEqual(["PURR"]);
  });
});

describe("day snapshot", () => {
  it("rolls on the UTC day boundary only", () => {
    const a = rollDay(null, DAY0 + 5, fx("100"));
    expect(a.rolled).toBe(true);
    expect(a.day).toEqual({ dayIndex: utcDayIndex(DAY0), startEquity: "100", snapshotAtMs: DAY0 + 5 });
    const b = rollDay(a.day, DAY0 + DAY_MS - 1, fx("90"));
    expect(b.rolled).toBe(false);
    expect(b.day).toBe(a.day);
    const c = rollDay(a.day, DAY0 + DAY_MS, fx("90"));
    expect(c.rolled).toBe(true);
    expect(c.day.startEquity).toBe("90");
  });
});

describe("netFlow / loss", () => {
  const day = { dayIndex: 20_000, startEquity: "100", snapshotAtMs: DAY0 + 1000 };
  it("deposits and transfers in are positive, withdrawals and transfers out negative", () => {
    const l = [led(1, "deposit", "20"), led(2, "transfer_in", "5"), led(3, "withdraw", "3"), led(4, "transfer_out", "2")];
    expect(fxStr(netFlow(l, () => true))).toBe("20");
  });
  it("plain loss and gain", () => {
    expect(fxStr(lossToday(day, fx("93"), []))).toBe("7");
    expect(fxStr(lossToday(day, fx("104"), []))).toBe("-4");
  });
  it("a top-up after the snapshot does not hide a loss", () => {
    // 100 -> topped up 20 -> equity 110: the bot lost 10, not gained 10
    expect(fxStr(lossToday(day, fx("110"), [led(DAY0 + 2000, "deposit", "20")]))).toBe("10");
  });
  it("a top-up does not fake a loss either", () => {
    expect(fxStr(lossToday(day, fx("120"), [led(DAY0 + 2000, "deposit", "20")]))).toBe("0");
  });
  it("ledger entries at or before the snapshot are ignored (already inside the start equity)", () => {
    expect(fxStr(lossToday(day, fx("100"), [led(DAY0 + 1000, "deposit", "20"), led(DAY0 - 5, "deposit", "9")]))).toBe("0");
  });
  it("a manual withdrawal counts as a loss", () => {
    // equity fell 100 -> 90 because 10 left the account; ADR T10: treated as a loss of 10 (errs toward stopping)
    expect(fxStr(lossToday(day, fx("90"), [led(DAY0 + 2000, "withdraw", "10")]))).toBe("10");
    expect(fxStr(lossToday(day, fx("90"), [led(DAY0 + 2000, "withdraw", "10"), led(DAY0 + 3000, "deposit", "5")]))).toBe("15");
  });
});

describe("pnlSummary", () => {
  it("today = -loss; total = equity - net funded since the start time", () => {
    const day = { dayIndex: 20_000, startEquity: "30", snapshotAtMs: DAY0 };
    const ledger = [led(DAY0 - 10 * DAY_MS, "deposit", "99"), led(DAY0 - 1000, "deposit", "30"), led(DAY0 + 10, "deposit", "20")];
    const s = pnlSummary(day, fx("47"), ledger, DAY0 - 2000);
    expect(fxStr(s.netFunded)).toBe("50"); // the 99 deposit is before the start time
    expect(fxStr(s.total)).toBe("-3");
    expect(fxStr(s.today)).toBe("-3"); // 30 + 20 - 47 = 3 loss
    expect(fxStr(s.lossToday)).toBe("3");
    expect(fxStr(s.dayStartEquity)).toBe("30");
  });
});
