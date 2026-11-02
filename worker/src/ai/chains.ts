/**
 * Destination chains the assistant can put into a proposal. Chain ids are 1Click `blockchain` ids (ADR-0003 §10).
 * The assistant only supports chains whose address format it knows; the USDC `assetId` (the recipient's
 * `destination_asset`) is resolved from 1Click `/v0/tokens`, never hard-coded. Anything else is refused.
 */

export type AddressKind = "evm" | "sol" | "near";

interface ChainInfo {
  kind: AddressKind;
  label: string;
}

export const CHAINS: Readonly<Record<string, ChainInfo>> = {
  base: { kind: "evm", label: "Base" },
  arb: { kind: "evm", label: "Arbitrum" },
  eth: { kind: "evm", label: "Ethereum" },
  sol: { kind: "sol", label: "Solana" },
  // Hyperliquid HyperCore spot (ADR-0005): 0x address of the owner's HL account. 1Click lists two USDC assets here; the
  // hip1 one must be picked (see sdk resolveUsdc), not the first match.
  hypercore: { kind: "evm", label: "Hyperliquid (HyperCore)" },
};

const ALIASES: Readonly<Record<string, string>> = {
  solana: "sol",
  ethereum: "eth",
  arbitrum: "arb",
  hyperliquid: "hypercore",
  hl: "hypercore",
};

/** Maps user wording ("Solana", "BASE") to a 1Click chain id, or `null` when unknown/unsupported. */
export function normalizeChain(input: string): string | null {
  const c = input.trim().toLowerCase();
  const id = ALIASES[c] ?? c;
  return Object.hasOwn(CHAINS, id) ? id : null;
}

export const TRON_REFUSAL = "Tron is not supported: only USDT exists on Tron in 1Click (no USDC)";

export function isTronName(input: string): boolean {
  return ["tron", "trx"].includes(input.trim().toLowerCase());
}

export const SUPPORTED_CHAIN_IDS: readonly string[] = Object.keys(CHAINS);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export interface AddressCheck {
  ok: boolean;
  /** Canonical form to put on-chain (EVM addresses lowercased). */
  normalized: string;
  error?: string;
  warning?: string;
}

export function checkAddress(chain: string, address: string): AddressCheck {
  const a = address.trim();
  const info = CHAINS[chain];
  if (!info) return { ok: false, normalized: a, error: `Unsupported chain '${chain}'. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}` };
  switch (info.kind) {
    case "evm":
      return /^0x[0-9a-fA-F]{40}$/.test(a)
        ? { ok: true, normalized: a.toLowerCase() }
        : { ok: false, normalized: a, error: `Not a valid ${info.label} address: expected 0x followed by 40 hex characters` };
    case "sol":
      return a.length >= 32 && a.length <= 44 && BASE58.test(a)
        ? { ok: true, normalized: a }
        : { ok: false, normalized: a, error: "Not a valid Solana address: expected 32-44 base58 characters" };
    case "near":
      return /^([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/.test(a) && a.length >= 2 && a.length <= 64
        ? { ok: true, normalized: a }
        : { ok: false, normalized: a, error: "Not a valid NEAR account id" };
  }
}

/** Equality of two destination addresses on the same chain (EVM is case-insensitive). */
export function sameAddress(chain: string, a: string, b: string): boolean {
  return CHAINS[chain]?.kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** NEAR account id check used for `owner_account` in requests. */
export function isNearAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && /^([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/.test(s);
}
