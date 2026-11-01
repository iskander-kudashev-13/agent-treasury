import { describe, expect, it } from "vitest";
import { isAccountId, measurementLabel, parseMeasurements, parsePpids } from "./trustAnchors";

const good = { rtmrs: { mrtd: "ab".repeat(48), rtmr0: "cd", rtmr1: "ef", rtmr2: "01" }, key_provider_event_digest: "aa", app_compose_hash_payload: "bb" };

describe("parseMeasurements", () => {
  it("accepts the documented shape", () => expect(parseMeasurements(JSON.stringify(good)).error).toBeNull());
  it("rejects bad JSON, wrong shape and non-hex", () => {
    expect(parseMeasurements("{").error).toBe("Not valid JSON");
    expect(parseMeasurements("[]").error).toMatch(/Expected/);
    expect(parseMeasurements(JSON.stringify({ ...good, rtmrs: { ...good.rtmrs, mrtd: "zz" } })).error).toMatch(/rtmrs.mrtd/);
    expect(parseMeasurements(JSON.stringify({ ...good, app_compose_hash_payload: 1 })).error).toMatch(/app_compose/);
  });
});
describe("parsePpids", () => {
  const a = "A".repeat(32);
  it("splits, lowercases, dedupes", () => expect(parsePpids(`${a}, ${"a".repeat(32)}\n${"b".repeat(32)}`)).toEqual({ value: ["a".repeat(32), "b".repeat(32)], error: null }));
  it("rejects wrong length", () => expect(parsePpids("abcd").error).toMatch(/not a PPID/));
  it("empty is empty", () => expect(parsePpids("")).toEqual({ value: [], error: null }));
});
describe("misc", () => {
  it("account ids", () => {
    expect(isAccountId("agent.testnet")).toBe(true);
    expect(isAccountId("Bad Name")).toBe(false);
  });
  it("label", () => {
    expect(measurementLabel(good)).toMatch(/…/);
    expect(measurementLabel(null)).toBe("null");
  });
});
