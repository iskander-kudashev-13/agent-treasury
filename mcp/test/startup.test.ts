import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { verifyRuntime } from "../src/startup.js";

const env = { TREASURY_VAULT: "v.testnet", TREASURY_NETWORK: "testnet", TREASURY_AGENT_ACCOUNT: "a.testnet", ONECLICK_MODE: "simulated" };
/** ADR-0007: loadConfig returns { treasury, trading }; startup checks the treasury section. */
const treasuryOf = (e: Record<string, string>) => {
  const t = loadConfig(e).treasury;
  if (t === null) throw new Error("treasury section missing");
  return t;
};
const rpc = (chainId: string): typeof fetch => () => Promise.resolve(new Response(JSON.stringify({ result: { chain_id: chainId } })));

describe("verifyRuntime", () => {
  it("accepts simulated mode only on a real testnet RPC", async () => {
    await expect(verifyRuntime(treasuryOf(env), rpc("testnet"))).resolves.toBeUndefined();
    await expect(verifyRuntime(treasuryOf({ ...env, NEAR_RPC: "https://free.rpc.fastnear.com" }), rpc("mainnet"))).rejects.toThrow(/not "testnet"/);
  });
  it("refuses when the chain cannot be verified", async () => {
    await expect(verifyRuntime(treasuryOf(env), (() => Promise.reject(new Error("down"))))).rejects.toThrow(/cannot verify/);
  });
  it("does nothing in live mode", async () => {
    await expect(verifyRuntime(treasuryOf({ ...env, ONECLICK_MODE: "live" }), (() => Promise.reject(new Error("never called"))))).resolves.toBeUndefined();
  });
});
