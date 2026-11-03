/**
 * Owner confirmation of a trading rule set (ADR-0005 sections 4-5, threats T2, T3, T13, T14).
 *
 * challenge: validates the rules, issues a single-use 5 min nonce BOUND to (rules hash, bot id), returns the exact NEP-413
 *            message to sign (v2: it names the bot). The dashboard computes the hash itself and refuses on mismatch.
 * confirm:   consumes the nonce (first use wins even if the signature is bad), then `verifyEnvelope`:
 *            hash == sha256(canonical(rules)), message == the ADR message, ed25519 NEP-413 signature, the key is a
 *            FULL-ACCESS key of the signer, the signer is the vault owner, validate() passes against hard limits and
 *            live pair data. Only then is the envelope persisted.
 * `verifyEnvelope` is also what `store.ts` runs on every load, so a stored file is trusted no more than a request.
 */
import { randomBytes } from "node:crypto";
import { CHALLENGE_TTL_MS, nep413Digest, verifyEd25519 } from "../ai/session.js";
import { makeAgentToken } from "./agent.js";
import { RegistryError } from "./bots.js";
import type { BotRegistry } from "./bots.js";
import { confirmationMessage, hashRuleSet } from "./rules/canonical.js";
import { parseRuleSet } from "./rules/schema.js";
import { validate } from "./rules/validate.js";
import type { RulesStore } from "./store.js";
import { BOT_ID_RE, DEFAULT_BOT_ID } from "./types.js";
import type { AgentTokenIssued, Bot, BotKind, ConfirmedRules, HardLimits, PairInfoMap, RuleSetV1 } from "./types.js";

export interface ConfirmCtx {
  vault: string;
  agentId: string;
  hlNetwork: "mainnet" | "testnet";
  /** `HL_MASTER_ADDRESS`. */
  hlAccount: string;
  hard: HardLimits;
  /** RPC `view_access_key`: what kind of key `publicKey` is on `accountId`. */
  accessKey: (accountId: string, publicKey: string) => Promise<"full" | "limited" | "none">;
  /** Current vault owner (`contractInfo().owner_id`). Must not be cached for longer than the caller accepts. */
  vaultOwner: () => Promise<string>;
}

