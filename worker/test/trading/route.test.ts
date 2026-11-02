/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AppDeps } from "../../src/app.js";
import { ProposeError } from "../../src/trading/propose.js";
import { dcaRules, harness, SECRET, T0 } from "./harness.js";
import { HL_ACCOUNT, ownerKeyPair, OWNER, VAULT } from "./fixtures.js";
import { signToken } from "../../src/ai/session.js";
import { newKey } from "../ai-fakes.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<Json> => (await r.json()) as Json;
const post = (app: Hono, path: string, headers: Record<string, string>, body: unknown = {}) =>
  app.request(`/trading${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const get = (app: Hono, path: string, headers: Record<string, string> = { "x-forwarded-for": "9.9.9.9" }) => app.request(`/trading${path}`, { headers });

const proposer = () => Promise.resolve({ rules: dcaRules(), hash: "a".repeat(64), validation: { ok: true, errors: [], warnings: [] }, model: "m" });

describe("auth matrix", () => {
  const owner: { name: string; call: (h: ReturnType<typeof harness>, headers: Record<string, string>) => Response | Promise<Response> }[] = [
    { name: "GET /rules", call: (h, hd) => get(h.app, "/rules", hd) },
    { name: "GET /log", call: (h, hd) => get(h.app, "/log", hd) },
    { name: "POST /rules/propose", call: (h, hd) => post(h.app, "/rules/propose", hd, { text: "buy HYPE" }) },
    { name: "POST /rules/challenge", call: (h, hd) => post(h.app, "/rules/challenge", hd, { rules: dcaRules() }) },
    { name: "POST /kill", call: (h, hd) => post(h.app, "/kill", hd, {}) },
    { name: "POST /api-wallet/rotate", call: (h, hd) => post(h.app, "/api-wallet/rotate", hd, {}) },
  ];
  for (const ep of owner) {
    describe(ep.name, () => {
      it("401 without a token, with garbage, with a token for another vault or an expired one", async () => {
        const h = harness({ proposer, envKey: undefined });
        const attempts: Record<string, string>[] = [
          { "x-forwarded-for": "1.1.1.1" },
          { authorization: "Bearer nonsense", "x-forwarded-for": "1.1.1.1" },
          { authorization: `Bearer ${signToken(SECRET, { sub: OWNER, vault: "other.near", iat: T0, exp: T0 + 1000 })}`, "x-forwarded-for": "1.1.1.1" },
          { authorization: `Bearer ${signToken(SECRET, { sub: OWNER, vault: VAULT, iat: T0 - 9000, exp: T0 - 1 })}`, "x-forwarded-for": "1.1.1.1" },
          { authorization: `Bearer ${signToken("x".repeat(40), { sub: OWNER, vault: VAULT, iat: T0, exp: T0 + 1000 })}`, "x-forwarded-for": "1.1.1.1" },
        ];
        for (const headers of attempts) {
          const r = await ep.call(h, headers);
          expect(r.status).toBe(401);
          expect(await j(r)).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
        }
        expect(h.hl.calls.filter((c) => c.kind !== "read")).toHaveLength(0);
        expect(h.service.status().state).not.toBe("halted");
      });
      it("403 for a signed-in account that is not (or no longer) the vault owner", async () => {
        const h = harness({ proposer, envKey: undefined });
        const r = await ep.call(h, h.authed("mallory.near"));
        expect(r.status).toBe(403);
        expect(await j(r)).toMatchObject({ type: "error", code: "NOT_OWNER" });
      });
      it("502 when the owner cannot be verified (fail closed)", async () => {
        const h = harness({ proposer, envKey: undefined });
        h.near.rpcDown = true;
        const r = await ep.call(h, h.authed());
        // The kill switch only moves toward safety: it accepts the signed session when NEAR RPC is down.
        expect(r.status).toBe(ep.name === "POST /kill" ? 200 : 502);
      });
      it("200 for the owner", async () => {
        const h = harness({ proposer, envKey: undefined });
        const r = await ep.call(h, h.authed());
        expect(r.status).toBe(200);
      });
    });
  }

  it("a demoted owner is rejected on mutations immediately (fresh check, no cache)", async () => {
    const h = harness();
    expect((await get(h.app, "/log", h.authed())).status).toBe(200); // warms the read cache
    h.near.owner = "new.owner.near";
    const r = await post(h.app, "/kill", h.authed(), {});
    expect(r.status).toBe(403);
    expect(h.service.status().state).not.toBe("halted");
  });

  it("GET /status is public and returns the TradingStatus shape", async () => {
    const h = harness();
    await h.service.tick();
    const r = await get(h.app, "/status");
    expect(r.status).toBe(200);
    const s = await j(r);
    expect(s).toMatchObject({ enabled: true, state: "no_rules", hl_network: "testnet", vault: VAULT, agent_id: "hl-trader", hl_account: HL_ACCOUNT });
    expect(s.api_wallet.address).toBe(h.address);
    expect(JSON.stringify(s)).not.toContain(h.wallet.load().reveal().slice(2));
    for (const k of ["balances", "pnl", "limits", "open_orders", "dead_man", "perp_check", "warnings", "last_tick_ms", "next_tick_ms", "active_rules"]) expect(s).toHaveProperty(k);
  });

  it("GET /status before the first tick: not_configured placeholder, still a valid shape", async () => {
    const h = harness();
    const s = await j(await get(h.app, "/status"));
    expect(s).toMatchObject({ enabled: true, state: "not_configured", last_tick_ms: null });
  });

  it("confirm needs no bearer but a valid NEP-413 signature: a bad signature is 401, not 403", async () => {
    const h = harness();
    const bad = await h.confirmOverHttp(dcaRules(), { key: newKey() });
    expect(bad.status).toBe(401);
    expect(await j(bad)).toMatchObject({ type: "error", code: expect.stringMatching(/BAD_SIGNATURE|NOT_FULL_ACCESS/) });
    expect(h.service.status().active_rules).toBeNull();
  });
});

describe("disabled", () => {
  it("answers { enabled: false } on /trading/status and 404 on everything else", async () => {
    const app = createApp({ dashboardOrigin: "http://localhost:5173" } as unknown as AppDeps);
    const s = await app.request("/trading/status");
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ enabled: false });
    for (const [m, p] of [["GET", "/trading/rules"], ["GET", "/trading/log"], ["POST", "/trading/kill"], ["POST", "/trading/rules/confirm"], ["POST", "/trading/rules/challenge"], ["POST", "/trading/api-wallet/rotate"], ["POST", "/trading/rules/propose"]] as const) {
      expect((await app.request(p, { method: m })).status, `${m} ${p}`).toBe(404);
    }
  });
});

describe("request validation", () => {
  it("log limit must be 1..200", async () => {
    const h = harness();
    expect((await get(h.app, "/log?limit=0", h.authed())).status).toBe(400);
    expect((await get(h.app, "/log?limit=201", h.authed())).status).toBe(400);
    expect((await get(h.app, "/log?limit=abc", h.authed())).status).toBe(400);
    expect((await get(h.app, "/log?limit=5", h.authed())).status).toBe(200);
  });
  it("propose needs text <= 2000", async () => {
    const h = harness({ proposer });
    expect((await post(h.app, "/rules/propose", h.authed(), {})).status).toBe(400);
    expect((await post(h.app, "/rules/propose", h.authed(), { text: "x".repeat(2001) })).status).toBe(400);
    const ok = await post(h.app, "/rules/propose", h.authed(), { text: "buy" });
    expect(await j(ok)).toMatchObject({ hash: "a".repeat(64), model: "m" });
  });
  it("propose maps ProposeError and answers 502 when no proposer is configured", async () => {
    const h = harness({ proposer: () => Promise.reject(new ProposeError(400, "NO_PROPOSAL", "describe the rules")) });
    const r = await post(h.app, "/rules/propose", h.authed(), { text: "hi" });
    expect(r.status).toBe(400);
    expect(await j(r)).toEqual({ type: "error", code: "NO_PROPOSAL", message: "describe the rules" });
    const h2 = harness();
    expect((await post(h2.app, "/rules/propose", h2.authed(), { text: "hi" })).status).toBe(502);
  });
  it("challenge: invalid rules are 400 RULES_INVALID, over-limit rules too", async () => {
    const h = harness();
    const r = await post(h.app, "/rules/challenge", h.authed(), { rules: { nope: 1 } });
    expect(r.status).toBe(400);
    expect(await j(r)).toMatchObject({ type: "error", code: "RULES_INVALID" });
    const over = dcaRules();
    over.limits.max_order_usdc = "21";
    expect((await post(h.app, "/rules/challenge", h.authed(), { rules: over })).status).toBe(400);
    expect((await post(h.app, "/rules/challenge", h.authed(), {})).status).toBe(400);
  });
  it("challenge returns nonce, message, recipient, hash, expiry", async () => {
    const h = harness();
    const r = await j(await post(h.app, "/rules/challenge", h.authed(), { rules: dcaRules() }));
    expect(r).toMatchObject({ recipient: VAULT, hash: expect.stringMatching(/^[0-9a-f]{64}$/), expires_at: T0 + 300_000 });
    expect(r.message).toContain("Agent Treasury: activate trading rules");
  });
  it("non-JSON and non-object bodies are 400; oversize is 413", async () => {
    const h = harness();
    const bad = await h.app.request("/trading/rules/confirm", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, body: "{oops" });
    expect(bad.status).toBe(400);
    const arr = await post(h.app, "/rules/confirm", { "x-forwarded-for": "9.9.9.9" }, [1]);
    expect(arr.status).toBe(400);
    const big = await h.app.request("/trading/rules/confirm", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, body: "x".repeat(70_000) });
    expect(big.status).toBe(413);
  });
  it("kill rejects unknown body keys", async () => {
    const h = harness();
    expect((await post(h.app, "/kill", h.authed(), { reason: "x", extra: 1 })).status).toBe(400);
    expect(h.service.status().state).not.toBe("halted");
  });
});

describe("kill and rotate over HTTP", () => {
  it("kill returns the per-step result the dashboard expects", async () => {
    const h = harness();
    const r = await post(h.app, "/kill", h.authed(), { reason: "demo" });
    expect(r.status).toBe(200);
    expect(await j(r)).toEqual({ state: "halted", cancelled_orders: 0, steps: { cancel_all: "ok", schedule_cancel: "ok", state_saved: "ok", tick_wait: "ok" } });
    expect((await j(await get(h.app, "/status"))).state).toBe("halted");
  });
  it("kill is not rate limited", async () => {
    const h = harness();
    const app = new Hono().route("/trading", (await import("../../src/trading/route.js")).createTradingRouter({ ...h.routeDeps, rateLimitPerMin: 1 }));
    const hd = h.authed();
    expect((await get(app, "/log", hd)).status).toBe(200);
    expect((await get(app, "/log", hd)).status).toBe(429);
    expect((await post(app, "/kill", hd, {})).status).toBe(200);
  });
  it("rotate returns the new address and the status shows awaiting_api_wallet", async () => {
    const h = harness({ envKey: undefined });
    const r = await post(h.app, "/api-wallet/rotate", h.authed(), {});
    const { address } = await j(r);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toBe(h.address);
    expect(await j(await get(h.app, "/status"))).toMatchObject({ state: "awaiting_api_wallet", api_wallet: { address, approved: false } });
  });
  it("rotate with an env-fixed key is 400", async () => {
    const h = harness();
    const r = await post(h.app, "/api-wallet/rotate", h.authed(), {});
    expect(r.status).toBe(400);
    expect(await j(r)).toMatchObject({ code: "ROTATE_REFUSED" });
  });
});

describe("confirm", () => {
  it("success persists, activates, runs a tick and reports the state", async () => {
    const h = harness();
    const r = await h.confirmOverHttp(dcaRules());
    expect(r.status).toBe(200);
    const body = await j(r);
    expect(body.active).toMatchObject({ account_id: OWNER, rules: { name: "DCA" } });
    expect(body.state).toBe("running");
    expect(h.hl.placed).toHaveLength(1);
    const rules = await j(await get(h.app, "/rules", h.authed()));
    expect(rules.active.hash).toBe(body.active.hash);
    expect(rules.history).toHaveLength(1);
  });

  it("clears a KILLED halt", async () => {
    const h = harness();
    await post(h.app, "/kill", h.authed(), {});
    expect((await j(await get(h.app, "/status"))).state).toBe("halted");
    const r = await h.confirmOverHttp(dcaRules());
    expect(r.status).toBe(200);
    expect((await j(r)).state).toBe("running");
    expect((await j(await get(h.app, "/status"))).state).toBe("running");
  });

  it("409 PERP_STILL_OPEN while the perp is open; nothing is stored; 200 and halt cleared once it is closed", async () => {
    const h = harness();
    h.hl.setPerp(HL_ACCOUNT, { positions: [{ coin: "ETH", size: "0.1" }], openPerpOrders: 0, accountValueUsdc: "40" });
    await h.service.tick();
    expect((await j(await get(h.app, "/status"))).state_reason).toBe("PERP_POSITION_DETECTED");

    const blocked = await h.confirmOverHttp(dcaRules());
    expect(blocked.status).toBe(409);
    expect(await j(blocked)).toMatchObject({ type: "error", code: "PERP_STILL_OPEN" });
    expect(h.hl.placed).toHaveLength(0);
    expect(h.store.history()).toHaveLength(0);
    expect((await j(await get(h.app, "/status"))).state).toBe("halted");

    h.hl.setPerp(HL_ACCOUNT, { positions: [], openPerpOrders: 0, accountValueUsdc: "0" });
    const ok = await h.confirmOverHttp(dcaRules());
    expect(ok.status).toBe(200);
    expect((await j(ok)).state).toBe("running");
    expect(h.hl.placed).toHaveLength(1);
  });

  it("the perp check happens before the nonce is consumed: the same signature works after the perp is closed", async () => {
    const h = harness();
    h.hl.setPerp(HL_ACCOUNT, { positions: [{ coin: "ETH", size: "0.1" }], openPerpOrders: 0, accountValueUsdc: "40" });
    await h.service.tick();
    const rules = dcaRules();
    const ch = await j(await post(h.app, "/rules/challenge", h.authed(), { rules }));
    const body = {
      rules,
      account_id: OWNER,
      public_key: ownerKeyPair.publicKey,
      signature: ownerKeyPair.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: VAULT, callbackUrl: null }),
      nonce: ch.nonce,
    };
    const hd = { "x-forwarded-for": "9.9.9.9" };
    expect((await post(h.app, "/rules/confirm", hd, body)).status).toBe(409);
    h.hl.setPerp(HL_ACCOUNT, { positions: [], openPerpOrders: 0, accountValueUsdc: "0" });
    expect((await post(h.app, "/rules/confirm", hd, body)).status).toBe(200);
    // and a replay of the same signature is rejected
    expect((await post(h.app, "/rules/confirm", hd, body)).status).toBe(401);
  });

  it("the signer is no longer the vault owner at confirm time: 403 and nothing stored", async () => {
    const h = harness();
    const rules = dcaRules();
    const ch = await j(await post(h.app, "/rules/challenge", h.authed(), { rules }));
    h.near.owner = "someone.else.near";
    const r = await post(h.app, "/rules/confirm", { "x-forwarded-for": "9.9.9.9" }, {
      rules,
      account_id: OWNER,
      public_key: ownerKeyPair.publicKey,
      signature: ownerKeyPair.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: VAULT, callbackUrl: null }),
      nonce: ch.nonce,
    });
    expect(r.status).toBe(403);
    expect(await j(r)).toMatchObject({ type: "error", code: "NOT_OWNER" });
    expect(h.store.history()).toHaveLength(0);
  });
});
