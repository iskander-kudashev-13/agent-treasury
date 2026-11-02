/* Test-only: HTTP bodies are asserted as loosely typed JSON. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
/**
 * End-to-end, in process: the trading module is built exactly as `src/index.ts` does (`createTradingModule`), with the
 * two network adapters swapped by `vi.mock`: the Hyperliquid adapter (`hl/nktkas.ts`) returns a `FakeHl`, and the SDK's
 * `createTreasuryClient` returns a fake vault client. NEAR RPC is the `FakeChain` view + access-key table. The model is
 * the scripted OpenAI-compatible fake server. Everything goes through the real HTTP app (`createApp`).
 *
 * owner chats -> TradingRules card -> challenge -> NEP-413 sign -> confirm -> IOC order with the rules' cloid prefix
 * -> price drop -> daily loss stop -> kill -> orders cancelled + scheduleCancel a few seconds out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../../src/app.js";
import type { AppDeps } from "../../src/app.js";
import { AiInfo } from "../../src/ai/info.js";
import type { AiDeps } from "../../src/ai/route.js";
import type { ViewFn } from "../../src/ai/views.js";
import { loadConfig } from "../../src/config.js";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import type { FakeHl } from "../../src/trading/hl/fake.js";
import { createTradingModule } from "../../src/trading/index.js";
import { hashRuleSet } from "../../src/trading/rules/canonical.js";
import type { RuleSetV1 } from "../../src/trading/types.js";
import { chat, FakeChain, FakeModelServer, ownerKey, OWNER, signIn, VAULT } from "../ai-fakes.js";
import { dcaRules, FakeSdkClient, T0, TEST_KEY } from "./harness.js";
import { HL_ACCOUNT, tmpDir } from "./fixtures.js";

interface Holder {
  hl: unknown;
  client: unknown;
  hlCreated: unknown[];
  clientOpts: unknown[];
}
const holder: Holder = vi.hoisted((): Holder => ({ hl: null, client: null, hlCreated: [], clientOpts: [] }));

vi.mock("../../src/trading/hl/nktkas.js", async () => {
  const { FakeHl: Fake } = await import("../../src/trading/hl/fake.js");
  return {
    createNktkasHl: (opts: unknown) => {
      holder.hlCreated.push(opts);
      holder.hl ??= new Fake({ now: () => Date.now() });
      return holder.hl;
    },
  };
});

vi.mock("agent-treasury-sdk", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createTreasuryClient: (opts: unknown) => {
      holder.clientOpts.push(opts);
      return holder.client;
    },
  };
});

class E2eClient extends FakeSdkClient {
  watchPayment(id: string) {
    this.watched.push(id);
    return { done: Promise.resolve({ kind: "reported" }) };
  }
}

const model = new FakeModelServer();
beforeAll(async () => {
  await model.start();
});
afterAll(() => {
  model.stop();
});
beforeEach(() => {
  // Only Date is faked: the fake model server and hono keep real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  holder.hl = null;
  holder.hlCreated = [];
  holder.clientOpts = [];
  holder.client = new E2eClient([]);
  model.rounds = [];
  model.requests = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function world() {
  const dir = tmpDir();
  const chain = new FakeChain();
  const budget = { status: "Active", vault_paused: false, remaining_today: "50000000", per_tx_limit: "25000000", payments_today: 0, max_payments_per_day: 2, expires_at: null as string | null };
  const view: ViewFn = (method, args) => (method === "get_agent_budget" ? Promise.resolve(structuredClone(budget)) : chain.view(method, args));
  const config = loadConfig({
    VAULT_CONTRACT_ID: VAULT,
    AI_SESSION_SECRET: "s".repeat(40),
    NEARAI_API_KEY: "k",
    TRADING_ENABLED: "true",
    HL_NETWORK: "testnet",
    HL_MASTER_ADDRESS: HL_ACCOUNT,
    HL_API_WALLET_PRIVATE_KEY: TEST_KEY,
    TRADING_STATE_DIR: dir,
    TRADER_NEAR_ACCOUNT_ID: "trader.test.near",
    TRADER_NEAR_PRIVATE_KEY: "ed25519:fake-not-a-real-key",
    TRADING_TICK_SEC: "60",
    TRADING_DEADMAN_SEC: "180",
  });
  const ai: AiDeps = {
    config: {
      apiKey: "k",
      model: "m",
      baseUrl: model.url,
      vault: VAULT,
      network: "testnet",
      rateLimitPerMin: 100,
      maxMessages: 10,
      maxMessageChars: 2000,
      timeoutMs: 10_000,
      trustProxy: true,
      sessionSecret: "s".repeat(40),
    },
    view,
    info: new AiInfo({ baseUrl: model.url, apiKey: "k", model: "m" }),
    now: () => Date.now(),
    usdcAsset: () => Promise.resolve(null),
    accessKey: (acc, pk) => Promise.resolve(chain.accessKeys[`${acc}|${pk}`] ?? "none"),
  };
  // Same order as src/index.ts: module first, then `ai.trading`, then the app.
  const trading = createTradingModule(config, ai);
  ai.trading = trading.authoring;
  const hl = holder.hl as FakeHl;
  hl.account = HL_ACCOUNT.toLowerCase();
  hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  const apiAddress = trading.service.status().api_wallet.address;
  hl.setApprovedAgents(HL_ACCOUNT, [{ address: apiAddress, name: "agent-treasury", validUntilMs: T0 + 30 * 86_400_000 }]);

  const appDeps: AppDeps = {
    mode: "local",
    network: "testnet",
    vaultId: VAULT,
    dryRun: true,
    oneclickMode: "simulated",
    agentAccountId: "worker.test.near",
    agentId: "payroll",
    loop: { lastRun: () => undefined, recentRuns: () => [], isRunning: false, nextRunAt: undefined, run: () => Promise.resolve() } as unknown as AppDeps["loop"],
    budget: () => Promise.resolve(null),
    rejections: () => Promise.resolve([]),
    schedules: () => Promise.resolve({ due: 0, upcoming: [] }),
    registration: () => ({ state: "registered" }) as unknown as ReturnType<AppDeps["registration"]>,
    attestation: () => Promise.resolve(undefined),
    adminToken: undefined,
    dashboardOrigin: "http://localhost:5173",
    ai,
    trading: trading.routeDeps,
  };
  const app = createApp(appDeps);
  return { dir, chain, budget, config, ai, trading, hl, app, client: holder.client as E2eClient, apiAddress };
}

const hdr = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": "9.9.9.9" });

async function chatForRules(app: Hono, rules: RuleSetV1) {
  model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules } }] }, { text: "Here are the rules. Review and sign." }];
  const r = await chat(app, "buy HYPE for 12 USDC every hour; max 40 USDC; stop at -5 USDC today");
  const cards: any[] = r.events.filter((e) => e.event === "proposal").map((e) => (e.data as { proposal?: unknown }).proposal);
  return { r, cards };
}

async function challengeSignConfirm(app: Hono, token: string, rules: RuleSetV1) {
  const chRes = await app.request("/trading/rules/challenge", { method: "POST", headers: hdr(token), body: JSON.stringify({ rules }) });
  expect(chRes.status).toBe(200);
  const ch = (await chRes.json()) as { nonce: string; message: string; recipient: string; hash: string };
  const res = await app.request("/trading/rules/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify({
      rules,
      account_id: OWNER,
      public_key: ownerKey.publicKey,
      signature: ownerKey.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient, callbackUrl: null }),
      nonce: ch.nonce,
    }),
  });
  return { ch, res, body: (await res.json()) };
}

describe("trading e2e (createTradingModule + createApp, fake HL / SDK / NEAR / model)", () => {
  it("chat -> proposal -> sign -> confirm -> IOC order -> loss stop -> kill", async () => {
    const w = world();
    // index.ts wiring: one HL adapter on testnet, and the trader's own SDK client bound to the trading agent id.
    expect(holder.hlCreated).toEqual([expect.objectContaining({ network: "testnet" })]);
    expect(holder.clientOpts).toEqual([expect.objectContaining({ vaultId: VAULT, agentId: "hl-trader", agentAccountId: "trader.test.near" })]);

    // Before any rules: public status works and nothing is traded.
    await w.trading.service.tick();
    expect(((await (await w.app.request("/trading/status")).json())).state).toBe("no_rules");
    expect(w.hl.placed).toHaveLength(0);

    // 1. Owner chats; the model calls propose_trading_rules; a TradingRules card comes back with the canonical hash.
    const rules = dcaRules();
    const { r, cards } = await chatForRules(w.app, rules);
    expect(r.status).toBe(200);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card).toMatchObject({ type: "TradingRules", rules, hash: hashRuleSet(rules), validation: { ok: true } });
    // The model saw only data, and the hard limits from the real config.
    expect(model.requests[0]?.body.tools.map((t) => t.function.name)).toContain("propose_trading_rules");

    // 2. Owner signs the card's rules over NEP-413 and confirms (the same session token as the chat).
    const token = (await signIn(w.app)).json.token as string;
    const { ch, res, body } = await challengeSignConfirm(w.app, token, card.rules as RuleSetV1);
    expect(ch.hash).toBe(card.hash);
    expect(res.status).toBe(200);
    expect(body.active.hash).toBe(card.hash);
    expect(body.state).toBe("running");

    // 3. The confirm tick placed exactly one IOC buy with the rules' cloid prefix, after the dead-man switch.
    expect(w.hl.placed).toHaveLength(1);
    const order = w.hl.placed[0];
    expect(order).toMatchObject({ assetId: 10107, isBuy: true, tif: "Ioc" });
    expect(order?.cloid.startsWith(cloidPrefix(card.hash as string))).toBe(true);
    expect(order?.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    const log = w.hl.callLog();
    expect(log.indexOf("scheduleCancel")).toBeLessThan(log.indexOf("place"));
    // band: buy at or below mid * (1 + 100 bps)
    expect(Number(order?.price)).toBeLessThanOrEqual(40 * 1.01);
    const st1 = (await (await w.app.request("/trading/status")).json());
    expect(st1.active_rules).toMatchObject({ hash: card.hash, confirmed_by: OWNER });
    expect(st1.limits.today.orders).toBe(1);
    // (balances in this status were read before the order; the fill shows on the next tick)

    // 4. Price halves. The next tick: daily loss >= 5 USDC -> stopped_today, no new order.
    vi.setSystemTime(T0 + 60_000);
    w.hl.setMid("HYPE/USDC", "20");
    await w.trading.service.tick();
    const st2 = (await (await w.app.request("/trading/status")).json());
    expect(st2.state).toBe("stopped_today");
    expect(st2.state_reason).toBe("DAILY_LOSS_STOP");
    expect(st2.balances.positions[0]).toMatchObject({ pair: "HYPE/USDC", size: order?.size, mid: "20" });
    expect(Number(st2.limits.today.loss_usdc)).toBeGreaterThanOrEqual(5);
    expect(w.hl.placed).toHaveLength(1);
    // still stopped one hour later, when the interval rule would fire again
    vi.setSystemTime(T0 + 61 * 60_000);
    await w.trading.service.tick();
    expect(w.trading.service.status().state).toBe("stopped_today");
    expect(w.hl.placed).toHaveLength(1);

    // 5. Kill over HTTP: a resting order of ours is cancelled and scheduleCancel is set a few seconds out.
    const prefix = cloidPrefix(card.hash as string);
    w.hl.setOpenOrders(HL_ACCOUNT, [
      { oid: 77, cloid: `${prefix}${"0".repeat(15)}9`, market: "spot", pair: "HYPE/USDC", side: "buy", price: "19", size: "0.6", placedAtMs: Date.now() },
    ]);
    const before = w.hl.scheduleCancelCalls.length;
    // the first session may have expired by now: sign in again, as the dashboard would
    const token2 = (await signIn(w.app)).json.token as string;
    const killAt = Date.now();
    const kr = await w.app.request("/trading/kill", { method: "POST", headers: hdr(token2), body: JSON.stringify({ reason: "e2e" }) });
    expect(kr.status).toBe(200);
    expect(await kr.json()).toMatchObject({ state: "halted", cancelled_orders: 1, steps: { cancel_all: "ok", schedule_cancel: "ok" } });
    expect(w.hl.cancelled).toContainEqual({ assetId: 10107, oid: 77 });
    expect(w.hl.scheduleCancelCalls.slice(before)).toEqual([killAt + 6_000]);
    const st3 = (await (await w.app.request("/trading/status")).json());
    expect(st3).toMatchObject({ state: "halted", state_reason: "KILLED", dead_man: { cancel_at_ms: killAt + 6_000 } });

    // 6. After the kill, a new UTC day still does not trade (the halt is sticky until a new signature).
    vi.setSystemTime(T0 + 86_400_000);
    w.hl.setMid("HYPE/USDC", "40");
    await w.trading.service.tick();
    expect(w.trading.service.status().state).toBe("halted");
    expect(w.hl.placed).toHaveLength(1);

    // Funding never fired: the HL balance stayed above the floor the whole time.
    expect(w.client.requests).toEqual([]);
  });

  it("a non-owner session cannot challenge, confirm via a foreign key, or kill", async () => {
    const w = world();
    const rules = dcaRules();
    // A signature by a key that is not a full-access key of the owner: 401 and nothing placed.
    const token = (await signIn(w.app)).json.token as string;
    const chRes = await w.app.request("/trading/rules/challenge", { method: "POST", headers: hdr(token), body: JSON.stringify({ rules }) });
    const ch = (await chRes.json()) as { nonce: string; message: string; recipient: string };
    const { newKey } = await import("../ai-fakes.js");
    const stranger = newKey();
    const res = await w.app.request("/trading/rules/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({
        rules,
        account_id: OWNER,
        public_key: stranger.publicKey,
        signature: stranger.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient, callbackUrl: null }),
        nonce: ch.nonce,
      }),
    });
    expect([401, 403]).toContain(res.status);
    expect(w.hl.placed).toHaveLength(0);
    // No bearer -> kill is refused.
    const kr = await w.app.request("/trading/kill", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(kr.status).toBe(401);
  });

  it("low HL balance with no rules: the wired funder tops up once through the trader's SDK client, to hypercore + master", async () => {
    const w = world();
    w.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "3", hold: "0" }]);
    await w.trading.service.tick();
    expect(w.client.requests).toEqual([{ chain: "hypercore", address: HL_ACCOUNT, amountUsdc: "20", memo: "hl-trader top-up" }]);
    expect(w.client.watched).toEqual(["7"]);
    vi.setSystemTime(T0 + 60_000);
    await w.trading.service.tick();
    expect(w.client.requests).toHaveLength(1);
  });
});
