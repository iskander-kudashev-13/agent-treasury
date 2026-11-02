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

describe("NearVault.getSentKeyAgentPayouts", () => {
  it("pages backwards over all payouts until they are older than sinceMs, keeps Sent payouts of Key agents", async () => {
    const { NearVault } = await import("../src/vault.js");
    // 250 payouts: ids 0..249, created_at = id. Key agent "claude" has Sent payouts 5 (too old) and 180, 240.
    const all = Array.from({ length: 250 }, (_, i) => ({
      id: String(i), agent_id: i % 2 === 0 ? "claude" : "payroll", recipient_id: null, amount: "1",
      status: [5, 180, 240, 241].includes(i) ? "Sent" : "Confirmed", deposit_address: "d", agent_account: null, tx_hash: null,
      created_at_ms: String(i), updated_at_ms: String(i),
    }));
    const calls: [string, Record<string, unknown>][] = [];
    const view = (m: string, a: Record<string, unknown>) => {
      calls.push([m, a]);
      if (m === "get_payouts_count") return Promise.resolve(String(all.length));
      if (m === "get_payouts") return Promise.resolve(all.slice(a.from_index as number, (a.from_index as number) + (a.limit as number)));
      if (m === "get_agent") return Promise.resolve(a.agent_id === "claude" ? { kind: "Key" } : { kind: "Tee" });
      return Promise.reject(new Error(m));
    };
    const v = new NearVault({ view, call: () => Promise.reject(new Error("no")), takeLastTxHash: () => undefined }, "payroll");
    const res = await v.getSentKeyAgentPayouts({ sinceMs: 100, pageSize: 100, maxPages: 20 });
    expect(res.map((p) => p.id)).toEqual(["180", "240"]);
    // Whole-vault scan (no agent_id), stops after the first page that is entirely older than sinceMs.
    expect(calls.filter(([m]) => m === "get_payouts").map(([, a]) => a)).toEqual([
      { from_index: 150, limit: 100 },
      { from_index: 50, limit: 100 },
      { from_index: 0, limit: 50 },
    ]);
    // Only the agents seen among Sent payouts are looked up.
    expect(calls.filter(([m]) => m === "get_agent").map(([, a]) => a.agent_id).sort()).toEqual(["claude", "payroll"]);
  });

  it("respects maxPages", async () => {
    const { NearVault } = await import("../src/vault.js");
    let pages = 0;
    const view = (m: string, a: Record<string, unknown>) => {
      if (m === "get_payouts_count") return Promise.resolve("10000");
      if (m === "get_payouts") {
        pages++;
        return Promise.resolve([{ id: String(a.from_index), agent_id: "x", recipient_id: null, amount: "1", status: "Confirmed", deposit_address: null, agent_account: null, tx_hash: null, created_at_ms: "999999", updated_at_ms: "1" }]);
      }
      return Promise.resolve(null);
    };
    const v = new NearVault({ view, call: () => Promise.reject(new Error("no")), takeLastTxHash: () => undefined }, "payroll");
    await v.getSentKeyAgentPayouts({ sinceMs: 0, pageSize: 100, maxPages: 3 });
    expect(pages).toBe(3);
  });
});

