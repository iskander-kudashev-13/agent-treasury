import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_SCOPE, HistoryStore, TIERS, tierFor } from "../../src/trading/history.js";

let dir: string;
let clock: number;
const T0 = 1_793_750_400_000; // a minute/15 min/day boundary
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hist-"));
  clock = T0;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const mk = () => new HistoryStore(dir, () => clock);
const file = (id: string, tier: string) => join(dir, "bots", id, `${tier}.jsonl`);
const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);

describe("history buckets", () => {
  it("folds samples into one bucket with close/lo/hi and writes it when the next bucket starts", () => {
    const h = mk();
    h.record({ botId: "a", atMs: T0 + 1000, pnl: "1", positionUsdc: "10" });
    h.record({ botId: "a", atMs: T0 + 2000, pnl: "-2.5", positionUsdc: "11", today: "-1", pos: { "HYPE/USDC": "0.3" }, px: { "HYPE/USDC": "33" } });
    h.record({ botId: "a", atMs: T0 + 3000, pnl: "0.5", positionUsdc: "12" });
    expect(() => readFileSync(file("a", "h-1m"))).toThrow(); // open bucket is memory only
    clock = T0 + 61_000;
    h.record({ botId: "a", atMs: T0 + 61_000, pnl: "3", positionUsdc: "12" });
    const l = lines(file("a", "h-1m"));
    expect(l).toHaveLength(1);
    expect(JSON.parse(l[0] as string)).toMatchObject({ t: T0, pnl: "0.5", lo: "-2.5", hi: "1", val: "12" });
    const r = h.read("a", "1h");
    expect(r.bucket_ms).toBe(60_000);
    expect(r.points.map((p) => p.t)).toEqual([T0, T0 + 60_000]); // open bucket is the last point
    expect(r.points[1]).toMatchObject({ pnl: "3", lo: "3", hi: "3" });
  });

  it("rolls the 15 min and 1 day tiers independently", () => {
    const h = mk();
    for (let m = 0; m < 31; m++) h.record({ botId: "a", atMs: T0 + m * 60_000, pnl: String(m), positionUsdc: "1" });
    expect(lines(file("a", "h-1m"))).toHaveLength(30);
    const q = lines(file("a", "h-15m")).map((s) => JSON.parse(s) as { t: number; pnl: string; lo: string; hi: string });
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ t: T0, pnl: "14", lo: "0", hi: "14" });
    expect(() => readFileSync(file("a", "h-1d"))).toThrow();
    h.record({ botId: "a", atMs: T0 + 86_400_000, pnl: "40", positionUsdc: "1" });
    expect(lines(file("a", "h-1d"))).toHaveLength(1);
  });

  it("ignores a sample older than the open bucket (clock stepped back)", () => {
    const h = mk();
    h.record({ botId: "a", atMs: T0 + 120_000, pnl: "1", positionUsdc: "1" });
    h.record({ botId: "a", atMs: T0, pnl: "9", positionUsdc: "1" });
    expect(h.read("a", "1h").points).toHaveLength(1);
    expect(h.read("a", "1h").points[0]?.pnl).toBe("1");
  });

  it("keeps account history apart from bots and rejects unsafe ids", () => {
    const h = mk();
    h.record({ botId: ACCOUNT_SCOPE, atMs: T0, pnl: "1", positionUsdc: "100", equity: "120" });
    h.record({ botId: ACCOUNT_SCOPE, atMs: T0 + 60_000, pnl: "2", positionUsdc: "100", equity: "121" });
    expect(readdirSync(join(dir, "account"))).toContain("h-1m.jsonl");
    expect(h.read(ACCOUNT_SCOPE, "1h").points[1]?.equity).toBe("121");
    expect(() => { h.record({ botId: "../x", atMs: T0, pnl: "1", positionUsdc: "1" }); }).toThrow();
  });

  it("uses exact decimals, no float drift", () => {
    const h = mk();
    h.record({ botId: "a", atMs: T0, pnl: "0.1", positionUsdc: "0.2" });
    h.record({ botId: "a", atMs: T0 + 1, pnl: "0.3", positionUsdc: "0.2" });
    h.record({ botId: "a", atMs: T0 + 2, pnl: "-0.000001", positionUsdc: "0.2" });
    expect(h.read("a", "1h").points[0]).toMatchObject({ hi: "0.3", lo: "-0.000001" });
  });
});

