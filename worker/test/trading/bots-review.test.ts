/**
 * Independent review tests for ADR-0006 (multi-bot): a kill of one bot that lands while ANOTHER bot is in the middle of the
 * tick, confirm v2 binding (wrong bot id in the signed message, a nonce replayed for another bot, a confirm-time race for the
 * same rules), and archive refusals around the 10 USDC position rule. Real service, store, registry, confirmer and router;
 * FakeHl simulates the exchange; no money moves, no real keys.
 *
 * Tests named "BUG: ..." reproduce defects; they are skipped unless (bug tests unskipped) (then they fail until the bug is fixed).
 */
/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfirmError } from "../../src/trading/confirm.js";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { confirmationMessage, hashRuleSet } from "../../src/trading/rules/canonical.js";
import type { HlOrderResult, HlPlaceOrder, Rule, RuleSetV1 } from "../../src/trading/types.js";
import { harness } from "./harness.js";
import { HL_ACCOUNT, ownerKeyPair, OWNER, VAULT } from "./fixtures.js";

const H = 3_600_000;
type Harness = ReturnType<typeof harness>;

const dca = (id = "dca", usdc = "12"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc }, order: { type: "ioc" } } });
const limitBuy = (id = "lim"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "2", ttl: "4h" } } });
const idle = (): Rule => ({ id: "idle", pair: "HYPE/USDC", when: { type: "price", op: "gte", usdc: "9999" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } }, cooldown: "1d" });
const rulesOf = (name: string, rules: Rule[] = [dca()]): RuleSetV1 => ({
  version: 1,
  name,
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "40", max_order_usdc: "12", daily_loss_stop_usdc: "5", max_orders_per_day: 10 },
  rules,
});
const pre = (name: string, rules?: Rule[]): string => cloidPrefix(hashRuleSet(rulesOf(name, rules)));
const funded = (): Harness => {
  const h = harness();
  h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  return h;
};
const step = async (h: Harness, ms = 60_000): Promise<void> => {
  h.clock.t += ms;
  await h.service.tick();
};
const openPrefixes = (h: Harness): string[] => (h.hl.openOrders[HL_ACCOUNT.toLowerCase()] ?? []).map((o) => (o.cloid ?? "").slice(0, 18));

/** Holds the HL answer of the n-th placeSpotOrder call (1-based, counted from now) until `release()`. */
function holdPlacement(h: Harness, n = 1): { reached: Promise<HlPlaceOrder>; release: () => void } {
  const orig = h.hl.placeSpotOrder.bind(h.hl);
  let count = 0;
  let release: () => void = () => undefined;
  let reachedResolve: (o: HlPlaceOrder) => void = () => undefined;
  const reached = new Promise<HlPlaceOrder>((r) => (reachedResolve = r));
  const gate = new Promise<void>((r) => (release = r));
  h.hl.placeSpotOrder = async (o: HlPlaceOrder): Promise<HlOrderResult> => {
    count += 1;
    const res = orig(o);
    if (count === n) {
      reachedResolve(o);
      await gate;
    }
    return res;
  };
  return {
    reached,
    release: () => {
      release();
    },
  };
}

