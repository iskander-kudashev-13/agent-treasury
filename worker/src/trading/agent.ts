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
  /** null while the first request with this key is still running (`pending` settles with its answer). */
  response: AgentOrderResponse | null;
  /** Settles with the first request's answer, or null when it was aborted (no answer, e.g. the token was revoked meanwhile). */
  pending: Promise<AgentOrderResponse | null> | null;
}

interface BotGate {
  inFlight: boolean;
  lastStartMs: number | null;
  cache: Map<string, CacheEntry>;
}

export type GateDecision =
  | { kind: "go"; release: (response: AgentOrderResponse) => void; abort: () => void }
  | { kind: "replay"; response: AgentOrderResponse }
  /** Same key and same body as a request that is still running: wait for its answer and replay it (audit AL2, review M3). */
  | { kind: "wait"; result: Promise<AgentOrderResponse | null> }
  | { kind: "error"; status: 409 | 429; code: "ORDER_IN_FLIGHT" | "IDEMPOTENCY_KEY_REUSED" | "AGENT_RATE_LIMITED"; message: string; retryAfterS?: number };

/** A refusal that may clear by itself is not cached (audit AL8): a retry with the same key after `retry_after_s` runs again. */
const cacheable = (r: AgentOrderResponse): boolean => !(r.status === "rejected" && !r.final);

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
   * Order of checks (ADR-0007 section 4): idempotency first (a replay, or a wait for the running request with the same key and
   * body; neither places anything, so neither is rate limited), then one request in flight, then the interval (start to start).
   * A `go` must be followed by exactly one `release` or `abort`.
   */
  begin(botId: string, tokenId: string, idemKey: string | undefined, body: string): GateDecision {
    const g = this.gate(`${botId}:${tokenId}`);
    const t = this.now();
    for (const [k, e] of g.cache) if (e.pending === null && t - e.atMs > IDEMPOTENCY_TTL_MS) g.cache.delete(k);
    if (idemKey !== undefined) {
      const hit = g.cache.get(idemKey);
      if (hit !== undefined) {
        if (hit.body !== body) return { kind: "error", status: 409, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency_key was used for a different order" };
        if (hit.response !== null) return { kind: "replay", response: { ...hit.response, replayed: true } };
        if (hit.pending !== null) return { kind: "wait", result: hit.pending.then((r) => (r === null ? null : { ...r, replayed: true })) };
      }
    }
    if (g.inFlight) return { kind: "error", status: 409, code: "ORDER_IN_FLIGHT", message: "Another order of this bot is being processed; wait for its result" };
    if (g.lastStartMs !== null && t - g.lastStartMs < this.minIntervalMs) {
      const wait = Math.max(1, Math.ceil((g.lastStartMs + this.minIntervalMs - t) / 1000));
      return { kind: "error", status: 429, code: "AGENT_RATE_LIMITED", message: `Orders of this bot are limited to one per ${Math.round(this.minIntervalMs / 1000)} s; try again in ${wait} s`, retryAfterS: wait };
    }
    g.inFlight = true;
    g.lastStartMs = t;
    let settle: (r: AgentOrderResponse | null) => void = () => undefined;
    let entry: CacheEntry | null = null;
    if (idemKey !== undefined) {
      const pending = new Promise<AgentOrderResponse | null>((resolve) => (settle = resolve));
      entry = { body, atMs: t, response: null, pending };
      g.cache.delete(idemKey);
      g.cache.set(idemKey, entry);
      this.trim(g);
    }
    let done = false;
    return {
      kind: "go",
      release: (response) => {
        if (done) return;
        done = true;
        g.inFlight = false;
        const stored = { ...response, replayed: false };
        if (entry !== null && idemKey !== undefined) {
          if (cacheable(stored) && g.cache.get(idemKey) === entry) {
            entry.response = stored;
            entry.pending = null;
            entry.atMs = this.now();
          } else if (g.cache.get(idemKey) === entry) g.cache.delete(idemKey);
        }
        settle(stored); // a request that waited on this key gets the same answer (also a transient one)
      },
      abort: () => {
        if (done) return;
        done = true;
        g.inFlight = false;
        if (entry !== null && idemKey !== undefined && g.cache.get(idemKey) === entry) g.cache.delete(idemKey);
        settle(null);
      },
    };
  }

  /** Keeps the 100 newest entries; an entry whose request is still running is never evicted. */
  private trim(g: BotGate): void {
    for (const [k, e] of g.cache) {
      if (g.cache.size <= IDEMPOTENCY_MAX) break;
      if (e.pending === null) g.cache.delete(k);
    }
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

/**
 * The public scrub (audit L5, also used by `publicText` for `/status`): no URLs or query strings, since RPC / HL endpoints can
 * carry keys and host names.
 */
export function scrubUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, "[url]").replace(/\?[A-Za-z0-9_.~%-]+=\S*/g, "");
}

/** Worker text only, single line, bounded, URLs removed (audit AL7: exception text can name hosts). */
export function responseMessage(s: string): string {
  return scrubUrls(s).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MESSAGE_MAX);
}

/**
 * Review M1: the order reached the point of placement but no clean answer came back (a network error or timeout on the order
 * call, or a failure after it). It may or may not exist on Hyperliquid. FINAL: the agent must read the state before anything else.
 */
export const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";
export const OUTCOME_UNKNOWN_MESSAGE =
  "The order was sent but its outcome is unknown: it may or may not have traded. Call trading_get_state before doing anything else, and do not repeat this order until the state shows what happened";

/** Owner-chosen text shown to the agent (the bot name, audit AL5): the note sanitiser plus a length cap. */
export function plainText(s: string, max: number): string | null {
  const flat = sanitizeNote(s);
  return flat === null ? null : Array.from(flat).slice(0, max).join("").trim() || null;
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
