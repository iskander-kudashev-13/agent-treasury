import { beforeEach, describe, expect, it } from "vitest";
import { FakeHl, HYPE_PAIR } from "../../src/trading/hl/fake.js";
import { buildCloid } from "../../src/trading/hl/format.js";
import type { HlPlaceOrder } from "../../src/trading/types.js";

const ME = "0x00000000000000000000000000000000000000aa";
const HASH = "ab".repeat(32);

function order(over: Partial<HlPlaceOrder> = {}): HlPlaceOrder {
  return { assetId: HYPE_PAIR.assetId, isBuy: true, price: "40.4", size: "0.25", tif: "Ioc", cloid: buildCloid(HASH, 1), ...over };
}

let t = 1_700_000_000_000;
let hl: FakeHl;
beforeEach(() => {
  t = 1_700_000_000_000;
  hl = new FakeHl({ now: () => t });
  hl.account = ME;
  hl.setBalances(ME, [{ coin: "USDC", total: "100", hold: "0" }]);
});

describe("FakeHl reads", () => {
  it("serves pairs, mids, a default book from the mid, and stamps atMs from the clock", async () => {
    expect((await hl.getSpotPairs())[0]?.name).toBe("HYPE/USDC");
    expect(await hl.getMids()).toEqual({ mids: { "HYPE/USDC": "40" }, atMs: t });
    expect(await hl.getBook("HYPE/USDC")).toEqual({ bid: "40", ask: "40", atMs: t });
    hl.setBook("HYPE/USDC", "39.9", "40.1");
    expect(await hl.getBook("HYPE/USDC")).toEqual({ bid: "39.9", ask: "40.1", atMs: t });
    hl.staleAtMs = t - 999_999;
    expect((await hl.getMids()).atMs).toBe(t - 999_999);
  });
  it("setMid updates both mids and the pair listing", async () => {
    hl.setMid("HYPE/USDC", "41.5");
    expect((await hl.getMids()).mids["HYPE/USDC"]).toBe("41.5");
    expect((await hl.getSpotPairs())[0]?.midUsdc).toBe("41.5");
  });
  it("filters candles, ledger and fills by time and keys state by lower-case account", async () => {
    hl.setCandles("HYPE/USDC", [
      { openTimeMs: 0, closeTimeMs: 99, open: "1", close: "2" },
      { openTimeMs: 100, closeTimeMs: 199, open: "2", close: "3" },
    ]);
    expect(await hl.getCandles("HYPE/USDC", "1h", 100, 300)).toHaveLength(1);
    hl.setLedger(ME.toUpperCase().replace("0X", "0x"), [
      { timeMs: 5, kind: "deposit", usdc: "10" },
      { timeMs: 50, kind: "withdraw", usdc: "1" },
    ]);
    expect(await hl.getLedger(ME, 10)).toEqual([{ timeMs: 50, kind: "withdraw", usdc: "1" }]);
    hl.setPerp(ME, { positions: [{ coin: "BTC", size: "-1" }], openPerpOrders: 1, accountValueUsdc: "5" });
    expect((await hl.getPerpState(ME)).positions).toHaveLength(1);
    expect((await hl.getPerpState("0xdead")).positions).toHaveLength(0);
    hl.setApprovedAgents(ME, [{ address: "0x1", name: "bot", validUntilMs: 5 }]);
    expect(await hl.getApprovedAgents(ME)).toHaveLength(1);
  });
  it("failNext makes exactly one call throw", async () => {
    hl.failNext("getMids", new Error("boom"));
    await expect(hl.getMids()).rejects.toThrow("boom");
    await expect(hl.getMids()).resolves.toBeDefined();
  });
});

