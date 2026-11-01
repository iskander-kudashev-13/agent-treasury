/** Sliding-window request limiter plus in-flight caps, in memory (one worker process). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perMinute: number,
    private readonly maxPerKeyInFlight = 2,
    private readonly maxTotalInFlight = 8,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns `null` when allowed (and counts the request), else the number of seconds to wait. */
  hit(key: string): number | null {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((60_000 - (t - (recent[0] ?? t))) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((x) => t - x >= 60_000)) this.hits.delete(k);
    }
    return null;
  }

  /** Reserves an in-flight slot; returns a release function or `null` when full. */
  acquire(key: string): (() => void) | null {
    const mine = this.inFlight.get(key) ?? 0;
    if (mine >= this.maxPerKeyInFlight || this.total >= this.maxTotalInFlight) return null;
    this.inFlight.set(key, mine + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const n = (this.inFlight.get(key) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, n);
    };
  }
}
