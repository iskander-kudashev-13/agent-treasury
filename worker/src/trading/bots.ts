/**
 * Bot registry (ADR-0006 sections 1, 2 and 5): `<TRADING_STATE_DIR>/bots.json`.
 *
 * It replaces `active.json` and is the PERMANENT map from cloid prefix to bot. A bot's prefixes are never dropped, so a fill is
 * attributed for ever to the bot whose rule set placed the order. Confirm refuses anything that would make that ambiguous:
 *   RULES_USED_BY_OTHER_BOT  the hash already belongs to another bot (the owner renames the rule set)
 *   CLOID_PREFIX_TAKEN       a different hash with the same 8-byte prefix exists (2^-64, checked anyway)
 *   TOO_MANY_RULE_SETS       64 activations per bot; failing closed beats losing attribution
 *   MAX_BOTS                 TRADING_MAX_BOTS bots that are not archived
 *   BOT_ARCHIVED             an archived id is never reused
 * The file is written atomically (tmp + rename) and only after a signature verified, so an unconfirmed challenge creates nothing.
 *
 * MIGRATION (`openRegistry`): a state dir from before multi-bot support has `active.json` (and an engine state that remembered
 * cloid prefixes). On first open the bot `default` is written to `bots.json` with the active hash, every remembered prefix, and
 * `legacy_v1` = the pre-migration active hash (the only rule set whose stored envelope may still carry the v1 message). Then
 * `active.json` is renamed to `active.v1.json`. Every step is idempotent: a crash between the write and the rename is finished
 * by the next start, and an existing `bots.json` is never overwritten.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./history.js";
import { cloidPrefix } from "./engine/risk.js";
import { BOT_ID_RE, BOT_NAME_MAX, DEFAULT_BOT_ID, MAX_RULE_SETS_PER_BOT } from "./types.js";
import type { Bot, BotHashEntry } from "./types.js";

export class RegistryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface BotsFile {
  version: 1;
  bots: Bot[];
  /** The pre-migration active rule set of `default`; its stored envelope may carry the v1 confirmation message. */
  legacy_v1: { bot_id: string; hash: string } | null;
}

/** "new" is how the dashboard says "a new strategy" (`trading_bot`), so it can never be a real bot id. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["new"]);
const PREFIX = /^0x[0-9a-f]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Cleans a display name: control characters out, trimmed, at most 60 chars. */
export function cleanBotName(s: string): string {
  return s.replace(/\p{Cc}/gu, " ").trim().slice(0, BOT_NAME_MAX);
}

function parseBot(x: unknown): Bot {
  if (!isObj(x)) throw new Error("bot entry is not an object");
  const { id, name, created_at_ms, archived_at_ms, active_hash, hashes } = x;
  if (typeof id !== "string" || !BOT_ID_RE.test(id)) throw new Error(`bad bot id ${JSON.stringify(id)}`);
  if (typeof name !== "string" || name.length === 0 || name.length > BOT_NAME_MAX) throw new Error(`bad name for bot ${id}`);
  if (typeof created_at_ms !== "number" || !Number.isFinite(created_at_ms)) throw new Error(`bad created_at_ms for bot ${id}`);
  if (archived_at_ms !== null && typeof archived_at_ms !== "number") throw new Error(`bad archived_at_ms for bot ${id}`);
  if (active_hash !== null && (typeof active_hash !== "string" || !HASH.test(active_hash))) throw new Error(`bad active_hash for bot ${id}`);
  if (!Array.isArray(hashes)) throw new Error(`bad hashes for bot ${id}`);
  const hs: BotHashEntry[] = hashes.map((h: unknown) => {
    if (!isObj(h) || typeof h["prefix"] !== "string" || !PREFIX.test(h["prefix"]) || typeof h["activated_at_ms"] !== "number") throw new Error(`bad hash entry for bot ${id}`);
    const hash = h["hash"];
    if (hash !== null && (typeof hash !== "string" || !HASH.test(hash))) throw new Error(`bad hash for bot ${id}`);
    return { prefix: h["prefix"], hash, activated_at_ms: h["activated_at_ms"] };
  });
  return { id, name, created_at_ms, archived_at_ms, active_hash, hashes: hs };
}

