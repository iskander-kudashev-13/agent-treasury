import { describe, expect, it } from "vitest";
import {
  MIN_NOTIONAL,
  type OrderCandidate,
  type RiskContext,
  SCALE,
  checkOrder,
  cloidPrefix,
  cooldownActive,
  effectiveLimits,
  fx,
  fxStr,
  makeCloid,
  roundPrice,
  roundSizeDown,
  sizeOrder,
} from "../../src/trading/engine/risk.js";
import type { Action, HardLimits, RuleSetV1 } from "../../src/trading/types.js";

const hard: HardLimits = {
  maxPositionUsdc: "50",
  maxOrderUsdc: "20",
  dailyLossUsdc: "10",
  maxOrdersPerDay: 20,
  allowedPairs: ["HYPE/USDC"],
  minPairVolumeUsdc: "1000000",
  priceBandBps: 100,
};

describe("fixed point", () => {
  it("parses and formats", () => {
    expect(fx("12.5")).toBe(12n * SCALE + SCALE / 2n);
    expect(fxStr(fx("-0.034"))).toBe("-0.034");
    expect(fxStr(fx("10.000000"))).toBe("10");
    expect(fxStr(fx("1.23456789"), 6)).toBe("1.234567");
    expect(fxStr(fx("-0.0000001"))).toBe("0");
    expect(() => fx("1e5")).toThrow();
  });
});

describe("rounding", () => {
  it("sizes round down to szDecimals", () => {
    expect(roundSizeDown(fx("0.299999"), 2)).toBe(fx("0.29"));
    expect(roundSizeDown(fx("5.9"), 0)).toBe(fx("5"));
  });
  it("prices: 5 significant figures, buy down / sell up", () => {
    expect(fxStr(roundPrice(fx("40.4049"), 2, "down"), 8)).toBe("40.404");
    expect(fxStr(roundPrice(fx("40.4041"), 2, "up"), 8)).toBe("40.405");
    expect(fxStr(roundPrice(fx("40.404"), 2, "up"), 8)).toBe("40.404"); // exact stays
    expect(fxStr(roundPrice(fx("0.0123456"), 0, "down"), 8)).toBe("0.012345");
    expect(fxStr(roundPrice(fx("0.0123451"), 0, "up"), 8)).toBe("0.012346");
  });
  it("prices: at most 8 - szDecimals decimals", () => {
    // szDecimals 6 -> 2 decimals even though 5 sig figs would allow 4
    expect(fxStr(roundPrice(fx("1.2345"), 6, "down"), 8)).toBe("1.23");
    expect(fxStr(roundPrice(fx("1.2345"), 6, "up"), 8)).toBe("1.24");
  });
  it("prices: integers are always allowed, carry works", () => {
    expect(fxStr(roundPrice(fx("123456.7"), 2, "down"), 8)).toBe("123456");
    expect(fxStr(roundPrice(fx("123456.2"), 2, "up"), 8)).toBe("123457");
    expect(fxStr(roundPrice(fx("9.999951"), 2, "up"), 8)).toBe("10");
  });
});

