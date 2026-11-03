import { describe, expect, it, vi } from "vitest";
import { backoffMs, isRetryable, view } from "./rpc";

const ok = (v: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: [...new TextEncoder().encode(JSON.stringify(v))] } }), { status: 200 });

describe("rpc view retries", () => {
  it("classifies retryable answers", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(null)).toBe(true);
    expect(isRetryable(200, -429)).toBe(true);
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(200, -32000)).toBe(false);
    expect(backoffMs(1, 0)).toBe(300);
    expect(backoffMs(9, 0)).toBe(2500);
  });

  it("moves to the next endpoint after a 429 and returns the value", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const f = vi.fn(async (url: string) => {
      seen.push(url);
      return seen.length === 1 ? new Response("rate", { status: 429 }) : ok("2");
    });
    vi.stubGlobal("fetch", f);
    const p = view<string>("get_agent_payouts_count", { agent_id: "payroll" }, "vault.near", ["https://a", "https://b"]);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("2");
    expect(seen).toEqual(["https://a", "https://b"]);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not retry a contract error", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "panicked" } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await expect(view("x", {}, "vault.near", ["https://a", "https://b"])).rejects.toThrow("panicked");
    expect(f).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