export class ConfirmError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfirmError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function b64(s: unknown, len: number): Buffer | null {
  if (typeof s !== "string" || s.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.length === len ? b : null;
}

/**
 * Pair data used when only the stored envelope is re-checked on load (no live HL call): every allowed pair is treated
 * as an acceptable spot pair. Live volume and asset ids are enforced again by the engine on every tick.
 */
export function offlinePairInfo(hard: HardLimits): PairInfoMap {
  return Object.fromEntries(
    hard.allowedPairs.map((name) => [name, { name, assetId: 10_000, szDecimals: 0, volume24hUsdc: hard.minPairVolumeUsdc }]),
  );
}

/** Which bot an envelope must belong to, and whether the v1 message (no `bot:` line) is acceptable for it. */
export interface EnvelopeExpect {
  botId: string;
  /**
   * The pre-migration active hash of bot `default` (`bots.json` `legacy_v1`). Only an envelope with this exact hash, for the bot
   * `default`, and no `bot_id` field may still carry the v1 message. Every other envelope must carry the v2 message.
   */
  legacyV1Hash?: string | null | undefined;
}

/**
 * Full re-verification of a confirmed rule set. Throws `ConfirmError` on any failure. Used by confirm and by the store.
 * Returns the parsed rule set.
 */
export async function verifyEnvelope(env: ConfirmedRules, ctx: ConfirmCtx, pairInfo: PairInfoMap, expect: EnvelopeExpect): Promise<RuleSetV1> {
  const parsed = parseRuleSet(env.rules);
  if (!parsed.ok) throw new ConfirmError(400, "RULES_INVALID", `Invalid rules: ${parsed.issues.map((i) => `${i.code} ${i.path}`).join(", ")}`);
  const rules = parsed.value;
  const v = validate(rules, ctx.hard, pairInfo);
  if (!v.ok) throw new ConfirmError(400, "RULES_INVALID", `Rules rejected: ${v.errors.map((i) => `${i.code} ${i.path}`).join(", ")}`);

  const hash = hashRuleSet(rules);
  if (typeof env.hash !== "string" || !SHA256_HEX.test(env.hash) || env.hash !== hash) throw new ConfirmError(400, "HASH_MISMATCH", "The hash does not match the rules");

  const base = { vault: ctx.vault, agentId: ctx.agentId, hlNetwork: ctx.hlNetwork, hlAccount: ctx.hlAccount, rulesSha256: hash };
  // ADR-0007: the mode comes from the PARSED SIGNED rules, never from a request field; an agent mandate needs the v3 message.
  const mode = rules.mode;
  let message: string;
  if (env.bot_id === undefined) {
    // Written before multi-bot support: valid only as the migrated `default` rule set that was active at migration time.
    if (mode !== undefined || expect.botId !== DEFAULT_BOT_ID || expect.legacyV1Hash == null || expect.legacyV1Hash !== hash)
      throw new ConfirmError(400, "MESSAGE_MISMATCH", "This confirmation predates bots and is not valid for this bot; sign the rules again");
    message = confirmationMessage(base);
  } else {
    if (env.bot_id !== expect.botId) throw new ConfirmError(400, "MESSAGE_MISMATCH", "The confirmation was signed for a different bot");
    message = confirmationMessage({ ...base, botId: env.bot_id, ...(mode !== undefined ? { mode } : {}) });
  }
  if (env.message !== message) throw new ConfirmError(400, "MESSAGE_MISMATCH", "The signed message is not the expected confirmation message");

  const nonce = b64(env.nonce, 32);
  const signature = b64(env.signature, 64);
  if (!nonce || !signature) throw new ConfirmError(400, "BAD_ENCODING", "nonce must be 32 bytes and signature 64 bytes, base64");
  const digest = nep413Digest({ message, nonce, recipient: ctx.vault, callbackUrl: env.callback_url });
  if (!verifyEd25519(env.public_key, digest, signature)) throw new ConfirmError(401, "BAD_SIGNATURE", "Invalid signature");

  let kind: "full" | "limited" | "none";
  let owner: string;
  try {
    kind = await ctx.accessKey(env.account_id, env.public_key);
    owner = await ctx.vaultOwner();
  } catch {
    throw new ConfirmError(502, "RPC_ERROR", "Could not verify the key or the vault owner via NEAR RPC");
  }
  if (kind !== "full") throw new ConfirmError(401, "NOT_FULL_ACCESS", "The signing key is not a full-access key of this account");
  if (owner !== env.account_id) throw new ConfirmError(403, "NOT_OWNER", "This account is not the owner of the vault");
  return rules;
}

export interface ConfirmDeps {
  ctx: ConfirmCtx;
  store: Pick<RulesStore, "save">;
  registry: BotRegistry;
  /** `TRADING_MAX_BOTS`. */
  maxBots: number;
  /** Live `spotMeta` data (HL call). */
  getPairInfo: () => Promise<PairInfoMap>;
  /** Absent = available. False: limit orders are only a warning in the challenge. */
  deadManAvailable?: (() => boolean) | undefined;
  /** Returns why the service cannot accept owner writes right now (corrupt state / registry), or null. Challenges and confirmations are refused meanwhile. */
  writeBlocked?: (() => string | null) | undefined;
  /**
   * Opaque stamp of the kill state that concerns `botId` (kill-all epoch + that bot's epoch). A challenge remembers the stamp it was
   * issued under; a confirmation under a different stamp is refused, so a signature collected before a Stop cannot undo the Stop
   * (audit 2026-11-03 MM2). Absent = no check (tests that do not wire the service).
   */
  killStamp?: ((botId: string) => string) | undefined;
  /**
   * ADR-0007: agent-driven trading. Absent or `enabled: false` = an agent mandate is refused (409 AGENT_TRADING_DISABLED).
   * `tokenTtlMs`: lifetime of a token minted by a confirmation.
   */
  agent?: { enabled: boolean; tokenTtlMs: number } | undefined;
  now?: () => number;
}

export interface Challenge {
  nonce: string;
  message: string;
  recipient: string;
  hash: string;
  expires_at: number;
  warnings: string[];
  bot_id: string;
  /** True when the bot does not exist yet: it is created by the confirmation (not by this challenge). */
  is_new: boolean;
  /** ADR-0007: "agent" for an agent mandate (message v3), else "rules". */
  mode: BotKind;
}

export interface ConfirmBody {
  rules: unknown;
  account_id: unknown;
  public_key: unknown;
  signature: unknown;
  nonce: unknown;
  callback_url?: unknown;
  bot_id?: unknown;
  bot_name?: unknown;
}

export interface Confirmation {
  env: ConfirmedRules;
  bot: Bot;
  /** ADR-0007: the new agent token (returned ONCE; only its sha256 is stored). Null for DSL rule sets. */
  agentToken: AgentTokenIssued | null;
}

const MAX_PENDING = 200;

function fromRegistry(e: unknown): never {
  if (e instanceof RegistryError) throw new ConfirmError(e.status, e.code, e.message);
  throw e;
}

export class RulesConfirmer {
  private readonly pending = new Map<string, { hash: string; botId: string; botName: string | undefined; isNew: boolean; stamp: string | null; expiresAt: number }>();
  private readonly now: () => number;
  constructor(private readonly d: ConfirmDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Kind of a parsed rule set, refused while agent-driven trading is off. */
  private kindOf(rules: RuleSetV1): BotKind {
    if (rules.mode !== "agent") return "rules";
    if (this.d.agent?.enabled !== true)
      throw new ConfirmError(409, "AGENT_TRADING_DISABLED", "AI-agent trading is turned off on this worker (TRADING_AGENT_ENABLED=false)");
    return "agent";
  }

  private assertWritable(): void {
    const why = this.d.writeBlocked?.() ?? null;
    if (why !== null) throw new ConfirmError(409, "SERVICE_STATE_UNUSABLE", `The trading service refuses changes until its state files are fixed: ${why}`);
  }

  private async pairInfo(): Promise<PairInfoMap> {
    try {
      return await this.d.getPairInfo();
    } catch {
      throw new ConfirmError(502, "HL_UNAVAILABLE", "Could not read Hyperliquid pair data");
    }
  }

  /**
   * @param botId the bot the rules are for; absent = `default` (callers from before bots existed).
   * @param botName required when the bot does not exist yet (a bot is created only when its first confirmation verifies).
   */
  async challenge(rulesInput: unknown, botId: string = DEFAULT_BOT_ID, botName?: string): Promise<Challenge> {
    this.assertWritable();
    // Taken before any await: a kill that lands while the pair data is fetched also invalidates this challenge.
    const stamp = this.d.killStamp?.(botId) ?? null;
    if (!BOT_ID_RE.test(botId)) throw new ConfirmError(400, "BAD_BOT_ID", "bot_id must be lower-case letters, digits and '-', 1..16 chars");
    const parsed = parseRuleSet(rulesInput);
    if (!parsed.ok) throw new ConfirmError(400, "RULES_INVALID", `Invalid rules: ${parsed.issues.map((i) => `${i.code} ${i.path}`).join(", ")}`);
    const hash = hashRuleSet(parsed.value);
    const kind = this.kindOf(parsed.value);
    // Bot rules first (cheap, no HL call): MAX_BOTS, RULES_USED_BY_OTHER_BOT, BOT_ARCHIVED, BOT_KIND_MISMATCH ...
    let isNew: boolean;
    try {
      isNew = this.d.registry.check({ botId, hash, name: botName ?? parsed.value.name, maxBots: this.d.maxBots, kind }).isNew;
    } catch (e) {
      return fromRegistry(e);
    }
    const v = validate(parsed.value, this.d.ctx.hard, await this.pairInfo(), { deadManAvailable: this.d.deadManAvailable?.() ?? true });
    if (!v.ok) throw new ConfirmError(400, "RULES_INVALID", `Rules rejected: ${v.errors.map((i) => `${i.code} ${i.path}`).join(", ")}`);
    const t = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(k);
    if (this.pending.size >= MAX_PENDING) throw new ConfirmError(429, "TOO_MANY_CHALLENGES", "Too many pending challenges. Try again shortly.");
    const nonce = randomBytes(32);
    const expiresAt = t + CHALLENGE_TTL_MS;
    this.pending.set(nonce.toString("hex"), { hash, botId, botName: botName ?? parsed.value.name, isNew, stamp, expiresAt });
    const c = this.d.ctx;
    return {
      nonce: nonce.toString("base64"),
      message: confirmationMessage({ vault: c.vault, agentId: c.agentId, hlNetwork: c.hlNetwork, hlAccount: c.hlAccount, rulesSha256: hash, botId, ...(kind === "agent" ? { mode: "agent" as const } : {}) }),
      recipient: c.vault,
      hash,
      expires_at: expiresAt,
      warnings: v.warnings.map((w) => `${w.code}: ${w.message}`),
      bot_id: botId,
      is_new: isNew,
      mode: kind,
    };
  }

  async confirm(body: ConfirmBody): Promise<Confirmation> {
    this.assertWritable();
    const { account_id, public_key, signature, nonce } = body;
    if (typeof account_id !== "string" || typeof public_key !== "string" || typeof signature !== "string" || typeof nonce !== "string")
      throw new ConfirmError(400, "BAD_REQUEST", "Expected { rules, account_id, public_key, signature, nonce }");
    const cb = body.callback_url;
    if (cb !== undefined && cb !== null && (typeof cb !== "string" || cb.length > 500 || !/^https?:\/\//.test(cb)))
      throw new ConfirmError(400, "BAD_REQUEST", "callback_url must be null or an http(s) URL");
    if (body.bot_id !== undefined && typeof body.bot_id !== "string") throw new ConfirmError(400, "BAD_REQUEST", "bot_id must be a string");
    if (body.bot_name !== undefined && typeof body.bot_name !== "string") throw new ConfirmError(400, "BAD_REQUEST", "bot_name must be a string");
    const n = b64(nonce, 32);
    if (!n) throw new ConfirmError(400, "BAD_ENCODING", "nonce must be 32 bytes, base64");

    // Consume first: a nonce is single-use whatever happens next (replay protection).
    const key = n.toString("hex");
    const p = this.pending.get(key);
    this.pending.delete(key);
    if (!p || p.expiresAt <= this.now()) throw new ConfirmError(401, "UNKNOWN_NONCE", "Unknown, expired or already used challenge; request a new one");
    // The nonce is bound to (hash, bot): a challenge for bot A cannot activate bot B.
    const botId = body.bot_id ?? p.botId;
    if (botId !== p.botId) throw new ConfirmError(400, "BOT_MISMATCH", "This challenge was issued for a different bot");

    // A Stop (kill-all, or a kill of this bot) since the challenge was issued: the owner's later intent wins over this signature.
    if (p.stamp !== null && this.d.killStamp?.(botId) !== p.stamp)
      throw new ConfirmError(409, "KILLED_SINCE_CHALLENGE", "The trading was stopped after this confirmation was requested; nothing was activated. Create the rules again.");
    // A challenge for a NEW bot must not turn into an update of a bot that took the id meanwhile (audit 2026-11-03 MM1).
    if (p.isNew && this.d.registry.get(botId) !== undefined)
      throw new ConfirmError(409, "BOT_ID_TAKEN", `An agent with the id "${botId}" exists now; this confirmation was for a new agent and would have replaced its rules. Create the rules again.`);

    const parsed = parseRuleSet(body.rules);
    if (!parsed.ok) throw new ConfirmError(400, "RULES_INVALID", `Invalid rules: ${parsed.issues.map((i) => `${i.code} ${i.path}`).join(", ")}`);
    const hash = hashRuleSet(parsed.value);
    if (hash !== p.hash) throw new ConfirmError(400, "HASH_MISMATCH", "These rules are not the rules the challenge was issued for");
    const kind = this.kindOf(parsed.value);

    const c = this.d.ctx;
    const env: ConfirmedRules = {
      bot_id: botId,
      rules: parsed.value,
      hash,
      message: confirmationMessage({ vault: c.vault, agentId: c.agentId, hlNetwork: c.hlNetwork, hlAccount: c.hlAccount, rulesSha256: hash, botId, ...(kind === "agent" ? { mode: "agent" as const } : {}) }),
      signature,
      public_key,
      account_id,
      nonce,
      callback_url: typeof cb === "string" ? cb : null,
      confirmed_at_ms: this.now(),
    };
    await verifyEnvelope(env, c, await this.pairInfo(), { botId });
    // The bot exists only from this point on: after a valid signature. Rules are re-checked against the registry (it may have
    // changed while the signature was verified) and the registry file is the commit point, written after the envelope.
    const name = (typeof body.bot_name === "string" ? body.bot_name : undefined) ?? p.botName;
    const act = { botId, hash, name, maxBots: this.d.maxBots, kind };
    try {
      this.d.registry.check(act);
      this.d.store.save(env);
      // ADR-0007: every confirmation of an agent mandate (new bot, resume with the same hash, new limits) mints a NEW token. Only
      // its sha256 goes into bots.json, in the same commit that activates the hash, so the previous token dies with that commit.
      const minted = kind === "agent" ? makeAgentToken(botId, this.now(), this.d.agent?.tokenTtlMs ?? 0) : null;
      const bot = this.d.registry.activate(act, this.now(), minted?.record);
      return { env, bot, agentToken: minted?.issued ?? null };
    } catch (e) {
      return fromRegistry(e);
    }
  }
}
