import { describe, expect, it } from "vitest";
import { formatNear, parseAccessKey } from "./accessKey";

describe("parseAccessKey", () => {
  it("function-call key", () => {
    expect(parseAccessKey({ result: { permission: { FunctionCall: { allowance: "250000000000000000000000", receiver_id: "v.near", method_names: ["request_payment"] } } } })).toEqual({
      state: "function-call",
      allowanceYocto: "250000000000000000000000",
      receiverId: "v.near",
      methods: ["request_payment"],
    });
  });
  it("full access and missing", () => {
    expect(parseAccessKey({ result: { permission: "FullAccess" } })).toEqual({ state: "full-access" });
    expect(parseAccessKey({ error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } })).toEqual({ state: "missing" });
    expect(parseAccessKey({ result: { error: "access key ed25519:x does not exist while viewing" } })).toEqual({ state: "missing" });
  });
  it("other errors throw", () => {
    expect(() => parseAccessKey({ error: { message: "boom" } })).toThrow("boom");
    expect(() => parseAccessKey({ result: {} })).toThrow();
  });
});

describe("formatNear", () => {
  it("formats", () => {
    expect(formatNear("250000000000000000000000")).toBe("0.25");
    expect(formatNear("1000000000000000000000000")).toBe("1");
    expect(formatNear("1234567000000000000000")).toBe("0.001");
    expect(formatNear("0")).toBe("0");
  });
});
