/**
 * Fixes for docs/security/audit-2026-11-03-multibot.md: MM1 (new-vs-update race), MM2 (a Stop invalidates open challenges),
 * ML1 (failed archive keeps the bot halted), ML2 (kill whose state write fails still writes the halt marker), ML8 (no API-wallet
 * rotation while the state is unusable). Real service/store/registry/confirmer, FakeHl; no money moves.
 */
/* Test-only: persisted JSON is asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rule, RuleSetV1 } from "../../src/trading/types.js";
import { harness } from "./harness.js";
import { HL_ACCOUNT, ownerKeyPair, OWNER, tmpDir, VAULT } from "./fixtures.js";

const H = 3_600_000;
type Harness = ReturnType<typeof harness>;
const dca = (usdc = "12"): Rule => ({ id: "dca", pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc }, order: { type: "ioc" } } });
const rs = (name: string): RuleSetV1 => ({ version: 1, name, pairs: ["HYPE/USDC"], limits: { max_position_usdc: "40", max_order_usdc: "12", daily_loss_stop_usdc: "5", max_orders_per_day: 10 }, rules: [dca()] });
const funded = (dir?: string): Harness => {
  const h = harness(dir === undefined ? {} : { dir });
  h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  return h;
};

async function signAndConfirm(h: Harness, rules: RuleSetV1, ch: { nonce: string; message: string }, botId: string, botName?: string) {
  const { env, bot } = await h.confirmer.confirm({
    bot_id: botId,
    ...(botName ? { bot_name: botName } : {}),
    rules,
    account_id: OWNER,
    public_key: ownerKeyPair.publicKey,
    signature: ownerKeyPair.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: VAULT, callbackUrl: null }),
    nonce: ch.nonce,
  });
  await h.service.activated(env, bot.id);
  return { env, bot };
}

describe("MM1: a 'new strategy' challenge never becomes an update", () => {
  it("the second of two open challenges for the same new id is refused with BOT_ID_TAKEN and the first bot keeps its rules", async () => {
    const h = funded();
    const a = rs("Strategy A");
    const b = rs("Strategy B");
    const chA = await h.confirmer.challenge(a, "dca", "DCA");
    const chB = await h.confirmer.challenge(b, "dca", "DCA");
    expect(chA.is_new).toBe(true);
    expect(chB.is_new).toBe(true);
    const first = await signAndConfirm(h, a, chA, "dca", "DCA");
    await expect(signAndConfirm(h, b, chB, "dca", "DCA")).rejects.toMatchObject({ status: 409, code: "BOT_ID_TAKEN" });
    expect(h.service.registry.list()).toHaveLength(1);
    expect(h.service.registry.get("dca")?.active_hash).toBe(first.env.hash);
    // the owner can still update it on purpose: a fresh challenge says is_new: false
    const chB2 = await h.confirmer.challenge(b, "dca");
    expect(chB2.is_new).toBe(false);
    const upd = await signAndConfirm(h, b, chB2, "dca");
    expect(h.service.registry.get("dca")?.active_hash).toBe(upd.env.hash);
  });
});

describe("MM2: a Stop invalidates open challenges", () => {
  it("a challenge issued before kill-all and confirmed after it is refused; the account stays halted", async () => {
    const h = funded();
    await h.confirmDirect(rs("Alpha"), "alpha", "Alpha");
    const v2 = rs("Alpha v2");
    const ch = await h.confirmer.challenge(v2, "alpha");
    await h.service.kill("panic");
    await expect(signAndConfirm(h, v2, ch, "alpha")).rejects.toMatchObject({ status: 409, code: "KILLED_SINCE_CHALLENGE" });
    expect(h.service.status().state).toBe("halted");
    const placed = h.hl.placed.length;
    h.clock.t += H;
    await h.service.tick();
    expect(h.service.status().state).toBe("halted");
    expect(h.hl.placed).toHaveLength(placed);
    // a challenge requested after the Stop is a deliberate resume and works
    const ch2 = await h.confirmer.challenge(v2, "alpha");
    await signAndConfirm(h, v2, ch2, "alpha");
  });

  it("kill of ONE bot invalidates that bot's challenges only", async () => {
    const h = funded();
    await h.confirmDirect(rs("Alpha"), "alpha", "Alpha");
    await h.confirmDirect(rs("Beta"), "beta", "Beta");
    const a2 = rs("Alpha v2");
    const b2 = rs("Beta v2");
    const chA = await h.confirmer.challenge(a2, "alpha");
    const chB = await h.confirmer.challenge(b2, "beta");
    await h.service.killBot("alpha", "stop alpha");
    await expect(signAndConfirm(h, a2, chA, "alpha")).rejects.toMatchObject({ status: 409, code: "KILLED_SINCE_CHALLENGE" });
    await expect(signAndConfirm(h, b2, chB, "beta")).resolves.toBeDefined();
  });

  it("a kill that lands while the challenge is still being prepared also invalidates it", async () => {
    const h = funded();
    await h.confirmDirect(rs("Alpha"), "alpha", "Alpha");
    const v2 = rs("Alpha v2");
    const pending = h.confirmer.challenge(v2, "alpha");
    await h.service.kill("during");
    const ch = await pending;
    await expect(signAndConfirm(h, v2, ch, "alpha")).rejects.toMatchObject({ code: "KILLED_SINCE_CHALLENGE" });
  });
});

describe("ML1: a refused archive leaves the bot halted", () => {
  it("TICK_BUSY after the halt does not put the bot back into trading", async () => {
    const h = funded();
    await h.confirmDirect(rs("Alpha"), "alpha", "Alpha"); // order placed, fill not folded in yet
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ status: 409 });
    expect(h.service.registry.get("alpha")?.archived_at_ms).toBeNull();
    const placed = h.hl.placed.length;
    h.clock.t += H;
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(placed);
    expect(h.service.botsList(false).find((b) => b.id === "alpha")?.state).toBe("halted");
    const st = JSON.parse(readFileSync(join(h.dir, "engine-state.json"), "utf8"));
    expect(st.bots.alpha.halt).toMatchObject({ reason: "KILLED" });
  });
});

describe("ML2: a kill whose state write fails still writes the halt marker", () => {
  it("kill-all and kill-bot", async () => {
    const h = funded();
    await h.confirmDirect(rs("Alpha"), "alpha", "Alpha");
    // engine-state.json becomes a directory: the atomic rename fails, the state is not fatal (it was loaded fine)
    rmSync(join(h.dir, "engine-state.json"));
    mkdirSync(join(h.dir, "engine-state.json"));
    const kb = await h.service.killBot("alpha", "x");
    expect(kb.steps.state_saved).toBe("failed");
    expect(JSON.parse(readFileSync(join(h.dir, "halt-marker.json"), "utf8")).halts).toMatchObject([{ bot_id: "alpha", reason: "KILLED" }]);
    const k = await h.service.kill("y");
    expect(k.steps.state_saved).toBe("failed");
    expect(JSON.parse(readFileSync(join(h.dir, "halt-marker.json"), "utf8")).halts).toMatchObject([{ bot_id: "alpha" }, { bot_id: null, reason: "KILLED" }]);
    // restart after the disk recovered: the kill is remembered
    rmSync(join(h.dir, "engine-state.json"), { recursive: true });
    const h2 = funded(h.dir);
    expect(h2.service.status().state).toBe("halted");
    expect(existsSync(join(h.dir, "halt-marker.json"))).toBe(false);
  });
});

describe("ML8: no API-wallet rotation while the state is unusable", () => {
  it("rotateApiWallet is refused with STATE_CORRUPT and the key is unchanged", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "engine-state.json"), "{ broken");
    const h = funded(dir);
    const before = h.wallet.load();
    await expect(h.service.rotateApiWallet()).rejects.toMatchObject({ status: 409, code: "STATE_CORRUPT" });
    expect(h.wallet.load()).toEqual(before);
  });
});
