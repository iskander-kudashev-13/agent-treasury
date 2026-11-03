/**
 * Agent-driven trading (docs/adr/0007-agent-driven-trading.md): the pieces around the engine that are specific to an external AI
 * agent placing orders.
 *
 *   token      `atk1_<bot_id>_<43 base64url chars>`, minted ONLY by a NEP-413 confirm of an agent mandate (confirm.ts). The worker
 *              keeps sha256(token) in bots.json and nothing else; the raw token is returned once and never logged.
 *   note       the agent's `reason`, sanitised to plain text for the owner. It is never returned to the agent and never put into
 *              an LLM prompt.
 *   body       strict schema of `POST /trading/agent/order`.
 *   gate       per bot: one request in flight, a minimum interval between requests, and an in-memory idempotency cache.
 *   mapping    engine outcome -> the frozen `AgentOrderResponse`; `TRANSIENT` codes are the only non-final refusals.
 *
 * The risk decision itself is NOT here: every agent order goes through the engine's `attempt()` (engine/tick.ts), the same code
 * path as a DSL rule, after every account gate of the same tick.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { botKind } from "./bots.js";
import type { BotRegistry } from "./bots.js";
import { toMicro } from "./rules/schema.js";
import type { AgentIntent, AgentOrderResponse, AgentTokenIssued, AgentTokenRecord } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------------------------------------------------

export const AGENT_TOKEN_RE = /^atk1_([a-z0-9][a-z0-9-]{0,15})_([A-Za-z0-9_-]{43})$/;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A new random token for `botId` and the record that is stored instead of it. */
export function makeAgentToken(botId: string, nowMs: number, ttlMs: number): { issued: AgentTokenIssued; record: AgentTokenRecord } {
  const token = `atk1_${botId}_${randomBytes(32).toString("base64url")}`;
  if (!AGENT_TOKEN_RE.test(token)) throw new Error("bad bot id for an agent token");
  const token_sha256 = sha256Hex(token);
  const record: AgentTokenRecord = { token_sha256, token_id: token_sha256.slice(0, 8), issued_at_ms: nowMs, expires_at_ms: nowMs + ttlMs };
  return { issued: { token, token_id: record.token_id, issued_at_ms: record.issued_at_ms, expires_at_ms: record.expires_at_ms }, record };
}

/** The bot id a token names (only a syntactic parse; `verifyAgentToken` decides). */
export function parseAgentToken(token: string): { botId: string } | null {
  const m = AGENT_TOKEN_RE.exec(token);
  return m?.[1] === undefined ? null : { botId: m[1] };
}

export type TokenCheck =
  | { ok: true; botId: string; tokenId: string; record: AgentTokenRecord }
  | { ok: false; status: 401; code: "AGENT_UNAUTHORIZED" | "AGENT_TOKEN_EXPIRED"; message: string };

const UNAUTHORIZED: TokenCheck = { ok: false, status: 401, code: "AGENT_UNAUTHORIZED", message: "Missing or invalid agent token" };

/**
 * ADR-0007 section 3 "Verify". Unknown bot, archived bot, not an agent bot, no token on record and a hash mismatch all give the
 * same answer, so the response does not tell which one applied. The bot id comes ONLY from the token.
 */
export function verifyAgentToken(registry: Pick<BotRegistry, "get">, authorization: string | undefined, nowMs: number): TokenCheck {
  const bearer = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (bearer === undefined || bearer.length > 100) return UNAUTHORIZED;
  const p = parseAgentToken(bearer);
  if (p === null) return UNAUTHORIZED;
  const bot = registry.get(p.botId);
  const rec = bot?.agent ?? null;
  // Hash the presented token even when the bot is unknown, so timing does not reveal whether the bot exists.
  const presented = createHash("sha256").update(bearer, "utf8").digest();
  const stored = Buffer.from(rec?.token_sha256 ?? "0".repeat(64), "hex");
  const same = stored.length === 32 && timingSafeEqual(presented, stored);
  if (bot === undefined || bot.archived_at_ms !== null || botKind(bot) !== "agent" || rec === null || !same) return UNAUTHORIZED;
  if (nowMs >= rec.expires_at_ms) return { ok: false, status: 401, code: "AGENT_TOKEN_EXPIRED", message: "The agent token has expired; ask the owner for a new one" };
  return { ok: true, botId: bot.id, tokenId: rec.token_id, record: rec };
}

