/**
 * Assistant side of ADR-0006: `/ai/chat` takes `trading_bot` ("new" or a bot id) from the dashboard, and the trading card carries
 * `bot: { id, name, is_new }` filled by the worker, never by the model. Plus the shared NEP-413 message vectors.
 */
/* Test-only: SSE events and tool results are asserted as loosely typed JSON. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiRouter } from "../../src/ai/route.js";
import type { AiDeps } from "../../src/ai/route.js";
import { AiInfo } from "../../src/ai/info.js";
import { stubPairInfoProvider } from "../../src/ai/trading.js";
import { openRegistry } from "../../src/trading/bots.js";
import { confirmationMessage, hashRuleSet } from "../../src/trading/rules/canonical.js";
import { chat, FakeChain, FakeModelServer, NOW, ownerKey, VAULT } from "../ai-fakes.js";
import { dcaRules } from "./harness.js";
import { HARD, PAIRS, tmpDir } from "./fixtures.js";

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

function setup(maxBots = 3) {
  const registry = openRegistry(tmpDir());
  const chain = new FakeChain();
  const d: AiDeps = {
    config: { apiKey: "k", model: "m", baseUrl: model.url, vault: VAULT, network: "testnet", rateLimitPerMin: 100, maxMessages: 10, maxMessageChars: 500, timeoutMs: 10_000, trustProxy: true, sessionSecret: "s".repeat(40) },
    view: chain.view,
    info: new AiInfo({ baseUrl: model.url, apiKey: "k", model: "m" }),
    now: () => NOW,
    usdcAsset: () => Promise.resolve(null),
    accessKey: (acc, pk) => Promise.resolve(chain.accessKeys[`${acc}|${pk}`] ?? (acc === "owner.test.near" && pk === ownerKey.publicKey ? "full" : "none")),
    trading: { hard: HARD, pairs: stubPairInfoProvider(PAIRS), bots: { registry, maxBots } },
  };
  return { registry, app: new Hono().route("/ai", createAiRouter(d)) };
}
const propose = (rules: unknown = dcaRules()) => {
  model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules } }] }, { text: "Please review and sign." }];
};
const cardsOf = (r: Awaited<ReturnType<typeof chat>>): any[] => r.events.filter((e) => e.event === "proposal").map((e) => (e.data as any).proposal);
const toolResult = (): any => JSON.parse(model.requests.at(-1)?.body.messages.filter((m) => m.role === "tool").at(-1)?.content ?? "{}");

describe("/ai/chat trading_bot", () => {
  it('"new": the card says it is a new strategy and carries an id derived from the rule set name', async () => {
    const { app } = setup();
    propose();
    const r = await chat(app, "buy HYPE every hour", { trading_bot: "new" });
    expect(r.status).toBe(200);
    const [card] = cardsOf(r);
    expect(card).toMatchObject({ type: "TradingRules", bot: { id: "dca", name: "DCA", is_new: true }, hash: hashRuleSet(dcaRules()), validation: { ok: true } });
  });

  it("an existing bot id: the card says it changes that bot and shows ITS name", async () => {
    const { app, registry } = setup();
    registry.activate({ botId: "alpha", hash: "a".repeat(64), name: "Alpha strategy", maxBots: 3 }, NOW);
    propose();
    const [card] = cardsOf(await chat(app, "change the size", { trading_bot: "alpha" }));
    expect(card.bot).toEqual({ id: "alpha", name: "Alpha strategy", is_new: false });
    expect(card.validation.ok).toBe(true);
  });

  it("the model cannot pick the bot: a bot field in the tool arguments is not read and not in the schema", async () => {
    const { app } = setup();
    propose();
    await chat(app, "x", { trading_bot: "new" });
    const tool = model.requests[0]?.body.tools.find((t) => t.function.name === "propose_trading_rules");
    expect(Object.keys(((tool?.function as unknown as { parameters: { properties: object } }).parameters).properties)).toEqual(["rules"]);
    model.rounds = [{ calls: [{ name: "propose_trading_rules", args: { rules: dcaRules(), bot: "other", bot_id: "other" } }] }, { text: "ok" }];
    const [card] = cardsOf(await chat(app, "x", { trading_bot: "new" }));
    expect(card.bot).toMatchObject({ id: "dca", is_new: true });
  });

  it("an unknown or archived bot gives the model an error and no card; the owner is told to pick another", async () => {
    const { app, registry } = setup();
    propose();
    expect(cardsOf(await chat(app, "x", { trading_bot: "ghost" }))).toEqual([]);
    expect(toolResult().errors.join(" ")).toMatch(/does not exist/);
    registry.activate({ botId: "old", hash: "b".repeat(64), name: "Old", maxBots: 3 }, NOW);
    registry.archive("old", NOW);
    propose();
    expect(cardsOf(await chat(app, "x", { trading_bot: "old" }))).toEqual([]);
    expect(toolResult().errors.join(" ")).toMatch(/archived/);
  });

  it("a bot-level refusal makes the card red (MAX_BOTS, RULES_USED_BY_OTHER_BOT) instead of failing silently", async () => {
    const { app, registry } = setup(1);
    registry.activate({ botId: "one", hash: hashRuleSet(dcaRules()), name: "One", maxBots: 1 }, NOW);
    propose({ ...dcaRules(), name: "Another" });
    const [full] = cardsOf(await chat(app, "x", { trading_bot: "new" }));
    expect(full.bot.is_new).toBe(true);
    expect(full.validation.ok).toBe(false);
    expect(full.validation.errors.join(" ")).toContain("MAX_BOTS");
    const { app: app2, registry: reg2 } = setup(3);
    reg2.activate({ botId: "one", hash: hashRuleSet(dcaRules()), name: "One", maxBots: 3 }, NOW);
    propose(); // the exact rules of bot one, proposed for a new bot
    const [dup] = cardsOf(await chat(app2, "x", { trading_bot: "new" }));
    expect(dup.validation.ok).toBe(false);
    expect(dup.validation.errors.join(" ")).toContain("RULES_USED_BY_OTHER_BOT");
  });

  it("the id of a new bot is deduplicated against existing and archived ids", async () => {
    const { app, registry } = setup();
    registry.activate({ botId: "dca", hash: "c".repeat(64), name: "Taken", maxBots: 3 }, NOW);
    registry.archive("dca", NOW);
    propose();
    const [card] = cardsOf(await chat(app, "x", { trading_bot: "new" }));
    expect(card.bot.id).toBe("dca-2");
  });

  it("no trading_bot (client from before bots): targets 'default' when it exists, else a new bot", async () => {
    const { app, registry } = setup();
    propose();
    expect(cardsOf(await chat(app, "x"))[0].bot).toMatchObject({ is_new: true });
    registry.activate({ botId: "default", hash: "d".repeat(64), name: "Default", maxBots: 3 }, NOW);
    propose();
    expect(cardsOf(await chat(app, "x"))[0].bot).toEqual({ id: "default", name: "Default", is_new: false });
  });

  it("trading_bot is validated: only bot ids / 'new' pass", async () => {
    const { app } = setup();
    propose();
    for (const bad of ["UPPER", "has space", "a".repeat(17), "../x", ""]) {
      expect((await chat(app, "x", { trading_bot: bad })).status, bad).toBe(400);
    }
    expect((await chat(app, "x", { trading_bot: "new" })).status).toBe(200);
  });

  it("the system prompt tells the model it cannot choose the bot", async () => {
    const { app } = setup();
    propose();
    await chat(app, "x", { trading_bot: "new" });
    const sys = model.requests[0]?.body.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys).toMatch(/cannot choose or switch the bot/);
  });
});

describe("shared NEP-413 message vectors (docs/trading-rules-vectors.json)", () => {
  interface Case {
    input: { vault: string; agentId: string; hlNetwork: "mainnet" | "testnet"; hlAccount: string; botId?: string; rulesSha256: string };
    message: string;
  }
  const v = JSON.parse(readFileSync(new URL("../../../docs/trading-rules-vectors.json", import.meta.url), "utf8")) as { messages: { v2: Case[]; v1_legacy: Case[] } };

  it("v2 messages have the bot line right after the agent line", () => {
    expect(v.messages.v2.length).toBeGreaterThanOrEqual(3);
    for (const c of v.messages.v2) {
      expect(confirmationMessage(c.input)).toBe(c.message);
      expect(c.message.split("\n")[3]).toBe(`bot: ${c.input.botId}`);
    }
  });
  it("the legacy v1 message has no bot line", () => {
    for (const c of v.messages.v1_legacy) {
      expect(confirmationMessage(c.input)).toBe(c.message);
      expect(c.message).not.toContain("bot:");
    }
  });
  it("the account address is lower-cased in the message", () => {
    for (const c of [...v.messages.v2, ...v.messages.v1_legacy]) expect(c.message).toContain(`hl_account: ${c.input.hlAccount.toLowerCase()}`);
  });
});
