/**
 * Second code review of the multi-bot change: lost registry, owner actions while the state is unusable, archive race and
 * position evidence, journal-before-state, copy-on-write registry, state schema checks. No money moves (FakeHl).
 */
/* Test-only: persisted JSON is asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RegistryError, openRegistry } from "../../src/trading/bots.js";
import { RulesConfirmer } from "../../src/trading/confirm.js";
import type { Rule, RuleSetV1 } from "../../src/trading/types.js";
import { harness } from "./harness.js";
import { HL_ACCOUNT, tmpDir } from "./fixtures.js";

const dca = (id = "dca"): Rule => ({ id, pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } });
const rulesOf = (name: string, rules: Rule[] = [dca()]): RuleSetV1 => ({
  version: 1,
  name,
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "40", max_order_usdc: "12", daily_loss_stop_usdc: "5", max_orders_per_day: 10 },
  rules,
});
type H = ReturnType<typeof harness>;
const funded = (dir?: string): H => {
  const h = harness(dir === undefined ? {} : { dir });
  h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  return h;
};
const step = async (h: H, ms = 60_000): Promise<void> => {
  h.clock.t += ms;
  await h.service.tick();
};
const j = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
/** The harness confirmer has no service guard; this one is wired like production (index.ts). */
const guarded = (h: H): RulesConfirmer =>
  new RulesConfirmer({ ctx: h.confirmer["d"].ctx, store: h.store, registry: h.service.registry, maxBots: 3, getPairInfo: () => h.confirmer["d"].getPairInfo(), writeBlocked: () => h.service.writeBlockedReason(), now: () => h.clock.t });
const files = (dir: string, prefix: string): string[] => readdirSync(dir).filter((f) => f.startsWith(prefix));

/** A directory with one bot `alpha` that traded once. */
async function tradedDir(): Promise<string> {
  const a = funded();
  await a.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
  await step(a);
  return a.dir;
}

