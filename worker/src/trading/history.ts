/**
 * Per-bot and account P&L / position history for charts (docs/adr/0006 section 6).
 *
 * Three tiers of JSONL files per scope (`bots/<id>/` or `account/`): h-1m (1 min buckets, 48 h), h-15m (15 min, 31 d),
 * h-1d (1 day, 400 d). The OPEN bucket of each tier lives in memory; a bucket is appended as one JSON line when the
 * first sample of a later bucket arrives, so a crash loses at most one bucket per tier. Reads add the open bucket as the
 * last point, so the curve is current.
 *
 * Properties:
 *  - Synchronous fs, like store.ts: callers (the tick) never interleave two writes to one file.
 *  - Appends are single `appendFileSync` calls; compaction rewrites the newest lines with tmp + rename.
 *  - Corrupt or torn lines are skipped on read and dropped by the next compaction. A file whose last line has no
 *    newline (torn append) gets a leading newline before the next append, so the new line is never glued to garbage.
 *  - Money math is bigint fixed point (`Fx` from engine/risk.ts), no floats.
 *  - Size bound: 2880 + 2976 + 400 lines (about 0.8 MB) per scope before compaction at 1.25x, so under 5 MB for 5 bots
 *    plus the account.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fx, fxStr } from "./engine/risk.js";
import type { Fx } from "./engine/risk.js";
import type { Dec, SDec } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface Tier {
  readonly name: "h-1m" | "h-15m" | "h-1d";
  readonly bucketMs: number;
  readonly keepMs: number;
  readonly maxLines: number;
}

export const TIERS: readonly Tier[] = [
  { name: "h-1m", bucketMs: MIN, keepMs: 48 * HOUR, maxLines: 2880 },
  { name: "h-15m", bucketMs: 15 * MIN, keepMs: 31 * DAY, maxLines: 2976 },
  { name: "h-1d", bucketMs: DAY, keepMs: 400 * DAY, maxLines: 400 },
];
/** Compaction triggers when a file holds more than this multiple of its max lines. */
export const COMPACT_FACTOR = 1.25;
/** Hard cap on points in one response (ADR section 8). */
export const MAX_POINTS = 3000;

export const RANGES = ["1h", "1d", "1w", "1m", "all"] as const;
export type Range = (typeof RANGES)[number];
export const isRange = (x: unknown): x is Range => typeof x === "string" && (RANGES as readonly string[]).includes(x);

/** Window length of a range; `all` is open ended (null). `1m` is 30 days. */
export const RANGE_MS: Readonly<Record<Range, number | null>> = {
  "1h": HOUR,
  "1d": DAY,
  "1w": 7 * DAY,
  "1m": 30 * DAY,
  all: null,
};
const RANGE_TIER: Readonly<Record<Range, Tier["name"]>> = { "1h": "h-1m", "1d": "h-1m", "1w": "h-15m", "1m": "h-15m", all: "h-1d" };

export const tierFor = (range: Range): Tier => TIERS.find((t) => t.name === RANGE_TIER[range]) as Tier;

/** Scope id of the account-wide history (directory `account/`). Never a valid bot id. */
export const ACCOUNT_SCOPE = "@account";

const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Directory of a scope under the state dir. Throws on ids that could escape it. */
export function scopeDir(stateDir: string, id: string): string {
  if (id === ACCOUNT_SCOPE) return join(stateDir, "account");
  if (!BOT_ID.test(id)) throw new Error(`invalid bot id: ${JSON.stringify(id)}`);
  return join(stateDir, "bots", id);
}

export interface HistoryPoint {
  /** Bucket start, ms. */
  t: number;
  /** Total trading P&L at the end of the bucket. */
  pnl: SDec;
  lo: SDec;
  hi: SDec;
  /** Today's P&L at the end of the bucket. */
  today: SDec;
  /** Value of the position (or account equity for the account scope) at the end of the bucket. */
  val: Dec;
  /** Position size per pair at the end of the bucket. */
  pos: Record<string, Dec>;
  /** Mid per pair at the end of the bucket. */
  px: Record<string, Dec>;
  /** Account equity when the sample carried it. */
  equity?: Dec;
}