describe("history ranges", () => {
  it("maps ranges to tiers and windows", () => {
    expect(tierFor("1h").name).toBe("h-1m");
    expect(tierFor("1d").name).toBe("h-1m");
    expect(tierFor("1w").name).toBe("h-15m");
    expect(tierFor("1m").name).toBe("h-15m");
    expect(tierFor("all").name).toBe("h-1d");
    const h = mk();
    for (let m = 0; m < 200; m++) h.record({ botId: "a", atMs: T0 + m * 60_000, pnl: String(m), positionUsdc: "1" });
    clock = T0 + 200 * 60_000;
    expect(h.read("a", "1d").points).toHaveLength(200);
    const hour = h.read("a", "1h").points;
    expect(hour.length).toBeGreaterThanOrEqual(60);
    expect(hour.length).toBeLessThanOrEqual(61);
    expect(h.read("a", "1w").bucket_ms).toBe(900_000);
    expect(h.read("a", "all").bucket_ms).toBe(86_400_000);
  });

  it("`all` starts at the bot's creation", () => {
    const h = mk();
    for (let d = 0; d < 5; d++) h.record({ botId: "a", atMs: T0 + d * 86_400_000, pnl: String(d), positionUsdc: "1" });
    clock = T0 + 5 * 86_400_000;
    expect(h.read("a", "all", { createdAtMs: T0 + 2 * 86_400_000 }).points.map((p) => p.pnl)).toEqual(["2", "3", "4"]);
    expect(h.read("a", "all").points).toHaveLength(5);
  });
});

describe("history files", () => {
  it("restart resumes the files and does not duplicate a bucket", () => {
    const h1 = mk();
    for (let m = 0; m < 3; m++) h1.record({ botId: "a", atMs: T0 + m * 60_000, pnl: String(m), positionUsdc: "1" });
    clock = T0 + 3 * 60_000;
    const h2 = mk();
    h2.record({ botId: "a", atMs: T0 + 3 * 60_000, pnl: "7", positionUsdc: "1" });
    h2.record({ botId: "a", atMs: T0 + 4 * 60_000, pnl: "8", positionUsdc: "1" });
    expect(h2.read("a", "1h").points.map((p) => p.pnl)).toEqual(["0", "1", "7", "8"]);
    // h1 never wrote bucket 2 (open bucket in memory only); disk has buckets 0 and 1, then 3 from h2
    expect(lines(file("a", "h-1m")).map((s) => (JSON.parse(s) as { pnl: string }).pnl)).toEqual(["0", "1", "7"]);
    // a bucket at or before the last written one is never appended again
    const h3 = mk();
    h3.record({ botId: "a", atMs: T0 + 60_000, pnl: "99", positionUsdc: "1" });
    h3.record({ botId: "a", atMs: T0 + 10 * 60_000, pnl: "1", positionUsdc: "1" });
    expect(lines(file("a", "h-1m"))).toHaveLength(3);
  });

  it("skips corrupt lines on read and glues nothing to a torn last line", () => {
    mkdirSync(join(dir, "bots", "a"), { recursive: true });
    const good = JSON.stringify({ t: T0, pnl: "1", lo: "1", hi: "1", today: "1", val: "2", pos: {}, px: {} });
    writeFileSync(file("a", "h-1m"), `garbage\n${good}\n{"t":123,"pnl":`);
    const h = mk();
    expect(h.read("a", "1h").points).toHaveLength(1);
    h.record({ botId: "a", atMs: T0 + 60_000, pnl: "2", positionUsdc: "1" });
    h.record({ botId: "a", atMs: T0 + 120_000, pnl: "3", positionUsdc: "1" });
    const last = lines(file("a", "h-1m")).pop() as string;
    expect(JSON.parse(last)).toMatchObject({ t: T0 + 60_000, pnl: "2" });
    expect(h.read("a", "1h").points.map((p) => p.pnl)).toEqual(["1", "2", "3"]);
  });

  it("compacts past 1.25 x the cap to the newest lines, atomically", () => {
    const tier = TIERS.find((t) => t.name === "h-1d");
    if (tier === undefined) throw new Error("tier");
    const h = mk();
    const n = Math.floor(tier.maxLines * 1.25) + 2;
    for (let d = 0; d <= n; d++) h.record({ botId: "a", atMs: T0 + d * 86_400_000, pnl: String(d), positionUsdc: "1" });
    const l = lines(file("a", "h-1d")).map((s) => JSON.parse(s) as { pnl: string });
    expect(l.length).toBeLessThanOrEqual(tier.maxLines * 1.25);
    expect(l.length).toBeLessThan(n); // the oldest were dropped
    expect(l.length).toBeGreaterThan(0);
    expect(Number(l[l.length - 1]?.pnl)).toBe(n - 1); // newest closed bucket kept
    expect(readdirSync(join(dir, "bots", "a")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("enforceRetention drops points older than the keep window and corrupt lines", () => {
    mkdirSync(join(dir, "bots", "a"), { recursive: true });
    const pt = (t: number) => JSON.stringify({ t, pnl: "1", lo: "1", hi: "1", today: "1", val: "1", pos: {}, px: {} });
    const old = T0 - 3 * 86_400_000;
    writeFileSync(file("a", "h-1m"), `${pt(old)}\nbad\n${pt(T0 - 60_000)}\n${pt(T0)}\n`);
    mk().enforceRetention("a");
    expect(lines(file("a", "h-1m")).map((s) => (JSON.parse(s) as { t: number }).t)).toEqual([T0 - 60_000, T0]);
    appendFileSync(file("a", "h-1m"), "");
  });
});