describe("1. a lost bots.json cannot make an old bot id reusable", () => {
  it("start is fatal when engine-state knows a bot the registry lacks; nothing trades", async () => {
    const dir = await tradedDir();
    rmSync(join(dir, "bots.json"));
    const b = funded(dir);
    await b.service.tick();
    expect(b.service.status()).toMatchObject({ state: "error", state_reason: "STATE_CORRUPT" });
    expect(b.service.status().state_detail).toMatch(/alpha/);
    expect(b.hl.placed).toHaveLength(0);
    await expect(b.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha again")).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(dir, "bots.json"))).toBe(false); // nothing was recreated
  });

  it("start is fatal when only an order-id map value (oidBot) names an unknown bot", async () => {
    const dir = await tradedDir();
    const st = j(join(dir, "engine-state.json"));
    st.oidBot["777"] = "ghost";
    writeFileSync(join(dir, "engine-state.json"), JSON.stringify(st));
    const b = funded(dir);
    expect(b.service.writeBlockedReason()).toMatch(/ghost/);
  });

  it("check() rejects an id that exists in the engine state, even if the registry does not list it", () => {
    const reg = openRegistry(tmpDir());
    reg.reserveStateIds(() => ["alpha"]);
    expect(() => reg.check({ botId: "alpha", hash: "a".repeat(64), name: "Alpha", maxBots: 3 })).toThrow(expect.objectContaining({ code: "BOT_ID_IN_USE" }) as RegistryError);
    expect(reg.suggestId("alpha")).toBe("alpha-2");
    expect(() => reg.check({ botId: "beta", hash: "b".repeat(64), name: "Beta", maxBots: 3 })).not.toThrow();
  });

  it("a v1 state of a worker that never had rules still migrates (its pristine default block is not a lost bot)", async () => {
    const h = funded();
    await h.service.tick();
    expect(h.service.writeBlockedReason()).toBeNull();
  });
});

describe("2. owner actions are refused while the service is fatal; corrupt files are kept; kill still records its halt", () => {
  it("corrupt engine-state: confirm / rename / archive refused, file untouched, a copy kept", async () => {
    const dir = tmpDir();
    const bad = '{"version":2,"account":';
    writeFileSync(join(dir, "engine-state.json"), bad);
    const h = funded(dir);
    await expect(guarded(h).challenge(rulesOf("X strategy"), "x", "X")).rejects.toMatchObject({ status: 409, code: "SERVICE_STATE_UNUSABLE" });
    expect(() => h.service.rename("x", "Y")).toThrow(expect.objectContaining({ status: 409, code: "STATE_CORRUPT" }) as Error);
    await expect(h.service.archive("x")).rejects.toMatchObject({ status: 409, code: "STATE_CORRUPT" });
    expect(readFileSync(join(dir, "engine-state.json"), "utf8")).toBe(bad);
    const copies = files(dir, "engine-state.corrupt.");
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0] as string), "utf8")).toBe(bad);
    // a second start with the same content does not pile up copies
    funded(dir);
    expect(files(dir, "engine-state.corrupt.")).toHaveLength(1);
  });

  it("corrupt bots.json: a copy is kept, the file is never overwritten, owner writes are refused", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "bots.json"), "{nope");
    const h = funded(dir);
    await expect(guarded(h).challenge(rulesOf("X strategy"), "x", "X")).rejects.toMatchObject({ code: "SERVICE_STATE_UNUSABLE" });
    expect(() => h.service.registry.activate({ botId: "x", hash: "c".repeat(64), name: "X", maxBots: 3 }, 1)).toThrow(expect.objectContaining({ code: "REGISTRY_UNUSABLE" }) as Error);
    expect(readFileSync(join(dir, "bots.json"), "utf8")).toBe("{nope");
    expect(files(dir, "bots.corrupt.")).toHaveLength(1);
  });

  it("kill with an unreadable state records the halt in halt-marker.json, leaves the state file alone, and the next good start honours it", async () => {
    const dir = tmpDir();
    const bad = "{ broken";
    writeFileSync(join(dir, "engine-state.json"), bad);
    const h = funded(dir);
    const k = await h.service.kill("test");
    expect(k.steps.state_saved).toBe("ok");
    expect(readFileSync(join(dir, "engine-state.json"), "utf8")).toBe(bad);
    expect(j(join(dir, "halt-marker.json")).halts).toHaveLength(1);
    // operator fixes the state file (here: removes it) and restarts: the kill is still in force
    rmSync(join(dir, "engine-state.json"));
    const h2 = funded(dir);
    expect(h2.service.writeBlockedReason()).toBeNull();
    expect(h2.service.status().state).toBe("halted");
    expect(j(join(dir, "engine-state.json")).account.halt.reason).toBe("KILLED");
    expect(existsSync(join(dir, "halt-marker.json"))).toBe(false);
    await h2.service.tick();
    expect(h2.hl.placed).toHaveLength(0);
  });

  it("kill of one bot with an unreadable state is recorded too, for that bot only", async () => {
    const dir = await tradedDir();
    const good = readFileSync(join(dir, "engine-state.json"), "utf8");
    writeFileSync(join(dir, "engine-state.json"), "garbage");
    const h = funded(dir);
    const r = await h.service.killBot("alpha", "x");
    expect(r.steps.state_saved).toBe("ok");
    expect(readFileSync(join(dir, "engine-state.json"), "utf8")).toBe("garbage");
    writeFileSync(join(dir, "engine-state.json"), good);
    const h2 = funded(dir);
    expect(h2.service.botsList(false).find((b) => b.id === "alpha")?.state).toBe("halted");
    expect(h2.service.status().state).not.toBe("halted"); // the account itself was not killed
  });

  it("an unreadable halt marker is fatal (fail closed) and is kept", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "halt-marker.json"), "oops");
    const h = funded(dir);
    expect(h.service.writeBlockedReason()).toMatch(/halt-marker/);
    expect(files(dir, "halt-marker.corrupt.")).toHaveLength(1);
  });
});

