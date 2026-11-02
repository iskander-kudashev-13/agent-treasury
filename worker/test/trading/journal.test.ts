import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorError, FillsJournal } from "../../src/trading/journal.js";
import type { JournalFill } from "../../src/trading/journal.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const path = () => join(dir, "bots", "a", "fills.jsonl");

const fill = (i: number, o: Partial<JournalFill> = {}): JournalFill => ({
  tid: i, oid: 1000 + i, cloid: null, rule_id: "r1", time_ms: 1_000_000 + i * 1000, pair: "HYPE/USDC", side: "buy",
  px: "30", sz: "0.5", fee_usdc: "0.01", fee_token: "USDC", fee_amount: "0.01", realized_usdc: null, pos_after: "0.5", ...o,
});

describe("fills journal", () => {
  it("appends, de-duplicates by tid+oid and survives a restart", () => {
    const j = new FillsJournal(dir);
    expect(j.append("a", [fill(1), fill(2), fill(1)])).toBe(2);
    expect(j.append("a", [fill(2), fill(3)])).toBe(1);
    expect(readFileSync(path(), "utf8").trim().split("\n")).toHaveLength(3);
    const j2 = new FillsJournal(dir);
    expect(j2.append("a", [fill(3), fill(4)])).toBe(1);
    expect(j2.readAll("a").map((f) => f.tid)).toEqual([1, 2, 3, 4]);
    expect(j2.lastFillMs("a")).toBe(1_004_000);
    expect(j2.lastFillMs("none")).toBeNull();
  });

  it("de-duplicates fills without a tid by their fields; same tid with another oid is a different fill", () => {
    const j = new FillsJournal(dir);
    expect(j.append("a", [fill(1, { tid: null }), fill(1, { tid: null })])).toBe(1);
    expect(j.append("a", [fill(1, { tid: null, px: "31" })])).toBe(1);
    expect(j.append("a", [fill(5), fill(5, { oid: 7 })])).toBe(2);
  });

  it("pages newest first with a cursor and from_ms", () => {
    const j = new FillsJournal(dir);
    j.append("a", Array.from({ length: 7 }, (_, i) => fill(i + 1)));
    const p1 = j.page("a", { limit: 3 });
    expect(p1.fills.map((f) => f.tid)).toEqual([7, 6, 5]);
    expect(p1.fills[0]).toMatchObject({ price: "30", size: "0.5" });
    expect(p1.next_cursor).not.toBeNull();
    const p2 = j.page("a", { limit: 3, cursor: p1.next_cursor });
    expect(p2.fills.map((f) => f.tid)).toEqual([4, 3, 2]);
    const p3 = j.page("a", { limit: 3, cursor: p2.next_cursor });
    expect(p3.fills.map((f) => f.tid)).toEqual([1]);
    expect(p3.next_cursor).toBeNull();
    expect(j.page("a", { limit: 2, fromMs: 1_006_000 }).fills.map((f) => f.tid)).toEqual([7, 6]);
    expect(j.page("a", { limit: 5, fromMs: 1_006_000 }).next_cursor).toBeNull();
    expect(j.page("a", { limit: 99999 }).fills).toHaveLength(7);
    expect(j.page("a", { limit: 0 }).fills).toHaveLength(1); // clamped to 1
    expect(j.page("missing").fills).toEqual([]);
  });

  it("cursor does not skip fills that share a timestamp", () => {
    const j = new FillsJournal(dir);
    j.append("a", [1, 2, 3, 4].map((i) => fill(i, { time_ms: 5_000 })));
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const p = j.page("a", { limit: 1, cursor });
      seen.push(...p.fills.map((f) => f.tid as number));
      cursor = p.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual([4, 3, 2, 1]);
  });

  it("rejects a malformed cursor", () => {
    const j = new FillsJournal(dir);
    expect(() => j.page("a", { cursor: "!!!" })).toThrow(CursorError);
    expect(() => j.page("a", { cursor: Buffer.from("x:y").toString("base64url") })).toThrow(CursorError);
  });

  it("tolerates corrupt lines and a torn last line", () => {
    mkdirSync(join(dir, "bots", "a"), { recursive: true });
    writeFileSync(path(), `${JSON.stringify(fill(1))}\nnot json\n{"tid":2}\n${JSON.stringify(fill(3)).slice(0, 40)}`);
    const j = new FillsJournal(dir);
    expect(j.readAll("a").map((f) => f.tid)).toEqual([1]);
    j.append("a", [fill(4)]);
    expect(new FillsJournal(dir).readAll("a").map((f) => f.tid)).toEqual([1, 4]);
  });

  it("rotates: past 1.25 x the cap the file keeps the newest maxLines fills", () => {
    const j = new FillsJournal(dir, { maxLines: 8 });
    for (let i = 1; i <= 10; i++) j.append("a", [fill(i)]);
    expect(readFileSync(path(), "utf8").trim().split("\n")).toHaveLength(10); // 10 = 1.25 x 8, not past it yet
    j.append("a", [fill(11)]);
    const l = readFileSync(path(), "utf8").trim().split("\n").map((s) => (JSON.parse(s) as { tid: number }).tid);
    expect(l).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(j.append("a", [fill(3)])).toBe(1); // dropped fills are forgotten, a re-sent old one re-enters
    expect(j.page("a", { limit: 200 }).fills[0]?.tid).toBe(11);
  });

  it("keeps order when a late fill arrives out of time order", () => {
    const j = new FillsJournal(dir);
    j.append("a", [fill(2), fill(3)]);
    j.append("a", [fill(1)]);
    expect(j.page("a").fills.map((f) => f.tid)).toEqual([3, 2, 1]);
  });

  it("refuses unsafe bot ids", () => {
    expect(() => new FillsJournal(dir).append("../x", [fill(1)])).toThrow();
  });
});
