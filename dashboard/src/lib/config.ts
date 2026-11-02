import { isSimulatedOneClick } from "./oneclickStatus";

export type Network = "testnet" | "mainnet";

const env = import.meta.env;
const net = env.VITE_NEAR_NETWORK;
export const NETWORK: Network = net === "mainnet" ? "mainnet" : "testnet";

// New names (UI_PLAN §2) first, legacy names as fallback.
export const VAULT_ID = env.VITE_VAULT_CONTRACT || env.VITE_VAULT_CONTRACT_ID || "";
export const USDC_ID = env.VITE_USDC_CONTRACT ?? "";

export const RPC_URL =
  env.VITE_NEAR_RPC ||
  env.VITE_NEAR_RPC_URL ||
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

export const WORKER_URL = (env.VITE_WORKER_URL ?? "").replace(/\/$/, "");
/** NEAR Intents 1Click API (read-only /v0/status used by the "Quote check" before approving a payout). */
export const ONECLICK_URL = (env.VITE_ONECLICK_BASE_URL || "https://1click.chaindefuser.com").replace(/\/$/, "");
/** Testnet-only: the worker/MCP run a simulated 1Click, so the approval quote check is skipped with an explicit ack. */
export const ONECLICK_SIMULATED = isSimulatedOneClick({ mode: env.VITE_ONECLICK_MODE, network: NETWORK, vaultId: VAULT_ID });
export const AI_ENABLED = env.VITE_AI_ENABLED === "true";

/** Contract views and worker status are refetched on this interval (UI_PLAN §2). */
export const POLL_MS = 10_000;

export const EXPLORER_BASE = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const explorerAddressUrl = (account: string, base = EXPLORER_BASE): string => `${base}/address/${account}`;
export const explorerTxUrl = (hash: string, base = EXPLORER_BASE): string => `${base}/txns/${hash}`;
