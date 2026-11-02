import { describe, expect, it } from "vitest";
import { OVERLAP_MS, applyFills, basisOf, completeFrom, emptyTracker, readFrom, rollToday } from "../../src/trading/engine/fills.js";
import { FakeHl, HYPE_PAIR } from "../../src/trading/hl/fake.js";
import { FillsTruncatedError, fillKey, readAllFills } from "../../src/trading/hl/pagination.js";
import type { HlFill } from "../../src/trading/types.js";

const ACC = "0x00000000000000000000000000000000000000aa";
const PRE = "0xabababababababab";
const CLOID = `${PRE}0000000000000001`;
let tid = 0;
const fill = (timeMs: number, o: Partial<HlFill> = {}): HlFill => ({
  oid: 1,
  tid: ++tid,
  cloid: CLOID,
  pair: "HYPE/USDC",
  side: "buy",
  price: "40",
  size: "1",
  feeUsdc: "0",
  timeMs,
  ...o,
});

function fakeWith(n: number, cap: number, retain: number): FakeHl {
  const hl = new FakeHl({ pairs: [HYPE_PAIR] });
  hl.fillsPageCap = cap;
  hl.fillsRetain = retain;
  for (let i = 0; i < n; i++) hl.addFill(ACC, fill(1000 + i));
  return hl;
}

describe("getUserFills pagination (HL caps: page 2000, retention 10000)", () => {
  it("reads across several full pages", async () => {
    const hl = fakeWith(25, 10, 1000);
    const got = await hl.getUserFills(ACC, 0);
    expect(got).toHaveLength(25);
    expect(new Set(got.map(fillKey)).size).toBe(25);
    expect(got.map((f) => f.timeMs)).toEqual([...got.map((f) => f.timeMs)].sort((a, b) => a - b));
  });
  it("same-millisecond rows at a page boundary are not lost or doubled", async () => {
    const hl = new FakeHl({ pairs: [HYPE_PAIR] });
    hl.fillsPageCap = 4;
    for (let i = 0; i < 3; i++) hl.addFill(ACC, fill(1000 + i));
    for (let i = 0; i < 3; i++) hl.addFill(ACC, fill(1003)); // rows 4..6 share one ms, the page boundary falls inside
    const got = await hl.getUserFills(ACC, 0);
    expect(got).toHaveLength(6);
  });
  it("fails closed when a full page ends inside one millisecond (cannot paginate)", async () => {
    const hl = new FakeHl({ pairs: [HYPE_PAIR] });
    hl.fillsPageCap = 3;
    for (let i = 0; i < 5; i++) hl.addFill(ACC, fill(1000));
    await expect(hl.getUserFills(ACC, 0)).rejects.toBeInstanceOf(FillsTruncatedError);
  });
  it("fails closed when the account has as many rows as HL retains (older ones may be gone)", async () => {
    const hl = fakeWith(30, 10, 30);
    await expect(hl.getUserFills(ACC, 0)).rejects.toMatchObject({ code: "FILLS_TRUNCATED" });
  });
  it("below the retention cap a window that starts late is complete", async () => {
    const hl = fakeWith(50, 10, 1000);
    expect(await hl.getUserFills(ACC, 1040)).toHaveLength(10);
  });
  it("a FULL page that is not oldest-first fails closed (the docs do not promise the order)", async () => {
    const hl = fakeWith(25, 10, 1000);
    hl.fillsNewestFirst = true;
    await expect(hl.getUserFills(ACC, 0)).rejects.toBeInstanceOf(FillsTruncatedError);
    // a short page is the whole answer, whatever its order
    expect(await fakeWith(5, 10, 1000).getUserFills(ACC, 0)).toHaveLength(5);
    const short = fakeWith(5, 10, 1000);
    short.fillsNewestFirst = true;
    expect(await short.getUserFills(ACC, 0)).toHaveLength(5);
  });
  it("a full page whose first row is not at the cursor fails closed (older rows may have been cut off)", async () => {
    const row = (t: number) => fill(t);
    const pages: Record<number, { rows: number[] }> = { 0: { rows: [10, 11, 12] }, 12: { rows: [15, 16, 17] } };
    const reader = (start: number, end?: number) => {
      const rows = (pages[start]?.rows ?? []).filter((t) => end === undefined || t <= end);
      return Promise.resolve({ fills: rows.map(row), rawCount: rows.length, maxTimeMs: rows.at(-1) ?? null, minTimeMs: rows[0] ?? null, ascending: true });
    };
    await expect(readAllFills(reader, 0, { pageCap: 3, retain: 1000 })).rejects.toThrow(/starts at 15 instead of 12/);
  });
  it("a full first page that starts before the requested start fails closed", async () => {
    const reader = () => Promise.resolve({ fills: [], rawCount: 3, maxTimeMs: 20, minTimeMs: 5, ascending: true });
    await expect(readAllFills(reader, 10, { pageCap: 3, retain: 1000 })).rejects.toBeInstanceOf(FillsTruncatedError);
  });
  it("readAllFills gives up after too many pages", async () => {
    let t = 0;
    await expect(
      readAllFills(() => Promise.resolve({ fills: [], rawCount: 5, maxTimeMs: ++t, minTimeMs: t - 1, ascending: true }), 0, { pageCap: 5, retain: 1_000_000 }),
    ).rejects.toBeInstanceOf(FillsTruncatedError);
  });
});