// ---------------------------------------------------------------------------------------------------------------------
// Note (the agent's `reason`)
// ---------------------------------------------------------------------------------------------------------------------

export const NOTE_MAX = 200;

/**
 * Control, format (incl. bidi overrides) and line/paragraph separators become spaces, whitespace is collapsed, the text is trimmed
 * and cut to 200 code points. Empty = null. The result is shown to the owner as plain text only.
 */
export function sanitizeNote(reason: string | undefined | null): string | null {
  if (reason === undefined || reason === null) return null;
  const flat = reason.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = Array.from(flat).slice(0, NOTE_MAX).join("").trim(); // code points, as the ADR says
  return cut === "" ? null : cut;
}

// ---------------------------------------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------------------------------------

export const AGENT_BODY_MAX_BYTES = 2048;
const DEC_RE = /^\d+(\.\d{1,6})?$/;
const PAIR_RE = /^[A-Za-z0-9]{1,16}\/USDC$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const agentOrderBody = z
  .strictObject({
    pair: z.string().regex(PAIR_RE),
    side: z.enum(["buy", "sell"]),
    usdc: z.string().regex(DEC_RE).optional(),
    position_pct: z.string().regex(DEC_RE).optional(),
    reason: z.string().max(NOTE_MAX).optional(),
    idempotency_key: z.string().regex(IDEMPOTENCY_KEY_RE).optional(),
  })
  .superRefine((b, ctx) => {
    const has = (b.usdc !== undefined ? 1 : 0) + (b.position_pct !== undefined ? 1 : 0);
    if (has !== 1) ctx.addIssue({ code: "custom", message: "exactly one of usdc / position_pct is required", path: ["usdc"] });
    if (b.usdc !== undefined && toMicro(b.usdc) <= 0n) ctx.addIssue({ code: "custom", message: "usdc must be greater than 0", path: ["usdc"] });
    if (b.position_pct !== undefined) {
      if (b.side !== "sell") ctx.addIssue({ code: "custom", message: "position_pct is allowed for sell only", path: ["position_pct"] });
      const v = toMicro(b.position_pct);
      if (v < 1_000_000n || v > 100_000_000n) ctx.addIssue({ code: "custom", message: "position_pct must be between 1 and 100", path: ["position_pct"] });
    }
  });
export type AgentOrderBody = z.infer<typeof agentOrderBody>;

export function intentOf(b: AgentOrderBody): AgentIntent {
  return { pair: b.pair, side: b.side, size: b.usdc !== undefined ? { usdc: b.usdc } : { position_pct: b.position_pct ?? "0" } };
}

