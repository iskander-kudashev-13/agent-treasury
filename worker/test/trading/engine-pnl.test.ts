import { describe, expect, it } from "vitest";
import { DAY_MS, backstopEquity, computeEquity, matchVaultInflows, netFlow, pnlSummary, rollDay, tradingPnl, utcDayIndex } from "../../src/trading/engine/pnl.js";
import { aggFromFills, aggFx, applyFills, emptyBotAgg, emptyCursor, resolveBot } from "../../src/trading/engine/fills.js";
import { ACTIVATION_FEE_USDC, equityDrop } from "../../src/trading/engine/pnl.js";
import { fx, fxStr } from "../../src/trading/engine/risk.js";
import type { HlFill, HlLedgerEntry } from "../../src/trading/types.js";

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
    expect(a.day).toEqual({ dayIndex: utcDayIndex(DAY0), startEquity: "100", snapshotAtMs: DAY0 + 5, startPositions: {} });
    const b = rollDay(a.day, DAY0 + DAY_MS - 1, fx("90"));
    expect(b.rolled).toBe(false);
    expect(b.day).toBe(a.day);
    const c = rollDay(a.day, DAY0 + DAY_MS, fx("90"));
    expect(c.rolled).toBe(true);
    expect(c.day.startEquity).toBe("90");
  });
  it("records the held positions at the snapshot ({} when none, so a missing field marks a legacy snapshot)", () => {
    const e = computeEquity([{ coin: "USDC", total: "10", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }], { "HYPE/USDC": "40" });
    expect(rollDay(null, DAY0, e.equity, e.positions).day.startPositions).toEqual({ "HYPE/USDC": { size: "2", mid: "40" } });
    expect(rollDay(null, DAY0, e.equity).day.startPositions).toEqual({});
  });
});

const PRE = "0xabababababababab";
const fill = (timeMs: number, side: "buy" | "sell", price: string, size: string, feeUsdc = "0", cloid: string | null = `${PRE}0000000000000001`): HlFill => ({
  oid: 1,
  cloid,
  pair: "HYPE/USDC",
  side,
  price,
  size,
  feeUsdc,
  timeMs,
});
const MIDS = { "HYPE/USDC": "40" };

describe("netFlow", () => {
  it("deposits and transfers in are positive, withdrawals and transfers out negative", () => {
    const l = [led(1, "deposit", "20"), led(2, "transfer_in", "5"), led(3, "withdraw", "3"), led(4, "transfer_out", "2")];
    expect(fxStr(netFlow(l, () => true))).toBe("20");
  });
});

describe("resolveBot", () => {
  it("keeps only fills whose cloid carries a bot prefix", () => {
    const f = [fill(1, "buy", "40", "1"), fill(2, "buy", "40", "1", "0", null), fill(3, "buy", "40", "1", "0", "0x" + "11".repeat(16))];
    const map = new Map([[PRE, "a"]]);
    expect(f.filter((x) => resolveBot(x, map, {}) !== null)).toHaveLength(1);
  });
});

const A = (fills: HlFill[]) => aggFx(aggFromFills(fills));

describe("tradingPnl", () => {
  it("a buy marked to market, fees subtracted", () => {
    // bought 1 at 39 (fee 0.1), mid 40 -> +1 - 0.1
    const r = tradingPnl(A([fill(1, "buy", "39", "1", "0.1")]), {}, MIDS);
    expect(fxStr(r.pnl)).toBe("0.9");
    expect(fxStr(r.fees)).toBe("0.1");
  });
  it("a round trip realises its profit", () => {
    expect(fxStr(tradingPnl(A([fill(1, "buy", "38", "2"), fill(2, "sell", "41", "2")]), {}, MIDS).pnl)).toBe("6");
  });
  it("marks a position held since the snapshot", () => {
    expect(fxStr(tradingPnl(A([]), { "HYPE/USDC": { size: "2", mid: "45" } }, MIDS).pnl)).toBe("-10");
  });
  it("sells of the start position: realised against the start mid", () => {
    // start 2 @45, sold 2 at 43 -> 2*(43-45)
    expect(fxStr(tradingPnl(A([fill(1, "sell", "43", "2")]), { "HYPE/USDC": { size: "2", mid: "45" } }, MIDS).pnl)).toBe("-4");
  });
  it("a pair without a mid is valued at 0 for the stop (a held bag counts as lost) and at the last price for display", () => {
    const r = tradingPnl(A([fill(1, "buy", "39", "1")]), {}, {});
    expect(fxStr(r.pnl)).toBe("-39");
    expect(fxStr(r.pnlDisplay)).toBe("0");
    expect(r.unpriced).toEqual(["HYPE/USDC"]);
  });
  it("a start position without a mid is valued at 0 for the stop, not at its start mid", () => {
    const r = tradingPnl({}, { "HYPE/USDC": { size: "2", mid: "45" } }, {});
    expect(fxStr(r.pnl)).toBe("-90");
    expect(fxStr(r.pnlDisplay)).toBe("0");
  });
});