describe("3. archive: the bot is stopped before the wait, and the position is checked again afterwards", () => {
  it("a tick that starts while archive is cancelling cannot place an order for the bot", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await step(h); // fill folded; position is 11.6 USDC
    h.hl.setMid("HYPE/USDC", "30"); // below the 10 USDC archive limit
    h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "88", hold: "0" }, { coin: "HYPE", total: "0.29", hold: "0" }]);
    await step(h);
    const placedBefore = h.hl.placed.length;
    // hold the cancel step open (getOpenOrders is the first call of cancelWhere) and tick inside the window
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const orig = h.hl.getOpenOrders.bind(h.hl);
    let entered: () => void = () => undefined;
    const inWindow = new Promise<void>((r) => {
      entered = r;
    });
    let first = true;
    h.hl.getOpenOrders = async (a: string) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return orig(a);
    };
    const p = h.service.archive("alpha");
    await inWindow;
    h.clock.t += 2 * 3_600_000; // the dca rule is due again
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(placedBefore);
    h.hl.getOpenOrders = orig;
    release();
    await p;
    expect(h.service.registry.get("alpha")?.archived_at_ms).not.toBeNull();
  });

  it("a fill that lands after the first check is found by the re-check; the refusal leaves the bot HALTED (audit ML1: never back to trading)", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha"); // order placed, its fill not folded in yet
    await expect(h.service.archive("alpha")).rejects.toMatchObject({ status: 409, code: "BOT_HOLDS_POSITION" });
    expect(h.service.registry.get("alpha")?.archived_at_ms).toBeNull();
    const placed = h.hl.placed.length;
    await step(h, 3_600_000);
    expect(h.hl.placed).toHaveLength(placed);
    expect(h.service.botsList(false).find((b) => b.id === "alpha")?.state).toBe("halted");
    const st = j(join(h.dir, "engine-state.json"));
    expect(st.bots.alpha.halt).toMatchObject({ reason: "KILLED" });
  });
});

describe("4. archive needs priced evidence of the position", () => {
  it("no tick since start: position unknown", async () => {
    const dir = await tradedDir();
    const b = funded(dir);
    await expect(b.service.archive("alpha")).rejects.toMatchObject({ status: 409, code: "POSITION_UNKNOWN" });
    expect(b.service.registry.get("alpha")?.archived_at_ms).toBeNull();
  });

  it("a tick without mids (unpriced view) does not let a holding bot through", async () => {
    const dir = await tradedDir();
    const b = funded(dir);
    b.hl.getMids = () => Promise.reject(new Error("hl down"));
    await step(b);
    await expect(b.service.archive("alpha")).rejects.toMatchObject({ status: 409, code: "POSITION_UNKNOWN" });
    expect(b.service.registry.get("alpha")?.archived_at_ms).toBeNull();
    expect(b.service.botsList(false).find((x) => x.id === "alpha")?.state).not.toBe("archived");
  });
});

describe("5. fills reach the journal before the state when an order is about to be placed", () => {
  it("at the moment of the second order the first order's fill is already journaled", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    expect(h.service.botFills("alpha", {}).fills).toHaveLength(0);
    h.clock.t += 3_600_000 + 60_000;
    let seen = -1;
    const place = h.hl.placeSpotOrder.bind(h.hl);
    h.hl.placeSpotOrder = (...a: Parameters<typeof place>) => {
      seen = h.service.botFills("alpha", {}).fills.length;
      return place(...a);
    };
    await h.service.tick();
    expect(seen).toBe(1);
    expect(h.service.botFills("alpha", {}).fills).toHaveLength(2 - 1 + (h.hl.placed.length - 2)); // no duplicates after the tick's own journal pass
  });
});

