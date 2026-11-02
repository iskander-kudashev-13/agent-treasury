/** Spot pair metadata for rule validation (hard limits, assistant tool), read from the HL adapter and cached briefly. */
import type { PairInfoProvider } from "../ai/trading.js";
import type { HlPort, PairInfoMap } from "./types.js";

export function createPairInfoProvider(getHl: () => HlPort, opts: { ttlMs?: number; now?: () => number } = {}): PairInfoProvider {
  const ttl = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let cache: { at: number; map: PairInfoMap } | undefined;
  let pending: Promise<PairInfoMap> | undefined;
  return {
    async getPairInfo(): Promise<PairInfoMap> {
      if (cache && now() - cache.at < ttl) return cache.map;
      pending ??= getHl()
        .getSpotPairs()
        .then((pairs) => {
          const map: PairInfoMap = Object.fromEntries(
            pairs.map((p) => [p.name, { name: p.name, assetId: p.assetId, szDecimals: p.szDecimals, volume24hUsdc: p.volume24hUsdc, ...(p.midUsdc ? { mid: p.midUsdc } : {}) }]),
          );
          cache = { at: now(), map };
          return map;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
