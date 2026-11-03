/**
 * ADR-0007 section 6 coverage gaps (tester pass 2026-11-03): the token is never echoed (config errors, startup line, network
 * errors), plain HTTP only to loopback, and the single internal retry reuses the same idempotency_key (also after a timeout)
 * and is never repeated. No real worker, no network beyond spawning the server on stdio.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTradingApi, createTradingTools } from "../src/trading.js";

const SECRET = "Zx9_Qw-8".repeat(5) + "abc"; // 43 base64url chars
const TOKEN = `atk1_purr-agent_${SECRET}`;
const MCP_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("TRADING_WORKER_URL: no token over plain HTTP except to this machine", () => {
  it("refuses look-alike and non-loopback http hosts; accepts https anywhere", () => {
    for (const u of [
      "http://127.0.0.2:3000",
      "http://0.0.0.0:3000",
      "http://localhost.evil.com",
      "http://127.0.0.1.nip.io",
      "http://evil.com#@127.0.0.1",
      "http://[::ffff:127.0.0.1]:3000",
      "http://10.0.0.1:3000",
      "ws://127.0.0.1:3000",
      "file:///tmp/sock",
    ])
      expect(() => loadConfig({ TRADING_AGENT_TOKEN: TOKEN, TRADING_WORKER_URL: u }), u).toThrow(/TRADING_WORKER_URL/);
    for (const u of ["HTTP://LOCALHOST:3000", "https://10.0.0.1:3000", "https://worker.example.com/base"]) expect(loadConfig({ TRADING_AGENT_TOKEN: TOKEN, TRADING_WORKER_URL: u }).trading).not.toBeNull();
  });

  it("a config error never contains the token, even when the URL is the bad part", () => {
    for (const env of [{ TRADING_AGENT_TOKEN: TOKEN, TRADING_WORKER_URL: "http://10.0.0.1" }, { TRADING_AGENT_TOKEN: TOKEN }, { TRADING_AGENT_TOKEN: `${TOKEN}x`, TRADING_WORKER_URL: "http://127.0.0.1:3000" }]) {
      let msg = "";
      try {
        loadConfig(env);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(SECRET);
    }
  });
});

function runServer(env: Record<string, string>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: MCP_DIR, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.includes("agent-treasury-mcp ready")) child.kill("SIGTERM");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

describe("the startup line names the bot, never the token", () => {
  it("trading only: 'trading=enabled bot=purr-agent' and no secret on stderr or stdout", async () => {
    const r = await runServer({ TRADING_AGENT_TOKEN: TOKEN, TRADING_WORKER_URL: "http://127.0.0.1:9" });
    expect(r.stderr).toContain("trading=enabled bot=purr-agent");
    expect(r.stderr).toContain("treasury=disabled");
    expect(r.stderr).not.toContain(SECRET);
    expect(r.stdout).not.toContain(SECRET);
  }, 20_000);

  it("a refused URL exits non-zero without printing the token", async () => {
    const r = await runServer({ TRADING_AGENT_TOKEN: TOKEN, TRADING_WORKER_URL: "http://192.168.1.5:3000" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/TRADING_WORKER_URL/);
    expect(r.stderr).not.toContain(SECRET);
  }, 20_000);
});

interface Seen {
  body: Record<string, unknown> | null;
  auth: string | null;
}
function fakeFetch(answers: (Response | Error | "hang")[]) {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = (_input, init) => {
    seen.push({ body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null, auth: new Headers(init?.headers).get("authorization") });
    const a = answers.shift() ?? new Error("no more answers");
    if (a === "hang")
      return new Promise((_r, rej) => {
        init?.signal?.addEventListener("abort", () => {
          rej(new DOMException("aborted", "AbortError"));
        });
      });
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { seen, fetchFn };
}
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FILLED = { status: "filled", code: null, message: "Filled", final: false, retry_after_s: null, order: null, fill: null, remaining_today: { orders: 5, loss_usdc: "3" }, replayed: true, request_id: "c" };
type Handler = (a: Record<string, unknown>) => Promise<{ isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown }>;
const place = (fetchFn: typeof fetch, timeoutMs = 1000): Handler => {
  const tools = createTradingTools(createTradingApi({ workerUrl: "http://127.0.0.1:3000", token: TOKEN, fetchFn, timeoutMs }));
  return tools.find((t) => t.name === "trading_place_order")?.handler as unknown as Handler;
};
const ORDER = { pair: "PURR/USDC", side: "buy", usdc: "14", reason: "r" };

describe("the single retry", () => {
  it("a timeout (abort) is retried once with the same idempotency_key and the same body", async () => {
    const w = fakeFetch(["hang", res(200, FILLED)]);
    const out = await place(w.fetchFn, 50)(ORDER);
    expect(out.isError).toBeFalsy();
    expect(w.seen).toHaveLength(2);
    expect(w.seen[0]?.body).toEqual(w.seen[1]?.body);
    expect(String(w.seen[0]?.body?.["idempotency_key"])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("network error then 409 ORDER_IN_FLIGHT (the first request is still running on the worker): isError, no third attempt", async () => {
    const w = fakeFetch([new TypeError("fetch failed"), res(409, { type: "error", code: "ORDER_IN_FLIGHT", message: "wait" })]);
    const out = await place(w.fetchFn)(ORDER);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0]?.text ?? "{}")).toMatchObject({ error: "ORDER_IN_FLIGHT" });
    expect(w.seen).toHaveLength(2);
  });

  it("two separate tool calls without a key get two different keys (no accidental replay across calls)", async () => {
    const w = fakeFetch([res(200, FILLED), res(200, FILLED)]);
    const h = place(w.fetchFn);
    await h(ORDER);
    await h(ORDER);
    expect(w.seen[0]?.body?.["idempotency_key"]).not.toBe(w.seen[1]?.body?.["idempotency_key"]);
  });

  it("the token never appears in a result, even when the network error or the worker's message carries it", async () => {
    const w = fakeFetch([new TypeError(`connect failed Authorization: Bearer ${TOKEN}`), new TypeError(`again ${TOKEN}`)]);
    const out = await place(w.fetchFn)(ORDER);
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).not.toContain(SECRET);
    expect(w.seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("an empty or non-JSON 200 is an error, not a success", async () => {
    const w = fakeFetch([new Response("not json", { status: 200 }), new Response("[]", { status: 200 })]);
    const h = place(w.fetchFn);
    expect((await h(ORDER)).isError).toBe(true);
    expect((await h(ORDER)).isError).toBe(true);
    expect(w.seen).toHaveLength(2);
  });
});
