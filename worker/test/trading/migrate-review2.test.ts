/** migrateV1 rebuilds base-token buy fees (feeBase) from the v1 USDC fee total, erring toward a smaller position. */
import { describe, expect, it } from "vitest";
import { initialEngineStateV1, migrateV1 } from "../../src/trading/engine/migrate.js";
import type { V1Tracker } from "../../src/trading/engine/migrate.js";

const tracker = (total: V1Tracker["total"]): V1Tracker => ({ cursorMs: 1, seen: [], totalComplete: true, todayFromMs: null, total, today: {}, botFillsToday: 0, foreignFills: 0 });
const agg = (cash: string, dq: string, fees: string, lastPx: string) => ({ cash, dq, fees, lastPx });
const run = (total: V1Tracker["total"]) => migrateV1({ ...initialEngineStateV1(), fills: tracker(total) }).state.bots["default"]?.agg.total["X/USDC"];

describe("migrateV1 feeBase estimate", () => {
  it("buys only: fee value / price", () => {
    expect(run({ "X/USDC": agg("-41.2155", "9", "0.02885085", "4.5795") })?.feeBase).toBe("0.0063");
  });
  it("last price above the average buy price: the lower (average) price is used, so the position is not overstated", () => {
    const a = run({ "X/USDC": agg("-40", "10", "0.02", "8") });
    expect(a?.feeBase).toBe("0.005"); // 0.02 / 4, not 0.02 / 8
  });
  it("no fees or no position: nothing invented; an existing feeBase is kept", () => {
    expect(run({ "X/USDC": agg("-40", "10", "0", "4") })?.feeBase).toBeUndefined();
    expect(run({ "X/USDC": agg("40", "-10", "0.1", "4") })?.feeBase).toBeUndefined();
    expect(run({ "X/USDC": { ...agg("-40", "10", "0.1", "4"), feeBase: "0.001" } })?.feeBase).toBe("0.001");
  });
  it("never more than the gross position", () => {
    expect(run({ "X/USDC": agg("-1", "1", "100", "1") })?.feeBase).toBe("1");
  });
});
