/**
 * Persistence of confirmed rule sets (ADR-0005 section 5, bots per ADR-0006).
 *
 *   <dir>/rules/<hash>.json   the ConfirmedRules envelope (rules + NEP-413 signature), one pool for all bots
 *   <dir>/bots.json           the bot registry: which hash is active for which bot (replaces active.json, see bots.ts)
 *
 * `loadBot` never trusts the files: it re-runs the full envelope verification (hash, message, signature, full-access key,
 * signer is STILL the vault owner, hard limits, the envelope belongs to THIS bot) and returns `refused` on any failure, which the
 * engine maps to "this bot has no rules". Other bots are not affected. Writes are atomic (tmp + rename).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfirmError, offlinePairInfo, verifyEnvelope } from "./confirm.js";
import type { ConfirmCtx } from "./confirm.js";
import type { Bot, ConfirmedRules, PairInfoMap } from "./types.js";

const HASH = /^[0-9a-f]{64}$/;

export type LoadResult =
  | { status: "ok"; confirmed: ConfirmedRules; activatedAtMs: number }
  | { status: "none" }
  | { status: "refused"; code: string; reason: string };

export interface HistoryEntry {
  hash: string;
  name: string;
  confirmed_at_ms: number;
  superseded_at_ms: number | null;
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export class RulesStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private rulesDir(): string {
    return join(this.dir, "rules");
  }

  /** Persists the envelope. The caller has verified it already; the registry (`bots.json`) makes it active afterwards. */
  save(c: ConfirmedRules): void {
    if (!HASH.test(c.hash)) throw new Error("refusing to store a malformed hash");
    mkdirSync(this.rulesDir(), { recursive: true, mode: 0o700 });
    writeAtomic(join(this.rulesDir(), `${c.hash}.json`), JSON.stringify(c));
  }

  /**
   * Loads and fully re-verifies the active rule set of a bot.
   * @param pairInfo live pair data when available; otherwise the offline set from the allowed pairs.
   * @param legacyV1Hash `bots.json` `legacy_v1.hash`: the only envelope that may still carry the v1 message.
   */
  async loadBot(bot: Bot, ctx: ConfirmCtx, opts: { pairInfo?: PairInfoMap | undefined; legacyV1Hash?: string | null | undefined } = {}): Promise<LoadResult> {
    const hash = bot.active_hash;
    if (hash === null) return { status: "none" };
    const refuse = (code: string, reason: string): LoadResult => ({ status: "refused", code, reason });
    let env: ConfirmedRules;
    try {
      const j: unknown = JSON.parse(readFileSync(join(this.rulesDir(), `${hash}.json`), "utf8"));
      if (!isRecord(j)) return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
      env = j as unknown as ConfirmedRules;
    } catch {
      return refuse("ENVELOPE_MISSING", "the active rules file is missing or unreadable");
    }
    if (env.hash !== hash) return refuse("HASH_MISMATCH", "rules file hash differs from the registry");
    if (typeof env.account_id !== "string" || typeof env.public_key !== "string" || typeof env.confirmed_at_ms !== "number")
      return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
    if (env.callback_url !== null && typeof env.callback_url !== "string") return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
    if (env.bot_id !== undefined && typeof env.bot_id !== "string") return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
    try {
      await verifyEnvelope(env, ctx, opts.pairInfo ?? offlinePairInfo(ctx.hard), { botId: bot.id, legacyV1Hash: opts.legacyV1Hash });
    } catch (e) {
      if (e instanceof ConfirmError) return refuse(e.code, e.message);
      return refuse("VERIFY_ERROR", e instanceof Error ? e.message : "verification failed");
    }
    return { status: "ok", confirmed: env, activatedAtMs: bot.hashes.find((h) => h.hash === hash)?.activated_at_ms ?? env.confirmed_at_ms };
  }

  /**
   * Informational history (no signature re-check): stored rule sets, oldest first, with the supersede time. `only` restricts it
   * to the hashes of one bot (its registry history); superseded = confirmed time of that bot's next rule set.
   */
  history(only?: (hash: string) => boolean): HistoryEntry[] {
    if (!existsSync(this.rulesDir())) return [];
    const items: { hash: string; name: string; at: number }[] = [];
    for (const f of readdirSync(this.rulesDir())) {
      const m = /^([0-9a-f]{64})\.json$/.exec(f);
      if (!m?.[1]) continue;
      try {
        const j = JSON.parse(readFileSync(join(this.rulesDir(), f), "utf8")) as Partial<ConfirmedRules>;
        if (j.hash === m[1] && typeof j.confirmed_at_ms === "number" && typeof j.rules?.name === "string" && (only === undefined || only(m[1])))
          items.push({ hash: m[1], name: j.rules.name, at: j.confirmed_at_ms });
      } catch {
        /* skip unreadable file */
      }
    }
    items.sort((a, b) => a.at - b.at);
    return items.map((it, i) => ({ hash: it.hash, name: it.name, confirmed_at_ms: it.at, superseded_at_ms: items[i + 1]?.at ?? null }));
  }
}
