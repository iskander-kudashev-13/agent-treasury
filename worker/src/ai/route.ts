/** Hono routes: `POST /ai/chat` (SSE) and `GET /ai/info`. Mounted by createApp under `/ai`. */
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { isNearAccountId } from "./chains.js";
import { runChat } from "./chat.js";
import { toJson } from "./events.js";
import type { ChatEvent } from "./events.js";
import type { AiInfo } from "./info.js";
import { RateLimiter } from "./ratelimit.js";
import { challengeMessage, ChallengeStore, nep413Digest, SESSION_TTL_MS, signToken, verifyEd25519, verifyToken } from "./session.js";
import { buildTools } from "./tools.js";
import { VaultReader } from "./views.js";
import type { ViewFn } from "./views.js";

export interface AiConfig {
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
  vault: string;
  network: string;
  rateLimitPerMin: number;
  maxMessages: number;
  maxMessageChars: number;
  timeoutMs: number;
  /** Trust the first `X-Forwarded-For` hop as the client IP (only behind a proxy you control). */
  trustProxy: boolean;
  /** HMAC secret for session tokens (>= 32 chars). The AI routes are not mounted without it. */
  sessionSecret: string;
}

export interface AiDeps {
  config: AiConfig;
  /** Read-only vault view calls. The AI code has no other chain access. */
  view: ViewFn;
  info: AiInfo;
  /** USDC `assetId` of a chain from 1Click `/v0/tokens` (cached by the caller), or `null`. */
  usdcAsset: (chain: string) => Promise<string | null>;
  /** Kind of key `publicKey` is on `accountId` (RPC `view_access_key`): full access, function call/other, or not a key of it. */
  accessKey: (accountId: string, publicKey: string) => Promise<"full" | "limited" | "none">;
  now?: () => number;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TOTAL_CHARS = 40_000;

const bodySchema = z.object({
  conversation_id: z.string().min(1).max(64),
  // Only user/assistant roles: a client can never inject a system or tool message.
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1),
  vault: z.string().min(1).max(64),
  owner_account: z.string().min(1).max(64),
});

const sessionBodySchema = z.object({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().min(10).max(80),
  signature: z.string().min(80).max(100),
  nonce: z.string().min(40).max(48),
  // Redirect wallets include their callback URL in the signed payload.
  callbackUrl: z.string().max(500).nullish(),
});

