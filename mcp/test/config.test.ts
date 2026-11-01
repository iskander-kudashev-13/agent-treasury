import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { TREASURY_VAULT: "vault.owner.near", TREASURY_NETWORK: "mainnet", TREASURY_AGENT_ACCOUNT: "procurement.owner.near" };

describe("loadConfig", () => {
  it("maps the AGENT_ACCESS env", () => {
    const c = loadConfig({ ...base, TREASURY_AGENT_PRIVATE_KEY: "test-key-placeholder", NEAR_RPC: "https://rpc.example.com", ONECLICK_JWT: "jwt" });
    expect(c).toMatchObject({
      vaultId: "vault.owner.near",
      network: "mainnet",
      agentAccountId: "procurement.owner.near",
      agentPrivateKey: "test-key-placeholder",
      rpcUrl: "https://rpc.example.com",
      oneclick: { baseUrl: "https://1click.chaindefuser.com", jwt: "jwt", mode: "live" },
    });
  });
  it("treats empty strings as unset and accepts ONECLICK_API_KEY", () => {
    const c = loadConfig({ ...base, ONECLICK_JWT: "", NEAR_RPC: "", ONECLICK_API_KEY: "k", TREASURY_AGENT_PRIVATE_KEY: "" });
    expect(c.oneclick.apiKey).toBe("k");
    expect(c.oneclick.jwt).toBeUndefined();
    expect(c.rpcUrl).toBeUndefined();
    expect(c.agentPrivateKey).toBeUndefined();
  });
  it("requires vault, network and account", () => {
    expect(() => loadConfig({})).toThrow(/TREASURY_VAULT/);
    expect(() => loadConfig({ ...base, TREASURY_NETWORK: "devnet" })).toThrow(/TREASURY_NETWORK/);
  });
  it("refuses simulated 1Click on mainnet", () => {
    expect(() => loadConfig({ ...base, ONECLICK_MODE: "simulated" })).toThrow(/only allowed with TREASURY_NETWORK=testnet/);
    expect(loadConfig({ ...base, TREASURY_NETWORK: "testnet", ONECLICK_MODE: "simulated" }).oneclick.mode).toBe("simulated");
  });
});
