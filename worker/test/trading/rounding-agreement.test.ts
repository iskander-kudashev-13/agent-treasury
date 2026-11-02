/**
 * Two independent implementations of HL's spot price rule exist: `engine/risk.ts` `roundPrice` (bigint fixed point,
 * 1e12) used by the engine to build orders, and `hl/format.ts` `formatPrice` (exact decimal strings) used by the
 * adapter / FakeHl to validate them. They must agree, or the engine would build prices HL (and FakeHl) reject.
 *
 * Result: they agree for every price with <= 12 decimals (the engine's precision), all szDecimals 0..8, both directions.
 * Where they cannot agree (more than 12 input decimals, which fx() truncates; a price that rounds to zero) the engine
 * side is the one that wins on the order path, and it fails closed (see the last describe block).
 */
import { describe, expect, it } from "vitest";
import { fx, fxStr, roundPrice, sizeOrder } from "../../src/trading/engine/risk.js";
import { bandPrice, FormatError, formatPrice, isValidPrice } from "../../src/trading/hl/format.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random positive decimal string: 0..7 integer digits, 0..12 decimals, random digits (also long runs of 9 and 0). */
function randPrice(r: () => number): string {
  const digit = (): string => {
    const x = r();
    return x < 0.15 ? "9" : x < 0.3 ? "0" : String(Math.floor(r() * 10));
  };
  const intLen = Math.floor(r() * 8);
  const decLen = Math.floor(r() * 13);
  let int = Array.from({ length: intLen }, digit).join("").replace(/^0+/, "");
  if (int === "") int = "0";
  const frac = Array.from({ length: decLen }, digit).join("");
  const s = frac === "" ? int : `${int}.${frac}`;
  return /[1-9]/.test(s) ? s : "1";
}

const engine = (p: string, sz: number, dir: "down" | "up"): string | null => {
  const v = roundPrice(fx(p), sz, dir);
  return v === 0n ? null : fxStr(v, 12);
};
const adapter = (p: string, sz: number, dir: "down" | "up"): string | null => {
  try {
    return formatPrice(p, sz, dir);
  } catch (e) {
    if (e instanceof FormatError) return null;
    throw e;
  }
};

describe("roundPrice (engine) vs formatPrice (adapter)", () => {
  it("agree on 50k random prices with <= 12 decimals, szDecimals 0..8, both directions", () => {
    const r = mulberry32(42);
    const diffs: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      const p = randPrice(r);
      const sz = Math.floor(r() * 9);
      const dir = r() < 0.5 ? "down" : "up";
      const a = engine(p, sz, dir);
      const b = adapter(p, sz, dir);
      if (a !== b) diffs.push(`${p} sz=${sz} ${dir}: engine ${a} adapter ${b}`);
      if (a !== null && !isValidPrice(a, sz)) diffs.push(`${p} sz=${sz} ${dir}: engine result ${a} is not a valid HL price`);
    }
    expect(diffs.slice(0, 20)).toEqual([]);
  });

  it("agree on hand-picked edges: carries, magnitude boundaries, integers above 5 digits, tiny prices", () => {
    const edges = [
      "9.99996", "9.99994", "99999.5", "99999.4", "0.999995", "0.0999995", "1", "10", "100000", "123456.7", "1234567.89",
      "0.00001", "0.000012345", "0.00000001", "0.000000015", "0.1", "0.12345", "0.123456", "40.4049", "40.4041", "1.2345",
      "12.3456", "12345.6", "12345", "0.000001", "999999999.999999999999",
    ];
    for (const p of edges)
      for (let sz = 0; sz <= 8; sz++)
        for (const dir of ["down", "up"] as const) expect(`${p} ${sz} ${dir} ${engine(p, sz, dir)}`).toBe(`${p} ${sz} ${dir} ${adapter(p, sz, dir)}`);
  });

  it("rounding is idempotent and on the safe side in both implementations", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 5_000; i++) {
      const p = randPrice(r);
      const sz = Math.floor(r() * 9);
      const down = engine(p, sz, "down");
      const up = engine(p, sz, "up");
      if (down !== null) {
        expect(fx(down) <= fx(p)).toBe(true);
        expect(engine(down, sz, "down")).toBe(down);
        expect(engine(down, sz, "up")).toBe(down);
      }
      expect(up).not.toBeNull();
      expect(fx(up as string) >= fx(p)).toBe(true);
      expect(adapter(up as string, sz, "up")).toBe(up);
    }
  });
});

describe("the engine's IOC price equals the adapter's band price", () => {
  it("for realistic mids (<= 6 decimals), every band and szDecimals, buy and sell", () => {
    const r = mulberry32(99);
    const diffs: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const v = 10 ** (-4 + r() * 9);
      const mid = v.toFixed(Math.floor(r() * 7)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
      if (fx(mid) === 0n) continue;
      const sz = Math.floor(r() * 9);
      const bps = 10 + Math.floor(r() * 191);
      for (const side of ["buy", "sell"] as const) {
        const s = sizeOrder({ action: { side, size: { usdc: "1000000" }, order: { type: "ioc" } }, mid: fx(mid), priceBandBps: bps, szDecimals: sz, freeBase: 0n });
        const e = s.ok ? fxStr(s.price, 12) : null;
        let a: string | null;
        try {
          a = bandPrice(mid, side, bps, sz);
        } catch {
          a = null;
        }
        if (e !== a && !(e === null && a === null)) diffs.push(`${side} mid=${mid} bps=${bps} sz=${sz}: engine ${e} adapter ${a}`);
      }
    }
    expect(diffs.slice(0, 20)).toEqual([]);
  });
});

describe("where they cannot agree, the engine side fails closed", () => {
  it("more than 12 decimals: fx() truncates first, so the engine can only be lower (buy: never above the adapter's price)", () => {
    // 0.1234500000001 down: both 0.12345; 1.0000000000001 up at sz 0: adapter 1.0001, engine 1 (the 13th decimal is gone)
    expect(engine("1.0000000000001", 0, "up")).toBe("1");
    expect(adapter("1.0000000000001", 0, "up")).toBe("1.0001");
    expect(engine("0.1234500000001", 0, "down")).toBe(adapter("0.1234500000001", 0, "down"));
  });

  it("a sell at the band edge of a 12-decimal mid rounds to a price below the band; the guard then rejects it (no order)", () => {
    // raw = mid * 0.99 = 0.99000000000099 is truncated to 0.990000000000 before rounding up -> 0.99, which is below
    // the exact band edge. Exact rounding (bandPrice) gives 0.99001. The engine never sends 0.99: checkOrder compares
    // against the exact edge and answers PRICE_BAND. Only unrealistic mids (HL mids have <= 8 decimals) hit this.
    const mid = "1.000000000001";
    const s = sizeOrder({ action: { side: "sell", size: { usdc: "100" }, order: { type: "ioc" } }, mid: fx(mid), priceBandBps: 100, szDecimals: 0, freeBase: 0n });
    expect(s.ok && fxStr(s.price, 12)).toBe("0.99");
    expect(bandPrice(mid, "sell", 100, 0)).toBe("0.99001");
    // band check, same formula as checkOrder: sell price * 10000 >= mid * (10000 - bps)
    expect(s.ok && s.price * 10_000n >= fx(mid) * 9_900n).toBe(false);
  });

  it("a price that rounds to zero: engine returns 0 (NO_PRICE), adapter throws; neither produces an order price", () => {
    expect(roundPrice(fx("0.000000001"), 0, "down")).toBe(0n);
    expect(() => formatPrice("0.000000001", 0, "down")).toThrow(FormatError);
  });
});
