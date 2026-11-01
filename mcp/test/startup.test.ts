import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { verifyRuntime } from "../src/startup.js";

const env = { TREASURY_VAULT: "v.testnet", TREASURY_NETWORK: "testnet", TREASURY_AGENT_ACCOUNT: "a.testnet", ONECLICK_MODE: "simulated" };
const rpc = (chainId: string): typeof fetch => () => Promise.resolve(new Response(JSON.stringify({ result: { chain_id: chainId } })));

describe("verifyRuntime", () => {
  it("accepts simulated mode only on a real testnet RPC", async () => {
    await expect(verifyRuntime(loadConfig(env), rpc("testnet"))).resolves.toBeUndefined();
    await expect(verifyRuntime(loadConfig({ ...env, NEAR_RPC: "https://free.rpc.fastnear.com" }), rpc("mainnet"))).rejects.toThrow(/not "testnet"/);
  });
  it("refuses when the chain cannot be verified", async () => {
    await expect(verifyRuntime(loadConfig(env), (() => Promise.reject(new Error("down"))))).rejects.toThrow(/cannot verify/);
  });
  it("does nothing in live mode", async () => {
    await expect(verifyRuntime(loadConfig({ ...env, ONECLICK_MODE: "live" }), (() => Promise.reject(new Error("never called"))))).resolves.toBeUndefined();
  });
});