describe("fill tracker", () => {
  const ctx = { prefixes: [PRE], oids: new Set<number>(), fundedSinceMs: 0 };
  it("sums the bot's fills once, however often they are read again", () => {
    let t = emptyTracker(0, 0, true);
    const f = [fill(10), fill(20, { side: "sell", price: "41" })];
    t = applyFills(t, f, ctx);
    t = applyFills(t, f, ctx);
    expect(t.total["HYPE/USDC"]).toMatchObject({ cash: "1", dq: "0" });
    expect(t.botFillsToday).toBe(2);
  });
  it("picks up a fill that HL indexes late (older than one already seen, inside the overlap)", () => {
    let t = emptyTracker(0, 0, true);
    const seen = fill(1_000_000);
    t = applyFills(t, [seen], ctx);
    expect(readFrom(t)).toBe(1_000_000 - OVERLAP_MS);
    t = applyFills(t, [seen, fill(990_000)], ctx);
    expect(t.total["HYPE/USDC"]?.dq).toBe("2");
  });
  it("matches on cloid OR oid; anything else is foreign and only counted", () => {
    let t = emptyTracker(0, 0, true);
    t = applyFills(t, [fill(10, { cloid: null, oid: 77 }), fill(11, { cloid: "0x" + "11".repeat(16), oid: 78 }), fill(12, { cloid: null, oid: 79 })], { ...ctx, oids: new Set([77]) });
    expect(t.botFillsToday).toBe(1);
    expect(t.foreignFills).toBe(2);
  });
  it("rollToday restarts only today's sum", () => {
    let t = applyFills(emptyTracker(0, 0, true), [fill(10)], ctx);
    t = rollToday(t, 500);
    expect(t.today).toEqual({});
    expect(t.botFillsToday).toBe(0);
    expect(t.total["HYPE/USDC"]?.dq).toBe("1");
    t = applyFills(t, [fill(400, { tid: 9999 }), fill(600)], ctx);
    expect(t.botFillsToday).toBe(1); // 400 < new snapshot
  });
  it("prunes the seen set to the overlap window and survives a JSON round trip", () => {
    let t = applyFills(emptyTracker(0, 0, true), [fill(10), fill(10 + 10 * OVERLAP_MS)], ctx);
    expect(t.seen).toHaveLength(1);
    t = JSON.parse(JSON.stringify(t)) as typeof t;
    t = applyFills(t, [fill(10 + 10 * OVERLAP_MS, { tid: tid })], ctx);
    expect(t.total["HYPE/USDC"]?.dq).toBe("2");
  });
});

describe("fill tracker cursor", () => {
  it("never moves past the latest fill time (HL clock), also when nothing new arrives", () => {
    const empty = applyFills(emptyTracker(1_000_000, 0, true), [], { prefixes: [PRE], oids: new Set(), fundedSinceMs: 0 });
    expect(readFrom(empty)).toBe(1_000_000 - OVERLAP_MS);
    const t = applyFills(empty, [fill(1_500_000)], { prefixes: [PRE], oids: new Set(), fundedSinceMs: 0 });
    expect(readFrom(t)).toBe(1_500_000 - OVERLAP_MS);
    // a later read with no new fill does not move it either
    expect(readFrom(applyFills(t, [], { prefixes: [PRE], oids: new Set(), fundedSinceMs: 0 }))).toBe(1_500_000 - OVERLAP_MS);
  });
});