describe("matchVaultInflows", () => {
  const t0 = DAY0;
  it("matches an inflow close in time and amount, once per top-up", () => {
    const l = [led(t0 + 60_000, "deposit", "19.96"), led(t0 + 70_000, "deposit", "19.96")];
    expect(fxStr(matchVaultInflows(l, [{ atMs: t0, amountUsdc: "20" }]))).toBe("19.96");
  });
  it("ignores inflows of another size or before the request", () => {
    const l = [led(t0 + 1000, "deposit", "1000"), led(t0 - 3_600_000, "deposit", "20")];
    expect(fxStr(matchVaultInflows(l, [{ atMs: t0, amountUsdc: "20" }]))).toBe("0");
  });
});

describe("pnlSummary: accounting 2026-11-03", () => {
  const day = { dayIndex: 20_000, startEquity: "999", snapshotAtMs: DAY0 + 10 };
  const funded = DAY0 - 1000;
  /** Windows as the engine builds them: tracker.total since funding, tracker.today since the snapshot. */
  const win = (fills: HlFill[]) => {
    const map = new Map([[PRE, "a"]]);
    const r = applyFills(emptyCursor(funded, day.snapshotAtMs, true), { a: emptyBotAgg() }, fills, { fundedSinceMs: funded, resolve: (f) => resolveBot(f, map, {}) });
    const t = r.aggs["a"] ?? emptyBotAgg();
    return { todayAgg: t.today, totalAgg: t.total };
  };
  const base = { day, fundedSinceMs: funded, mids: MIDS, ...win([]) };

  it("faucet 1000 minus 1 activation fee: no trading loss, the fee is untracked, the inflow external", () => {
    const s = pnlSummary({ ...base, equityNow: fx("999"), ledger: [led(DAY0 - 500, "deposit", "1000")] });
    expect(fxStr(s.lossToday)).toBe("0");
    expect(fxStr(s.today)).toBe("0");
    expect(fxStr(s.total)).toBe("0");
    expect(fxStr(s.netFunded)).toBe("1000");
    expect(fxStr(s.externalInflow)).toBe("1000");
    expect(fxStr(s.fundedByVault)).toBe("0");
    expect(fxStr(s.untrackedDelta)).toBe("-1");
  });
  it("a vault top-up is reported as vault funding", () => {
    const s = pnlSummary({ ...base, equityNow: fx("999"), ledger: [led(DAY0 - 500, "deposit", "19.97")], topups: [{ atMs: DAY0 - 600, amountUsdc: "20" }] });
    expect(fxStr(s.fundedByVault)).toBe("19.97");
    expect(fxStr(s.externalInflow)).toBe("0");
  });
  it("a deposit today does not hide a real loss and does not fake one", () => {
    // bought 1 at 45 (mid 40 now) = -5; a 20 deposit arrived after the snapshot
    const s = pnlSummary({ ...base, equityNow: fx("1014"), ...win([fill(DAY0 + 100, "buy", "45", "1")]), ledger: [led(DAY0 + 50, "deposit", "20")] });
    expect(fxStr(s.lossToday)).toBe("5");
    expect(fxStr(s.today)).toBe("-5");
  });
  it("a manual withdrawal is visible but is not trading loss", () => {
    const s = pnlSummary({ ...base, equityNow: fx("989"), ledger: [led(DAY0 - 500, "deposit", "1000"), led(DAY0 + 500, "withdraw", "10")] });
    expect(fxStr(s.lossToday)).toBe("0");
    expect(fxStr(s.externalOutflow)).toBe("10");
    expect(fxStr(s.netFunded)).toBe("990");
  });
  it("fills before the snapshot are inside the start positions", () => {
    const s = pnlSummary({ ...base, equityNow: fx("999"), ...win([fill(DAY0 + 9, "buy", "99", "1")]), ledger: [] });
    expect(fxStr(s.today)).toBe("0");
    expect(fxStr(s.total)).toBe("-59"); // total window includes it (bought at 99, mid 40)
    expect(fxStr(s.fees)).toBe("0");
  });
});

