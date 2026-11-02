import { beforeEach, describe, expect, it } from "vitest";
import { ConfirmError, RulesConfirmer } from "../../src/trading/confirm.js";
import type { Challenge } from "../../src/trading/confirm.js";
import { hashRuleSet } from "../../src/trading/rules/canonical.js";
import { type BotRegistry, openRegistry } from "../../src/trading/bots.js";
import { RulesStore } from "../../src/trading/store.js";
import type { RuleSetV1 } from "../../src/trading/types.js";
import { newKey } from "../ai-fakes.js";
import { baseRules, freshNear, makeCtx, ownerKeyPair, OWNER, PAIRS, tmpDir, VAULT } from "./fixtures.js";
import type { FakeNear } from "./fixtures.js";

let now = 1_800_000_000_000;
let near: FakeNear;
let store: RulesStore;
let registry: BotRegistry;
let dir: string;
let c: RulesConfirmer;
const loadActive = async (ctx = makeCtx(near)) => {
  const b = registry.get("default");
  return b === undefined ? ({ status: "none" } as const) : store.loadBot(b, ctx, { legacyV1Hash: registry.legacyV1()?.hash ?? null });
};
let pairsDown = false;
let pairsLive: typeof PAIRS = PAIRS;

beforeEach(() => {
  now = 1_800_000_000_000;
  near = freshNear();
  pairsDown = false;
  pairsLive = PAIRS;
  dir = tmpDir();
  registry = openRegistry(dir);
  store = new RulesStore(dir, () => now);
  c = new RulesConfirmer({ ctx: makeCtx(near), store, registry, maxBots: 3, getPairInfo: () => (pairsDown ? Promise.reject(new Error("hl")) : Promise.resolve(pairsLive)), now: () => now });
});

function sign(ch: Challenge, rules: RuleSetV1, o: { key?: typeof ownerKeyPair; account?: string; callback?: string | null; message?: string } = {}) {
  const key = o.key ?? ownerKeyPair;
  const nonce = Buffer.from(ch.nonce, "base64");
  return {
    rules,
    account_id: o.account ?? OWNER,
    public_key: key.publicKey,
    signature: key.signNep413({ message: o.message ?? ch.message, nonce, recipient: VAULT, callbackUrl: o.callback ?? null }),
    nonce: ch.nonce,
    ...(o.callback ? { callback_url: o.callback } : {}),
  };
}
async function fails(p: Promise<unknown>, code: string, status?: number) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ConfirmError);
  expect((e as ConfirmError).code).toBe(code);
  if (status) expect((e as ConfirmError).status).toBe(status);
}

describe("challenge", () => {
  it("returns the exact ADR message, hash, recipient and 5 min expiry", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    expect(Buffer.from(ch.nonce, "base64")).toHaveLength(32);
    expect(ch.hash).toBe(hashRuleSet(rules));
    expect(ch.recipient).toBe(VAULT);
    expect(ch.expires_at).toBe(now + 5 * 60_000);
    expect(ch.message).toBe(
      ["Agent Treasury: activate trading rules", `vault: ${VAULT}`, "agent: hl-trader", "bot: default", "hl_network: testnet", "hl_account: 0xabcdef0123456789abcdef0123456789abcdef01", `rules_sha256: ${ch.hash}`].join("\n"),
    );
  });
  it("rejects invalid rules, over-limit rules and unreachable HL data", async () => {
    await fails(c.challenge({ nope: 1 }), "RULES_INVALID", 400);
    const over = baseRules();
    over.limits.max_order_usdc = "21";
    await fails(c.challenge(over), "RULES_INVALID", 400);
    pairsDown = true;
    await fails(c.challenge(baseRules()), "HL_UNAVAILABLE", 502);
  });
});