function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function createAiRouter(d: AiDeps): Hono {
  const app = new Hono();
  const cfg = d.config;
  const now = d.now ?? Date.now;
  const limiter = new RateLimiter(cfg.rateLimitPerMin);
  const tools = buildTools();
  const reader = new VaultReader(d.view);
  let ownerCache: { at: number; id: string } | undefined;
  const vaultOwner = async (): Promise<string> => {
    if (ownerCache && now() - ownerCache.at < 60_000) return ownerCache.id;
    const id = (await reader.contractInfo()).owner_id;
    ownerCache = { at: now(), id };
    return id;
  };
  const fail = (c: Context, status: 400 | 401 | 403 | 413 | 429 | 502, message: string) => c.json({ type: "error", message }, status);

  const challenges = new ChallengeStore(now);
  const authLimiter = new RateLimiter(20, 4, 16, now);
  const message = challengeMessage(cfg.vault);

  app.post("/session/challenge", (c) => {
    const wait = authLimiter.hit(clientKey(c, cfg.trustProxy));
    if (wait !== null) return fail(c, 429, `Too many requests. Try again in ${wait}s.`);
    const ch = challenges.issue();
    if (!ch) return fail(c, 429, "Too many pending sign-in challenges. Try again shortly.");
    return c.json({ nonce: ch.nonce.toString("base64"), message, recipient: cfg.vault, expires_at: ch.expiresAt });
  });

  app.post("/session", async (c) => {
    const wait = authLimiter.hit(clientKey(c, cfg.trustProxy));
    if (wait !== null) return fail(c, 429, `Too many requests. Try again in ${wait}s.`);
    const parsed = sessionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "Invalid request: expected { accountId, publicKey, signature, nonce }");
    const b = parsed.data;
    const nonce = Buffer.from(b.nonce, "base64");
    if (nonce.length !== 32 || !challenges.consume(nonce)) return fail(c, 401, "Unknown, expired or already used challenge; request a new one");
    const digest = nep413Digest({ message, nonce, recipient: cfg.vault, callbackUrl: b.callbackUrl ?? null });
    if (!verifyEd25519(b.publicKey, digest, Buffer.from(b.signature, "base64"))) return fail(c, 401, "Invalid signature");
    try {
      if ((await d.accessKey(b.accountId, b.publicKey)) !== "full") return fail(c, 401, "The signing key is not a full-access key of this account");
      if ((await vaultOwner()) !== b.accountId) return fail(c, 403, "This account is not the owner of the vault");
    } catch {
      return fail(c, 502, "Could not verify the key or the vault owner via NEAR RPC");
    }
    const t = now();
    const token = signToken(cfg.sessionSecret, { sub: b.accountId, vault: cfg.vault, iat: t, exp: t + SESSION_TTL_MS });
    return c.json({ token, account_id: b.accountId, expires_at: t + SESSION_TTL_MS });
  });

  app.get("/info", async (c) => c.json(await d.info.get()));

  app.post("/chat", async (c) => {
    const key = clientKey(c, cfg.trustProxy);
    const wait = limiter.hit(key);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return fail(c, 429, `Too many requests. Try again in ${wait}s.`);
    }
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const claims = bearer ? verifyToken(cfg.sessionSecret, bearer, cfg.vault, now()) : null;
    if (!claims) return fail(c, 401, "Sign in first: missing, invalid or expired assistant session");
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return fail(c, 413, "Request body too large");
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(c, 413, "Request body too large");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(c, 400, "Body must be JSON");
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return fail(c, 400, `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const body = parsed.data;

    if (body.messages.length > cfg.maxMessages) return fail(c, 400, `Too many messages (max ${cfg.maxMessages}); start a new conversation`);
    if (body.messages.some((m) => m.content.length > cfg.maxMessageChars)) return fail(c, 400, `A message is too long (max ${cfg.maxMessageChars} characters)`);
    if (body.messages.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) return fail(c, 400, "The conversation is too long; start a new one");
    if (body.messages[body.messages.length - 1]?.role !== "user") return fail(c, 400, "The last message must be from the user");
    if (body.vault !== cfg.vault) return fail(c, 403, "This assistant only serves the vault this worker is configured for");
    if (!isNearAccountId(body.owner_account) || body.owner_account !== claims.sub) return fail(c, 403, "owner_account does not match the signed-in account");

    // Ownership can change after the session was issued: re-check (cached 60 s).
    try {
      if ((await vaultOwner()) !== claims.sub) return fail(c, 403, "The signed-in account is no longer the owner of this vault");
    } catch {
      return fail(c, 502, "Could not read the vault from NEAR RPC");
    }

    const release = limiter.acquire(key);
    if (!release) return fail(c, 429, "Too many conversations in progress. Try again shortly.");

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      const timer = setTimeout(() => {
        abort.abort();
      }, cfg.timeoutMs);
      stream.onAbort(() => {
        abort.abort();
      });
      const send = (ev: ChatEvent) => stream.writeSSE({ event: ev.type, data: toJson(ev) });
      try {
        if (!cfg.apiKey) {
          await send({ type: "error", message: "The AI assistant is not configured: set NEARAI_API_KEY in the worker environment." });
          return;
        }
        const events = runChat(
          { model: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }, view: d.view, tools, vault: cfg.vault, network: cfg.network, now, usdcAsset: d.usdcAsset },
          body.messages,
          body.owner_account,
          abort.signal,
        );
        for await (const ev of events) await send(ev);
      } finally {
        clearTimeout(timer);
        release();
      }
    });
  });

  return app;
}
