/** M4: `ONECLICK_MODE=simulated` must only ever run against a real testnet RPC. A label (`NEAR_NETWORK`) proves nothing: NEAR transactions carry no chain id. */
export async function assertTestnetRpc(
  rpcUrl: string,
  vaultId: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<void> {
  if (vaultId.endsWith(".near")) throw new Error(`ONECLICK_MODE=simulated refused: vault '${vaultId}' looks like a mainnet account`);
  const f = opts.fetchFn ?? fetch;
  let chainId: unknown;
  try {
    const res = await f(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "chain-check", method: "status", params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const json: unknown = await res.json();
    if (typeof json === "object" && json !== null && "result" in json) {
      const result: unknown = json.result;
      if (typeof result === "object" && result !== null && "chain_id" in result) chainId = result.chain_id;
    }
  } catch (e) {
    throw new Error(`ONECLICK_MODE=simulated refused: could not verify the RPC chain (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  if (chainId !== "testnet") {
    throw new Error(`ONECLICK_MODE=simulated refused: RPC reports chain_id '${String(chainId)}', expected 'testnet'`);
  }
}
