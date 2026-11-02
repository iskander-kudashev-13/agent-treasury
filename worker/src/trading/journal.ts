/**
 * Per-bot fills journal (docs/adr/0006 section 6 and 8): `bots/<id>/fills.jsonl`, one line per attributed fill.
 *
 *  - Append-only; de-duplicated by fill identity (HL trade id + oid, else the fields that make two fills the same).
 *  - Bounded: when the file passes 1.25 x `maxLines` it is rewritten (tmp + rename) with the newest `maxLines` fills
 *    (oldest dropped). The P&L sums in the engine do not depend on the journal.
 *  - Reads are paged newest first with an opaque cursor; corrupt lines are skipped.
 *  - The parsed fills stay in memory (at most 1.25 x maxLines objects per bot), so a page does not re-read the file.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, scopeDir, writeFileAtomic } from "./history.js";
import type { Dec, SDec } from "./types.js";

export const JOURNAL_MAX_LINES = 50_000;
export const JOURNAL_COMPACT_FACTOR = 1.25;
export const FILLS_DEFAULT_LIMIT = 50;
export const FILLS_MAX_LIMIT = 200;

/** One journal line. */
export interface JournalFill {
  /** HL trade id, null when HL did not give one. */
  tid: number | null;
  oid: number;
  cloid: string | null;
  rule_id: string | null;
  time_ms: number;
  pair: string;
  side: "buy" | "sell";
  px: Dec;
  sz: Dec;
  /** Fee converted to USDC at the fill price. */
  fee_usdc: Dec;
  /** Token the fee was charged in ("USDC", or the base token for buys). */
  fee_token: string;
  /** Fee as charged, in `fee_token`. */
  fee_amount: Dec;
  /** Realized P&L of this fill (average cost), null for buys or when unknown. */
  realized_usdc: SDec | null;
  /** The bot's position in this pair after the fill (base units). */
  pos_after: Dec;
}

/** API shape `BotFill` of GET /trading/bots/:id/fills. */
export interface BotFill {
  tid: number | null;
  oid: number;
  cloid: string | null;
  rule_id: string | null;
  time_ms: number;
  pair: string;
  side: "buy" | "sell";
  price: Dec;
  size: Dec;
  fee_usdc: Dec;
  fee_token: string;
  realized_usdc: SDec | null;
}

export interface FillsPage {
  fills: BotFill[];
  next_cursor: string | null;
}

export class CursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "CursorError";
  }
}

/** Identity of a journal fill. Same idea as hl/pagination.ts `fillKey`, plus the oid for the tid form. */
export function journalKey(f: Pick<JournalFill, "tid" | "oid" | "time_ms" | "side" | "px" | "sz">): string {
  return f.tid !== null ? `t${f.tid}|${f.oid}` : `${f.oid}|${f.time_ms}|${f.side}|${f.px}|${f.sz}`;
}

