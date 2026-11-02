import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import { describe, expect, it, vi } from "vitest";
import { NktkasHl, createNktkasHl, type HlExchangeApi, type HlInfoApi } from "../../src/trading/hl/nktkas.js";
import { buildCloid } from "../../src/trading/hl/format.js";
import type { HlPlaceOrder } from "../../src/trading/types.js";

const MASTER = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
const CLOID = buildCloid("cd".repeat(32), 3);

// spotMeta fixture: USDC(0), HYPE(150, canonical-like), two look-alike "FAKE" tokens, one canonical "PURR" legacy pair.
const tokens = [
  { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, isCanonical: true },
  { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 150, isCanonical: false },
  { name: "PURR", szDecimals: 0, weiDecimals: 5, index: 1, isCanonical: true },
  { name: "FAKE", szDecimals: 1, weiDecimals: 6, index: 500, isCanonical: false },
  { name: "FAKE", szDecimals: 3, weiDecimals: 6, index: 501, isCanonical: false },
  { name: "USDH", szDecimals: 2, weiDecimals: 8, index: 268, isCanonical: true },
];
const spotMeta = {
  universe: [
    { tokens: [1, 0], name: "PURR/USDC", index: 0, isCanonical: true },
    { tokens: [150, 0], name: "@107", index: 107, isCanonical: false },
    { tokens: [150, 268], name: "@207", index: 207, isCanonical: false },
    { tokens: [500, 0], name: "@300", index: 300, isCanonical: false },
    { tokens: [501, 0], name: "@301", index: 301, isCanonical: false },
  ],
  tokens,
};
const ctx = (coin: string, mid: string | null, vol: string) => ({ coin, midPx: mid, dayNtlVlm: vol, markPx: "1", prevDayPx: "1" });
const assetCtxs = [ctx("PURR/USDC", "0.2", "1000"), ctx("@107", "83.9795", "85046957.58225"), ctx("@207", null, "0"), ctx("@300", "1", "5"), ctx("@301", "2", "6")];

