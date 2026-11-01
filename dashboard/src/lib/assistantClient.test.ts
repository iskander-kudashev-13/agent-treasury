import { describe, expect, it } from "vitest";
import { clearSession, createSseParser, loadSession, parseAiInfo, parseChatEvent, saveSession, type SseMessage } from "./assistantClient";

const collect = (chunks: string[]): SseMessage[] => {
  const p = createSseParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.flush()];
};

describe("SSE parser", () => {
  const stream = 'event: text\ndata: {"type":"text","delta":"Hi"}\n\nevent: done\ndata: {"type":"done"}\n\n';
  it("parses whole events", () => {
    expect(collect([stream])).toEqual([
      { event: "text", data: '{"type":"text","delta":"Hi"}' },
      { event: "done", data: '{"type":"done"}' },
    ]);
  });
  it("is chunk-boundary independent (byte by byte)", () => {
    expect(collect([...stream])).toEqual(collect([stream]));
  });
  it("handles CRLF, CR, comments, multi-line data and missing space", () => {
    expect(collect(["event: a\r\ndata: 1\r\n\r\n"])).toEqual([{ event: "a", data: "1" }]);
    expect(collect(["event: a\rdata: 1\r\r"])).toEqual([{ event: "a", data: "1" }]);
    expect(collect([": keep-alive\n\ndata:x\ndata: y\n\n"])).toEqual([{ event: "message", data: "x\ny" }]);
    expect(collect(["event: a\r", "\ndata: 1\r", "\n\r", "\n"])).toEqual([{ event: "a", data: "1" }]);
  });
  it("flushes a final event without trailing blank line", () => {
    expect(collect(["event: done\ndata: {}"])).toEqual([{ event: "done", data: "{}" }]);
  });
  it("ignores events without data", () => {
    expect(collect(["event: ping\n\n"])).toEqual([]);
  });
});

describe("parseChatEvent", () => {
  const ev = (o: unknown) => parseChatEvent({ event: "x", data: JSON.stringify(o) });
  it("parses the worker events", () => {
    expect(ev({ type: "text", delta: "a" })).toEqual({ type: "text", delta: "a" });
    expect(ev({ type: "question", text: "Which chain?", options: ["Base", 3, "Solana"] })).toEqual({ type: "question", text: "Which chain?", options: ["Base", "Solana"] });
    expect(ev({ type: "data", kind: "table", payload: { rows: [] } })).toEqual({ type: "data", kind: "table", payload: { rows: [] } });
    expect(ev({ type: "done" })).toEqual({ type: "done" });
    expect(ev({ type: "error", message: "nope" })).toEqual({ type: "error", message: "nope" });
  });
  it("drops garbage and marks malformed proposals", () => {
    expect(parseChatEvent({ event: "text", data: "not json" })).toBeNull();
    expect(ev({ type: "data", kind: "chart", payload: 1 })).toBeNull();
    expect(ev({ type: "tool_call", name: "withdraw" })).toBeNull();
    expect(ev({ type: "proposal", proposal: { type: "Withdraw", call: { method: "withdraw", args: {} } } })).toEqual({ type: "malformed_proposal" });
  });
  it("uses the SSE event name when the payload has no type", () => {
    expect(parseChatEvent({ event: "text", data: '{"delta":"z"}' })).toEqual({ type: "text", delta: "z" });
  });
});

describe("session storage", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it("keeps a valid session for the same account and drops expired or foreign ones", () => {
    const st = mem();
    clearSession(st);
    saveSession({ token: "t", accountId: "owner.near", expiresAt: 10_000_000 }, st);
    expect(loadSession("owner.near", 1000, st)?.token).toBe("t");
    expect(loadSession("other.near", 1000, st)).toBeNull();
    saveSession({ token: "t", accountId: "owner.near", expiresAt: 10_000_000 }, st);
    expect(loadSession("owner.near", 9_990_000, st)).toBeNull(); // < 30 s left
    expect(st.getItem("at.ai.session")).toBeNull();
  });
  it("survives a throwing storage", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    clearSession(bad);
    expect(() => saveSession({ token: "t", accountId: "a.near", expiresAt: 9e12 }, bad)).not.toThrow();
    expect(loadSession("a.near", 1, bad)?.token).toBe("t"); // memory copy
  });
});

describe("parseAiInfo", () => {
  it("keeps attestation honest and sanitises the verify url", () => {
    const i = parseAiInfo({ model: "m", provider: "NEAR AI Cloud", private: true, tier: "confidential_tee", attestation: { status: "fetched_unverified", verify_url: "javascript:alert(1)", note: "n" } });
    expect(i?.attestation?.status).toBe("fetched_unverified");
    expect(i?.attestation?.verify_url).toBe("https://cloud.near.ai/verify");
    expect(parseAiInfo({})).toBeNull();
  });
});