/** The body without the idempotency key, keys sorted: two requests are "the same" when this matches. */
export function canonicalBody(b: AgentOrderBody): string {
  const o: Record<string, string> = {};
  for (const k of ["pair", "position_pct", "reason", "side", "usdc"] as const) {
    const v = b[k];
    if (v !== undefined) o[k] = v;
  }
  return JSON.stringify(o);
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-bot gate: in flight, interval, idempotency (in memory; lost on restart, documented)
// ---------------------------------------------------------------------------------------------------------------------

export const IDEMPOTENCY_MAX = 100;
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

interface CacheEntry {
  body: string;
  atMs: number;
  response: AgentOrderResponse;
}

interface BotGate {
  inFlight: boolean;
  lastStartMs: number | null;
  cache: Map<string, CacheEntry>;
}

export type GateDecision =
  | { kind: "go"; release: (key: string | undefined, body: string, response: AgentOrderResponse) => void; abort: () => void }
  | { kind: "replay"; response: AgentOrderResponse }
  | { kind: "error"; status: 409 | 429; code: "ORDER_IN_FLIGHT" | "IDEMPOTENCY_KEY_REUSED" | "AGENT_RATE_LIMITED"; message: string; retryAfterS?: number };

export class AgentGate {
  private readonly bots = new Map<string, BotGate>();
  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keyed by bot AND token id: a new token (re-sign) starts with an empty cache. */
  private gate(key: string): BotGate {
    let g = this.bots.get(key);
    if (g === undefined) {
      g = { inFlight: false, lastStartMs: null, cache: new Map() };
      this.bots.set(key, g);
    }
    return g;
  }

  /** When the next order request of this bot would be accepted by the interval check. */
  nextAllowedAtMs(botId: string, tokenId: string): number {
    const g = this.bots.get(`${botId}:${tokenId}`);
    return g?.lastStartMs == null ? this.now() : Math.max(this.now(), g.lastStartMs + this.minIntervalMs);
  }

  /**
   * Order of checks (ADR-0007 section 4): idempotent replay first (it never places anything, so it is not rate limited), then one
   * request in flight, then the interval (start to start). A `go` must be followed by exactly one `release` or `abort`.
   */
  begin(botId: string, tokenId: string, idemKey: string | undefined, body: string): GateDecision {
    const g = this.gate(`${botId}:${tokenId}`);
    const t = this.now();
    for (const [k, e] of g.cache) if (t - e.atMs > IDEMPOTENCY_TTL_MS) g.cache.delete(k);
    if (idemKey !== undefined) {
      const hit = g.cache.get(idemKey);
      if (hit !== undefined) {
        if (hit.body !== body) return { kind: "error", status: 409, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency_key was used for a different order" };
        return { kind: "replay", response: { ...hit.response, replayed: true } };
      }
    }
    if (g.inFlight) return { kind: "error", status: 409, code: "ORDER_IN_FLIGHT", message: "Another order of this bot is being processed; wait for its result" };
    if (g.lastStartMs !== null && t - g.lastStartMs < this.minIntervalMs) {
      const wait = Math.max(1, Math.ceil((g.lastStartMs + this.minIntervalMs - t) / 1000));
      return { kind: "error", status: 429, code: "AGENT_RATE_LIMITED", message: `Orders of this bot are limited to one per ${Math.round(this.minIntervalMs / 1000)} s; try again in ${wait} s`, retryAfterS: wait };
    }
    g.inFlight = true;
    g.lastStartMs = t;
    let done = false;
    return {
      kind: "go",
      release: (key, b, response) => {
        if (done) return;
        done = true;
        g.inFlight = false;
        if (key === undefined) return;
        g.cache.set(key, { body: b, atMs: this.now(), response: { ...response, replayed: false } });
        while (g.cache.size > IDEMPOTENCY_MAX) {
          const oldest = g.cache.keys().next().value;
          if (oldest === undefined) break;
          g.cache.delete(oldest);
        }
      },
      abort: () => {
        if (done) return;
        done = true;
        g.inFlight = false;
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------------------------------------------------

/** Refusals that may clear by themselves (market or worker temporarily unavailable): `final: false`, retry after 60 s. */
export const TRANSIENT: ReadonlySet<string> = new Set([
  "STALE_BOOK",
  "BOOK_EMPTY",
  "SPREAD_TOO_WIDE",
  "BOOK_UNAVAILABLE",
  "STALE_DATA",
  "HL_READ_FAILED",
  "VAULT_STATUS_UNAVAILABLE",
  "NO_DAY_SNAPSHOT",
  "FILLS_RESYNC",
  "FILLS_NOT_ATTRIBUTED",
  "NO_MID_FOR_POSITION",
  "SCHEDULE_CANCEL_FAILED",
  "STATE_WRITE_FAILED",
  "INTERNAL_ERROR",
  "SERVICE_ERROR",
  "NO_TICK_YET",
]);
export const TRANSIENT_RETRY_S = 60;

/** Any code not in TRANSIENT is final (fail closed on behaviour). */
export const isFinal = (code: string): boolean => !TRANSIENT.has(code);

const MESSAGE_MAX = 300;
const HL_ERROR_MAX = 200;

/** Worker text only, single line, bounded. */
export function responseMessage(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MESSAGE_MAX);
}

export function requestId(): string {
  return randomBytes(8).toString("hex");
}

export interface RemainingToday {
  orders: number;
  loss_usdc: string;
}

export function rejected(code: string, message: string, remaining: RemainingToday, order: AgentOrderResponse["order"] = null, id = requestId()): AgentOrderResponse {
  const final = isFinal(code);
  return {
    status: "rejected",
    code,
    message: responseMessage(message),
    final,
    retry_after_s: final ? null : TRANSIENT_RETRY_S,
    order,
    fill: null,
    remaining_today: remaining,
    replayed: false,
    request_id: id,
  };
}

/** `HL_REJECTED` keeps HL's own text, cut to 200 chars. */
export function hlErrorText(e: string): string {
  return responseMessage(e).slice(0, HL_ERROR_MAX);
}