describe("kill one bot while ANOTHER bot is mid-tick", () => {
  it("beta is killed while alpha's order is in flight: alpha's order completes, beta places nothing, beta's halt survives the tick's state write", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy"), "beta", "Beta");
    const before = h.hl.placed.length;
    h.clock.t += H; // both DCA rules are due; alpha (created first) is evaluated first
    const g = holdPlacement(h, 1);
    const tickP = h.service.tick();
    const first = await g.reached;
    expect(first.cloid.startsWith(pre("Alpha strategy"))).toBe(true);
    const killP = h.service.killBot("beta", "mid-tick");
    g.release();
    const [, kill] = await Promise.all([tickP, killP]);
    expect(kill).toMatchObject({ bot_id: "beta", state: "halted", steps: { state_saved: "ok" } });
    const fresh = h.hl.placed.slice(before);
    expect(fresh.map((o) => o.cloid.slice(0, 18))).toEqual([pre("Alpha strategy")]);
    // the tick's result was written after the kill: the kill must still be in the persisted state
    const st = JSON.parse(readFileSync(join(h.dir, "engine-state.json"), "utf8"));
    expect(st.bots.beta.halt).toMatchObject({ reason: "KILLED" });
    expect(st.bots.alpha.halt).toBeNull();
    expect(st.account.halt).toBeNull();
    expect(h.service.status().bots).toEqual([
      { id: "alpha", name: "Alpha", state: "running" },
      { id: "beta", name: "Beta", state: "halted" },
    ]);
    // later ticks: alpha keeps trading, beta stays halted
    await step(h, H + 60_000);
    expect(h.hl.placed.slice(before).filter((o) => o.cloid.startsWith(pre("Beta strategy")))).toHaveLength(0);
    expect(h.hl.placed.slice(before).filter((o) => o.cloid.startsWith(pre("Alpha strategy")))).toHaveLength(2);
  });

  it("alpha is killed while ITS OWN resting order is in flight: the order is cancelled by the kill after the tick, beta's resting order is untouched", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy", [idle()]), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy", [idle()]), "beta", "Beta");
    // swap in limit rules by confirming new rule sets (fresh hashes, new prefixes)
    await h.confirmDirect(rulesOf("Alpha limit", [limitBuy()]), "alpha");
    // beta's limit order rests first (separate tick) so that the next tick only has alpha's order in flight
    await h.confirmDirect(rulesOf("Beta limit", [limitBuy()]), "beta");
    expect(openPrefixes(h).sort()).toEqual([pre("Alpha limit", [limitBuy()]), pre("Beta limit", [limitBuy()])].sort());
    // next hour both are due again; hold alpha's placement and kill alpha meanwhile
    h.clock.t += H;
    const g = holdPlacement(h, 1);
    const tickP = h.service.tick();
    const o = await g.reached;
    expect(o.cloid.startsWith(pre("Alpha limit", [limitBuy()]))).toBe(true);
    const schedBefore = h.hl.scheduleCancelCalls.length;
    const killP = h.service.killBot("alpha");
    g.release();
    const [, kill] = await Promise.all([tickP, killP]);
    // both of alpha's resting orders (the old one and the one that was in flight) are gone; beta's two remain
    expect(kill.cancelled_orders).toBe(2);
    expect(openPrefixes(h).every((p) => p === pre("Beta limit", [limitBuy()]))).toBe(true);
    expect(openPrefixes(h)).toHaveLength(2);
    // the dead-man switch was not pulled forward by a single-bot kill
    expect(h.hl.scheduleCancelCalls.slice(schedBefore).some((t) => t !== null && t <= h.clock.t + 10_000)).toBe(false);
    expect(h.service.status().state).toBe("running");
  });

  it("a kill of the LAST running bot mid-tick leaves the account 'halted' in status, and a later tick does not trade", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy"), "beta", "Beta");
    await h.service.killBot("beta");
    const before = h.hl.placed.length;
    h.clock.t += H;
    const g = holdPlacement(h, 1);
    const tickP = h.service.tick();
    await g.reached;
    const killP = h.service.killBot("alpha");
    g.release();
    await Promise.all([tickP, killP]);
    expect(h.hl.placed.slice(before)).toHaveLength(1); // the order that was already in flight
    await step(h, H + 60_000);
    expect(h.hl.placed.slice(before)).toHaveLength(1);
    expect(h.service.status().bots.map((b) => b.state)).toEqual(["halted", "halted"]);
    expect(h.service.status().state).toBe("halted");
  });
});

