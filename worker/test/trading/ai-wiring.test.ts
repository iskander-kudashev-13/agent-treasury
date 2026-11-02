import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiDeps, HYPERCORE_USDC_ASSET } from "../../src/ai/index.js";
import { createAiRouter } from "../../src/ai/route.js";
import type { AiDeps } from "../../src/ai/route.js";
import { AiInfo } from "../../src/ai/info.js";
import { stubPairInfoProvider } from "../../src/ai/trading.js";
import { loadConfig } from "../../src/config.js";
import { OneClickClient } from "../../src/oneclick.js";
import { SimulatedOneClient } from "../../src/oneclick-simulated.js";
import { createProposer, ProposeError } from "../../src/trading/propose.js";
import { chat, FakeChain, FakeModelServer, NOW, ownerKey, VAULT } from "../ai-fakes.js";
import { dcaRules } from "./harness.js";
import { HARD, PAIRS } from "./fixtures.js";

const model = new FakeModelServer();
beforeAll(async () => {
  await model.start();
});
afterAll(() => {
  model.stop();
});
beforeEach(() => {
  model.rounds = [];
  model.requests = [];
});

function deps(over: Partial<AiDeps> = {}, apiKey: string | undefined = "k"): AiDeps {
  const chain = new FakeChain();
  const config = {
    apiKey,
    model: "m",
    baseUrl: model.url,
    vault: VAULT,
    network: "testnet",
    rateLimitPerMin: 100,
    maxMessages: 10,
    maxMessageChars: 500,
    timeoutMs: 10_000,
    trustProxy: true,
    sessionSecret: "s".repeat(40),
  };
  return {
    config,
    view: chain.view,
    info: new AiInfo({ baseUrl: model.url, apiKey: config.apiKey, model: "m" }),
    now: () => NOW,
    usdcAsset: () => Promise.resolve(null),
    accessKey: (acc, pk) => Promise.resolve(chain.accessKeys[`${acc}|${pk}`] ?? (acc === "owner.test.near" && pk === ownerKey.publicKey ? "full" : "none")),
    ...over,
  };
}

describe("/ai/chat tool list", () => {
  const toolNames = async (d: AiDeps): Promise<string[]> => {
    const app = new Hono().route("/ai", createAiRouter(d));
    model.requests = [];
    model.rounds = [{ text: "hi" }];
    await chat(app, "hello");
    return model.requests[0]?.body.tools.map((t) => t.function.name) ?? [];
  };
  it("offers propose_trading_rules only when trading is wired", async () => {
    expect(await toolNames(deps())).not.toContain("propose_trading_rules");
    expect(await toolNames(deps({ trading: { hard: HARD, pairs: stubPairInfoProvider(PAIRS) } }))).toContain("propose_trading_rules");
  });
});

describe("createProposer (/trading/rules/propose backend)", () => {
  const authoring = { hard: HARD, pairs: stubPairInfoProvider(PAIRS) };
  it("returns rules, hash, validation and model from the tool card", async () => {
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: dcaRules() } }] }, { text: "done" }];
    const r = await createProposer(deps(), authoring)("buy HYPE for 12 USDC every hour", "owner.test.near", new AbortController().signal);
    expect(r.rules).toEqual(dcaRules());
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.validation.ok).toBe(true);
    expect(r.model).toBe("m");
    // only the trading tool is offered on this path
    expect(model.requests[0]?.body.tools.map((t) => t.function.name)).toEqual(["propose_trading_rules"]);
  });
  it("NO_PROPOSAL (400) when the model only talks", async () => {
    model.rounds = [{ text: "Which pair do you mean?" }];
    await expect(createProposer(deps(), authoring)("something", "owner.test.near", new AbortController().signal)).rejects.toMatchObject({ status: 400, code: "NO_PROPOSAL" });
  });
  it("AI_NOT_CONFIGURED (502) without an API key", async () => {
    await expect(createProposer(deps({}, undefined), authoring)("x", "owner.test.near", new AbortController().signal)).rejects.toBeInstanceOf(ProposeError);
  });
});

describe("hypercore USDC pin", () => {
  const cfg = loadConfig({ VAULT_CONTRACT_ID: VAULT, AI_SESSION_SECRET: "s".repeat(40) });
  it("is the hip1 asset, as in the SDK", () => {
    expect(HYPERCORE_USDC_ASSET).toBe("1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054");
  });
  it("simulated 1Click returns the pinned id", async () => {
    const ai = createAiDeps(cfg, new SimulatedOneClient({ outcome: "success" }));
    expect(await ai?.usdcAsset("hypercore")).toBe(HYPERCORE_USDC_ASSET);
  });
  it("live: the pinned id when 1Click lists it, never the erc20 USDC", async () => {
    const oc = new OneClickClient({ baseUrl: "http://127.0.0.1:1", apiKey: undefined, timeoutMs: 100 });
    const tok = (assetId: string, symbol = "USDC") => ({ assetId, symbol, blockchain: "hypercore", decimals: 8 });
    oc.getTokens = () => Promise.resolve([tok("nep141:hyperliquid-erc20-usdc.omft.near"), tok(HYPERCORE_USDC_ASSET)] as never);
    const ai = createAiDeps(cfg, oc);
    expect(await ai?.usdcAsset("hypercore")).toBe(HYPERCORE_USDC_ASSET);
    oc.getTokens = () => Promise.resolve([tok("nep141:hyperliquid-erc20-usdc.omft.near")] as never);
    expect(await ai?.usdcAsset("hypercore")).toBeNull();
  });
});