function parseFile(text: string): BotsFile {
  const j: unknown = JSON.parse(text);
  if (!isObj(j) || j["version"] !== 1 || !Array.isArray(j["bots"])) throw new Error("bots.json has an unknown shape");
  const bots = j["bots"].map(parseBot);
  if (new Set(bots.map((b) => b.id)).size !== bots.length) throw new Error("bots.json has duplicate bot ids");
  const lv = j["legacy_v1"];
  let legacy: BotsFile["legacy_v1"] = null;
  if (isObj(lv) && typeof lv["bot_id"] === "string" && typeof lv["hash"] === "string" && HASH.test(lv["hash"])) legacy = { bot_id: lv["bot_id"], hash: lv["hash"] };
  return { version: 1, bots, legacy_v1: legacy };
}

export interface ActivationCheck {
  botId: string;
  hash: string;
  /** Required when the bot does not exist yet. */
  name?: string | undefined;
  maxBots: number;
}

export class BotRegistry {
  private file: BotsFile;
  /** Ids the engine state knows (bot blocks, order-id map). A bot id that appears there is never handed out again. */
  private stateIds: () => Iterable<string> = () => [];
  constructor(
    private readonly dir: string,
    file: BotsFile,
    /** Set when bots.json could not be read: nothing may be written over it (the operator fixes or restores it first). */
    private readonly readOnly: string | null = null,
  ) {
    this.file = file;
  }

  /** The service installs this: ids that exist in `engine-state.json` cannot be (re)used for a new bot even if bots.json lost them. */
  reserveStateIds(fn: () => Iterable<string>): void {
    this.stateIds = fn;
  }

  private path(): string {
    return join(this.dir, "bots.json");
  }

  /**
   * Copy-on-write: the new file is written to disk first and only then becomes the in-memory registry, so a failed write
   * changes nothing (the caller gets the error and the engine keeps trading exactly what bots.json says).
   */
  private commit(next: BotsFile): void {
    if (this.readOnly !== null) throw new RegistryError(409, "REGISTRY_UNUSABLE", `bots.json is unusable (${this.readOnly}); fix or restore it before changing bots`);
    writeFileAtomic(this.path(), JSON.stringify(next));
    this.file = next;
  }

