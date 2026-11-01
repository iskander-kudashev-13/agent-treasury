import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { assertTestnetRpc } from "../src/chain-check.js";
import { loadConfig, loadTeePinned } from "../src/config.js";

const pinned = {
  NEAR_NETWORK: "mainnet",
  VAULT_CONTRACT_ID: "vault.near",
  AGENT_ID: "payroll",
  ONECLICK_BASE_URL: "https://1click.chaindefuser.com",
  ONECLICK_MODE: "live",
  DRY_RUN: "false",
};
function teeFile(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "tee-"));
  const p = join(dir, "tee.config.json");
  writeFileSync(p, JSON.stringify({ ...pinned, ...over }));
  return p;
}

describe("H1: tee mode pins money-relevant config", () => {
  it("uses the pinned values and ignores a missing env", () => {
    const c = loadConfig({ RUN_MODE: "tee", SPONSOR_ACCOUNT_ID: "s.near", SPONSOR_PRIVATE_KEY: "ed25519:x" }, { teeConfigPath: teeFile() });
    expect(c).toMatchObject({ NEAR_NETWORK: "mainnet", VAULT_CONTRACT_ID: "vault.near", ONECLICK_MODE: "live", DRY_RUN: false });
  });
  it.each([
    ["ONECLICK_BASE_URL", "https://evil.example"],
    ["VAULT_CONTRACT_ID", "other.near"],
    ["AGENT_ID", "other"],
    ["DRY_RUN", "true"],
    ["ONECLICK_MODE", "simulated"],
    ["NEAR_NETWORK", "testnet"],
    ["NEAR_RPC_URL", "https://rpc.evil.example"],
  ])("refuses an env override of %s", (key, value) => {
    expect(() => loadConfig({ RUN_MODE: "tee", SPONSOR_ACCOUNT_ID: "s", SPONSOR_PRIVATE_KEY: "k", [key]: value }, { teeConfigPath: teeFile() })).toThrow(/Refusing to start/);
  });
  it("accepts an env value equal to the pinned one", () => {
    expect(() => loadConfig({ RUN_MODE: "tee", SPONSOR_ACCOUNT_ID: "s", SPONSOR_PRIVATE_KEY: "k", AGENT_ID: "payroll" }, { teeConfigPath: teeFile() })).not.toThrow();
  });
  it("fails closed: missing file, placeholder, or live-only violation", () => {
    expect(() => loadConfig({ RUN_MODE: "tee" }, { teeConfigPath: "/nonexistent/tee.config.json" })).toThrow(/baked into the image/);
    expect(() => loadTeePinned(teeFile({ VAULT_CONTRACT_ID: "REPLACE_WITH_VAULT_ID" }))).toThrow(/placeholder/);
    expect(() => loadTeePinned(teeFile({ ONECLICK_MODE: "simulated" }))).toThrow();
    expect(() => loadTeePinned(teeFile({ extra: 1 }))).toThrow();
  });
  it("docker-compose.yaml literals equal the repo's tee.config.json", () => {
    const file = JSON.parse(readFileSync("tee.config.json", "utf8")) as Record<string, string>;
    const compose = readFileSync("docker-compose.yaml", "utf8");
    for (const [k, v] of Object.entries(file)) {
      const m = new RegExp(`^\\s+${k}: "?([^"\\n]+)"?\\s*$`, "m").exec(compose);
      expect(m?.[1], k).toBe(v);
    }
    expect(compose).toMatch(/RUN_MODE: tee/);
  });
});

describe("M3: insecure local mode on mainnet", () => {
  const base = { VAULT_CONTRACT_ID: "vault.near", NEAR_NETWORK: "mainnet", RUN_MODE: "local" };
  it("is refused without the explicit opt-in", () => {
    expect(() => loadConfig(base)).toThrow(/ALLOW_INSECURE_LOCAL_MODE/);
    expect(loadConfig({ ...base, ALLOW_INSECURE_LOCAL_MODE: "true" }).RUN_MODE).toBe("local");
  });
  it("needs no opt-in on testnet", () => {
    expect(() => loadConfig({ VAULT_CONTRACT_ID: "v.testnet", NEAR_NETWORK: "testnet", RUN_MODE: "local" })).not.toThrow();
  });
});

describe("M4: simulated mode verifies the RPC chain", () => {
  async function rpc(chainId: string) {
    const app = new Hono();
    app.post("/", (c) => c.json({ jsonrpc: "2.0", id: "x", result: { chain_id: chainId } }));
    const server = await new Promise<ReturnType<typeof serve>>((res) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => {
        res(s);
      });
    });
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return { url, close: () => server.close() };
  }
  it("accepts a testnet RPC", async () => {
    const r = await rpc("testnet");
    await expect(assertTestnetRpc(r.url, "vault.testnet")).resolves.toBeUndefined();
    r.close();
  });
  it("refuses a mainnet RPC even with a testnet label", async () => {
    const r = await rpc("mainnet");
    await expect(assertTestnetRpc(r.url, "vault.testnet")).rejects.toThrow(/chain_id 'mainnet'/);
    r.close();
  });
  it("refuses an unreachable RPC and a .near vault", async () => {
    await expect(assertTestnetRpc("http://127.0.0.1:1", "vault.testnet", { timeoutMs: 500 })).rejects.toThrow(/could not verify/);
    await expect(assertTestnetRpc("http://127.0.0.1:1", "vault.near")).rejects.toThrow(/mainnet account/);
  });
});