describe("equityDrop (backstop for what fill accounting cannot see)", () => {
  const day = { dayIndex: 20_000, startEquity: "100", snapshotAtMs: DAY0 + 10 };
  const F = DAY0 - 1000;
  it("is start + inflows - outflows - equity now", () => {
    expect(fxStr(equityDrop(day, fx("60"), [], F))).toBe("40");
    const earlier = led(DAY0 - 500, "deposit", "100"); // first entry is before today: no activation allowance
    expect(fxStr(equityDrop(day, fx("120"), [earlier, led(DAY0 + 50, "deposit", "20")], F))).toBe("0");
    expect(fxStr(equityDrop(day, fx("90"), [earlier, led(DAY0 + 50, "withdraw", "10")], F))).toBe("0");
  });
  it("ignores flows before the snapshot (already inside the start equity)", () => {
    expect(fxStr(equityDrop(day, fx("100"), [led(DAY0 - 500, "deposit", "1000"), led(DAY0 - 400, "withdraw", "5")], F))).toBe("0");
  });
  it("excuses the 1 USDC activation fee once: first ledger entry is an inflow on today's window", () => {
    const l = [led(DAY0 + 20, "deposit", "1000")];
    const d0 = { ...day, startEquity: "0" };
    expect(fxStr(equityDrop(d0, fx("999"), l, F))).toBe("0");
    expect(fxStr(equityDrop(d0, fx("998"), l, F))).toBe("1"); // anything beyond the fee shows
    expect(ACTIVATION_FEE_USDC).toBe(10n ** 12n);
  });
  it("gives no allowance when the first entry is an outflow, or lies before today", () => {
    expect(fxStr(equityDrop({ ...day, startEquity: "0" }, fx("0"), [led(DAY0 + 20, "withdraw", "0")], F))).toBe("0");
    expect(fxStr(equityDrop(day, fx("99"), [led(DAY0 - 500, "deposit", "100")], F))).toBe("1");
  });
});

describe("stop valuation of the start holding: only negative marks, capped at what is still there (re-review H3)", () => {
  const START = { "HYPE/USDC": { size: "10", mid: "100" } };
  const H = (n: string) => ({ "HYPE/USDC": fx(n) });
  it("a gain on the start holding does not offset a bot loss (display still shows it)", () => {
    // start 10 @100, mid 110; the bot bought 1 @120 (cash -120, mark +110): bot loss 10, start gain +100
    const r = tradingPnl(A([fill(1, "buy", "120", "1")]), START, { "HYPE/USDC": "110" }, H("11"));
    expect(fxStr(r.pnl)).toBe("-10");
    expect(fxStr(r.pnlDisplay)).toBe("90");
  });
  it("a loss on the start holding counts in full; a bot gain counts too", () => {
    expect(fxStr(tradingPnl(A([]), START, { "HYPE/USDC": "90" }, H("10")).pnl)).toBe("-100");
    expect(fxStr(tradingPnl(A([fill(1, "buy", "100", "1")]), START, { "HYPE/USDC": "110" }, H("11")).pnl)).toBe("10");
  });
  it("is capped at the size still held: a start holding that was sold or withdrawn by hand cannot lose value", () => {
    expect(fxStr(tradingPnl(A([]), START, { "HYPE/USDC": "90" }, H("4")).pnl)).toBe("-40");
    expect(fxStr(tradingPnl(A([]), START, { "HYPE/USDC": "90" }, {}).pnl)).toBe("0");
  });
  it("what the bot sold still counts at the start mid (the cap adds the sold part back)", () => {
    // sold all 10 at 95 (realised -50 against the start mid), price fell to 80 afterwards: still -50, not +150
    const r = tradingPnl(A([fill(1, "sell", "95", "10")]), START, { "HYPE/USDC": "80" }, H("0"));
    expect(fxStr(r.pnl)).toBe("-50");
  });
  it("an unpriced start holding is valued at 0, capped by what is held", () => {
    expect(fxStr(tradingPnl({}, START, {}, H("10")).pnl)).toBe("-1000");
    expect(fxStr(tradingPnl({}, START, {}, H("3")).pnl)).toBe("-300");
  });
});