export function toBotFill(f: JournalFill): BotFill {
  return {
    tid: f.tid,
    oid: f.oid,
    cloid: f.cloid,
    rule_id: f.rule_id,
    time_ms: f.time_ms,
    pair: f.pair,
    side: f.side,
    price: f.px,
    size: f.sz,
    fee_usdc: f.fee_usdc,
    fee_token: f.fee_token,
    realized_usdc: f.realized_usdc,
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const DEC = /^\d+(\.\d+)?$/;
const SDEC = /^-?\d+(\.\d+)?$/;
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const strOrNull = (x: unknown): string | null | undefined => (x === null ? null : typeof x === "string" ? x : undefined);

function parseFill(x: unknown): JournalFill | null {
  if (!isObj(x)) return null;
  const { tid, oid, cloid, rule_id, time_ms, pair, side, px, sz, fee_usdc, fee_token, fee_amount, realized_usdc, pos_after } = x;
  const c = strOrNull(cloid);
  const r = strOrNull(rule_id);
  const re = strOrNull(realized_usdc);
  if (!(tid === null || isInt(tid)) || !isInt(oid) || !isInt(time_ms)) return null;
  if (c === undefined || r === undefined || re === undefined) return null;
  if (typeof pair !== "string" || (side !== "buy" && side !== "sell") || typeof fee_token !== "string") return null;
  for (const d of [px, sz, fee_usdc, fee_amount, pos_after]) if (typeof d !== "string" || !DEC.test(d)) return null;
  if (re !== null && !SDEC.test(re)) return null;
  return {
    tid,
    oid,
    cloid: c,
    rule_id: r,
    time_ms,
    pair,
    side,
    px: px as string,
    sz: sz as string,
    fee_usdc: fee_usdc as string,
    fee_token,
    fee_amount: fee_amount as string,
    realized_usdc: re,
    pos_after: pos_after as string,
  };
}

/** Newest first: time, then trade id, then oid. Total order, so a cursor never skips or repeats a fill. */
const cmp = (a: JournalFill, b: JournalFill): number => a.time_ms - b.time_ms || (a.tid ?? 0) - (b.tid ?? 0) || a.oid - b.oid;

const encodeCursor = (f: JournalFill): string => Buffer.from(`${f.time_ms}:${f.tid ?? 0}:${f.oid}`).toString("base64url");

function decodeCursor(c: string): [number, number, number] {
  if (!/^[A-Za-z0-9_-]+$/.test(c)) throw new CursorError();
  const m = /^(\d+):(\d+):(\d+)$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  if (m === null) throw new CursorError();
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

interface Loaded {
  /** Oldest first. */
  fills: JournalFill[];
  keys: Set<string>;
  lines: number;
  needsNewline: boolean;
}

export class FillsJournal {
  private readonly loaded = new Map<string, Loaded>();

  constructor(
    private readonly stateDir: string,
    private readonly opts: { maxLines?: number } = {},
  ) {}

  private get maxLines(): number {
    return this.opts.maxLines ?? JOURNAL_MAX_LINES;
  }

  private path(botId: string): string {
    return join(scopeDir(this.stateDir, botId), "fills.jsonl");
  }

  private load(botId: string): Loaded {
    let l = this.loaded.get(botId);
    if (l !== undefined) return l;
    const r = readJsonl(this.path(botId), parseFill);
    const seen = new Set<string>();
    const fills: JournalFill[] = [];
    for (const f of r.items) {
      const k = journalKey(f);
      if (!seen.has(k)) {
        seen.add(k);
        fills.push(f);
      }
    }
    fills.sort(cmp);
    l = { fills, keys: seen, lines: r.totalLines, needsNewline: !r.endsWithNewline };
    this.loaded.set(botId, l);
    if (l.lines > this.maxLines * JOURNAL_COMPACT_FACTOR) this.compact(botId, l);
    return l;
  }

  /** Appends the fills not seen before; returns how many were new. */
  append(botId: string, fills: readonly JournalFill[]): number {
    const l = this.load(botId);
    const fresh: JournalFill[] = [];
    for (const f of fills) {
      const k = journalKey(f);
      if (l.keys.has(k)) continue;
      l.keys.add(k);
      fresh.push(f);
    }
    if (fresh.length === 0) return 0;
    mkdirSync(scopeDir(this.stateDir, botId), { recursive: true, mode: 0o700 });
    appendFileSync(this.path(botId), `${l.needsNewline ? "\n" : ""}${fresh.map((f) => `${JSON.stringify(f)}\n`).join("")}`, { mode: 0o600 });
    l.needsNewline = false;
    l.lines += fresh.length;
    const last = l.fills[l.fills.length - 1];
    l.fills.push(...fresh);
    if (last !== undefined && fresh.some((f) => cmp(last, f) > 0)) l.fills.sort(cmp);
    if (l.lines > this.maxLines * JOURNAL_COMPACT_FACTOR) this.compact(botId, l);
    return fresh.length;
  }

  /** Drops the oldest fills beyond `maxLines` and the corrupt lines (tmp + rename). */
  private compact(botId: string, l: Loaded): void {
    const dropped = l.fills.splice(0, Math.max(0, l.fills.length - this.maxLines));
    for (const f of dropped) l.keys.delete(journalKey(f));
    writeFileAtomic(this.path(botId), l.fills.map((f) => `${JSON.stringify(f)}\n`).join(""));
    l.lines = l.fills.length;
    l.needsNewline = false;
  }

  /** Newest-first page. `cursor` continues after the last fill of the previous page; `fromMs` cuts older fills. */
  page(botId: string, q: { cursor?: string | null; limit?: number; fromMs?: number } = {}): FillsPage {
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? FILLS_DEFAULT_LIMIT), 1), FILLS_MAX_LIMIT);
    const cur = q.cursor ? decodeCursor(q.cursor) : null;
    const all = this.load(botId).fills;
    const out: JournalFill[] = [];
    let more = false;
    for (let i = all.length - 1; i >= 0; i--) {
      const f = all[i] as JournalFill;
      if (q.fromMs !== undefined && f.time_ms < q.fromMs) break; // sorted: everything before is older
      if (cur !== null) {
        const [t, tid, oid] = cur;
        if (f.time_ms > t || (f.time_ms === t && ((f.tid ?? 0) > tid || ((f.tid ?? 0) === tid && f.oid >= oid)))) continue;
      }
      if (out.length === limit) {
        more = true;
        break;
      }
      out.push(f);
    }
    const lastOut = out[out.length - 1];
    return { fills: out.map(toBotFill), next_cursor: more && lastOut !== undefined ? encodeCursor(lastOut) : null };
  }

  /** Journal fills with time in [fromMs, toMs], oldest first (for metrics). Omit `fromMs` for the whole journal. */
  readAll(botId: string, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER): JournalFill[] {
    return this.load(botId).fills.filter((f) => f.time_ms >= fromMs && f.time_ms <= toMs);
  }

  /** True when a fill with this identity is already in the journal (the service skips it instead of applying it twice). */
  has(botId: string, f: Pick<JournalFill, "tid" | "oid" | "time_ms" | "side" | "px" | "sz">): boolean {
    return this.load(botId).keys.has(journalKey(f));
  }

  lastFillMs(botId: string): number | null {
    const all = this.load(botId).fills;
    const last = all[all.length - 1];
    return last === undefined ? null : last.time_ms;
  }
}
