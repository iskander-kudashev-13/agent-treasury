import { SdkError, errMsg } from "./errors.js";
import { defaultRpcUrl } from "./vault.js";

/**
 * Simulated 1Click fakes cross-chain delivery, so it must only run against a real NEAR testnet.
 * A "network" label is not proof (the RPC URL may point at mainnet): ask the node itself via the `status` RPC.
 */
export async function assertTestnetRpc(opts: { network: "mainnet" | "testnet"; rpcUrl?: string | undefined; fetchFn?: typeof fetch; timeoutMs?: number }): Promise<void> {
  if (opts.network !== "testnet") throw new SdkError("CONFIG", "simulated 1Click is only allowed with network \"testnet\"");
  const url = opts.rpcUrl ?? defaultRpcUrl("testnet");
  let chainId: unknown;
  try {
    const res = await (opts.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "chain-check", method: "status", params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const json = (await res.json()) as { result?: { chain_id?: unknown } };
    chainId = json.result?.chain_id;
  } catch (e) {
    throw new SdkError("CONFIG", `cannot verify the RPC chain (${errMsg(e)}); refusing simulated 1Click`);
  }
  if (chainId !== "testnet") {
    throw new SdkError("CONFIG", `RPC ${url} reports chain_id ${JSON.stringify(chainId)}, not "testnet"; refusing simulated 1Click`);
  }
}
