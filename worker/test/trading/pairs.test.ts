import { describe, expect, it } from "vitest";
import { createPairInfoProvider } from "../../src/trading/pairs.js";
import { FakeHl } from "../../src/trading/hl/fake.js";

describe("pair info provider", () => {
  it("maps HL spot pairs to PairInfoMap, caches briefly, shares an in-flight request", async () => {
    let t = 1000;
    const hl = new FakeHl();
    const p = createPairInfoProvider(() => hl, { ttlMs: 30_000, now: () => t });
    const [a, b] = await Promise.all([p.getPairInfo(), p.getPairInfo()]);
    expect(a).toEqual(b);
    expect(a["HYPE/USDC"]).toEqual({ name: "HYPE/USDC", assetId: 10107, szDecimals: 2, volume24hUsdc: "5000000", mid: "40" });
    expect(hl.callLog().filter((c) => c === "read:getSpotPairs")).toHaveLength(1);
    t += 29_000;
    await p.getPairInfo();
    expect(hl.callLog().filter((c) => c === "read:getSpotPairs")).toHaveLength(1);
    t += 2_000;
    await p.getPairInfo();
    expect(hl.callLog().filter((c) => c === "read:getSpotPairs")).toHaveLength(2);
  });
  it("an HL failure is not cached", async () => {
    const hl = new FakeHl();
    const p = createPairInfoProvider(() => hl);
    hl.failNext("getSpotPairs");
    await expect(p.getPairInfo()).rejects.toThrow();
    await expect(p.getPairInfo()).resolves.toHaveProperty("HYPE/USDC");
  });
});
