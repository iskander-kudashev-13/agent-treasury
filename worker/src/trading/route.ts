/**
 * Hono routes of the trading module (ADR-0005 "Worker HTTP API"), mounted at `/trading` by `createApp` only when
 * TRADING_ENABLED=true. Auth classes:
 *   public   GET /status                      (the data is public on HL and NEAR)
 *   owner    Bearer token of the NEP-413 assistant session (`/ai/session`), owner re-checked against the vault
 *   nep413   POST /rules/confirm              (the signature itself is the authentication)
 * Errors are `{ type: "error", code, message }`.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { clientKey } from "../ai/route.js";
import { RateLimiter } from "../ai/ratelimit.js";
import { verifyToken } from "../ai/session.js";
import { ConfirmError } from "./confirm.js";
import type { ConfirmBody, RulesConfirmer } from "./confirm.js";
import { ProposeError } from "./propose.js";
import type { Proposer } from "./propose.js";
import { ServiceError } from "./service.js";
import type { TradingService } from "./service.js";
import type { RulesStore } from "./store.js";
import type { ConfirmCtx } from "./confirm.js";

export interface TradingRouteDeps {
  service: TradingService;
  confirmer: RulesConfirmer;
  store: RulesStore;
  /** Same context the store and confirmer use; `vaultOwner` must be uncached. */
  confirmCtx: ConfirmCtx;
  sessionSecret: string;
  vault: string;
  trustProxy: boolean;
  /** Requests per minute per client for everything except kill. */
  rateLimitPerMin?: number;
  /** Model calls per minute per client (`/rules/propose`). */
  proposeLimitPerMin?: number;
  /** Undefined = `/rules/propose` answers 502 AI_NOT_CONFIGURED. */
  propose?: Proposer | undefined;
  proposeTimeoutMs?: number;
  now?: () => number;
}

type ErrStatus = 400 | 401 | 403 | 409 | 413 | 429 | 502;

const MAX_BODY_BYTES = 64 * 1024;
const OWNER_CACHE_MS = 30_000;

const proposeBody = z.object({ text: z.string().min(1).max(2000) });
const killBody = z.object({ reason: z.string().max(500).optional() }).strict();
const rulesBody = z.object({ rules: z.unknown() });