describe("6. the registry changes memory only after the disk write succeeded", () => {
  /** Makes the next write of bots.json fail: the rename target is a non-empty directory. */
  const breakWrites = (dir: string): void => {
    rmSync(join(dir, "bots.json"), { force: true });
    mkdirSync(join(dir, "bots.json"));
    writeFileSync(join(dir, "bots.json", "keep"), "x");
  };

  it("activate / rename / archive failing to persist change nothing", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    const before = JSON.stringify(h.service.registry.list());
    breakWrites(h.dir);
    expect(() => h.service.registry.activate({ botId: "beta", hash: "d".repeat(64), name: "Beta", maxBots: 3 }, 5)).toThrow();
    expect(() => h.service.registry.activate({ botId: "alpha", hash: "e".repeat(64), maxBots: 3 }, 5)).toThrow();
    expect(() => h.service.registry.rename("alpha", "Renamed")).toThrow();
    expect(() => h.service.registry.archive("alpha", 5)).toThrow();
    expect(JSON.stringify(h.service.registry.list())).toBe(before);
  });

  it("a confirmation whose registry write fails is an error and the engine keeps trading the old hash", async () => {
    const h = funded();
    const env1 = await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    breakWrites(h.dir);
    await expect(h.confirmDirect(rulesOf("Alpha strategy v2", [dca("dca2")]), "alpha")).rejects.toBeDefined();
    expect(h.service.registry.get("alpha")?.active_hash).toBe(env1.hash);
    expect(h.service.registry.get("alpha")?.hashes).toHaveLength(1);
  });
});

describe("state schema: wrong types in the v2 file are fatal", () => {
  const cases: [string, (st: any) => void][] = [
    ["account.day", (st) => (st.account.day = { dayIndex: "x" })],
    ["account.ordersToday", (st) => (st.account.ordersToday = "3")],
    ["account.stoppedDayIndex", (st) => (st.account.stoppedDayIndex = "yesterday")],
    ["account.stopReason", (st) => (st.account.stopReason = "BECAUSE")],
    ["bot.ordersToday", (st) => (st.bots.alpha.ordersToday = -1)],
    ["bot.stoppedDayIndex", (st) => (st.bots.alpha.stoppedDayIndex = "x")],
    ["bot.stopReason", (st) => (st.bots.alpha.stopReason = "EQUITY_DROP")],
    ["bot.startPositions", (st) => (st.bots.alpha.startPositions = { "HYPE/USDC": { size: 1, mid: "2" } })],
    ["bot.filledOidsToday", (st) => (st.bots.alpha.filledOidsToday = ["a"])],
  ];
  it.each(cases)("%s", async (_n, mutate) => {
    const dir = await tradedDir();
    const st = j(join(dir, "engine-state.json"));
    mutate(st);
    writeFileSync(join(dir, "engine-state.json"), JSON.stringify(st));
    expect(funded(dir).service.writeBlockedReason()).toMatch(/unreadable/);
  });

  it("a file written by the engine itself passes", async () => {
    const dir = await tradedDir();
    expect(funded(dir).service.writeBlockedReason()).toBeNull();
  });
});

describe("suggestions", () => {
  it("archive with an incomplete fill history succeeds with a warning", async () => {
    const dir = await tradedDir();
    const st = j(join(dir, "engine-state.json"));
    st.bots.alpha.agg.totalComplete = false;
    writeFileSync(join(dir, "engine-state.json"), JSON.stringify(st));
    const b = funded(dir);
    const r = await b.service.archive("alpha");
    expect(r.warning).toMatch(/incomplete/);
    expect(r.bot.state).toBe("archived");
  });

  it("archive of a clean bot has no warning field", async () => {
    const h = funded();
    await h.confirmDirect(rulesOf("Idle strategy", [{ id: "idle", pair: "HYPE/USDC", when: { type: "price", op: "gte", usdc: "9999" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } }, cooldown: "1d" }]), "idle", "Idle");
    const r = await h.service.archive("idle");
    expect("warning" in r).toBe(false);
  });

  it("status.limits.effective says whose limits it shows", async () => {
    const h = funded();
    expect(h.service.status().limits.effective_bot_id).toBeNull();
    await h.confirmDirect(rulesOf("Alpha strategy"), "alpha", "Alpha");
    await h.confirmDirect(rulesOf("Beta strategy"), "beta", "Beta");
    expect(h.service.status().limits.effective_bot_id).toBe("alpha");
    await h.confirmDirect(rulesOf("Default strategy"), "default", "Default");
    expect(h.service.status().limits.effective_bot_id).toBe("default");
  });
});
