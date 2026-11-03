import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer, instructionsFor } from "../src/server.js";
import { TRADING_INSTRUCTIONS, createTradingApi } from "../src/trading.js";
import { FakeClient } from "./fake-client.js";

const TOKEN = `atk1_purr-agent_${"A".repeat(43)}`;
const TREASURY = { TREASURY_VAULT: "vault.owner.near", TREASURY_NETWORK: "mainnet", TREASURY_AGENT_ACCOUNT: "procurement.owner.near" };
const TRADING = { TRADING_AGENT_TOKEN: TOKEN, TRADING_WORKER_URL: "http://127.0.0.1:3000" };

describe("config matrix", () => {
  it("treasury only, trading only, both, neither", () => {
    const t = loadConfig(TREASURY);
    expect(t.treasury?.vaultId).toBe("vault.owner.near");
    expect(t.trading).toBeNull();
    const g = loadConfig(TRADING);
    expect(g.treasury).toBeNull();
    expect(g.trading).toEqual({ workerUrl: "http://127.0.0.1:3000", token: TOKEN, botId: "purr-agent" });
    const both = loadConfig({ ...TREASURY, ...TRADING });
    expect(both.treasury).not.toBeNull();
    expect(both.trading).not.toBeNull();
    expect(() => loadConfig({})).toThrow(/nothing to serve/);
    expect(() => loadConfig({ TRADING_AGENT_TOKEN: "", TREASURY_VAULT: "" })).toThrow(/nothing to serve/);
  });
  it("the worker URL must be https, or http to loopback only; the URL is required with a token", () => {
    for (const u of ["https://worker.example.com", "http://localhost:3000", "http://[::1]:3000/", "http://127.0.0.1:3000"]) expect(loadConfig({ ...TRADING, TRADING_WORKER_URL: u }).trading?.workerUrl).toBe(u.replace(/\/$/, ""));
    for (const u of ["http://192.168.1.5:3000", "http://worker.example.com", "ftp://127.0.0.1", "not a url", "https://u:p@worker.example.com", "https://worker.example.com/?k=v"])
      expect(() => loadConfig({ ...TRADING, TRADING_WORKER_URL: u })).toThrow(/TRADING_WORKER_URL/);
    expect(() => loadConfig({ TRADING_AGENT_TOKEN: TOKEN })).toThrow(/TRADING_WORKER_URL: required/);
  });
  it("a bad token is refused without echoing it", () => {
    for (const bad of ["atk1_x", `atk2_purr_${"A".repeat(43)}`, `atk1_Purr_${"A".repeat(43)}`, `atk1_purr_${"A".repeat(42)}`, "s3cr3t-value"]) {
      let msg = "";
      try {
        loadConfig({ ...TRADING, TRADING_AGENT_TOKEN: bad });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/TRADING_AGENT_TOKEN/);
      expect(msg).not.toContain(bad);
    }
  });
});

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}
function fakeWorker(answers: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const h = new Headers(init?.headers);
    seen.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, method: init?.method ?? "GET", auth: h.get("authorization"), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const a = answers.shift() ?? new Error("no more answers");
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { seen, fetchFn };
}
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REJECTED = { status: "rejected", code: "MAX_ORDER", message: "too big", final: true, retry_after_s: null, order: null, fill: null, remaining_today: { orders: 5, loss_usdc: "3" }, replayed: false, request_id: "0123456789abcdef" };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function connect(answers: (Response | Error)[], withTreasury = false) {
  const w = fakeWorker(answers);
  const api = createTradingApi({ workerUrl: "http://127.0.0.1:3000/", token: TOKEN, fetchFn: w.fetchFn, timeoutMs: 1000 });
  const server = buildServer(withTreasury ? new FakeClient() : null, api);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    return { r, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { client, call, seen: w.seen };
}

describe("tools", () => {
  it("registers the two trading tools with the ADR descriptions and hints; treasury tools only when configured", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["trading_get_state", "trading_place_order"]);
    const place = tools.find((t) => t.name === "trading_place_order");
    expect(place?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tools.find((t) => t.name === "trading_get_state")?.annotations?.readOnlyHint).toBe(true);
    const d = place?.description ?? "";
    for (const s of [/REAL MONEY/, /you cannot set a price/, /FINAL/, /NEVER split/, /You cannot withdraw or move funds; no tool can/, /never executed/]) expect(d).toMatch(s);
    expect(Object.keys((place?.inputSchema.properties ?? {}) as object).sort()).toEqual(["idempotency_key", "pair", "position_pct", "reason", "side", "usdc"]);
    expect(place?.inputSchema.required).toEqual(["pair", "side", "reason", "idempotency_key"]);
    const both = await connect([], true);
    expect((await both.client.listTools()).tools).toHaveLength(7);
  });

  it("instructions carry the trading sentence only when trading is configured", async () => {
    expect(instructionsFor(true, false)).not.toContain("Trading:");
    expect(instructionsFor(false, true)).toBe(TRADING_INSTRUCTIONS);
    expect(instructionsFor(true, true)).toContain(TRADING_INSTRUCTIONS);
    expect(instructionsFor(true, true).startsWith("Agent Treasury: pay from a shared USDC vault")).toBe(true);
    const { client } = await connect([]);
    expect(client.getInstructions()).toBe(TRADING_INSTRUCTIONS);
  });

  it("get_state: GET with the token; 200 body minus request_id becomes structuredContent", async () => {
    const { call, seen } = await connect([res(200, { can_trade: true, bot: { id: "purr-agent" }, request_id: "x" })]);
    const { r, json } = await call("trading_get_state");
    expect(seen[0]).toMatchObject({ url: "http://127.0.0.1:3000/trading/agent/state", method: "GET", auth: `Bearer ${TOKEN}` });
    expect(r.structuredContent).toEqual({ can_trade: true, bot: { id: "purr-agent" } });
    expect(json).not.toHaveProperty("request_id");
  });

  it("place_order: a 200 rejection is a structured result (not isError) with final", async () => {
    const { call, seen } = await connect([res(200, REJECTED)]);
    const { r, json } = await call("trading_place_order", { pair: "PURR/USDC", side: "buy", usdc: 100, reason: "buy the dip", idempotency_key: "test-key-0001" });
    expect(r.isError).toBeFalsy();
    expect(json).toMatchObject({ status: "rejected", code: "MAX_ORDER", final: true });
    expect(json).not.toHaveProperty("request_id");
    expect(seen[0]?.url).toBe("http://127.0.0.1:3000/trading/agent/order");
    expect(seen[0]?.body).toMatchObject({ pair: "PURR/USDC", side: "buy", usdc: "100", reason: "buy the dip" });
    expect(seen[0]?.body?.["idempotency_key"]).toBe("test-key-0001");
  });

  it("HTTP errors become isError with { error, message }; 401 adds the new-token hint", async () => {
    const { call } = await connect([res(401, { type: "error", code: "AGENT_UNAUTHORIZED", message: "Missing or invalid agent token" }), res(429, { type: "error", code: "AGENT_RATE_LIMITED", message: "wait" })]);
    const a = await call("trading_get_state");
    expect(a.r.isError).toBe(true);
    expect(a.json).toEqual({ error: "AGENT_UNAUTHORIZED", message: "Missing or invalid agent token; the token is invalid, expired, revoked or was replaced (a Stop also revokes it); ask the owner for a new one" });
    const b = await call("trading_place_order", { pair: "PURR/USDC", side: "buy", usdc: "14", reason: "r", idempotency_key: "test-key-0001" });
    expect(b.r.isError).toBe(true);
    expect(b.json).toEqual({ error: "AGENT_RATE_LIMITED", message: "wait", idempotency_key: "test-key-0001" });
  });

  it("exactly one size field; position_pct only on sells, 1..100; nothing reaches the worker otherwise", async () => {
    const { call, seen } = await connect([]);
    for (const args of [
      { pair: "PURR/USDC", side: "buy", reason: "r" },
      { pair: "PURR/USDC", side: "sell", usdc: "12", position_pct: "50", reason: "r" },
      { pair: "PURR/USDC", side: "buy", position_pct: 50, reason: "r" },
      { pair: "PURR/USDC", side: "sell", position_pct: 101, reason: "r" },
      { pair: "PURR/USDC", side: "buy", usdc: 0.1234567, reason: "r" },
    ]) {
      const out = await call("trading_place_order", args).then(
        ({ r }) => r.isError === true,
        () => true,
      );
      expect(out, JSON.stringify(args)).toBe(true);
    }
    for (const args of [{ pair: "PURR", side: "buy", usdc: "12", reason: "r" }, { pair: "PURR/USDC", side: "buy", usdc: "12" }, { pair: "PURR/USDC", side: "buy", usdc: "12", reason: "x".repeat(201) }]) {
      const out = await call("trading_place_order", args).then(
        ({ r }) => r.isError === true,
        () => true,
      );
      expect(out).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });

  it("retries once on a network error with the SAME idempotency_key; never on an HTTP status", async () => {
    const ok = { ...REJECTED, status: "filled", code: null, final: false };
    const n = await connect([new TypeError("fetch failed"), res(200, ok)]);
    const { json } = await n.call("trading_place_order", { pair: "PURR/USDC", side: "sell", position_pct: "100", reason: "exit", idempotency_key: "my-key-0001" });
    expect(json).toMatchObject({ status: "filled" });
    expect(n.seen).toHaveLength(2);
    expect(n.seen[0]?.body).toEqual(n.seen[1]?.body);
    expect(n.seen[1]?.body).toMatchObject({ idempotency_key: "my-key-0001", position_pct: "100" });
    // The model's key is reused by the retry.
    const g = await connect([new TypeError("fetch failed"), res(200, ok)]);
    await g.call("trading_place_order", { pair: "PURR/USDC", side: "buy", usdc: "14", reason: "r", idempotency_key: "test-key-0001" });
    expect(g.seen[0]?.body?.["idempotency_key"]).toBe(g.seen[1]?.body?.["idempotency_key"]);
    // HTTP 502: no retry. Two network errors: WORKER_UNREACHABLE.
    const h = await connect([res(502, { type: "error", code: "INTERNAL_ERROR", message: "x" })]);
    expect((await h.call("trading_get_state")).json).toMatchObject({ error: "INTERNAL_ERROR" });
    expect(h.seen).toHaveLength(1);
    const u = await connect([new TypeError("a"), new TypeError("b")]);
    const ur = await u.call("trading_get_state");
    expect(ur.r.isError).toBe(true);
    expect(ur.json).toMatchObject({ error: "WORKER_UNREACHABLE" });
    expect(u.seen).toHaveLength(2);
  });

  it("the token never appears in a tool result", async () => {
    const { call } = await connect([res(401, { type: "error", code: "AGENT_UNAUTHORIZED", message: "no" }), new TypeError("x"), new TypeError("y")]);
    for (const name of ["trading_get_state", "trading_get_state"]) expect((await call(name)).text).not.toContain(TOKEN.slice(16));
  });
});