describe("confirm v2: bot binding and replay", () => {
  const sign = (message: string, nonce: string) => ownerKeyPair.signNep413({ message, nonce: Buffer.from(nonce, "base64"), recipient: VAULT, callbackUrl: null });
  const body = (rules: RuleSetV1, nonce: string, signature: string, botId?: string, botName?: string) => ({
    rules,
    account_id: OWNER,
    public_key: ownerKeyPair.publicKey,
    signature,
    nonce,
    ...(botId === undefined ? {} : { bot_id: botId }),
    ...(botName === undefined ? {} : { bot_name: botName }),
  });
  const code = async (p: Promise<unknown>): Promise<string> => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ConfirmError);
    return (e as ConfirmError).code;
  };
  const msgFor = (rules: RuleSetV1, botId?: string): string =>
    confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL_ACCOUNT, rulesSha256: hashRuleSet(rules), ...(botId === undefined ? {} : { botId }) });

  it("a signature over the message for ANOTHER bot id is refused (BAD_SIGNATURE) and creates nothing", async () => {
    const h = funded();
    const rules = rulesOf("Alpha strategy", [idle()]);
    const ch = await h.confirmer.challenge(rules, "alpha", "Alpha");
    expect(ch.message).toBe(msgFor(rules, "alpha"));
    // the owner's wallet was shown (or tricked into) the message for bot "beta"
    expect(await code(h.confirmer.confirm(body(rules, ch.nonce, sign(msgFor(rules, "beta"), ch.nonce), "alpha", "Alpha")))).toBe("BAD_SIGNATURE");
    expect(h.service.registry.get("alpha")).toBeUndefined();
    expect(h.service.registry.get("beta")).toBeUndefined();
  });

  it("the same, claiming bot beta in the body: BOT_MISMATCH (the nonce is bound to alpha)", async () => {
    const h = funded();
    const rules = rulesOf("Alpha strategy", [idle()]);
    const ch = await h.confirmer.challenge(rules, "alpha", "Alpha");
    expect(await code(h.confirmer.confirm(body(rules, ch.nonce, sign(msgFor(rules, "beta"), ch.nonce), "beta", "Beta")))).toBe("BOT_MISMATCH");
    expect(h.service.registry.list()).toEqual([]);
  });

  it("a nonce that activated bot alpha cannot be replayed for bot beta (with beta's correctly signed message)", async () => {
    const h = funded();
    const rules = rulesOf("Shared strategy", [idle()]);
    const ch = await h.confirmer.challenge(rules, "alpha", "Alpha");
    await h.confirmer.confirm(body(rules, ch.nonce, sign(ch.message, ch.nonce), "alpha", "Alpha"));
    expect(h.service.registry.get("alpha")?.active_hash).toBe(ch.hash);
    const other = rulesOf("Other strategy", [idle()]);
    expect(await code(h.confirmer.confirm(body(other, ch.nonce, sign(msgFor(other, "beta"), ch.nonce), "beta", "Beta")))).toBe("UNKNOWN_NONCE");
    expect(await code(h.confirmer.confirm(body(rules, ch.nonce, sign(msgFor(rules, "beta"), ch.nonce), "beta", "Beta")))).toBe("UNKNOWN_NONCE");
    expect(h.service.registry.get("beta")).toBeUndefined();
  });

  it("a v1 message (no bot line) signed with a fresh nonce is refused for every bot, including 'default'", async () => {
    const h = funded();
    const rules = rulesOf("Legacy strategy", [idle()]);
    for (const id of ["default", "alpha"]) {
      const ch = await h.confirmer.challenge(rules, id, "X");
      expect(await code(h.confirmer.confirm(body(rules, ch.nonce, sign(msgFor(rules), ch.nonce), id, "X")))).toBe("BAD_SIGNATURE");
    }
    expect(h.service.registry.list()).toEqual([]);
  });

  it("two open challenges for the same rules (alpha and beta): the first confirm wins, the second is refused at confirm time (RULES_USED_BY_OTHER_BOT)", async () => {
    const h = funded();
    const rules = rulesOf("Same rules", [idle()]);
    const a = await h.confirmer.challenge(rules, "alpha", "Alpha");
    const b = await h.confirmer.challenge(rules, "beta", "Beta");
    await h.confirmer.confirm(body(rules, a.nonce, sign(a.message, a.nonce), "alpha"));
    expect(await code(h.confirmer.confirm(body(rules, b.nonce, sign(b.message, b.nonce), "beta")))).toBe("RULES_USED_BY_OTHER_BOT");
    expect(h.service.registry.get("beta")).toBeUndefined();
    // the stored envelope still belongs to alpha (beta's refused confirm did not overwrite it)
    const env = JSON.parse(readFileSync(join(h.dir, "rules", `${a.hash}.json`), "utf8"));
    expect(env.bot_id).toBe("alpha");
    expect(await h.service.loadRules("alpha")).not.toBeNull();
  });

  it("over HTTP: confirm for bot beta with alpha's nonce is 400 BOT_MISMATCH, and a second use of the nonce is 401", async () => {
    const h = funded();
    const rules = rulesOf("Http strategy", [idle()]);
    const chRes = await h.app.request("/trading/rules/challenge", { method: "POST", headers: h.authed(), body: JSON.stringify({ rules, bot_id: "alpha", bot_name: "Alpha" }) });
    const ch = (await chRes.json()) as { nonce: string; message: string };
    const send = (b: unknown) => h.app.request("/trading/rules/confirm", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(b) });
    const r1 = await send(body(rules, ch.nonce, sign(msgFor(rules, "beta"), ch.nonce), "beta", "Beta"));
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ code: "BOT_MISMATCH" });
    const r2 = await send(body(rules, ch.nonce, sign(ch.message, ch.nonce), "alpha", "Alpha"));
    expect(r2.status).toBe(401); // consumed by the first (failed) attempt
    expect(h.service.registry.list()).toEqual([]);
  });
});