export function createTradingRouter(d: TradingRouteDeps): Hono {
  const app = new Hono();
  const now = d.now ?? Date.now;
  const limiter = new RateLimiter(d.rateLimitPerMin ?? 120, 4, 16, now);
  const proposeLimiter = new RateLimiter(d.proposeLimitPerMin ?? 10, 1, 4, now);
  let ownerCache: { at: number; id: string } | undefined;

  const fail = (c: Context, status: ErrStatus, code: string, message: string) => c.json({ type: "error", code, message }, status);

  /** Maps module errors to HTTP. Anything else is a 502 with a generic message (no internals in responses). */
  const mapError = (c: Context, e: unknown) => {
    if (e instanceof ConfirmError || e instanceof ServiceError || e instanceof ProposeError) return fail(c, e.status, e.code, e.message);
    return fail(c, 502, "INTERNAL_ERROR", "The trading module failed to handle this request");
  };

  const throttle = (c: Context): Response | null => {
    const wait = limiter.hit(clientKey(c, d.trustProxy));
    if (wait === null) return null;
    c.header("Retry-After", String(wait));
    return fail(c, 429, "RATE_LIMITED", `Too many requests. Try again in ${wait}s.`);
  };

  /**
   * Owner bearer token. `fresh` (mutations) asks the vault for the current owner on every call; reads accept a 30 s cache.
   * `safetyOnly` (kill) falls back to the session token and the last known owner when the RPC fails.
   * Returns the owner account, or a Response to send.
   */
  const owner = async (c: Context, fresh: boolean, safetyOnly = false): Promise<string | Response> => {
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const claims = bearer ? verifyToken(d.sessionSecret, bearer, d.vault, now()) : null;
    if (!claims) return fail(c, 401, "UNAUTHORIZED", "Sign in first: missing, invalid or expired owner session");
    try {
      let id: string;
      if (!fresh && ownerCache && now() - ownerCache.at < OWNER_CACHE_MS) id = ownerCache.id;
      else {
        id = await d.confirmCtx.vaultOwner();
        ownerCache = { at: now(), id };
      }
      if (id !== claims.sub) return fail(c, 403, "NOT_OWNER", "The signed-in account is no longer the owner of this vault");
      return claims.sub;
    } catch {
      // The kill switch only moves toward safety, so it must work while NEAR RPC is down: the session token is signed by
      // this worker and was issued to the owner; accept it unless a previously seen owner is somebody else.
      if (safetyOnly) {
        if (ownerCache === undefined || ownerCache.id === claims.sub) return claims.sub;
        return fail(c, 403, "NOT_OWNER", "The signed-in account is not the owner of this vault");
      }
      return fail(c, 502, "RPC_ERROR", "Could not read the vault owner from NEAR RPC");
    }
  };

  /** Reads a JSON body of at most 64 KB. */
  const json = async (c: Context): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return { ok: false, res: fail(c, 413, "BODY_TOO_LARGE", "Request body too large") };
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return { ok: false, res: fail(c, 413, "BODY_TOO_LARGE", "Request body too large") };
    if (raw.trim() === "") return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false, res: fail(c, 400, "BAD_REQUEST", "Body must be JSON") };
    }
  };

  app.get("/status", (c) => {
    const t = throttle(c);
    if (t) return t;
    return c.json(d.service.status());
  });

  app.get("/rules", async (c) => {
    const t = throttle(c);
    if (t) return t;
    const o = await owner(c, false);
    if (typeof o !== "string") return o;
    try {
      // Fresh verification, same as the engine does each tick; a refused file is shown as "no active rules".
      const loaded = await d.store.loadActive(d.confirmCtx);
      return c.json({ active: loaded.status === "ok" ? loaded.confirmed : null, history: d.store.history() });
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.get("/log", async (c) => {
    const t = throttle(c);
    if (t) return t;
    const o = await owner(c, false);
    if (typeof o !== "string") return o;
    const q = c.req.query("limit");
    const limit = q === undefined ? 50 : Number(q);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(c, 400, "BAD_REQUEST", "limit must be an integer from 1 to 200");
    return c.json({ entries: d.service.readLog(limit) });
  });

  app.post("/rules/propose", async (c) => {
    const t = throttle(c);
    if (t) return t;
    const o = await owner(c, true);
    if (typeof o !== "string") return o;
    const b = await json(c);
    if (!b.ok) return b.res;
    const parsed = proposeBody.safeParse(b.value);
    if (!parsed.success) return fail(c, 400, "BAD_REQUEST", "Expected { text: string (1..2000 chars) }");
    if (!d.propose) return fail(c, 502, "AI_NOT_CONFIGURED", "The AI assistant is not configured on this worker");
    const wait = proposeLimiter.hit(clientKey(c, d.trustProxy));
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return fail(c, 429, "RATE_LIMITED", `Too many requests. Try again in ${wait}s.`);
    }
    const release = proposeLimiter.acquire(clientKey(c, d.trustProxy));
    if (!release) return fail(c, 429, "RATE_LIMITED", "A proposal is already being compiled. Try again shortly.");
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, d.proposeTimeoutMs ?? 90_000);
    try {
      return c.json(await d.propose(parsed.data.text, o, abort.signal));
    } catch (e) {
      return mapError(c, e);
    } finally {
      clearTimeout(timer);
      release();
    }
  });

  app.post("/rules/challenge", async (c) => {
    const t = throttle(c);
    if (t) return t;
    const o = await owner(c, true);
    if (typeof o !== "string") return o;
    const b = await json(c);
    if (!b.ok) return b.res;
    const parsed = rulesBody.safeParse(b.value);
    if (!parsed.success || !(typeof b.value === "object" && b.value !== null && "rules" in b.value)) return fail(c, 400, "BAD_REQUEST", "Expected { rules }");
    try {
      return c.json(await d.confirmer.challenge(parsed.data.rules));
    } catch (e) {
      return mapError(c, e);
    }
  });

  // No bearer token: the NEP-413 signature over the rules hash is the authentication (verified inside `confirm`).
  app.post("/rules/confirm", async (c) => {
    const t = throttle(c);
    if (t) return t;
    const b = await json(c);
    if (!b.ok) return b.res;
    if (typeof b.value !== "object" || b.value === null || Array.isArray(b.value)) return fail(c, 400, "BAD_REQUEST", "Expected a JSON object");
    try {
      // The perp-alarm check comes BEFORE the nonce is consumed, so the owner can retry the same signature flow later.
      await d.service.assertMayActivate();
      const env = await d.confirmer.confirm(b.value as ConfirmBody);
      const state = await d.service.activated(env);
      return c.json({ active: env, state });
    } catch (e) {
      return mapError(c, e);
    }
  });

  // The kill switch is deliberately not rate limited: it must work when everything else is throttled.
  app.post("/kill", async (c) => {
    const o = await owner(c, true, true);
    if (typeof o !== "string") return o;
    const b = await json(c);
    if (!b.ok) return b.res;
    const parsed = killBody.safeParse(b.value);
    if (!parsed.success) return fail(c, 400, "BAD_REQUEST", "Expected { reason?: string }");
    try {
      return c.json(await d.service.kill(parsed.data.reason));
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.post("/api-wallet/rotate", async (c) => {
    const t = throttle(c);
    if (t) return t;
    const o = await owner(c, true);
    if (typeof o !== "string") return o;
    try {
      return c.json({ address: await d.service.rotateApiWallet() });
    } catch (e) {
      return mapError(c, e);
    }
  });

  return app;
}