describe("fill tracker: attribution oids and cost basis (re-review H4, H5)", () => {
  const ctx = { prefixes: [PRE], oids: new Set<number>(), fundedSinceMs: 0 };
  it("records the distinct order ids of today's bot fills and resets them with the day", () => {
    let t = applyFills(emptyTracker(0, 0, true), [fill(10, { oid: 5 }), fill(11, { oid: 5 }), fill(12, { oid: 6 }), fill(13, { oid: 9, cloid: null })], ctx);
    expect(t.botOidsToday).toEqual([5, 6]);
    t = rollToday(t, 1000);
    expect(t.botOidsToday).toEqual([]);
  });
  it("keeps a running weighted-average cost per rule-set prefix and pair, without re-reading history", () => {
    let t = applyFills(emptyTracker(0, 0, true), [fill(10, { price: "30", size: "1" }), fill(11, { price: "40", size: "1" })], ctx);
    expect(basisOf(t, PRE, "HYPE/USDC")).toEqual({ size: 2_000_000_000_000n, avgCost: 35_000_000_000_000n });
    t = applyFills(t, [fill(12, { side: "sell", price: "50", size: "1" })], ctx);
    expect(basisOf(t, PRE, "HYPE/USDC")).toMatchObject({ size: 1_000_000_000_000n, avgCost: 35_000_000_000_000n }); // sells keep the average
    t = applyFills(t, [fill(13, { side: "sell", price: "50", size: "1" })], ctx);
    expect(basisOf(t, PRE, "HYPE/USDC")).toEqual({ size: 0n, avgCost: 0n });
    expect(basisOf(t, "0x" + "cd".repeat(8), "HYPE/USDC")).toEqual({ size: 0n, avgCost: 0n });
  });
  it("fills attributed by oid only (no cloid) have no rule-set prefix and are not in a cost basis", () => {
    const t = applyFills(emptyTracker(0, 0, true), [fill(10, { cloid: null, oid: 77 })], { ...ctx, oids: new Set([77]) });
    expect(t.botFillsToday).toBe(1);
    expect(basisOf(t, PRE, "HYPE/USDC").size).toBe(0n);
  });
  it("completeFrom: 0 for a complete history, the restart point for a partial one, infinity for an old file", () => {
    expect(completeFrom(emptyTracker(500, 0, true))).toBe(0);
    expect(completeFrom(emptyTracker(500, 0, false))).toBe(500);
    const legacy = emptyTracker(500, 0, false);
    delete legacy.completeFromMs;
    expect(completeFrom(legacy)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("readAllFills: first full page that starts after the window start (re-review H2)", () => {
  type Row = { timeMs: number };
  const mk = (t: number): Row => ({ tid: t, oid: t, timeMs: t, pair: "PURR/USDC", side: "buy", price: "1", size: "1", feeUsdc: "0" }) as unknown as Row;
  it("accepts it when the gap before the first row is empty", async () => {
    const { readAllFills } = await import("../../src/trading/hl/pagination.js");
    const rows = [100, 101, 102].map(mk);
    const page = (start: number, end?: number) => {
      const r = rows.filter((f) => f.timeMs >= start && (end === undefined || f.timeMs <= end)).slice(0, 2);
      return Promise.resolve({ fills: r as never[], rawCount: r.length, minTimeMs: r[0]?.timeMs ?? null, maxTimeMs: r.at(-1)?.timeMs ?? null, ascending: true });
    };
    const out = await readAllFills(page, 50, { pageCap: 2 });
    expect(out.map((f) => f.timeMs)).toEqual([100, 101, 102]);
  });
  it("throws when the gap before the first row holds rows (newest-rows-first answer)", async () => {
    const { readAllFills, FillsTruncatedError } = await import("../../src/trading/hl/pagination.js");
    const all = [60, 70, 100, 101].map(mk);
    // A misbehaving API: the first request returns the NEWEST 2 rows (ascending), gap probes return what exists.
    const page = (start: number, end?: number) => {
      const r = end === undefined ? all.slice(-2) : all.filter((f) => f.timeMs >= start && f.timeMs <= end);
      return Promise.resolve({ fills: r as never[], rawCount: r.length, minTimeMs: r[0]?.timeMs ?? null, maxTimeMs: r.at(-1)?.timeMs ?? null, ascending: true });
    };
    await expect(readAllFills(page, 50, { pageCap: 2 })).rejects.toBeInstanceOf(FillsTruncatedError);
  });
});