  /** All bots in creation order (archived ones included: their prefixes stay attributed). */
  list(): readonly Bot[] {
    return this.file.bots;
  }
  get(id: string): Bot | undefined {
    return this.file.bots.find((b) => b.id === id);
  }
  /** Bots that are not archived. */
  live(): Bot[] {
    return this.file.bots.filter((b) => b.archived_at_ms === null);
  }
  legacyV1(): BotsFile["legacy_v1"] {
    return this.file.legacy_v1;
  }
  /** Bot whose rule-set history contains this hash. */
  hashOwner(hash: string): string | undefined {
    return this.file.bots.find((b) => b.hashes.some((h) => h.hash === hash))?.id;
  }
  prefixOwner(prefix: string): { botId: string; entry: BotHashEntry } | undefined {
    for (const b of this.file.bots) {
      const entry = b.hashes.find((h) => h.prefix === prefix);
      if (entry) return { botId: b.id, entry };
    }
    return undefined;
  }
  /** prefix -> bot id for every bot, archived ones too. */
  prefixMap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of this.file.bots) for (const h of b.hashes) m.set(h.prefix, b.id);
    return m;
  }

  /** An id for a new bot: slug of the name, `-2`, `-3` ... when taken (archived ids stay taken). */
  suggestId(name: string): string {
    const base =
      cleanBotName(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 12)
        .replace(/-+$/g, "") || "bot";
    if (RESERVED_IDS.has(base)) return this.suggestId(`${base} bot`);
    const inState = new Set(this.stateIds());
    const taken = (x: string): boolean => this.get(x) !== undefined || inState.has(x);
    let id = base;
    for (let n = 2; taken(id); n++) id = `${base.slice(0, 16 - `-${n}`.length)}-${n}`;
    return id;
  }

  /** Throws `RegistryError` when activating `hash` for `botId` is not allowed. Pure (no write). */
  check(c: ActivationCheck): { isNew: boolean } {
    if (!BOT_ID_RE.test(c.botId) || RESERVED_IDS.has(c.botId)) throw new RegistryError(400, "BAD_BOT_ID", "bot_id must be lower-case letters, digits and '-', 1..16 chars, starting with a letter or digit");
    const bot = this.get(c.botId);
    if (bot?.archived_at_ms != null) throw new RegistryError(409, "BOT_ARCHIVED", "This bot is archived; its id is never reused. Create a new strategy instead.");
    if (bot === undefined) {
      // bots.json lost a bot the engine state still has: reusing its id would hand the old position and fills to a new strategy.
      for (const id of this.stateIds())
        if (id === c.botId) throw new RegistryError(409, "BOT_ID_IN_USE", "This bot id still appears in the engine state (bots.json lost it?); choose another id");
      const name = c.name === undefined ? "" : cleanBotName(c.name);
      if (name === "") throw new RegistryError(400, "BOT_NAME_REQUIRED", "bot_name (1..60 chars) is required for a new bot");
      if (this.live().length >= c.maxBots) throw new RegistryError(409, "MAX_BOTS", `At most ${c.maxBots} bots can be active; archive one first`);
    }
    const owner = this.hashOwner(c.hash);
    if (owner !== undefined && owner !== c.botId)
      throw new RegistryError(409, "RULES_USED_BY_OTHER_BOT", `These exact rules already belong to bot '${owner}'. Change the rule set name so the bots stay distinguishable.`);
    const pre = this.prefixOwner(cloidPrefix(c.hash));
    if (pre !== undefined) {
      const sameHash = pre.entry.hash === c.hash || (pre.entry.hash === null && pre.botId === c.botId);
      if (!sameHash) throw new RegistryError(409, "CLOID_PREFIX_TAKEN", "A different rule set already uses the same order-id prefix; change the rule set name.");
    }
    if (bot !== undefined && !bot.hashes.some((h) => h.prefix === cloidPrefix(c.hash)) && bot.hashes.length >= MAX_RULE_SETS_PER_BOT)
      throw new RegistryError(409, "TOO_MANY_RULE_SETS", `A bot can activate at most ${MAX_RULE_SETS_PER_BOT} rule sets; create a new bot instead.`);
    return { isNew: bot === undefined };
  }

  /** Commit point of a confirmation: creates the bot if needed, records the prefix, makes the hash active. Re-checks first. */
  activate(c: ActivationCheck, nowMs: number): Bot {
    this.check(c);
    const prefix = cloidPrefix(c.hash);
    const old = this.get(c.botId);
    const bot: Bot =
      old === undefined
        ? { id: c.botId, name: cleanBotName(c.name ?? ""), created_at_ms: nowMs, archived_at_ms: null, active_hash: null, hashes: [] }
        : { ...old, hashes: old.hashes.map((h) => ({ ...h })) };
    const entry = bot.hashes.find((h) => h.prefix === prefix);
    if (entry === undefined) bot.hashes.push({ prefix, hash: c.hash, activated_at_ms: nowMs });
    else if (entry.hash === null) entry.hash = c.hash;
    bot.active_hash = c.hash;
    this.commit(this.with(bot));
    return bot;
  }

  /** A copy of the file in which `bot` replaces the bot with its id (or is appended). */
  private with(bot: Bot): BotsFile {
    const exists = this.file.bots.some((b) => b.id === bot.id);
    return { ...this.file, bots: exists ? this.file.bots.map((b) => (b.id === bot.id ? bot : b)) : [...this.file.bots, bot] };
  }

  rename(id: string, name: string): Bot {
    const old = this.get(id);
    if (old === undefined) throw new RegistryError(404, "BOT_NOT_FOUND", "No such bot");
    const n = cleanBotName(name);
    if (n === "") throw new RegistryError(400, "BAD_REQUEST", "name must be 1..60 characters");
    const bot: Bot = { ...old, name: n };
    this.commit(this.with(bot));
    return bot;
  }

  /** Marks a bot archived and drops its active hash. The caller has cancelled its orders and checked its position. */
  archive(id: string, nowMs: number): Bot {
    const old = this.get(id);
    if (old === undefined) throw new RegistryError(404, "BOT_NOT_FOUND", "No such bot");
    if (old.archived_at_ms !== null) return old;
    const bot: Bot = { ...old, archived_at_ms: nowMs, active_hash: null };
    this.commit(this.with(bot));
    return bot;
  }
}