function makeInfo(over: Record<string, unknown> = {}) {
  const info = {
    spotMetaAndAssetCtxs: vi.fn(() => Promise.resolve([spotMeta, assetCtxs])),
    allMids: vi.fn(() => Promise.resolve({ "@107": "83.954", "PURR/USDC": "0.2", BTC: "77000", "@999": "1" })),
    l2Book: vi.fn(() => Promise.resolve({ coin: "@107", time: 1, levels: [[{ px: "83.913", sz: "1", n: 1 }], [{ px: "83.914", sz: "2", n: 1 }]] })),
    candleSnapshot: vi.fn(() => Promise.resolve([{ t: 100, T: 199, s: "@107", i: "1h", o: "85.10", c: "86.068", h: "9", l: "1", v: "1", n: 1 }])),
    spotClearinghouseState: vi.fn(() => Promise.resolve({ balances: [{ coin: "USDC", token: 0, total: "20.50000000", hold: "10.0", entryNtl: "0" }, { coin: "HYPE", token: 150, total: "0.25", hold: "0.0", entryNtl: "0" }, { coin: "+1", total: "1", hold: "0", entryNtl: "0" }] })),
    clearinghouseState: vi.fn(() => Promise.resolve({ marginSummary: { accountValue: "12.5", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" }, assetPositions: [{ type: "oneWay", position: { coin: "BTC", szi: "-0.1" } }, { type: "oneWay", position: { coin: "ETH", szi: "0.0" } }] })),
    frontendOpenOrders: vi.fn(() => Promise.resolve([
      { coin: "@107", side: "B", limitPx: "83.5", sz: "0.25", oid: 7, timestamp: 1000, cloid: CLOID },
      { coin: "BTC", side: "A", limitPx: "80000", sz: "0.1", oid: 8, timestamp: 1001, cloid: null },
      { coin: "xyz:GOLD", side: "A", limitPx: "4000", sz: "1", oid: 9, timestamp: 1002, cloid: null },
    ])),
    userFillsByTime: vi.fn(() => Promise.resolve([
      { coin: "@107", px: "84", sz: "0.5", side: "B", time: 5, oid: 1, fee: "0.0003", feeToken: "HYPE", cloid: CLOID },
      { coin: "@107", px: "85", sz: "0.5", side: "A", time: 6, oid: 2, fee: "0.02", feeToken: "USDC" },
      { coin: "BTC", px: "1", sz: "1", side: "B", time: 7, oid: 3, fee: "0", feeToken: "USDC" },
      { coin: "@107", px: "85", sz: "0.1", side: "A", time: 8, oid: 4, fee: "-0.001", feeToken: "USDC" },
    ])),
    userNonFundingLedgerUpdates: vi.fn(() => Promise.resolve([
      { time: 1, hash: "0x", delta: { type: "deposit", usdc: "100.0" } },
      { time: 2, hash: "0x", delta: { type: "withdraw", usdc: "5", nonce: 1, fee: "1" } },
      { time: 3, hash: "0x", delta: { type: "spotTransfer", token: "USDC", amount: "20.5", usdcValue: "20.5", user: "0xaaaa", destination: MASTER.toLowerCase(), fee: "0", nativeTokenFee: "0", nonce: null, feeToken: "USDC" } },
      { time: 4, hash: "0x", delta: { type: "send", user: MASTER, destination: "0xbbbb", sourceDex: "spot", destinationDex: "spot", token: "USDC:0xeb62", amount: "7", usdcValue: "7", fee: "0", nativeTokenFee: "0", nonce: 1, feeToken: "USDC" } },
      { time: 5, hash: "0x", delta: { type: "spotTransfer", token: "HYPE", amount: "3", usdcValue: "250", user: "0xaaaa", destination: MASTER, fee: "0", nativeTokenFee: "0", nonce: null, feeToken: "HYPE" } },
      { time: 6, hash: "0x", delta: { type: "accountClassTransfer", usdc: "50", toPerp: true } },
      { time: 7, hash: "0x", delta: { type: "internalTransfer", usdc: "2", user: "0xcccc", destination: MASTER, fee: "0" } },
    ])),
    extraAgents: vi.fn(() => Promise.resolve([{ address: "0xABCDEF0000000000000000000000000000000001", name: "agent-treasury valid_until 1", validUntil: 1_800_000_000_000 }, { address: "0x2", name: "", validUntil: null }])),
    ...over,
  };
  return info;
}
function makeEx(over: Record<string, unknown> = {}) {
  return {
    order: vi.fn(() => Promise.resolve({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.12", avgPx: "84.30", oid: 55 } }] } } })),
    cancel: vi.fn(() => Promise.resolve({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } })),
    scheduleCancel: vi.fn(() => Promise.resolve({ status: "ok", response: { type: "default" } })),
    ...over,
  };
}
function setup(infoOver: Record<string, unknown> = {}, exOver: Record<string, unknown> = {}) {
  const info = makeInfo(infoOver);
  const ex = makeEx(exOver);
  const hl = new NktkasHl({ info: info as unknown as HlInfoApi, exchange: ex as unknown as HlExchangeApi, now: () => 4242 });
  return { info, ex, hl };
}
function ord(over: Partial<HlPlaceOrder> = {}): HlPlaceOrder {
  return { assetId: 10107, isBuy: true, price: "84.3", size: "0.12", tif: "Ioc", cloid: CLOID, ...over };
}

describe("getSpotPairs", () => {
  it("maps universe to display names, asset ids 10000+index, szDecimals, volume and mid", async () => {
    const { hl } = setup();
    const pairs = await hl.getSpotPairs();
    expect(pairs.find((p) => p.name === "HYPE/USDC")).toEqual({ name: "HYPE/USDC", base: "HYPE", assetId: 10107, szDecimals: 2, volume24hUsdc: "85046957.58225", midUsdc: "83.9795" });
    expect(pairs.find((p) => p.name === "PURR/USDC")).toMatchObject({ assetId: 10000, szDecimals: 0 });
    expect(pairs.find((p) => p.name === "HYPE/USDH")).toMatchObject({ assetId: 10207, midUsdc: null, volume24hUsdc: "0" });
  });
  it("drops names shared by several non-canonical tokens (look-alike protection)", async () => {
    const { hl } = setup();
    expect((await hl.getSpotPairs()).some((p) => p.name === "FAKE/USDC")).toBe(false);
    await expect(hl.getBook("FAKE/USDC")).rejects.toThrow(/unknown or ambiguous/);
  });
  it("prefers the canonical token on a name collision", async () => {
    const meta = {
      universe: [
        { tokens: [1, 0], name: "@1", index: 1, isCanonical: false },
        { tokens: [2, 0], name: "@2", index: 2, isCanonical: true },
      ],
      tokens: [
        { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, isCanonical: true },
        { name: "ABC", szDecimals: 1, weiDecimals: 8, index: 1, isCanonical: false },
        { name: "ABC", szDecimals: 3, weiDecimals: 8, index: 2, isCanonical: true },
      ],
    };
    const { hl } = setup({ spotMetaAndAssetCtxs: vi.fn(() => Promise.resolve([meta, [ctx("@1", "1", "1"), ctx("@2", "2", "2")]])) });
    const pairs = await hl.getSpotPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ assetId: 10002, szDecimals: 3, midUsdc: "2" });
  });
});

describe("market data", () => {
  it("maps allMids coin names to display pairs and drops perps and unknown spot coins", async () => {
    const { hl } = setup();
    expect(await hl.getMids()).toEqual({ mids: { "HYPE/USDC": "83.954", "PURR/USDC": "0.2" }, atMs: 4242 });
  });
  it("uses the HL coin name for book and candles", async () => {
    const { hl, info } = setup();
    expect(await hl.getBook("HYPE/USDC")).toEqual({ bid: "83.913", ask: "83.914", atMs: 4242 });
    expect(info.l2Book).toHaveBeenCalledWith({ coin: "@107" });
    expect(await hl.getCandles("HYPE/USDC", "1h", 10, 20)).toEqual([{ openTimeMs: 100, closeTimeMs: 199, open: "85.1", close: "86.068" }]);
    expect(info.candleSnapshot).toHaveBeenCalledWith({ coin: "@107", interval: "1h", startTime: 10, endTime: 20 });
  });
  it("returns null sides for an empty book", async () => {
    const { hl } = setup({ l2Book: vi.fn(() => Promise.resolve({ coin: "@107", time: 1, levels: [[], []] })) });
    expect(await hl.getBook("HYPE/USDC")).toEqual({ bid: null, ask: null, atMs: 4242 });
  });
});

describe("account state", () => {
  it("maps spot balances (normalized) and skips pseudo coins", async () => {
    const { hl, info } = setup();
    expect(await hl.getSpotBalances(MASTER)).toEqual([{ coin: "USDC", total: "20.5", hold: "10" }, { coin: "HYPE", total: "0.25", hold: "0" }]);
    expect(info.spotClearinghouseState).toHaveBeenCalledWith({ user: MASTER.toLowerCase() });
  });
  it("reports non-zero perp positions, open perp orders (incl. HIP-3) and account value", async () => {
    const { hl } = setup();
    expect(await hl.getPerpState(MASTER)).toEqual({ positions: [{ coin: "BTC", size: "-0.1" }], openPerpOrders: 2, accountValueUsdc: "12.5" });
  });
  it("maps open orders and marks perps", async () => {
    const { hl } = setup();
    const o = await hl.getOpenOrders(MASTER);
    expect(o[0]).toEqual({ oid: 7, cloid: CLOID, market: "spot", pair: "HYPE/USDC", side: "buy", price: "83.5", size: "0.25", placedAtMs: 1000 });
    expect(o[1]).toMatchObject({ market: "perp", pair: "BTC", side: "sell", cloid: null });
    expect(o[2]).toMatchObject({ market: "perp", pair: "xyz:GOLD" });
  });
  it("maps spot fills only, converts base-token fees to USDC, ignores rebates", async () => {
    const { hl, info } = setup();
    const f = await hl.getUserFills(MASTER, 99);
    expect(info.userFillsByTime).toHaveBeenCalledWith({ user: MASTER.toLowerCase(), startTime: 99 });
    expect(f).toHaveLength(3);
    expect(f[0]).toEqual({ oid: 1, cloid: CLOID, pair: "HYPE/USDC", side: "buy", price: "84", size: "0.5", feeUsdc: "0.0252", timeMs: 5 });
    expect(f[1]).toMatchObject({ side: "sell", feeUsdc: "0.02", cloid: null });
    expect(f[2]?.feeUsdc).toBe("0");
  });
  it("maps ledger flows of USDC only", async () => {
    const { hl } = setup();
    expect(await hl.getLedger(MASTER, 0)).toEqual([
      { timeMs: 1, kind: "deposit", usdc: "100" },
      { timeMs: 2, kind: "withdraw", usdc: "5" },
      { timeMs: 3, kind: "transfer_in", usdc: "20.5" },
      { timeMs: 4, kind: "transfer_out", usdc: "7" },
      { timeMs: 7, kind: "transfer_in", usdc: "2" },
    ]);
  });
  it("maps approved agents (lower-case address, empty name -> null, validUntil in ms)", async () => {
    const { hl } = setup();
    expect(await hl.getApprovedAgents(MASTER)).toEqual([
      { address: "0xabcdef0000000000000000000000000000000001", name: "agent-treasury valid_until 1", validUntilMs: 1_800_000_000_000 },
      { address: "0x2", name: null, validUntilMs: null },
    ]);
  });
  it("rejects malformed account addresses before any request", async () => {
    const { hl, info } = setup();
    await expect(hl.getSpotBalances("0x123")).rejects.toThrow(/bad HL address/);
    expect(info.spotClearinghouseState).not.toHaveBeenCalled();
  });
});

describe("placeSpotOrder", () => {
  it("signs a spot limit order with the cloid and no reduce-only", async () => {
    const { hl, ex } = setup();
    const r = await hl.placeSpotOrder(ord());
    expect(r).toEqual({ status: "filled", oid: 55, filledSize: "0.12", avgPx: "84.3" });
    expect(ex.order).toHaveBeenCalledWith({ orders: [{ a: 10107, b: true, p: "84.3", s: "0.12", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }], grouping: "na" });
  });
  it("refuses perp ids and unknown ids without touching the exchange", async () => {
    const { hl, ex } = setup();
    for (const assetId of [0, 1, 9999, -1, 10107.5]) await expect(hl.placeSpotOrder(ord({ assetId }))).rejects.toThrow(/not a spot asset/);
    await expect(hl.placeSpotOrder(ord({ assetId: 19999 }))).rejects.toThrow(/not a known spot pair/);
    expect(ex.order).not.toHaveBeenCalled();
  });
  it("validates price, size, cloid and tif", async () => {
    const { hl, ex } = setup();
    await expect(hl.placeSpotOrder(ord({ price: "0" }))).rejects.toThrow(/bad order price/);
    await expect(hl.placeSpotOrder(ord({ price: "1e3" }))).rejects.toThrow(/bad order price/);
    await expect(hl.placeSpotOrder(ord({ size: "-1" }))).rejects.toThrow(/bad order size/);
    await expect(hl.placeSpotOrder(ord({ cloid: "0x1234" }))).rejects.toThrow(/bad cloid/);
    await expect(hl.placeSpotOrder(ord({ tif: "Alo" as unknown as "Ioc" }))).rejects.toThrow(/unsupported tif/);
    expect(ex.order).not.toHaveBeenCalled();
  });
  it("maps resting", async () => {
    const { hl } = setup({}, { order: vi.fn(() => Promise.resolve({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 91 } }] } } })) });
    expect(await hl.placeSpotOrder(ord({ tif: "Gtc" }))).toEqual({ status: "resting", oid: 91 });
  });
  it("maps an IOC without liquidity to unfilled and other API errors to rejected", async () => {
    const noMatch = new ApiRequestError({}, "order 0: Order could not immediately match against any resting orders. asset=10107");
    const bad = new ApiRequestError({}, "order 0: Insufficient spot balance asset=10107");
    expect(await setup({}, { order: vi.fn(() => Promise.reject(noMatch)) }).hl.placeSpotOrder(ord())).toEqual({ status: "unfilled" });
    expect(await setup({}, { order: vi.fn(() => Promise.reject(bad)) }).hl.placeSpotOrder(ord())).toEqual({ status: "rejected", error: bad.message });
  });
  it("propagates transport failures: the order outcome is unknown", async () => {
    const { hl } = setup({}, { order: vi.fn(() => Promise.reject(new Error("socket hang up"))) });
    await expect(hl.placeSpotOrder(ord())).rejects.toThrow("socket hang up");
  });
  it("rejects unexpected status shapes", async () => {
    const { hl } = setup({}, { order: vi.fn(() => Promise.resolve({ status: "ok", response: { type: "order", data: { statuses: ["waitingForFill"] } } })) });
    expect(await hl.placeSpotOrder(ord())).toMatchObject({ status: "rejected" });
  });
});