export interface HistorySample {
  botId: string;
  atMs: number;
  /** Total trading P&L (USDC, signed decimal). */
  pnl: SDec;
  /** Value of the position in USDC. */
  positionUsdc: Dec;
  equity?: Dec;
  today?: SDec;
  pos?: Record<string, Dec>;
  px?: Record<string, Dec>;
}

export interface HistoryRead {
  range: Range;
  bucket_ms: number;
  points: HistoryPoint[];
}

// ---------------------------------------------------------------------------------------------------------------------
// File helpers (shared with journal.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Atomic whole-file write: tmp + rename. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface ReadLines<T> {
  items: T[];
  /** Non-empty lines in the file, valid or not (what compaction compares with the cap). */
  totalLines: number;
  /** False when the file is non-empty and does not end with a newline. */
  endsWithNewline: boolean;
}

/** Reads a JSONL file, skipping lines that are not valid JSON or fail `parse`. A missing file reads as empty. */
export function readJsonl<T>(path: string, parse: (x: unknown) => T | null): ReadLines<T> {
  if (!existsSync(path)) return { items: [], totalLines: 0, endsWithNewline: true };
  const text = readFileSync(path, "utf8");
  const items: T[] = [];
  let totalLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    totalLines++;
    try {
      const v = parse(JSON.parse(line) as unknown);
      if (v !== null) items.push(v);
    } catch {
      /* corrupt line: skipped, dropped by the next compaction */
    }
  }
  return { items, totalLines, endsWithNewline: text === "" || text.endsWith("\n") };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const SDEC = /^-?\d+(\.\d+)?$/;
const DEC = /^\d+(\.\d+)?$/;
const isDecMap = (x: unknown): x is Record<string, string> =>
  isObj(x) && Object.values(x).every((v) => typeof v === "string" && DEC.test(v));

function parsePoint(x: unknown): HistoryPoint | null {
  if (!isObj(x)) return null;
  const { t, pnl, lo, hi, today, val, pos, px, equity } = x;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) return null;
  for (const s of [pnl, lo, hi, today]) if (typeof s !== "string" || !SDEC.test(s)) return null;
  if (typeof val !== "string" || !DEC.test(val)) return null;
  const p: HistoryPoint = {
    t,
    pnl: pnl as string,
    lo: lo as string,
    hi: hi as string,
    today: today as string,
    val,
    pos: isDecMap(pos) ? pos : {},
    px: isDecMap(px) ? px : {},
  };
  if (typeof equity === "string" && DEC.test(equity)) p.equity = equity;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------------------------

interface OpenBucket {
  t: number;
  pnl: Fx;
  lo: Fx;
  hi: Fx;
  today: Fx;
  val: Fx;
  pos: Record<string, Dec>;
  px: Record<string, Dec>;
  equity: Fx | null;
}

interface FileState {
  lines: number;
  lastT: number;
  needsNewline: boolean;
}

const norm = (v: Fx): string => fxStr(v, 6);

function toPoint(b: OpenBucket): HistoryPoint {
  const p: HistoryPoint = { t: b.t, pnl: norm(b.pnl), lo: norm(b.lo), hi: norm(b.hi), today: norm(b.today), val: norm(b.val), pos: b.pos, px: b.px };
  if (b.equity !== null) p.equity = norm(b.equity);
  return p;
}

export class HistoryStore {
  private readonly open = new Map<string, OpenBucket>();
  private readonly files = new Map<string, FileState>();

