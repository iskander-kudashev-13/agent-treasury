import { describe, expect, it } from "vitest";
import { costBasis } from "../../src/trading/engine/pnl.js";
import { fx } from "../../src/trading/engine/risk.js";
import { DURATION_MS, type TriggerEnv, evalTrigger, referenceClose } from "../../src/trading/engine/triggers.js";
import type { HlCandle, HlFill, Trigger } from "../../src/trading/types.js";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const candle = (openTimeMs: number, close: string): HlCandle => ({ openTimeMs, closeTimeMs: openTimeMs + H - 1, open: close, close });

const env = (o: Partial<TriggerEnv> & { candles?: HlCandle[] } = {}): TriggerEnv => ({
  nowMs: NOW,
  pair: "HYPE/USDC",
  mid: fx("40"),
  lastFiredAtMs: undefined,
  cost: { size: 0n, avgCost: 0n },
  getCandles: () => Promise.resolve(o.candles ?? []),
  ...o,
});
const fired = async (t: Trigger, e: TriggerEnv) => (await evalTrigger(t, e)).fired;

describe("price", () => {
  it("lte / gte are inclusive", async () => {
    expect(await fired({ type: "price", op: "lte", usdc: "40" }, env())).toBe(true);
    expect(await fired({ type: "price", op: "lte", usdc: "39.999999" }, env())).toBe(false);
    expect(await fired({ type: "price", op: "gte", usdc: "40" }, env())).toBe(true);
    expect(await fired({ type: "price", op: "gte", usdc: "40.000001" }, env())).toBe(false);
  });
});

describe("interval", () => {
  it("fires immediately the first time, then once per period", async () => {
    const t: Trigger = { type: "interval", every: "1h" };
    expect(await fired(t, env())).toBe(true);
    expect(await fired(t, env({ lastFiredAtMs: NOW - H + 1 }))).toBe(false);
    expect(await fired(t, env({ lastFiredAtMs: NOW - H }))).toBe(true);
  });
  it("supports 1w", async () => {
    const t: Trigger = { type: "interval", every: "1w" };
    expect(await fired(t, env({ lastFiredAtMs: NOW - DURATION_MS["1w"] + 1 }))).toBe(false);
    expect(await fired(t, env({ lastFiredAtMs: NOW - DURATION_MS["1w"] }))).toBe(true);
  });
});

describe("price_change", () => {
  const day = DURATION_MS["1d"];
  it("referenceClose picks the close of the last candle that closed at or before now - window", () => {
    const cs = [candle(NOW - day - 3 * H, "50"), candle(NOW - day - H, "42"), candle(NOW - day, "41"), candle(NOW - H, "40")];
    // candle opening at now-day-1h closes exactly at now-day: qualifies; the one opening at now-day does not
    expect(referenceClose(cs, NOW, "1d")).toBe(fx("42"));
    expect(referenceClose([candle(NOW - day, "41")], NOW, "1d")).toBeNull();
    expect(referenceClose([], NOW, "1h")).toBeNull();
  });
  it("lte: -4.7% passes -3, -2.4% does not", async () => {
    const t: Trigger = { type: "price_change", window: "1d", op: "lte", pct: "-3" };
    expect(await fired(t, env({ candles: [candle(NOW - day - H, "42")] }))).toBe(true); // 40 vs 42 = -4.76%
    expect(await fired(t, env({ candles: [candle(NOW - day - H, "41")] }))).toBe(false); // -2.44%
  });
  it("boundary is exact: exactly -3.00% fires for lte", async () => {
    const t: Trigger = { type: "price_change", window: "1d", op: "lte", pct: "-3" };
    expect(await fired(t, env({ mid: fx("97"), candles: [candle(NOW - day - H, "100")] }))).toBe(true);
    expect(await fired(t, env({ mid: fx("97.000001"), candles: [candle(NOW - day - H, "100")] }))).toBe(false);
  });
  it("gte on a rise", async () => {
    const t: Trigger = { type: "price_change", window: "4h", op: "gte", pct: "5.5" };
    expect(await fired(t, env({ mid: fx("105.5"), candles: [candle(NOW - 4 * H - H, "100")] }))).toBe(true);
    expect(await fired(t, env({ mid: fx("105.49"), candles: [candle(NOW - 4 * H - H, "100")] }))).toBe(false);
  });
  it("asks the port for 1h candles around the reference time", async () => {
    let seen: unknown[] = [];
    await evalTrigger({ type: "price_change", window: "1h", op: "lte", pct: "-1" }, env({ getCandles: (...a) => ((seen = a), Promise.resolve([])) }));
    expect(seen[1]).toBe("1h");
  });
  it("no reference candle means false (and says why)", async () => {
    const r = await evalTrigger({ type: "price_change", window: "1d", op: "lte", pct: "-3" }, env());
    expect(r).toEqual({ fired: false, detail: "no reference candle" });
  });
});

describe("position_pnl", () => {
  const prefix = "0xaaaaaaaaaaaaaaaa";
  const fill = (side: "buy" | "sell", price: string, size: string, t: number, cloid: string | null = `${prefix}0000000000000001`): HlFill => ({
    oid: t,
    cloid,
    pair: "HYPE/USDC",
    side,
    price,
    size,
    feeUsdc: "0",
    timeMs: t,
  });
  const t: Trigger = { type: "position_pnl", op: "gte", pct: "10" };

  it("false when flat", async () => {
    expect(await fired(t, env({ cost: costBasis([], "HYPE/USDC", prefix) }))).toBe(false);
    const closed = [fill("buy", "30", "1", 1), fill("sell", "40", "1", 2)];
    expect(await fired(t, env({ cost: costBasis(closed, "HYPE/USDC", prefix) }))).toBe(false);
  });
  it("uses the average cost of fills under this rule set only", async () => {
    const fills = [fill("buy", "30", "1", 1), fill("buy", "40", "1", 2), fill("buy", "1", "100", 3, "0xbbbbbbbbbbbbbbbb0000000000000001"), fill("buy", "1", "100", 4, null)];
    const cost = costBasis(fills, "HYPE/USDC", prefix);
    expect(cost).toEqual({ size: fx("2"), avgCost: fx("35") });
    expect(await fired(t, env({ mid: fx("38.5"), cost }))).toBe(true); // +10.0%
    expect(await fired(t, env({ mid: fx("38.49"), cost }))).toBe(false);
    expect(await fired({ type: "position_pnl", op: "lte", pct: "-10" }, env({ mid: fx("31.5"), cost }))).toBe(true);
  });
  it("a partial sell keeps the average cost", () => {
    const cost = costBasis([fill("buy", "30", "1", 1), fill("buy", "40", "1", 2), fill("sell", "50", "1", 3)], "HYPE/USDC", prefix);
    expect(cost).toEqual({ size: fx("1"), avgCost: fx("35") });
  });
});