describe("cloid", () => {
  const h = "ab".repeat(32);
  it("is 0x + 8 bytes of hash + big-endian counter (32 hex)", () => {
    expect(cloidPrefix(h)).toBe("0xabababababababab");
    expect(makeCloid(h, 255)).toBe("0xabababababababab00000000000000ff");
    expect(makeCloid(h, 1)).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

describe("cooldown", () => {
  it("is active only inside the window", () => {
    expect(cooldownActive(1000, undefined, 500)).toBe(false);
    expect(cooldownActive(1000, 600, undefined)).toBe(false);
    expect(cooldownActive(1000, 600, 500)).toBe(true);
    expect(cooldownActive(1100, 600, 500)).toBe(false);
  });
});

describe("effectiveLimits", () => {
  const rs = (l: Partial<RuleSetV1["limits"]>): RuleSetV1 => ({
    version: 1,
    name: "x",
    pairs: ["HYPE/USDC"],
    limits: { max_position_usdc: "30", max_order_usdc: "15", daily_loss_stop_usdc: "4", max_orders_per_day: 3, ...l },
    rules: [],
  });
  it("takes the tighter of rule and hard", () => {
    const e = effectiveLimits(rs({}), hard);
    expect([e.maxPosition, e.maxOrder, e.dailyLossStop, e.maxOrdersPerDay]).toEqual([fx("30"), fx("15"), fx("4"), 3]);
  });
  it("never loosens beyond hard", () => {
    const e = effectiveLimits(rs({ max_position_usdc: "500", max_order_usdc: "500", daily_loss_stop_usdc: "500", max_orders_per_day: 50 }), hard);
    expect([e.maxPosition, e.maxOrder, e.dailyLossStop, e.maxOrdersPerDay]).toEqual([fx("50"), fx("20"), fx("10"), 20]);
  });
});

describe("sizeOrder", () => {
  const buy = (o: Action["order"], size: Action["size"] = { usdc: "12" }): Action => ({ side: "buy", size, order: o });
  const sell = (o: Action["order"], size: Action["size"] = { usdc: "12" }): Action => ({ side: "sell", size, order: o });
  const base = { mid: fx("40"), priceBandBps: 100, szDecimals: 2, freeBase: fx("1") };

  it("ioc buy sits at the band edge and rounds down; size = usdc / price rounded down", () => {
    const r = sizeOrder({ ...base, action: buy({ type: "ioc" }) });
    expect(r).toMatchObject({ ok: true, tif: "Ioc", ttl: null });
    if (!r.ok) return;
    expect(fxStr(r.price, 8)).toBe("40.4"); // 40 * 1.01
    expect(fxStr(r.size, 8)).toBe("0.29"); // 12 / 40.4 = 0.2970 -> 0.29
  });
  it("ioc sell sits at mid*(1-band), rounded up", () => {
    const r = sizeOrder({ ...base, mid: fx("40.01"), action: sell({ type: "ioc" }) });
    if (!r.ok) throw new Error("expected ok");
    expect(fxStr(r.price, 8)).toBe("39.61"); // 39.6099 -> up
  });
  it("limit orders: offset below mid for buys, above for sells, GTC with ttl", () => {
    const b = sizeOrder({ ...base, action: buy({ type: "limit", offset_pct: "2.5", ttl: "1h" }) });
    const s = sizeOrder({ ...base, action: sell({ type: "limit", offset_pct: "2.5", ttl: "4h" }) });
    if (!b.ok || !s.ok) throw new Error("expected ok");
    expect(fxStr(b.price, 8)).toBe("39"); // 40 * 0.975
    expect(fxStr(s.price, 8)).toBe("41"); // 40 * 1.025
    expect([b.tif, b.ttl, s.ttl]).toEqual(["Gtc", "1h", "4h"]);
  });
  it("position_pct sells a share of the free base, rounded down", () => {
    const r = sizeOrder({ ...base, freeBase: fx("1.239"), action: sell({ type: "ioc" }, { position_pct: "50" }) });
    if (!r.ok) throw new Error("expected ok");
    expect(fxStr(r.size, 8)).toBe("0.61"); // 0.6195 -> 0.61
  });
  it("size that rounds to zero is reported, not bumped", () => {
    expect(sizeOrder({ ...base, szDecimals: 0, action: buy({ type: "ioc" }, { usdc: "10" }) })).toMatchObject({ ok: false, code: "SIZE_ZERO" });
    expect(sizeOrder({ ...base, freeBase: 0n, action: sell({ type: "ioc" }, { position_pct: "100" }) })).toMatchObject({ ok: false, code: "SIZE_ZERO" });
    expect(sizeOrder({ ...base, mid: 0n, action: buy({ type: "ioc" }) })).toMatchObject({ ok: false, code: "NO_PRICE" });
  });
  it("a notional of exactly 10 USDC rounds below the HL minimum (documented consequence)", () => {
    const r = sizeOrder({ ...base, action: buy({ type: "ioc" }, { usdc: "10" }) });
    if (!r.ok) throw new Error("expected ok");
    expect(r.size * r.price / SCALE).toBeLessThan(MIN_NOTIONAL);
  });
});

describe("checkOrder", () => {
  const cand = (o: Partial<OrderCandidate> = {}): OrderCandidate => ({ pair: "HYPE/USDC", assetId: 10107, side: "buy", price: fx("40.4"), size: fx("0.3"), ...o });
  const ctx = (c: Partial<RiskContext> = {}): RiskContext => ({
    nowMs: 1_000_000,
    tickMs: 60_000,
    allowedPairs: ["HYPE/USDC"],
    rulePairs: ["HYPE/USDC"],
    priceBandBps: 100,
    limits: { maxPosition: fx("50"), maxOrder: fx("20"), dailyLossStop: fx("10"), maxOrdersPerDay: 3 },
    ordersToday: 0,
    mid: fx("40"),
    book: { bid: fx("39.99"), ask: fx("40.01"), atMs: 1_000_000 },
    freeUsdc: fx("100"),
    freeBase: fx("2"),
    positionValue: 0n,
    openBuyValue: 0n,
    lastFiredAtMs: undefined,
    cooldownMs: undefined,
    ...c,
  });
  const code = (o: OrderCandidate, c: RiskContext) => {
    const r = checkOrder(o, c);
    return r.ok ? "ok" : r.code;
  };

  it("accepts a clean order and returns its notional", () => {
    const r = checkOrder(cand(), ctx());
    expect(r).toEqual({ ok: true, notional: fx("12.12") });
  });
  it("refuses perp asset ids (< 10000)", () => {
    expect(code(cand({ assetId: 9999 }), ctx())).toBe("SPOT_ONLY");
    expect(code(cand({ assetId: 0 }), ctx())).toBe("SPOT_ONLY");
    expect(code(cand({ assetId: 10000 }), ctx())).toBe("ok");
  });
  it("pair must be in the hard allowlist and in the rule set", () => {
    expect(code(cand({ pair: "PURR/USDC" }), ctx())).toBe("PAIR_NOT_ALLOWED");
    expect(code(cand(), ctx({ rulePairs: ["PURR/USDC"] }))).toBe("PAIR_NOT_IN_RULES");
  });
  it("band edge is inclusive; one tick beyond is rejected (buy and sell)", () => {
    expect(code(cand({ price: fx("40.4") }), ctx())).toBe("ok"); // exactly +100 bps
    expect(code(cand({ price: fx("40.401") }), ctx())).toBe("PRICE_BAND");
    expect(code(cand({ side: "sell", price: fx("39.6") }), ctx())).toBe("ok"); // exactly -100 bps
    expect(code(cand({ side: "sell", price: fx("39.599") }), ctx())).toBe("PRICE_BAND");
    // far on the safe side is fine
    expect(code(cand({ price: fx("30") }), ctx())).toBe("MIN_NOTIONAL"); // 9 USDC, but not a band problem
    expect(code(cand({ side: "sell", price: fx("50") }), ctx())).toBe("ok");
  });
  it("band uses the configured bps", () => {
    expect(code(cand({ price: fx("40.2") }), ctx({ priceBandBps: 40 }))).toBe("PRICE_BAND");
    expect(code(cand({ price: fx("40.16") }), ctx({ priceBandBps: 40 }))).toBe("ok");
  });
  it("min notional is 10 USDC, inclusive", () => {
    expect(code(cand({ price: fx("40"), size: fx("0.25") }), ctx())).toBe("ok"); // exactly 10
    expect(code(cand({ price: fx("40"), size: fx("0.2499") }), ctx())).toBe("MIN_NOTIONAL");
  });
  it("max order", () => {
    expect(code(cand({ price: fx("40"), size: fx("0.5") }), ctx())).toBe("ok"); // exactly 20
    expect(code(cand({ price: fx("40"), size: fx("0.51") }), ctx())).toBe("MAX_ORDER");
  });
  it("max orders per day", () => {
    expect(code(cand(), ctx({ ordersToday: 2 }))).toBe("ok");
    expect(code(cand(), ctx({ ordersToday: 3 }))).toBe("MAX_ORDERS_PER_DAY");
  });
  it("position cap counts held base and open buy orders", () => {
    expect(code(cand(), ctx({ positionValue: fx("37.88") }))).toBe("ok"); // 37.88 + 12.12 = 50
    expect(code(cand(), ctx({ positionValue: fx("37.89") }))).toBe("POSITION_CAP");
    expect(code(cand(), ctx({ openBuyValue: fx("37.89") }))).toBe("POSITION_CAP");
    expect(code(cand(), ctx({ positionValue: fx("20"), openBuyValue: fx("20") }))).toBe("POSITION_CAP");
    // sells are not capped by the position cap
    expect(code(cand({ side: "sell", price: fx("40") }), ctx({ positionValue: fx("49"), freeBase: fx("1") }))).toBe("ok");
  });
  it("balances", () => {
    expect(code(cand(), ctx({ freeUsdc: fx("12") }))).toBe("INSUFFICIENT_USDC");
    expect(code(cand({ side: "sell", price: fx("40") }), ctx({ freeBase: fx("0.29") }))).toBe("INSUFFICIENT_BASE");
  });
  it("cooldown", () => {
    expect(code(cand(), ctx({ lastFiredAtMs: 999_000, cooldownMs: 3_600_000 }))).toBe("COOLDOWN");
    expect(code(cand(), ctx({ lastFiredAtMs: 1_000_000 - 3_600_000, cooldownMs: 3_600_000 }))).toBe("ok");
  });
  it("book: stale, empty, crossed, wide spread", () => {
    expect(code(cand(), ctx({ book: { bid: fx("39.99"), ask: fx("40.01"), atMs: 1_000_000 - 120_001 } }))).toBe("STALE_BOOK");
    expect(code(cand(), ctx({ book: { bid: null, ask: fx("40.01"), atMs: 1_000_000 } }))).toBe("BOOK_EMPTY");
    expect(code(cand(), ctx({ book: { bid: fx("40.1"), ask: fx("40"), atMs: 1_000_000 } }))).toBe("BOOK_EMPTY");
    expect(code(cand(), ctx({ book: { bid: fx("39.5"), ask: fx("40.5"), atMs: 1_000_000 } }))).toBe("SPREAD_TOO_WIDE"); // 2.5% > 1%
    expect(code(cand(), ctx({ book: { bid: fx("39.8"), ask: fx("40.2"), atMs: 1_000_000 } }))).toBe("ok"); // exactly 1%
  });
  it("rejects non-positive numbers", () => {
    expect(code(cand({ size: 0n }), ctx())).toBe("BAD_ORDER");
    expect(code(cand(), ctx({ mid: 0n }))).toBe("BAD_ORDER");
  });
});