describe("FakeHl orders", () => {
  it("fills a crossing IOC buy at the order price and moves balances", async () => {
    const r = await hl.placeSpotOrder(order({ price: "40.4", size: "0.25" })); // 10.1 USDC
    expect(r).toMatchObject({ status: "filled", filledSize: "0.25", avgPx: "40.4" });
    const bal = await hl.getSpotBalances(ME);
    expect(bal.find((b) => b.coin === "USDC")?.total).toBe("89.9");
    expect(bal.find((b) => b.coin === "HYPE")?.total).toBe("0.25");
    expect(hl.placed).toHaveLength(1);
    expect((await hl.getUserFills(ME, 0))[0]).toMatchObject({ side: "buy", price: "40.4", size: "0.25", pair: "HYPE/USDC" });
  });
  it("fills an IOC sell and returns USDC", async () => {
    hl.setBalances(ME, [{ coin: "HYPE", total: "1", hold: "0" }]);
    const r = await hl.placeSpotOrder(order({ isBuy: false, price: "39.6", size: "0.26" })); // 10.296
    expect(r.status).toBe("filled");
    const bal = await hl.getSpotBalances(ME);
    expect(bal.find((b) => b.coin === "HYPE")?.total).toBe("0.74");
    expect(bal.find((b) => b.coin === "USDC")?.total).toBe("10.296");
  });
  it("returns unfilled for an IOC that does not cross the mid", async () => {
    expect(await hl.placeSpotOrder(order({ price: "39.6", size: "0.26" }))).toEqual({ status: "unfilled" });
    expect((await hl.getSpotBalances(ME)).find((b) => b.coin === "USDC")?.total).toBe("100");
  });
  it("rests a non-crossing GTC with a hold and releases it on cancel", async () => {
    const r = await hl.placeSpotOrder(order({ tif: "Gtc", price: "39.6", size: "0.26" }));
    expect(r.status).toBe("resting");
    if (r.status !== "resting") throw new Error("unreachable");
    expect((await hl.getSpotBalances(ME))[0]).toMatchObject({ coin: "USDC", total: "100", hold: "10.296" });
    const open = await hl.getOpenOrders(ME);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ oid: r.oid, market: "spot", pair: "HYPE/USDC", side: "buy", price: "39.6", size: "0.26", placedAtMs: t });
    await hl.cancelOrders([{ assetId: HYPE_PAIR.assetId, oid: r.oid }]);
    expect(await hl.getOpenOrders(ME)).toHaveLength(0);
    expect((await hl.getSpotBalances(ME))[0]?.hold).toBe("0");
    expect(hl.cancelled).toEqual([{ assetId: 10107, oid: r.oid }]);
  });
  it("rejects like HL: tick, size decimals, minimum value, insufficient balance", async () => {
    expect(await hl.placeSpotOrder(order({ price: "40.123456" }))).toMatchObject({ status: "rejected", error: expect.stringContaining("tick") as unknown });
    expect(await hl.placeSpotOrder(order({ size: "0.255" }))).toMatchObject({ status: "rejected" });
    expect(await hl.placeSpotOrder(order({ price: "40.4", size: "0.2" }))).toMatchObject({ status: "rejected", error: expect.stringContaining("minimum") as unknown });
    expect(await hl.placeSpotOrder(order({ price: "40.4", size: "3" }))).toMatchObject({ status: "rejected", error: expect.stringContaining("Insufficient") as unknown });
    expect(hl.placed).toHaveLength(4); // attempts are recorded, none changed balances
    expect((await hl.getSpotBalances(ME))[0]?.total).toBe("100");
  });
  it("refuses perp asset ids (< 10000) without recording a placement", async () => {
    for (const assetId of [0, 1, 9999, -5, 10107.5]) {
      await expect(hl.placeSpotOrder(order({ assetId }))).rejects.toThrow(/not a spot asset/);
    }
    await expect(hl.cancelOrders([{ assetId: 3, oid: 1 }])).rejects.toThrow(/not a spot asset/);
    expect(hl.placed).toHaveLength(0);
    expect(hl.cancelled).toHaveLength(0);
  });
  it("scripted orderResults override the fill model (consumed once)", async () => {
    hl.orderResults = [{ status: "rejected", error: "scripted" }];
    expect(await hl.placeSpotOrder(order())).toEqual({ status: "rejected", error: "scripted" });
    expect((await hl.placeSpotOrder(order())).status).toBe("filled");
  });
  it("records scheduleCancel calls and the call order", async () => {
    await hl.getMids();
    await hl.scheduleCancel(t + 180_000);
    await hl.placeSpotOrder(order());
    await hl.scheduleCancel(null);
    expect(hl.scheduleCancelCalls).toEqual([t + 180_000, null]);
    expect(hl.callLog()).toEqual(["read:getMids", "scheduleCancel", "place", "scheduleCancel"]);
  });
});
