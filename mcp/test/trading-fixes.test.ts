/**
 * Fixes after the ADR-0007 audit (docs/security/audit-2026-11-03-agent-trading.md, "Fixes"):
 *   AL1  the client never follows an HTTP redirect with the bearer token;
 *   AL2  every trading_place_order result carries the idempotency_key it used (the model's own key, or the generated one);
 *        the client timeout is above the worker's worst case for one order.
 * Local loopback HTTP servers only; no worker, no money.
 */
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { TRADING_TIMEOUT_MS, createTradingApi, createTradingTools } from "../src/trading.js";

const TOKEN = `atk1_hype-agent_${"Zx9_Qw-8".repeat(5)}abc`;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function listen(handler: (headers: IncomingHttpHeaders, res: import("node:http").ServerResponse) => void): Promise<string> {
  const s = createServer((req, res) => {
    req.resume();
    handler(req.headers, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

type Handler = (a: Record<string, unknown>) => Promise<{ isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }>;
const tools = (fetchFn: typeof fetch, workerUrl = "http://127.0.0.1:3000") => {
  const t = createTradingTools(createTradingApi({ workerUrl, token: TOKEN, fetchFn, timeoutMs: 2000 }));
  const byName = (n: string) => t.find((x) => x.name === n)?.handler as unknown as Handler;
  return { place: byName("trading_place_order"), state: byName("trading_get_state") };
};
const body = (r: Awaited<ReturnType<Handler>>) => JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>;
const ORDER = { pair: "HYPE/USDC", side: "buy", usdc: "12", reason: "test", idempotency_key: "test-key-0001" };

describe("AL1: no redirect is followed with the token", () => {
  it("a 302 from the worker URL to another host: the target never sees the request, the tool reports an error", async () => {
    const seenAtTarget: IncomingHttpHeaders[] = [];
    const target = await listen((h, res) => {
      seenAtTarget.push(h);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const worker = await listen((_h, res) => {
      res.writeHead(302, { location: `${target.replace("127.0.0.1", "localhost")}/steal` }).end();
    });
    const { place, state } = tools(fetch, worker);
    const a = await state({});
    expect(a.isError).toBe(true);
    const b = await place({ ...ORDER });
    expect(b.isError).toBe(true);
    expect(body(b).idempotency_key).toBe("test-key-0001");
    expect(seenAtTarget).toHaveLength(0);
  });

  it("every call passes redirect: \"error\" to fetch", async () => {
    const inits: RequestInit[] = [];
    const fetchFn = ((_u: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;
    const { place, state } = tools(fetchFn);
    await state({});
    await place({ ...ORDER });
    expect(inits.map((i) => i.redirect)).toEqual(["error", "error"]);
  });
});

describe("AL2: the idempotency_key is in every place_order result", () => {
  const answer = (status: number, b: unknown) => (() => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;

  it("200: structured result + the model's own key, which was sent unchanged", async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn = ((_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ status: "rejected", code: "OUTCOME_UNKNOWN", final: true, request_id: "x" }), { status: 200 }));
    }) as unknown as typeof fetch;
    const r = await tools(fetchFn).place({ ...ORDER, idempotency_key: "my-own-key-1" });
    expect(sent["idempotency_key"]).toBe("my-own-key-1");
    expect(r.structuredContent).toEqual({ status: "rejected", code: "OUTCOME_UNKNOWN", final: true, idempotency_key: "my-own-key-1" });
  });

  it("HTTP error, local validation error and an unreachable worker all carry the key", async () => {
    const e1 = await tools(answer(409, { type: "error", code: "ORDER_IN_FLIGHT", message: "busy" })).place({ ...ORDER, idempotency_key: "key-aaaa-01" });
    expect(body(e1)).toEqual({ error: "ORDER_IN_FLIGHT", message: "busy", idempotency_key: "key-aaaa-01" });
    const e2 = await tools(answer(200, {})).place({ pair: "HYPE/USDC", side: "buy", reason: "r", idempotency_key: "key-aaaa-02" });
    expect(body(e2)).toMatchObject({ error: "BAD_ORDER_REQUEST", idempotency_key: "key-aaaa-02" });
    const down = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const e3 = await tools(down).place({ ...ORDER });
    const b3 = body(e3);
    expect(b3.error).toBe("WORKER_UNREACHABLE");
    expect(String(b3.message)).toContain("trading_get_state");
    expect(b3.idempotency_key).toBe("test-key-0001");
  });

  it("the default client timeout is 300 s (above the worker's worst case of two ticks)", () => {
    expect(TRADING_TIMEOUT_MS).toBe(300_000);
  });
});