describe("archive and the 10 USDC position rule", () => {
  /** One bot that bought `usdc` worth at mid 40 and whose fill has been read by a later tick. */
  async function holding(usdc: string): Promise<Harness> {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy", [dca("dca", usdc)]), "alpha", "Alpha");
    await step(h); // the fill is read now
    return h;
  }

  it("exactly 10 USDC of coins is refused (>= 10), just under is allowed", async () => {
    const h = await holding("12"); // 12 USDC at 40.4 (band) = 0.29 HYPE (2 size decimals)
    const pos = (await h.service.botDetail("alpha")).positions[0];
    expect(pos?.size).toBe("0.29");
    h.hl.setMid("HYPE/USDC", "34.482759"); // 0.29 x 34.482759 = 10.00000011
    await step(h);
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ status: 409, code: "BOT_HOLDS_POSITION" });
    h.hl.setMid("HYPE/USDC", "34.48"); // 9.9992
    await step(h);
    await expect(h.service.archive("alpha")).resolves.toMatchObject({ bot: { state: "archived" } });
  });

  it("a refused archive changes nothing: no order cancelled, the bot keeps trading, the registry is untouched (HTTP 409)", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy", [dca(), limitBuy()]), "alpha", "Alpha");
    await step(h);
    expect(openPrefixes(h)).toHaveLength(1);
    const res = await h.app.request("/trading/bots/alpha/archive", { method: "POST", headers: h.authed(), body: "{}" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "BOT_HOLDS_POSITION" });
    expect(openPrefixes(h)).toHaveLength(1);
    expect(h.service.registry.get("alpha")).toMatchObject({ archived_at_ms: null, active_hash: expect.any(String) });
    const before = h.hl.placed.length;
    await step(h, H);
    expect(h.hl.placed.length).toBeGreaterThan(before);
  });

  it("coins held by hand (or by another bot) do not block archiving a bot that owns none", async () => {
    const h = funded();
    h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "2", hold: "0" }]);
    await h.confirmDirect(rulesOf("Idle strategy", [idle()]), "idle", "Idle");
    await step(h);
    await expect(h.service.archive("idle")).resolves.toMatchObject({ bot: { state: "archived" } });
  });

  it("archive right after the bot's own buy filled is allowed (12 USDC held): the position view lags one tick - service.ts archive() checks the last tick's BotView, which predates that tick's own fill", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha"); // the confirm tick places and fills a 12 USDC buy
    expect(h.hl.placed).toHaveLength(1);
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ status: 409, code: "BOT_HOLDS_POSITION" });
  });

  it("archive after a tick whose HL read failed is allowed although the bot holds 12 USDC: the view values positions at mid 0 - engine/tick.ts finish() per-bot views (mids null) + service.ts archive() (no `priced` check)", async () => {
    const h = await holding("12");
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ code: "BOT_HOLDS_POSITION" }); // control: refused
    h.hl.failNext("getMids");
    await step(h);
    expect(h.service.status().state_reason).toBe("HL_READ_FAILED");
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ status: 409 });
  });
});
