/**
 * Exclusive lock on the trading state dir (audit 2026-11-03 M5). Two workers on one `TRADING_STATE_DIR` would both tick,
 * double the order/loss limits and collide on HL nonces, so the second one must refuse to start.
 *
 * The lock is a file `<dir>/lock` created with O_EXCL (`wx`) holding `{pid, token}` (token = random id + pid + process start time, so a reused pid, e.g. Docker pid 1 after `docker restart`, is not mistaken for a live holder). If the file exists and its pid is
 * dead (ESRCH), the lock is stale (crash, kill -9) and is taken over; a pid that is alive (or whose liveness we cannot tell,
 * EPERM) means "locked". Local mode only: a pid has no meaning across containers sharing a volume, so there the file is the
 * lock and a stale one must be removed by the operator.
 */
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export class TradingLockedError extends Error {
  constructor(
    readonly path: string,
    readonly holderPid: number | null,
  ) {
    super(`Trading state dir is locked by ${holderPid === null ? "another process" : `pid ${holderPid}`} (${path}). Stop that worker first; if it is dead, delete the lock file.`);
    this.name = "TradingLockedError";
  }
}

export interface StateDirLock {
  readonly path: string;
  release(): void;
}

/** Unique per process boot: random id + pid + start time. */
export const makeBootToken = (pid: number = process.pid): string =>
  `${randomBytes(8).toString("hex")}-${pid}-${Math.round(Date.now() - process.uptime() * 1000)}`;
const BOOT_TOKEN = makeBootToken();

/** Test seam: runs after the holder was read and judged stale, before the takeover rename. */
export interface LockOptions {
  pid?: number;
  token?: string;
  afterStaleRead?: () => void;
}

interface Holder {
  raw: string;
  pid: number | null;
  token: string | null;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM = exists but not ours
  }
};

const parseHolder = (raw: string): Holder => {
  try {
    const j = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (typeof j.pid === "number" && Number.isInteger(j.pid) && j.pid > 0) {
      return { raw, pid: j.pid, token: typeof j.token === "string" ? j.token : null };
    }
  } catch {
    /* legacy format: bare pid */
  }
  const n = Number(raw.trim());
  return { raw, pid: Number.isInteger(n) && n > 0 ? n : null, token: null };
};

const readHolder = (path: string): Holder | null => {
  try {
    return parseHolder(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

export function acquireStateDirLock(dir: string, opts: LockOptions | number = {}): StateDirLock {
  const o: LockOptions = typeof opts === "number" ? { pid: opts } : opts;
  const pid = o.pid ?? process.pid;
  const token = o.token ?? (o.pid === undefined ? BOOT_TOKEN : makeBootToken(pid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "lock");
  const mine = JSON.stringify({ pid, token }) + "\n";
  const owns = (): boolean => readHolder(path)?.token === token;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      // Re-read: a racing takeover must not leave two winners.
      if (!owns()) throw new TradingLockedError(path, readHolder(path)?.pid ?? null);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          if (owns()) {
            try {
              unlinkSync(path);
            } catch {
              /* already gone */
            }
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readHolder(path);
      if (holder === null) continue; // vanished between open and read: retry
      // Unreadable/garbled lock is treated as held: refusing is the safe side.
      if (holder.pid === null) throw new TradingLockedError(path, null);
      // Same pid but a different boot token: the pid was reused (container restart), the old holder is gone.
      const reusedOwnPid = holder.pid === pid && holder.token !== token;
      const stale = reusedOwnPid || (holder.pid !== pid && !isAlive(holder.pid));
      if (!stale) throw new TradingLockedError(path, holder.pid);
      o.afterStaleRead?.();
      // Atomic takeover: only one renamer can move this inode; the loser gets ENOENT.
      const aside = `${path}.stale.${randomBytes(6).toString("hex")}`;
      try {
        renameSync(path, aside);
      } catch {
        continue; // someone else took it over; retry and see their lock
      }
      const moved = readHolder(aside);
      if (moved?.raw !== holder.raw) {
        // We moved a lock that was replaced meanwhile (a live new holder). Put it back if the slot is free.
        try {
          linkSync(aside, path);
        } catch {
          /* slot taken again; the new owner re-verifies its own token */
        }
        try {
          unlinkSync(aside);
        } catch {
          /* gone */
        }
        throw new TradingLockedError(path, moved?.pid ?? null);
      }
      try {
        unlinkSync(aside);
      } catch {
        /* gone */
      }
    }
  }
  throw new TradingLockedError(path, readHolder(path)?.pid ?? null);
}