describe("NearVault.getSentKeyAgentPayouts paging (tester)", () => {
  const mk = (id: number, agent_id: string, status: string, created: number) => ({
    id: String(id), agent_id, recipient_id: null, amount: "1", status, deposit_address: "d", agent_account: null, tx_hash: null,
    created_at_ms: String(created), updated_at_ms: String(created),
  });
  /** View that pages like the contract (`get_payouts` honours from_index + limit, `get_agent` returns null if unknown). */
  function pagedView(agents: Record<string, string>, payouts: ReturnType<typeof mk>[]) {
    const calls: [string, Record<string, unknown>][] = [];
    const view = (m: string, a: Record<string, unknown>) => {
      calls.push([m, a]);
      if (m === "get_payouts_count") return Promise.resolve(String(payouts.length));
      if (m === "get_payouts") {
        const from = Number(a.from_index ?? 0);
        return Promise.resolve(payouts.slice(from, from + Number(a.limit ?? 50)));
      }
      if (m === "get_agent") {
        const kind = agents[String(a.agent_id)];
        return Promise.resolve(kind ? { id: a.agent_id, kind } : null);
      }
      if (m === "get_agents") return Promise.reject(new Error("get_agents must not be needed"));
      return Promise.reject(new Error(m));
    };
    const pages = () => calls.filter(([m]) => m === "get_payouts").map(([, a]) => a);
    return { view, calls, pages };
  }
  const near = async (view: (m: string, a: Record<string, unknown>) => Promise<unknown>) => {
    const { NearVault } = await import("../src/vault.js");
    return new NearVault({ view, call: () => Promise.reject(new Error("no")), takeLastTxHash: () => undefined }, "payroll");
  };

  it("pages backwards past newer payouts to find an old Key payout approved late, stops once a page is older than sinceMs", async () => {
    // 250 payouts, created_at = 1000 + id. A Key payout #10 (old, approved later → Sent) sits deep in the log.
    const payouts = Array.from({ length: 250 }, (_, i) => mk(i, "payroll", "Confirmed", 1000 + i));
    payouts[10] = mk(10, "claude", "Sent", 1010);
    payouts[200] = mk(200, "claude", "Sent", 1200);
    const { view, pages } = pagedView({ claude: "Key", payroll: "Tee" }, payouts);
    const v = await near(view);
    const res = await v.getSentKeyAgentPayouts({ sinceMs: 1005, pageSize: 100, maxPages: 20 });
    expect(res.map((p) => p.id)).toEqual(["10", "200"]);
    expect(pages()).toEqual([
      { from_index: 150, limit: 100 },
      { from_index: 50, limit: 100 },
      { from_index: 0, limit: 50 },
    ]);
    // sinceMs newer than a whole page: stops after it (page [150, 250) is all >= 1150, page [50, 150) all < 1150).
    const second = pagedView({ claude: "Key" }, payouts);
    const res2 = await (await near(second.view)).getSentKeyAgentPayouts({ sinceMs: 1150, pageSize: 100, maxPages: 20 });
    expect(second.pages()).toHaveLength(2);
    expect(res2.map((p) => p.id)).toEqual(["200"]);
  });

  it("is bounded by maxPages", async () => {
    const payouts = Array.from({ length: 500 }, (_, i) => mk(i, "claude", i === 0 ? "Sent" : "Confirmed", 1000 + i));
    const { view, pages } = pagedView({ claude: "Key" }, payouts);
    const res = await (await near(view)).getSentKeyAgentPayouts({ sinceMs: 0, pageSize: 100, maxPages: 2 });
    expect(pages()).toHaveLength(2);
    expect(res).toEqual([]);
  });

  it("does not depend on the number of agents: looks up only agents that own Sent payouts; drops Tee and unknown agents", async () => {
    // Regression for the earlier one-page get_agents (200) lookup: a vault may hold any number of agents.
    const payouts = [mk(0, "late-key", "Sent", 5), mk(1, "payroll", "Sent", 5), mk(2, "gone", "Sent", 5), mk(3, "late-key", "Sent", 5)];
    const { view, calls } = pagedView({ "late-key": "Key", payroll: "Tee" }, payouts);
    const res = await (await near(view)).getSentKeyAgentPayouts({ sinceMs: 0, pageSize: 100, maxPages: 20 });
    expect(res.map((p) => p.id)).toEqual(["0", "3"]);
    const looked = calls.filter(([m]) => m === "get_agent").map(([, a]) => a.agent_id);
    expect(looked.sort()).toEqual(["gone", "late-key", "payroll"]);
  });

  it("empty vault: no pages, no agent lookups", async () => {
    const { view, calls } = pagedView({}, []);
    expect(await (await near(view)).getSentKeyAgentPayouts({ sinceMs: 0, pageSize: 100, maxPages: 20 })).toEqual([]);
    expect(calls.map(([m]) => m)).toEqual(["get_payouts_count"]);
  });
});