describe("cancelOrders / scheduleCancel", () => {
  it("cancels in one signed action", async () => {
    const { hl, ex } = setup();
    await hl.cancelOrders([{ assetId: 10107, oid: 1 }, { assetId: 10000, oid: 2 }]);
    expect(ex.cancel).toHaveBeenCalledWith({ cancels: [{ a: 10107, o: 1 }, { a: 10000, o: 2 }] });
    await hl.cancelOrders([]);
    expect(ex.cancel).toHaveBeenCalledTimes(1);
  });
  it("refuses perp ids and treats already-gone orders as success", async () => {
    const { hl, ex } = setup();
    await expect(hl.cancelOrders([{ assetId: 5, oid: 1 }])).rejects.toThrow(/not a spot asset/);
    expect(ex.cancel).not.toHaveBeenCalled();
    const gone = setup({}, { cancel: vi.fn(() => Promise.reject(new ApiRequestError({}, "cancel 0: Order was never placed, already canceled, or filled."))) });
    await expect(gone.hl.cancelOrders([{ assetId: 10107, oid: 1 }])).resolves.toBeUndefined();
    const other = setup({}, { cancel: vi.fn(() => Promise.reject(new ApiRequestError({}, "cancel 0: Too many requests"))) });
    await expect(other.hl.cancelOrders([{ assetId: 10107, oid: 1 }])).rejects.toThrow("Too many");
  });
  it("sets and clears the dead-man switch", async () => {
    const { hl, ex } = setup();
    await hl.scheduleCancel(1_700_000_180_000);
    expect(ex.scheduleCancel).toHaveBeenLastCalledWith({ time: 1_700_000_180_000 });
    await hl.scheduleCancel(null);
    expect(ex.scheduleCancel).toHaveBeenLastCalledWith();
    await expect(hl.scheduleCancel(-5)).rejects.toThrow(/bad scheduleCancel/);
    await expect(hl.scheduleCancel(1.5)).rejects.toThrow(/bad scheduleCancel/);
  });
});

describe("createNktkasHl", () => {
  it("builds clients for both networks from an injected wallet without any request", () => {
    const wallet = { address: "0x1111111111111111111111111111111111111111" as const, signTypedData: () => Promise.resolve("0x" as const) };
    expect(createNktkasHl({ network: "testnet", wallet })).toBeInstanceOf(NktkasHl);
    expect(createNktkasHl({ network: "mainnet", wallet, timeoutMs: 1000 })).toBeInstanceOf(NktkasHl);
  });
});
