/**
 * Persistence of confirmed rule sets (ADR-0005 section 5).
 *
 *   <dir>/rules/<hash>.json   the ConfirmedRules envelope (rules + NEP-413 signature)
 *   <dir>/active.json         { hash, activated_at_ms }  pointer to the active rule set
 *
 * `loadActive` never trusts the files: it re-runs the full envelope verification (hash, message, signature, full-access
 * key, signer is STILL the vault owner, hard limits) and returns `refused` on any failure, which the engine maps to
 * `no_rules`. Writes are atomic (tmp + rename), envelope first, pointer second.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfirmError, offlinePairInfo, verifyEnvelope } from "./confirm.js";
import type { ConfirmCtx } from "./confirm.js";
import type { ConfirmedRules, PairInfoMap } from "./types.js";

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

  /** Persists the envelope and makes it active. The caller has verified it already. */
  save(c: ConfirmedRules): void {
    if (!HASH.test(c.hash)) throw new Error("refusing to store a malformed hash");
    mkdirSync(this.rulesDir(), { recursive: true, mode: 0o700 });
    writeAtomic(join(this.rulesDir(), `${c.hash}.json`), JSON.stringify(c));
    writeAtomic(join(this.dir, "active.json"), JSON.stringify({ hash: c.hash, activated_at_ms: this.now() }));
  }

  /**
   * @param pairInfo live pair data when available; otherwise the offline set from the allowed pairs.
   */
  async loadActive(ctx: ConfirmCtx, pairInfo?: PairInfoMap): Promise<LoadResult> {
    const pointerPath = join(this.dir, "active.json");
    if (!existsSync(pointerPath)) return { status: "none" };
    const refuse = (code: string, reason: string): LoadResult => ({ status: "refused", code, reason });
    let hash: string;
    let activatedAtMs: number;
    try {
      const ptr: unknown = JSON.parse(readFileSync(pointerPath, "utf8"));
      if (!isRecord(ptr) || typeof ptr["hash"] !== "string" || !HASH.test(ptr["hash"]) || typeof ptr["activated_at_ms"] !== "number")
        return refuse("POINTER_MALFORMED", "active.json is malformed");
      hash = ptr["hash"];
      activatedAtMs = ptr["activated_at_ms"];
    } catch {
      return refuse("POINTER_MALFORMED", "active.json is unreadable");
    }
    const path = join(this.rulesDir(), `${hash}.json`);
    let env: ConfirmedRules;
    try {
      const j: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(j)) return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
      env = j as unknown as ConfirmedRules;
    } catch {
      return refuse("ENVELOPE_MISSING", "the active rules file is missing or unreadable");
    }
    if (env.hash !== hash) return refuse("HASH_MISMATCH", "rules file hash differs from the active pointer");
    if (typeof env.account_id !== "string" || typeof env.public_key !== "string" || typeof env.confirmed_at_ms !== "number")
      return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
    if (env.callback_url !== null && typeof env.callback_url !== "string") return refuse("ENVELOPE_MALFORMED", "rules file is malformed");
    try {
      await verifyEnvelope(env, ctx, pairInfo ?? offlinePairInfo(ctx.hard));
    } catch (e) {
      if (e instanceof ConfirmError) return refuse(e.code, e.message);
      return refuse("VERIFY_ERROR", e instanceof Error ? e.message : "verification failed");
    }
    return { status: "ok", confirmed: env, activatedAtMs };
  }

  /** Informational history (no signature re-check): every stored rule set, oldest first, with the supersede time. */
  history(): HistoryEntry[] {
    if (!existsSync(this.rulesDir())) return [];
    const items: { hash: string; name: string; at: number }[] = [];
    for (const f of readdirSync(this.rulesDir())) {
      const m = /^([0-9a-f]{64})\.json$/.exec(f);
      if (!m?.[1]) continue;
      try {
        const j = JSON.parse(readFileSync(join(this.rulesDir(), f), "utf8")) as Partial<ConfirmedRules>;
        if (j.hash === m[1] && typeof j.confirmed_at_ms === "number" && typeof j.rules?.name === "string")
          items.push({ hash: m[1], name: j.rules.name, at: j.confirmed_at_ms });
      } catch {
        /* skip unreadable file */
      }
    }
    items.sort((a, b) => a.at - b.at);
    return items.map((it, i) => ({ hash: it.hash, name: it.name, confirmed_at_ms: it.at, superseded_at_ms: items[i + 1]?.at ?? null }));
  }
}
