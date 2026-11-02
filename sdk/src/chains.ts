import { SdkError } from "./errors.js";
import type { Token } from "./oneclick.js";

/** Friendly aliases -> 1Click `blockchain` ids. Anything else is lower-cased and passed through. */
const ALIASES: Record<string, string> = { solana: "sol", arbitrum: "arb", ethereum: "eth", ethereum_mainnet: "eth" };

export function normalizeChain(chain: string): string {
  const c = chain.trim().toLowerCase();
  if (c === "") throw new SdkError("INVALID_INPUT", "chain must not be empty");
  return ALIASES[c] ?? c;
}

const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "hypercore"]);

/** Cheap typo guard for EVM chains (1Click validates everything else). */
export function validateAddress(chain: string, address: string): string {
  const a = address.trim();
  if (a === "" || a.length > 128 || /\s/.test(a)) throw new SdkError("INVALID_INPUT", "address is empty, too long or contains whitespace");
  if (EVM_CHAINS.has(chain) && !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new SdkError("INVALID_INPUT", `"${a}" is not a valid ${chain} address (expected 0x + 40 hex characters)`);
  }
  return a;
}

/** EVM addresses are case-insensitive (checksum casing may be normalized); everything else must match exactly. */
export function sameAddress(a: string, b: string): boolean {
  if (/^0x/i.test(a) && /^0x/i.test(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * 1Click lists two USDC assets on HyperCore. Only the hip1 one is HyperCore spot USDC (8 decimals; the destination
 * amount is rescaled to 6 in client.ts). The erc20 one is an EVM-side token and must never be chosen.
 */
const PINNED_USDC: Readonly<Record<string, string>> = {
  hypercore: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
};

/**
 * Picks the USDC token for a chain from `/v0/tokens`. The asset id is never built by hand.
 * Throws a clear error when the chain has no USDC (e.g. tron lists only USDT).
 */
export function resolveUsdc(tokens: readonly Token[], chain: string, preferAssetId?: string): Token {
  const onChain = tokens.filter((t) => t.blockchain === chain);
  const usdc = onChain.filter((t) => t.symbol.toUpperCase() === "USDC");
  const pinnedId = PINNED_USDC[chain];
  if (pinnedId !== undefined) {
    const pinned = usdc.find((t) => t.assetId === pinnedId);
    if (!pinned) throw new SdkError("UNSUPPORTED_ASSET", `pinned USDC asset ${pinnedId} is not listed on "${chain}" in 1Click`);
    return pinned;
  }
  if (usdc.length === 1 && usdc[0]) return usdc[0];
  if (usdc.length > 1) {
    const preferred = usdc.find((t) => t.assetId === preferAssetId);
    if (preferred) return preferred;
    throw new SdkError("UNSUPPORTED_ASSET", `several USDC tokens are listed on "${chain}"; cannot choose one safely`);
  }
  if (onChain.some((t) => t.symbol.toUpperCase() === "USDT")) {
    throw new SdkError("UNSUPPORTED_ASSET", `USDC is not available on "${chain}" (only USDT is listed there); only USDC payments are supported`);
  }
  throw new SdkError("UNSUPPORTED_ASSET", `USDC is not available on chain "${chain}" in 1Click`);
}
