/* Test-only: events and tool results are asserted as loosely typed JSON. */
/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runChat } from "../src/ai/chat.js";
import type { ChatEvent } from "../src/ai/events.js";
import { stubPairInfoProvider } from "../src/ai/trading.js";
import { buildTools } from "../src/ai/tools.js";
import { normalizeChain, checkAddress } from "../src/ai/chains.js";
import { systemPrompt } from "../src/ai/prompt.js";
import { hashRuleSet } from "../src/trading/rules/canonical.js";
import type { HardLimits, PairInfoMap, RuleSetV1 } from "../src/trading/types.js";
import { FakeChain, FakeModelServer, NOW, VAULT, OWNER } from "./ai-fakes.js";

const HARD: HardLimits = {
  maxPositionUsdc: "100",
  maxOrderUsdc: "25",
  dailyLossUsdc: "10",
  maxOrdersPerDay: 10,
  allowedPairs: ["HYPE/USDC", "PURR/USDC"],
  minPairVolumeUsdc: "100000",
  priceBandBps: 100,
};
const PAIRS: PairInfoMap = {
  "HYPE/USDC": { name: "HYPE/USDC", assetId: 10107, szDecimals: 2, volume24hUsdc: "5000000" },
  "PURR/USDC": { name: "PURR/USDC", assetId: 10000, szDecimals: 0, volume24hUsdc: "50" },
};

// ADR-0005 example sentence.
const SENTENCE = "buy HYPE for 10 USDC when price drops 3% in a day; never hold more than 40 USDC; stop if -5 USDC today";
const EXAMPLE: RuleSetV1 = {
  version: 1,
  name: "HYPE dip buyer",
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "40", max_order_usdc: "10", daily_loss_stop_usdc: "5", max_orders_per_day: 3 },
  rules: [{ id: "dip", pair: "HYPE/USDC", when: { type: "price_change", window: "1d", op: "lte", pct: "-3" }, action: { side: "buy", size: { usdc: "10" }, order: { type: "ioc" } }, cooldown: "1d" }],
};

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
  model.status = 200;
});

async function run(text: string, opts: { trading?: boolean; pairs?: PairInfoMap } = {}): Promise<ChatEvent[]> {
  const chain = new FakeChain();
  const tools = buildTools(opts.trading === false ? {} : { trading: { hard: HARD, pairs: stubPairInfoProvider(opts.pairs ?? PAIRS) } });
  const events: ChatEvent[] = [];
  const gen = runChat(
    { model: { baseUrl: model.url, apiKey: "k", model: "m" }, view: chain.view, tools, vault: VAULT, network: "testnet", now: () => NOW, usdcAsset: () => Promise.resolve(null) },
    [{ role: "user", content: text }],
    OWNER,
    new AbortController().signal,
  );
  for await (const e of gen) events.push(e);
  return events;
}
const cards = (evs: ChatEvent[]): any[] => evs.flatMap((e) => (e.type === "proposal" ? [e.proposal] : []));
const errs = (r: any): string => (r.errors as string[]).join(" ");
const toolResults = (): any[] => model.requests.at(-1)?.body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content ?? "{}")) ?? [];

