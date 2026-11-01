import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { OneClickClient, OneClickError } from "../src/oneclick.js";
import { PayoutLoop } from "../src/payout-loop.js";
import { SimulatedOneClient, SIMULATED_BANNER } from "../src/oneclick-simulated.js";
import { FakeVault, makeLoop, startFakeOneClick } from "./fakes.js";

describe("config", () => {
  it("defaults to DRY_RUN=true and local mode", () => {
    const c = loadConfig({ VAULT_CONTRACT_ID: "vault.testnet" });
    expect(c.DRY_RUN).toBe(true);
    expect(c.RUN_MODE).toBe("local");
    expect(c.ONECLICK_BASE_URL).toBe("https://1click.chaindefuser.com");
  });
  it("requires the sponsor when DRY_RUN=false", () => {
    expect(() => loadConfig({ VAULT_CONTRACT_ID: "v.testnet", DRY_RUN: "false" })).toThrow(/SPONSOR_ACCOUNT_ID/);
  });
  it("rejects ambiguous booleans and missing vault", () => {
    expect(() => loadConfig({ VAULT_CONTRACT_ID: "v.testnet", DRY_RUN: "0" })).toThrow();
    expect(() => loadConfig({})).toThrow(/VAULT_CONTRACT_ID/);
  });
});

describe("OneClickClient", () => {
  it("caches /v0/tokens and rejects bad payloads / http errors with typed errors", async () => {
    const oc = await startFakeOneClick();
    try {
      let t = 0;
      const client = new OneClickClient({ baseUrl: oc.url, timeoutMs: 1000, now: () => t });
      await client.getTokens();
      oc.tokens = [];
      expect((await client.getTokens()).length).toBe(2); // cached
      t = 11 * 60_000;
      expect((await client.getTokens()).length).toBe(0); // expired
      oc.failStatusWith500 = true;
      await expect(client.getStatus("x")).rejects.toMatchObject({ kind: "http", status: 500 });
      const bad = new OneClickClient({ baseUrl: `${oc.url}/nope`, timeoutMs: 1000 });
      await expect(bad.getTokens()).rejects.toBeInstanceOf(OneClickError);
    } finally {
      await oc.close();
    }
  });
});

describe("HTTP API", () => {
  const mk = (adminToken: string | undefined) => {
    const vault = new FakeVault();
    vault.schedules = [];
    const loop = new PayoutLoop({
      vault,
      oneclick: new OneClickClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 100 }),
      settings: { dryRun: true, vaultId: "v", agentAccountId: "a", slippageBps: 100, quoteTtlMs: 1, approvalQuoteTtlMs: 1, pollTimeoutMs: 1, pollInitialMs: 1, pollMaxMs: 1, reconcileWindow: 1 },
      log: () => undefined,
    });
    const app = createApp({
      mode: "local", network: "testnet", vaultId: "v", dryRun: true, oneclickMode: "live", agentAccountId: "a", agentId: "payroll", budget: () => vault.getAgentBudget(), rejections: () => vault.getRejections(), schedules: () => Promise.resolve({ due: 0, upcoming: [] }), loop,
      registration: () => ({ state: "skipped" }), attestation: () => Promise.resolve(undefined),
      adminToken, dashboardOrigin: "http://localhost:3001",
    });
    return { app, loop };
  };

  it("GET /status and /runs", async () => {
    const { app, loop } = mk("secret");
    await loop.run("manual");
    const s = (await (await app.request("/status")).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ mode: "local", insecureDevMode: true, dryRun: true, agentAccountId: "a", attestation: null });
    const r = (await (await app.request("/runs")).json()) as { runs: unknown[] };
    expect(r.runs).toHaveLength(1);
  });

  it("POST /run is guarded by the admin token", async () => {
    expect((await mk(undefined).app.request("/run", { method: "POST" })).status).toBe(403);
    const { app } = mk("secret");
    expect((await app.request("/run", { method: "POST" })).status).toBe(401);
    expect((await app.request("/run", { method: "POST", headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/run", { method: "POST", headers: { Authorization: "Bearer secret" } })).status).toBe(202);
  });

  it("sets CORS for the dashboard origin only", async () => {
    const { app } = mk("secret");
    const res = await app.request("/status", { headers: { Origin: "http://localhost:3001" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3001");
  });
});

describe("simulated 1Click", () => {
  it("config refuses simulated mode on mainnet and allows it on testnet", () => {
    expect(() => loadConfig({ VAULT_CONTRACT_ID: "v.near", NEAR_NETWORK: "mainnet", ONECLICK_MODE: "simulated" })).toThrow(/only allowed with NEAR_NETWORK=testnet/);
    expect(loadConfig({ VAULT_CONTRACT_ID: "v.testnet", NEAR_NETWORK: "testnet", ONECLICK_MODE: "simulated" }).ONECLICK_MODE).toBe("simulated");
    expect(loadConfig({ VAULT_CONTRACT_ID: "v.near", NEAR_NETWORK: "mainnet", ALLOW_INSECURE_LOCAL_MODE: "true" }).ONECLICK_MODE).toBe("live");
  });

  const run = async (outcome: "success" | "refunded") => {
    const logs: string[] = [];
    const vault = new FakeVault();
    const sim = new SimulatedOneClient({ outcome, log: (m) => logs.push(m) });
    const { loop } = makeLoop({ vault, oneclickUrl: "http://127.0.0.1:1", oneclick: sim });
    const rec = await loop.run("manual");
    return { rec, vault, logs };
  };

  it("runs the whole loop to Confirmed, with a random 64-hex deposit address per quote and a loud banner", async () => {
    const { rec, vault, logs } = await run("success");
    expect(rec?.results[0]?.outcome).toBe("confirmed");
    expect(vault.requestCalls[0]?.depositAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.reports[0]?.status).toBe("Confirmed");
    expect(logs.some((l) => l.includes(SIMULATED_BANNER))).toBe(true);
    const sim = new SimulatedOneClient({ outcome: "success", log: () => undefined });
    const req = { dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:x", depositType: "ORIGIN_CHAIN", destinationAsset: "d", amount: "1000000", refundTo: "v", refundType: "ORIGIN_CHAIN", recipient: "r", recipientType: "DESTINATION_CHAIN", deadline: "2030-01-01T00:00:00.000Z" } as const;
    const a = (await sim.quote(req)).quote.depositAddress;
    const b = (await sim.quote(req)).quote.depositAddress;
    expect(a).not.toBe(b);
    expect((await sim.quote({ ...req, dry: true })).quote.depositAddress).toBeUndefined();
  });

  it("SIMULATED_OUTCOME=refunded reports Refunded", async () => {
    const { rec, vault } = await run("refunded");
    expect(rec?.results[0]?.outcome).toBe("refunded");
    expect(vault.reports[0]?.status).toBe("Refunded");
  });

  it("rejects destination assets it cannot parse", async () => {
    const sim = new SimulatedOneClient({ outcome: "success", log: () => undefined });
    expect(await sim.findToken("garbage")).toBeUndefined();
    expect((await sim.findToken("nep141:base-0xabc.omft.near"))?.blockchain).toBe("base");
  });
});