  constructor(
    private readonly stateDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Folds one sample into the open bucket of every tier; appends the buckets that this sample closed. */
  record(s: HistorySample): void {
    const dir = scopeDir(this.stateDir, s.botId);
    const pnl = fx(s.pnl);
    const sample = {
      pnl,
      today: fx(s.today ?? s.pnl),
      val: fx(s.positionUsdc),
      equity: s.equity === undefined ? null : fx(s.equity),
      pos: s.pos ?? {},
      px: s.px ?? {},
    };
    for (const tier of TIERS) {
      const key = `${dir}|${tier.name}`;
      const t = Math.floor(s.atMs / tier.bucketMs) * tier.bucketMs;
      const cur = this.open.get(key);
      if (cur !== undefined && t < cur.t) continue; // clock stepped back: older than the open bucket, ignored
      if (cur !== undefined && t === cur.t) {
        if (pnl < cur.lo) cur.lo = pnl;
        if (pnl > cur.hi) cur.hi = pnl;
        Object.assign(cur, { pnl, today: sample.today, val: sample.val, equity: sample.equity ?? cur.equity, pos: sample.pos, px: sample.px });
        continue;
      }
      if (cur !== undefined) this.append(dir, tier, toPoint(cur));
      this.open.set(key, { t, lo: pnl, hi: pnl, ...sample });
    }
  }

  /** Points of `range` for a scope at the tier's resolution, oldest first, the open bucket last. */
  read(botId: string, range: Range, opts: { createdAtMs?: number } = {}): HistoryRead {
    const dir = scopeDir(this.stateDir, botId);
    const tier = tierFor(range);
    const now = this.now();
    const win = RANGE_MS[range];
    const fromMs = win !== null ? now - win : Math.max(0, opts.createdAtMs ?? 0);
    const byT = new Map<number, HistoryPoint>();
    for (const p of readJsonl(join(dir, `${tier.name}.jsonl`), parsePoint).items) byT.set(p.t, p);
    const cur = this.open.get(`${dir}|${tier.name}`);
    if (cur !== undefined) byT.set(cur.t, toPoint(cur));
    // A bucket belongs to the range when it overlaps it: its end is after the start.
    const points = [...byT.values()].filter((p) => p.t + tier.bucketMs > fromMs).sort((a, b) => a.t - b.t);
    return { range, bucket_ms: tier.bucketMs, points: points.length > MAX_POINTS ? points.slice(-MAX_POINTS) : points };
  }

  /** Re-checks retention of every tier file of a scope (run at start). */
  enforceRetention(botId: string): void {
    const dir = scopeDir(this.stateDir, botId);
    for (const tier of TIERS) if (existsSync(join(dir, `${tier.name}.jsonl`))) this.compact(dir, tier, true);
  }

  private state(dir: string, tier: Tier): FileState {
    const path = join(dir, `${tier.name}.jsonl`);
    let st = this.files.get(path);
    if (st === undefined) {
      const r = readJsonl(path, parsePoint);
      st = { lines: r.totalLines, lastT: r.items.reduce((m, p) => Math.max(m, p.t), -1), needsNewline: !r.endsWithNewline };
      this.files.set(path, st);
    }
    return st;
  }

  private append(dir: string, tier: Tier, p: HistoryPoint): void {
    const st = this.state(dir, tier);
    if (p.t <= st.lastT) return; // already on disk (restart inside a closed bucket); the file stays strictly increasing
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${tier.name}.jsonl`);
    appendFileSync(path, `${st.needsNewline ? "\n" : ""}${JSON.stringify(p)}\n`, { mode: 0o600 });
    st.needsNewline = false;
    st.lines++;
    st.lastT = p.t;
    if (st.lines > tier.maxLines * COMPACT_FACTOR) this.compact(dir, tier, false);
  }

  /** Rewrites the newest `maxLines` valid lines inside the keep window (tmp + rename). */
  private compact(dir: string, tier: Tier, onlyIfNeeded: boolean): void {
    const path = join(dir, `${tier.name}.jsonl`);
    const r = readJsonl(path, parsePoint);
    const sorted = [...new Map(r.items.map((p) => [p.t, p])).values()].sort((a, b) => a.t - b.t);
    const newest = sorted.length > 0 ? (sorted[sorted.length - 1] as HistoryPoint).t : 0;
    const kept = sorted.filter((p) => p.t > newest - tier.keepMs).slice(-tier.maxLines);
    if (onlyIfNeeded && kept.length === r.totalLines && r.endsWithNewline && r.totalLines <= tier.maxLines * COMPACT_FACTOR) return;
    writeFileAtomic(path, kept.map((p) => `${JSON.stringify(p)}\n`).join(""));
    this.files.set(path, { lines: kept.length, lastT: kept.length > 0 ? (kept[kept.length - 1] as HistoryPoint).t : -1, needsNewline: false });
  }
}
