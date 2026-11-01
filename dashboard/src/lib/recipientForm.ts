import { normalizeAddress } from "./address";
import type { RecipientInput } from "./types";

export interface ChainOption {
  id: string;
  label: string;
  kind: "evm" | "sol" | "tron";
}
/** 1Click `blockchain` ids the dashboard can pay (same set as the worker assistant) plus Tron, which is refused with an explanation. */
export const RECIPIENT_CHAINS: readonly ChainOption[] = [
  { id: "base", label: "Base", kind: "evm" },
  { id: "arb", label: "Arbitrum", kind: "evm" },
  { id: "eth", label: "Ethereum", kind: "evm" },
  { id: "sol", label: "Solana", kind: "sol" },
  { id: "tron", label: "Tron", kind: "tron" },
];

export const TRON_MESSAGE = "Tron is not supported: only USDT exists on Tron in 1Click, there is no USDC.";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export interface RecipientDraft {
  label: string;
  chain: string;
  address: string;
}
export interface RecipientCheck {
  errors: Partial<Record<keyof RecipientDraft, string>>;
  /** Canonical address (EVM lowercased) when the address is valid. */
  address: string | null;
}

/** Per-chain validation. Does not know the asset id (resolved from 1Click, never typed). */
export function validateRecipientDraft(d: RecipientDraft, existing: Array<{ id?: number; label: string; destination_chain: string; destination_address: string }> = [], editingId: number | null = null): RecipientCheck {
  const errors: RecipientCheck["errors"] = {};
  const label = d.label.trim();
  if (!label) errors.label = "Name is required";
  else if (label.length > 64) errors.label = "Name is at most 64 characters";
  const chain = RECIPIENT_CHAINS.find((c) => c.id === d.chain);
  let address: string | null = null;
  if (!chain) errors.chain = "Select a chain";
  else if (chain.kind === "tron") errors.chain = TRON_MESSAGE;
  const a = d.address.trim();
  if (!a) errors.address = "Address is required";
  else if (chain && chain.kind !== "tron") {
    if (chain.kind === "evm") {
      if (!EVM_RE.test(a)) errors.address = `Not a valid ${chain.label} address: expected 0x followed by 40 hex characters`;
      else address = normalizeAddress(chain.id, a);
    } else if (!BASE58_RE.test(a)) errors.address = "Not a valid Solana address: expected base58, 32-44 characters";
    else address = a;
  }
  if (address && chain) {
    const dup = existing.find((r) => r.id !== editingId && r.destination_chain === chain.id && r.destination_address === address);
    if (dup) errors.address = `Already in your address book as ${dup.label}`;
  }
  return { errors, address: Object.keys(errors).length ? null : address };
}

export function buildRecipientInput(d: RecipientDraft, address: string, asset: string): RecipientInput {
  return { label: d.label.trim(), destination_chain: d.chain, destination_asset: asset, destination_address: address };
}
