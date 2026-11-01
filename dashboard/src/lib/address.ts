const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "monad", "xlayer", "plasma"]);
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Normalize/validate a destination address. 1Click rejects EVM addresses with an invalid mixed-case checksum,
 * so EVM addresses are stored lowercased (all-lowercase is always accepted). Throws on invalid input.
 */
export function normalizeAddress(chain: string, address: string): string {
  const a = address.trim();
  const c = chain.trim().toLowerCase();
  if (EVM_RE.test(a)) return a.toLowerCase();
  if (a.startsWith("0x") || EVM_CHAINS.has(c)) throw new Error("Invalid EVM address: expected 0x + 40 hex characters");
  if (c === "sol" && !BASE58_RE.test(a)) throw new Error("Invalid Solana address: expected base58, 32-44 characters");
  return a;
}
