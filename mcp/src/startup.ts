import { assertTestnetRpc } from "agent-treasury-sdk";
import type { TreasuryClientConfig } from "agent-treasury-sdk";

/** Fails fast at startup. Simulated 1Click must talk to a real testnet RPC (the network label alone is not proof). */
export async function verifyRuntime(config: TreasuryClientConfig, fetchFn?: typeof fetch): Promise<void> {
  if (config.oneclick.mode !== "simulated") return;
  await assertTestnetRpc({ network: config.network, rpcUrl: config.rpcUrl, ...(fetchFn ? { fetchFn } : {}) });
}
