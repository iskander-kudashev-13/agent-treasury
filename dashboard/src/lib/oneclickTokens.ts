/** USDC asset ids come from 1Click `GET /v0/tokens`; they are never typed by hand (ADR-0003 §10). */
import { useQuery } from "@tanstack/react-query";

export const ONECLICK_BASE_URL = String(import.meta.env.VITE_ONECLICK_BASE_URL || "https://1click.chaindefuser.com").replace(/\/+$/, "");

export interface OneClickToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
}

export function parseTokens(body: unknown): OneClickToken[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((t): OneClickToken[] => {
    if (typeof t !== "object" || t === null) return [];
    const o = t as Record<string, unknown>;
    return typeof o.assetId === "string" && typeof o.blockchain === "string" && typeof o.symbol === "string"
      ? [{ assetId: o.assetId, blockchain: o.blockchain, symbol: o.symbol, decimals: typeof o.decimals === "number" ? o.decimals : 6 }]
      : [];
  });
}

/**
 * The USDC asset id on `chain`, or null (Tron has no USDC in 1Click). Same rule as the worker.
 * `hypercore` lists two USDC tokens; only the HyperCore spot one (hip1) is a valid destination (ADR-0005).
 */
export function findUsdcAsset(tokens: OneClickToken[], chain: string): string | null {
  const usdc = tokens.filter((t) => t.blockchain === chain && t.symbol.toUpperCase() === "USDC");
  if (chain === "hypercore") return usdc.find((t) => t.assetId.includes(":hip1:"))?.assetId ?? null;
  return usdc[0]?.assetId ?? null;
}

export async function fetchTokens(signal?: AbortSignal): Promise<OneClickToken[]> {
  const res = await fetch(`${ONECLICK_BASE_URL}/v0/tokens`, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`1Click /v0/tokens: HTTP ${res.status}`);
  return parseTokens(await res.json());
}

/** Resolves the USDC asset id for a chain. `asset` is null while loading, on failure, or when the chain has no USDC. */
export function useUsdcAsset(chain: string): { asset: string | null; loading: boolean; error: string | null } {
  const q = useQuery({ queryKey: ["oneclick", "tokens", ONECLICK_BASE_URL], queryFn: ({ signal }) => fetchTokens(signal), staleTime: 10 * 60_000, retry: 1, enabled: chain !== "" });
  const asset = q.data ? findUsdcAsset(q.data, chain) : null;
  const error = q.error ? "Could not load the token list from 1Click" : q.data && chain && !asset ? `1Click has no USDC on ${chain}` : null;
  return { asset, loading: q.isPending && chain !== "", error };
}