export interface OpenOptions {
  /** Cloid prefixes the pre-multi-bot engine state remembered (oldest first); only used by the migration. */
  legacyPrefixes?: readonly string[];
  /** `TRADING_START_MS` (meta.json), the start of the migrated bot's "all" window. */
  startMs?: number | undefined;
}

/** Loads `bots.json`, or migrates `active.json` into it (see the header). Throws on a file that exists but cannot be trusted. */
export function openRegistry(dir: string, opts: OpenOptions = {}): BotRegistry {
  const botsPath = join(dir, "bots.json");
  const activePath = join(dir, "active.json");
  if (existsSync(botsPath)) {
    const reg = new BotRegistry(dir, parseFile(readFileSync(botsPath, "utf8")));
    // A crash between writing bots.json and renaming active.json: finish the rename.
    if (existsSync(activePath)) renameSync(activePath, join(dir, "active.v1.json"));
    return reg;
  }
  const legacyPrefixes = (opts.legacyPrefixes ?? []).filter((p) => PREFIX.test(p));
  if (!existsSync(activePath) && legacyPrefixes.length === 0) return new BotRegistry(dir, { version: 1, bots: [], legacy_v1: null });

  let activeHash: string | null = null;
  let activatedAt = opts.startMs ?? 0;
  if (existsSync(activePath)) {
    let ptr: unknown;
    try {
      ptr = JSON.parse(readFileSync(activePath, "utf8"));
    } catch {
      throw new Error("active.json is unreadable; fix or remove it after checking which rule set was active");
    }
    if (!isObj(ptr) || typeof ptr["hash"] !== "string" || !HASH.test(ptr["hash"]) || typeof ptr["activated_at_ms"] !== "number")
      throw new Error("active.json is malformed; fix or remove it after checking which rule set was active");
    activeHash = ptr["hash"];
    activatedAt = ptr["activated_at_ms"];
  }
  let name = "Default";
  if (activeHash !== null) {
    try {
      const env: unknown = JSON.parse(readFileSync(join(dir, "rules", `${activeHash}.json`), "utf8"));
      const n = isObj(env) && isObj(env["rules"]) ? env["rules"]["name"] : undefined;
      if (typeof n === "string" && cleanBotName(n) !== "") name = cleanBotName(n);
    } catch {
      /* the name is cosmetic; the envelope is verified on every load anyway */
    }
  }
  const prefixes = [...legacyPrefixes];
  if (activeHash !== null && !prefixes.includes(cloidPrefix(activeHash))) prefixes.push(cloidPrefix(activeHash));
  const created = opts.startMs ?? activatedAt;
  const bot: Bot = {
    id: DEFAULT_BOT_ID,
    name,
    created_at_ms: created,
    archived_at_ms: null,
    active_hash: activeHash,
    hashes: prefixes.map((prefix) => ({ prefix, hash: activeHash !== null && prefix === cloidPrefix(activeHash) ? activeHash : null, activated_at_ms: activatedAt })),
  };
  const file: BotsFile = { version: 1, bots: [bot], legacy_v1: activeHash === null ? null : { bot_id: DEFAULT_BOT_ID, hash: activeHash } };
  writeFileAtomic(botsPath, JSON.stringify(file));
  if (existsSync(activePath)) renameSync(activePath, join(dir, "active.v1.json"));
  return new BotRegistry(dir, file);
}
