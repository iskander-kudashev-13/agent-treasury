import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireStateDirLock, TradingLockedError } from "../../src/trading/lock.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lock-"));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A pid that is certainly dead: a child that already exited. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(r.stdout.toString());
};

describe("state dir lock (audit M5)", () => {
  it("creates the lock with our pid and removes it on release", () => {
    const l = acquireStateDirLock(dir);
    expect((JSON.parse(readFileSync(l.path, "utf8")) as { pid: number; token: string }).pid).toBe(process.pid);
    l.release();
    expect(existsSync(l.path)).toBe(false);
    l.release(); // idempotent
  });

  it("refuses a second start while the holder is alive", () => {
    const l = acquireStateDirLock(dir);
    expect(() => acquireStateDirLock(dir)).toThrow(TradingLockedError);
    l.release();
  });

  it("refuses when another live process holds it (parent pid)", () => {
    writeFileSync(join(dir, "lock"), `${process.ppid}\n`);
    expect(() => acquireStateDirLock(dir)).toThrow(/locked by pid/);
    expect(existsSync(join(dir, "lock"))).toBe(true);
  });

  it("takes over a stale lock whose pid is dead", () => {
    writeFileSync(join(dir, "lock"), `${deadPid()}\n`);
    const l = acquireStateDirLock(dir);
    expect((JSON.parse(readFileSync(l.path, "utf8")) as { pid: number; token: string }).pid).toBe(process.pid);
    l.release();
  });

  it("treats an unreadable lock as held (fail closed)", () => {
    writeFileSync(join(dir, "lock"), "garbage");
    expect(() => acquireStateDirLock(dir)).toThrow(TradingLockedError);
  });

  it("release does not delete a lock that someone else now owns", () => {
    const l = acquireStateDirLock(dir);
    writeFileSync(l.path, `${process.ppid}\n`);
    l.release();
    expect(existsSync(l.path)).toBe(true);
  });

  it("treats a lock with our pid but another boot token as stale (pid reuse after docker restart)", () => {
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: process.pid, token: "old-boot" }));
    const l = acquireStateDirLock(dir);
    expect((JSON.parse(readFileSync(l.path, "utf8")) as { pid: number; token: string }).pid).toBe(process.pid);
    l.release();
  });

  it("two concurrent takeovers of a stale lock: exactly one wins", () => {
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: deadPid(), token: "x" }));
    let b: ReturnType<typeof acquireStateDirLock> | undefined;
    let aErr: unknown;
    // A has read the stale holder; before it renames, B runs the whole acquisition and wins.
    try {
      acquireStateDirLock(dir, {
        pid: process.ppid,
        token: "A",
        afterStaleRead: () => {
          b = acquireStateDirLock(dir, { pid: process.pid, token: "B" });
        },
      });
    } catch (e) {
      aErr = e;
    }
    expect(b).toBeDefined();
    expect(aErr).toBeInstanceOf(TradingLockedError);
    expect((JSON.parse(readFileSync(join(dir, "lock"), "utf8")) as { token: string }).token).toBe("B");
    b?.release();
  });
});
