import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** ADR-0007: loadConfig returns { treasury, trading }; these tests are about the treasury section. */
const treasuryOf = (env: Record<string, string>) => {
  const t = loadConfig(env).treasury;
  if (t === null) throw new Error("treasury section missing");
  return t;
};

const base = { TREASURY_VAULT: "vault.owner.near", TREASURY_NETWORK: "mainnet", TREASURY_AGENT_ACCOUNT: "procurement.owner.near" };

describe("loadConfig", () => {
  it("maps the AGENT_ACCESS env", () => {
    const c = treasuryOf({ ...base, TREASURY_AGENT_PRIVATE_KEY: "test-key-placeholder", NEAR_RPC: "https://rpc.example.com", ONECLICK_JWT: "jwt" });
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
    const c = treasuryOf({ ...base, ONECLICK_JWT: "", NEAR_RPC: "", ONECLICK_API_KEY: "k", TREASURY_AGENT_PRIVATE_KEY: "" });
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
    expect(treasuryOf({ ...base, TREASURY_NETWORK: "testnet", ONECLICK_MODE: "simulated" }).oneclick.mode).toBe("simulated");
  });
});
