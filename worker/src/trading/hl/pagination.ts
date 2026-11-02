/**
 * Complete reads of `userFillsByTime` (the loss stop must never silently miss a fill).
 *
 * HL facts (docs, Info endpoint): a response holds at most 2000 fills and only the 10000 most recent fills of an account are
 * retrievable at all. The docs do NOT state the order of `userFillsByTime`, and the one live check possible (2026-11-03,
 * testnet account with a single fill) cannot show it. So the code does not assume it: a FULL page must be ascending by time
 * and must begin at the cursor (the first page: at or after the start; later pages: exactly at the previous page's last
 * timestamp, which the re-read returns). Any other full page might be the NEWEST 2000 rows with older ones cut off, and
 * throws `FillsTruncatedError`. So a full page means "there may be more" (continue from the
 * last timestamp; same-ms rows are re-read and de-duplicated by `fillKey`), and 10000 rows or more means the oldest ones may
 * already be gone. In every case where completeness cannot be shown we throw `FillsTruncatedError`: the engine then
 * refuses to trade (fail closed) instead of computing a loss from an incomplete history.
 */
import type { HlFill } from "../types.js";

export const FILLS_PAGE_CAP = 2000;
export const FILLS_RETAIN = 10_000;
const MAX_PAGES = 20;

export class FillsTruncatedError extends Error {
  readonly code = "FILLS_TRUNCATED";
  constructor(message: string) {
    super(message);
    this.name = "FillsTruncatedError";
  }
}

export const isFillsTruncated = (e: unknown): e is FillsTruncatedError => e instanceof FillsTruncatedError;

/** Identity of a fill: HL's trade id when known, else the fields that make two fills the same. */
export function fillKey(f: HlFill): string {
  return f.tid !== undefined ? `t${f.tid}` : `${f.oid}|${f.timeMs}|${f.side}|${f.price}|${f.size}`;
}

export interface FillsPage {
  /** Spot fills of the page, mapped. */
  fills: HlFill[];
  /** Rows the API returned (spot and perp): compared with the page cap. */
  rawCount: number;
  /** Latest timestamp among ALL returned rows; null when the page is empty. */
  maxTimeMs: number | null;
  /** Earliest timestamp among ALL returned rows; null when the page is empty. */
  minTimeMs: number | null;
  /** True when the rows came back in non-decreasing time order (as returned, before any filtering). */
  ascending: boolean;
}

export interface PaginationLimits {
  pageCap?: number;
  retain?: number;
}

/**
 * `page(startMs, endMs?)` returns HL rows with time in [startMs, endMs] (endMs omitted = up to now).
 * Ordering is not assumed: every full page must be ascending and start at the cursor; a first full page that starts
 * after `startMs` is accepted only if a probe of [startMs, firstRow - 1] proves that range is empty (re-review H2).
 */
export async function readAllFills(page: (startMs: number, endMs?: number) => Promise<FillsPage>, startMs: number, limits: PaginationLimits = {}): Promise<HlFill[]> {
  const cap = limits.pageCap ?? FILLS_PAGE_CAP;
  const retain = limits.retain ?? FILLS_RETAIN;
  const out = new Map<string, HlFill>();
  let cursor = startMs;
  let rows = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const p = await page(cursor);
    rows += p.rawCount;
    for (const f of p.fills) if (f.timeMs >= startMs) out.set(fillKey(f), f);
    if (p.rawCount < cap) {
      // The 10000-newest rule: that many rows or more and the oldest part of the window may have been dropped.
      if (rows >= retain) throw new FillsTruncatedError(`${rows} fill rows returned; HL keeps only the ${retain} newest, the window may be incomplete`);
      return [...out.values()].sort((a, b) => a.timeMs - b.timeMs);
    }
    // Full page: it is only usable as "the next 2000 rows from the cursor" if it is ascending and starts at the cursor.
    if (!p.ascending) throw new FillsTruncatedError(`a page of ${cap} fills is not ordered oldest first; cannot prove it starts at ${cursor}`);
    if (p.minTimeMs === null || p.minTimeMs < cursor || (i > 0 && p.minTimeMs !== cursor)) {
      throw new FillsTruncatedError(`a page of ${cap} fills starts at ${p.minTimeMs ?? "nothing"} instead of ${cursor}; older rows may be missing`);
    }
    if (i === 0 && p.minTimeMs > cursor) {
      // A full first page that starts after the window start could be "the newest rows" of a larger range: prove the gap is empty.
      const gap = await page(cursor, p.minTimeMs - 1);
      if (gap.rawCount > 0) throw new FillsTruncatedError(`fills exist between ${cursor} and ${p.minTimeMs} that the first page skipped; older rows may be missing`);
    }
    if (p.maxTimeMs === null || p.maxTimeMs <= cursor) {
      throw new FillsTruncatedError(`a page of ${cap} fills ends inside one millisecond (${cursor}); cannot paginate`);
    }
    cursor = p.maxTimeMs;
    if (rows >= retain) throw new FillsTruncatedError(`${rows} fill rows returned; HL keeps only the ${retain} newest, the window may be incomplete`);
  }
  throw new FillsTruncatedError(`more than ${MAX_PAGES} pages of fills; cannot complete`);
}