describe("backstopEquity: USDC + allowed-pair coins only (re-review B1)", () => {
  const eq = computeEquity(
    [
      { coin: "USDC", total: "50", hold: "0" },
      { coin: "HYPE", total: "2", hold: "0" },
      { coin: "JUNK", total: "1000", hold: "0" },
    ],
    { "HYPE/USDC": "40", "JUNK/USDC": "0.05" },
  );
  const allowed = new Set(["HYPE/USDC"]);
  it("a coin outside the allowed pairs is worth 0, however high its mid", () => {
    expect(fxStr(eq.equity)).toBe("180"); // display counts it
    expect(fxStr(backstopEquity(eq, allowed))).toBe("130");
  });
  it("gains on the coins held at the snapshot are clipped at the start mid, losses are not", () => {
    expect(fxStr(backstopEquity(eq, allowed, { "HYPE/USDC": { size: "2", mid: "30" } }))).toBe("110"); // 50 + 2*30
    expect(fxStr(backstopEquity(eq, allowed, { "HYPE/USDC": { size: "2", mid: "50" } }))).toBe("130"); // loss counts: 50 + 2*40
    expect(fxStr(backstopEquity(eq, allowed, { "HYPE/USDC": { size: "1", mid: "30" } }))).toBe("120"); // only 1 of 2 was held at the start
  });
});

describe("equityDrop: flows and the snapshot window (re-review)", () => {
  const F = DAY0 - 1000;
  const earlier = led(DAY0 - 500, "deposit", "100"); // before today: no activation allowance
  const day = { dayIndex: 20_000, startEquity: "100", snapshotAtMs: DAY0 + 10 };
  it("perp->spot class transfers count as inflows and spot->perp as outflows; netFunded ignores both", () => {
    expect(fxStr(equityDrop(day, fx("110"), [earlier, led(DAY0 + 50, "class_in", "10")], F))).toBe("0");
    expect(fxStr(equityDrop(day, fx("90"), [earlier, led(DAY0 + 50, "class_out", "10")], F))).toBe("0");
    expect(fxStr(equityDrop(day, fx("90"), [earlier], F))).toBe("10");
    expect(fxStr(netFlow([led(1, "deposit", "5"), led(2, "class_in", "7"), led(3, "class_out", "9")], () => true))).toBe("5");
    const s = pnlSummary({ day, equityNow: fx("110"), fundedSinceMs: F, mids: MIDS, todayAgg: {}, totalAgg: {}, ledger: [earlier, led(DAY0 + 50, "class_in", "10")] });
    expect(fxStr(s.netFunded)).toBe("100");
    expect(fxStr(s.externalInflow)).toBe("100");
    expect(fxStr(s.equityDrop)).toBe("0");
  });
  it("inflows count from the tick start, outflows only from after the balance read (both lean toward stopping)", () => {
    const d = { ...day, snapshotAtMs: DAY0 + 1000, balanceAtMs: DAY0 + 1005 };
    // an outflow between the two stamps may already be inside the snapshot balance: not subtracted again
    expect(fxStr(equityDrop(d, fx("100"), [earlier, led(DAY0 + 1002, "withdraw", "10")], F))).toBe("0");
    expect(fxStr(equityDrop(d, fx("100"), [earlier, led(DAY0 + 1006, "withdraw", "10")], F))).toBe("-10");
    // an inflow between the stamps is counted (a possible double count only raises the drop)
    expect(fxStr(equityDrop(d, fx("100"), [earlier, led(DAY0 + 1002, "deposit", "10")], F))).toBe("10");
  });
  it("uses startBackstop when present, else the all-coin startEquity", () => {
    expect(fxStr(equityDrop({ ...day, startEquity: "180", startBackstop: "130" }, fx("130"), [], F))).toBe("0");
    expect(fxStr(equityDrop({ ...day, startEquity: "180" }, fx("130"), [], F))).toBe("50");
  });
  it("rollDay stores the backstop equity and the balance stamp only when given", () => {
    const r = rollDay(null, DAY0, fx("180"), [], { backstop: fx("130"), balanceAtMs: DAY0 + 3 });
    expect(r.day).toMatchObject({ startEquity: "180", startBackstop: "130", balanceAtMs: DAY0 + 3 });
  });
});