describe("confirm", () => {
  it("valid signature by the owner's full-access key: stored and active", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const { env, bot } = await c.confirm(sign(ch, rules));
    expect(bot).toMatchObject({ id: "default", active_hash: ch.hash });
    expect(env).toMatchObject({ hash: ch.hash, account_id: OWNER, message: ch.message, callback_url: null, confirmed_at_ms: now });
    const loaded = await loadActive();
    expect(loaded.status).toBe("ok");
  });

  it("accepts a signed callback_url, rejects a swapped one and a non-http one", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const body = sign(ch, rules, { callback: "https://app.example/cb" });
    await fails(c.confirm({ ...body, callback_url: "https://evil.example/cb" }), "BAD_SIGNATURE", 401);
    const ch2 = await c.challenge(rules);
    await fails(c.confirm({ ...(sign(ch2, rules)), callback_url: "javascript:alert(1)" }), "BAD_REQUEST", 400);
    const ch3 = await c.challenge(rules);
    expect((await c.confirm(sign(ch3, rules, { callback: "https://app.example/cb" }))).env.callback_url).toBe("https://app.example/cb");
  });

  it("replay: a nonce works once, even after a failed attempt", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const body = sign(ch, rules);
    await c.confirm(body);
    await fails(c.confirm(body), "UNKNOWN_NONCE", 401);
    const ch2 = await c.challenge(rules);
    await fails(c.confirm({ ...(sign(ch2, rules, { key: newKey() })), public_key: ownerKeyPair.publicKey }), "BAD_SIGNATURE");
    await fails(c.confirm(sign(ch2, rules)), "UNKNOWN_NONCE");
  });

  it("expired and never-issued nonces", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    now += 5 * 60_000 + 1;
    await fails(c.confirm(sign(ch, rules)), "UNKNOWN_NONCE", 401);
    const forged = { ...(sign(ch, rules)), nonce: Buffer.alloc(32, 7).toString("base64") };
    await fails(c.confirm(forged), "UNKNOWN_NONCE");
  });

  it("different rules than the challenge was issued for", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const other = baseRules();
    other.name = "Swapped";
    await fails(c.confirm(sign(ch, other)), "HASH_MISMATCH", 400);
  });

  it("wrong signed message (hash of other rules inside the message)", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    await fails(c.confirm(sign(ch, rules, { message: ch.message.replace(ch.hash, "0".repeat(64)) })), "BAD_SIGNATURE", 401);
  });

  it("function-call key, unknown key, non-owner", async () => {
    const rules = baseRules();
    near.keys[`${OWNER}|${ownerKeyPair.publicKey}`] = "limited";
    await fails(c.confirm(sign(await c.challenge(rules), rules)), "NOT_FULL_ACCESS", 401);
    const k = newKey();
    await fails(c.confirm(sign(await c.challenge(rules), rules, { key: k })), "NOT_FULL_ACCESS", 401);
    near.keys[`mallory.near|${k.publicKey}`] = "full";
    await fails(c.confirm(sign(await c.challenge(rules), rules, { key: k, account: "mallory.near" })), "NOT_OWNER", 403);
  });

  it("live pair data is re-checked at confirm time", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    pairsLive = {};
    await fails(c.confirm(sign(ch, rules)), "RULES_INVALID", 400);
  });

  it("RPC failure is a 502 and nothing is stored", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    near.rpcDown = true;
    await fails(c.confirm(sign(ch, rules)), "RPC_ERROR", 502);
    near.rpcDown = false;
    expect((await loadActive()).status).toBe("none");
    expect(registry.get("default")).toBeUndefined(); // a failed confirm creates no bot
  });

  it("malformed bodies", async () => {
    await fails(c.confirm({ rules: baseRules(), account_id: 1, public_key: "x", signature: "y", nonce: "z" }), "BAD_REQUEST", 400);
    await fails(c.confirm({ rules: baseRules(), account_id: OWNER, public_key: "x", signature: "y", nonce: "short" }), "BAD_ENCODING", 400);
  });
});


