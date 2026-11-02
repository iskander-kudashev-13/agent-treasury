import { t } from "@/i18n";
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
  { id: "hypercore", label: "Hyperliquid", kind: "evm" },
  { id: "sol", label: "Solana", kind: "sol" },
  { id: "tron", label: "Tron", kind: "tron" },
];

export const tronMessage = (): string => t("rf.tron");
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
  if (!label) errors.label = t("rf.nameRequired");
  else if (label.length > 64) errors.label = t("rf.nameLong");
  const chain = RECIPIENT_CHAINS.find((c) => c.id === d.chain);
  let address: string | null = null;
  if (!chain) errors.chain = t("rf.selectChain");
  else if (chain.kind === "tron") errors.chain = tronMessage();
  const a = d.address.trim();
  if (!a) errors.address = t("rf.addrRequired");
  else if (chain && chain.kind !== "tron") {
    if (chain.kind === "evm") {
      if (!EVM_RE.test(a)) errors.address = t("rf.badEvm", { chain: chain.label });
      else address = normalizeAddress(chain.id, a);
    } else if (!BASE58_RE.test(a)) errors.address = t("rf.badSol");
    else address = a;
  }
  if (address && chain) {
    const dup = existing.find((r) => r.id !== editingId && r.destination_chain === chain.id && r.destination_address === address);
    if (dup) errors.address = t("rf.dup", { label: dup.label });
  }
  return { errors, address: Object.keys(errors).length ? null : address };
}

export function buildRecipientInput(d: RecipientDraft, address: string, asset: string): RecipientInput {
  return { label: d.label.trim(), destination_chain: d.chain, destination_asset: asset, destination_address: address };
}