describe("propose_trading_rules", () => {
  it("happy path: the ADR example becomes a TradingRules card with hash and plain-English lines", async () => {
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: EXAMPLE } }] }, { text: "I prepared the rules. Please review and sign them." }];
    const evs = await run(SENTENCE);
    const [card] = cards(evs);
    expect(cards(evs)).toHaveLength(1);
    expect(card).toMatchObject({
      type: "TradingRules",
      rules: EXAMPLE,
      hash: hashRuleSet(EXAMPLE),
      validation: { ok: true, errors: [], warnings: [expect.stringContaining("SIZE_NEAR_HL_MINIMUM")] },
      confirm: { kind: "nep413", challenge: "/trading/rules/challenge", endpoint: "/trading/rules/confirm" },
    });
    expect(card.call).toBeUndefined();
    expect(card.lines).toContain("Rule set: HYPE dip buyer");
    expect((card.lines as string[]).join("\n")).toContain("price change over 1 day is at or below -3%");
    expect(card.title).toBe("Trading rules: HYPE dip buyer");
    expect(evs.at(-1)?.type).toBe("done");
    // Offered to the model with the DSL as JSON schema and the live hard limits.
    const spec = model.requests[0]?.body.tools.find((t) => t.function.name === "propose_trading_rules") as any;
    expect(spec.function.description).toContain("max_order_usdc <= 25");
    expect(spec.function.parameters.properties.rules.properties.limits).toBeDefined();
    // The model got the hash back but nothing it could trade with.
    expect(toolResults()[0]).toMatchObject({ ok: true, hash: hashRuleSet(EXAMPLE), shown_to_owner: true });
  });

  it("invalid then corrected: hard-limit errors go back to the model, only the fixed card is shown", async () => {
    const tooBig = structuredClone(EXAMPLE);
    tooBig.limits.max_position_usdc = "500";
    model.rounds = [
      { calls: [{ name: "propose_trading_rules", args: { rules: tooBig } }] },
      { calls: [{ name: "propose_trading_rules", args: { rules: EXAMPLE } }] },
      { text: "Done." },
    ];
    const evs = await run(SENTENCE);
    const second = model.requests[1]?.body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content ?? "{}"))[0];
    expect(second.ok).toBe(false);
    expect(errs(second)).toContain("LIMIT_MAX_POSITION");
    expect(cards(evs)).toHaveLength(1);
    expect(cards(evs)[0].validation.ok).toBe(true);
  });

  it("structural errors are returned to the model as stable codes", async () => {
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: { ...EXAMPLE, leverage: 5 } } }] }, { text: "ok" }];
    const evs = await run(SENTENCE);
    expect(cards(evs)).toHaveLength(0);
    expect(errs(toolResults()[0])).toContain("UNKNOWN_KEY");
  });

  it("gives up after bounded rounds and shows the red card instead of looping", async () => {
    const bad = structuredClone(EXAMPLE);
    bad.limits.max_order_usdc = "99";
        model.rounds = [0, 1, 2, 3].map(() => ({ calls: [{ name: "propose_trading_rules", args: { rules: bad } }] }));
    model.rounds.push({ text: "That exceeds the limit." });
    const evs = await run(SENTENCE);
    const c = cards(evs);
    expect(c).toHaveLength(1);
    expect(c[0].validation.ok).toBe(false);
    expect(errs(c[0].validation)).toContain("LIMIT_MAX_ORDER");
  });

  it("a pair outside the allowed list or unknown to Hyperliquid is rejected", async () => {
    const btc = structuredClone(EXAMPLE);
    btc.pairs = ["BTC/USDC"];
    (btc.rules[0] as { pair: string }).pair = "BTC/USDC";
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: btc } }] }, { text: "BTC is not allowed." }];
    const evs = await run("buy BTC");
    expect(cards(evs)).toHaveLength(0);
    expect(errs(toolResults()[0])).toContain("PAIR_NOT_ALLOWED");
    // A perp-style name cannot even be expressed.
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: { ...EXAMPLE, pairs: ["BTC-PERP"] } } }] }, { text: "no" }];
    const evs2 = await run("long BTC perp 10x");
    expect(cards(evs2)).toHaveLength(0);
    expect(errs(toolResults()[0])).toContain("BAD_PAIR");
  });

  it("a pair that resolves to a perp asset id or has no pair data is rejected", async () => {
    const perp: PairInfoMap = { "HYPE/USDC": { name: "HYPE/USDC", assetId: 107, szDecimals: 2, volume24hUsdc: "5000000" } };
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: EXAMPLE } }] }, { text: "no" }];
    expect(cards(await run(SENTENCE, { pairs: perp }))).toHaveLength(0);
    expect(errs(toolResults()[0])).toContain("PAIR_PERP");
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: EXAMPLE } }] }, { text: "no" }];
    expect(cards(await run(SENTENCE, { pairs: {} }))).toHaveLength(0);
    expect(errs(toolResults()[0])).toContain("PAIR_UNKNOWN");
  });

  it("perps request: the model refuses in text and no card or tool call happens", async () => {
    model.rounds = [{ text: "I can only do spot trading on Hyperliquid, no perpetuals or leverage." }];
    const evs = await run("open a 10x long on BTC perp");
    expect(cards(evs)).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
    // The system prompt tells the model to refuse exactly this.
    const sys = model.requests[0]?.body.messages[0]?.content ?? "";
    expect(sys).toMatch(/REFUSE perpetuals, leverage/);
    expect(sys).toMatch(/Never invent a price/);
  });

  it("vague request: the model asks one question and the turn ends without a card", async () => {
    model.rounds = [{ calls: [{ name: "ask_question", args: { text: "How much USDC per buy?", options: ["10", "25"] } }] }];
    const evs = await run("buy HYPE when it dips");
    expect(evs.map((e) => e.type)).toEqual(["question", "done"]);
    expect(cards(evs)).toHaveLength(0);
  });

  it("the tool is absent when trading is not enabled, and its pair-data failure is not guessed around", async () => {
    model.rounds = [{ text: "hi" }];
    await run("hi", { trading: false });
    expect(model.requests[0]?.body.tools.map((t) => t.function.name)).not.toContain("propose_trading_rules");
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: EXAMPLE } }] }, { text: "try later" }];
    const chain = new FakeChain();
    const tools = buildTools({ trading: { hard: HARD, pairs: { getPairInfo: () => Promise.reject(new Error("HL down")) } } });
    const evs: ChatEvent[] = [];
    for await (const e of runChat({ model: { baseUrl: model.url, apiKey: "k", model: "m" }, view: chain.view, tools, vault: VAULT, network: "testnet", now: () => NOW, usdcAsset: () => Promise.resolve(null) }, [{ role: "user", content: "x" }], OWNER, new AbortController().signal)) evs.push(e);
    expect(cards(evs)).toHaveLength(0);
    expect(errs(toolResults()[0])).toContain("Could not load Hyperliquid pair data");
  });
});

describe("hypercore recipient chain", () => {
  it("is known to the recipient proposals with aliases and EVM address checks", () => {
    expect(normalizeChain("Hyperliquid")).toBe("hypercore");
    expect(normalizeChain("hypercore")).toBe("hypercore");
    expect(checkAddress("hypercore", "0xAb12Ab12Ab12Ab12Ab12Ab12Ab12Ab12Ab12Ab12")).toMatchObject({ ok: true, normalized: "0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12" });
    expect(checkAddress("hypercore", "nope").ok).toBe(false);
  });
  it("the prompt documents the trading rules section", () => {
    expect(systemPrompt({ nowMs: NOW, vault: VAULT, ownerAccount: OWNER, network: "testnet" })).toContain("propose_trading_rules");
  });
});