describe("bots (ADR-0006)", () => {
  const confirmFor = async (rules: RuleSetV1, botId: string, botName?: string, o: Parameters<typeof sign>[2] = {}) => {
    const ch = await c.challenge(rules, botId, botName);
    return c.confirm({ ...sign(ch, rules, o), bot_id: botId, ...(botName ? { bot_name: botName } : {}) });
  };
  const named = (name: string): RuleSetV1 => ({ ...baseRules(), name });

  it("the challenge message names the bot (v2) and the vectors in docs/ agree", async () => {
    const ch = await c.challenge(baseRules(), "dip-buyer", "Dip buyer");
    expect(ch.message.split("\n")[3]).toBe("bot: dip-buyer");
    expect(ch).toMatchObject({ bot_id: "dip-buyer", is_new: true });
  });

  it("a new bot exists only after a valid signature; an unconfirmed challenge creates nothing", async () => {
    await c.challenge(baseRules(), "alpha", "Alpha");
    expect(registry.get("alpha")).toBeUndefined();
    await fails(c.confirm({ ...sign(await c.challenge(baseRules(), "alpha", "Alpha"), baseRules(), { key: newKey() }), bot_id: "alpha", bot_name: "Alpha" }), "NOT_FULL_ACCESS");
    expect(registry.get("alpha")).toBeUndefined();
    const { bot } = await confirmFor(baseRules(), "alpha", "Alpha");
    expect(bot).toMatchObject({ id: "alpha", name: "Alpha", archived_at_ms: null });
    expect(registry.get("alpha")?.hashes).toHaveLength(1);
  });

  it("a nonce issued for (hash, bot A) cannot activate bot B", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules, "a-bot", "A");
    await fails(c.confirm({ ...sign(ch, rules), bot_id: "b-bot", bot_name: "B" }), "BOT_MISMATCH", 400);
    expect(registry.get("b-bot")).toBeUndefined();
    expect(registry.get("a-bot")).toBeUndefined();
  });

  it("a message signed for another bot id is refused: MESSAGE_MISMATCH on load", async () => {
    const { env } = await confirmFor(baseRules(), "a-bot", "A");
    // re-label the stored envelope as bot b: the signature covers "bot: a-bot"
    const b = { ...(registry.get("a-bot") as NonNullable<ReturnType<BotRegistry["get"]>>), id: "b-bot" };
    const r = await store.loadBot(b, makeCtx(near));
    expect(env.bot_id).toBe("a-bot");
    expect(r).toMatchObject({ status: "refused", code: "MESSAGE_MISMATCH" });
  });

  it("MAX_BOTS, BOT_ARCHIVED, RULES_USED_BY_OTHER_BOT, BAD_BOT_ID", async () => {
    await confirmFor(named("One"), "one", "One");
    await confirmFor(named("Two"), "two", "Two");
    await confirmFor(named("Three"), "three", "Three");
    await fails(c.challenge(named("Four"), "four", "Four"), "MAX_BOTS", 409);
    registry.archive("three", now);
    await confirmFor(named("Four"), "four", "Four"); // archiving freed a slot
    await fails(c.challenge(named("Three again"), "three", "Three"), "BOT_ARCHIVED", 409);
    await fails(c.challenge(named("One"), "two", "Two"), "RULES_USED_BY_OTHER_BOT", 409);
    await fails(c.challenge(baseRules(), "Bad Id!", "x"), "BAD_BOT_ID", 400);
    await fails(c.challenge(baseRules(), "new", "x"), "BAD_BOT_ID", 400); // reserved for the dashboard's "new strategy"
    await fails(c.challenge(named("Five")), "MAX_BOTS", 409); // no bot_id = default, which does not exist yet
  });

  it("a bot name is required for a new bot; an existing bot keeps its name", async () => {
    await fails(c.challenge(baseRules(), "named", "   "), "BOT_NAME_REQUIRED", 400);
    await confirmFor(baseRules(), "named", "Mine");
    const second = named("Second");
    await confirmFor(second, "named", "Ignored rename");
    expect(registry.get("named")?.name).toBe("Mine");
    expect(registry.get("named")?.hashes).toHaveLength(2);
  });

  it("CLOID_PREFIX_TAKEN: a different hash with the same 8-byte prefix", async () => {
    await confirmFor(baseRules(), "a-bot", "A");
    const a = registry.get("a-bot") as NonNullable<ReturnType<BotRegistry["get"]>>;
    const rules = named("Collider");
    const hash = hashRuleSet(rules);
    // Force a collision: register this rule set's prefix under another hash for bot a-bot.
    a.hashes.push({ prefix: `0x${hash.slice(0, 16)}`, hash: "f".repeat(64), activated_at_ms: now });
    expect(() => registry.check({ botId: "other", hash, name: "x", maxBots: 3 })).toThrow(/same order-id prefix/);
    expect(() => registry.check({ botId: "a-bot", hash, name: "x", maxBots: 3 })).toThrow(/same order-id prefix/);
  });

  it("TOO_MANY_RULE_SETS: 64 activations per bot, re-signing a known one is still fine", async () => {
    const first = await confirmFor(named("S0"), "many", "Many");
    for (let i = 1; i < 64; i++) {
      const n = named(`S${i}`);
      registry.activate({ botId: "many", hash: hashRuleSet(n), name: "Many", maxBots: 3 }, now + i);
    }
    expect(registry.get("many")?.hashes).toHaveLength(64);
    await fails(c.challenge(named("S64"), "many"), "TOO_MANY_RULE_SETS", 409);
    const again = await c.challenge(named("S0"), "many");
    expect(again.hash).toBe(first.env.hash);
  });
});
