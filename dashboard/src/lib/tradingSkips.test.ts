import { afterEach, describe, expect, it } from "vitest";
import { setLocaleSilently } from "@/i18n/core";
import type { LogEntry } from "./tradingClient";
import { lastDecisions, SKIP_CODES, skipReason } from "./tradingSkips";

afterEach(() => setLocaleSilently("en"));

describe("skipReason", () => {
  it("MIN_NOTIONAL keeps the amount", () => {
    expect(skipReason("MIN_NOTIONAL: notional 9.25 USDC is below the 10 USDC minimum")).toBe("Order 9.25 USDC is below the 10 USDC Hyperliquid minimum.");
    expect(skipReason("MIN_NOTIONAL: weird")).toBe("Order is below the 10 USDC Hyperliquid minimum.");
  });
  it("translates every known code, in all languages", () => {
    for (const l of ["en", "ru", "uk"] as const) {
      setLocaleSilently(l);
      for (const c of SKIP_CODES) {
        const out = skipReason(`${c}: whatever 1.5 USDC`);
        expect(out).not.toContain("trading.skip");
        expect(out).not.toContain(c);
      }
    }
    setLocaleSilently("ru");
    expect(skipReason("COOLDOWN: rule is in cooldown")).toMatch(/пауз/);
  });
  it("shows unknown codes and free text as received", () => {
    expect(skipReason("NEW_CODE: something")).toBe("NEW_CODE: something");
    expect(skipReason("kill switch pulled")).toBe("kill switch pulled");
  });
});

describe("lastDecisions", () => {
  const e = (at_ms: number, kind: LogEntry["kind"], detail: string, rule_id?: string): LogEntry => ({ at_ms, kind, detail, ...(rule_id ? { rule_id } : {}) });
  it("takes the newest order or skip per rule", () => {
    const d = lastDecisions([e(5, "skip", "COOLDOWN: x", "a"), e(4, "state", "halted", "a"), e(3, "order", "buy 1 @ 2", "a"), e(2, "skip", "POSITION_CAP: y", "b"), e(1, "skip", "COOLDOWN: x")]);
    expect(Object.keys(d).sort()).toEqual(["a", "b"]);
    expect(d.a).toMatchObject({ at_ms: 5, kind: "skip" });
    expect(d.b?.text).toMatch(/max position/);
  });
});
