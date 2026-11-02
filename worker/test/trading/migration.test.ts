/**
 * Migration of a state directory written by the single-bot worker (version 1 engine state, `active.json`, a v1-signed
 * envelope) to the multi-bot layout (ADR-0006): automatic, idempotent and lossless. The v1 files below have exactly the shape the
 * live testnet worker writes. No money moves: FakeHl only simulates balances.
 */
/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRegistry } from "../../src/trading/bots.js";
import { type EngineStateV1, initialEngineStateV1, migrateV1 } from "../../src/trading/engine/migrate.js";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { confirmationMessage, hashRuleSet } from "../../src/trading/rules/canonical.js";
import { TradingService } from "../../src/trading/service.js";
import { RulesStore } from "../../src/trading/store.js";
import type { ConfirmedRules, RuleSetV1 } from "../../src/trading/types.js";
import { dcaRules, harness, T0 } from "./harness.js";
import { freshNear, HL_ACCOUNT, makeCtx, ownerKeyPair, OWNER, tmpDir, VAULT } from "./fixtures.js";

const DAY_START = Date.UTC(2026, 10, 5, 0, 5, 0);
const j = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

/** A v1-signed envelope (message without the `bot:` line), as the old confirm wrote it. */
function v1Envelope(rules: RuleSetV1, confirmedAtMs: number): ConfirmedRules {
  const hash = hashRuleSet(rules);
  const message = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL_ACCOUNT, rulesSha256: hash });
  const nonce = Buffer.alloc(32, 9);
  return {
    rules,
    hash,
    message,
    signature: ownerKeyPair.signNep413({ message, nonce, recipient: VAULT, callbackUrl: null }),
    public_key: ownerKeyPair.publicKey,
    account_id: OWNER,
    nonce: nonce.toString("base64"),
    callback_url: null,
    confirmed_at_ms: confirmedAtMs,
  };
}

/** The v1 engine state of a worker that traded: one position, a cursor, remembered order ids and prefixes. */
function v1State(hash: string, extra: Partial<EngineStateV1> = {}): EngineStateV1 {
  const prefix = cloidPrefix(hash);
  const agg = { cash: "-20.2", dq: "0.5", fees: "0.01", lastPx: "40.4" };
  return {
    ...initialEngineStateV1(),
    rulesHash: hash,
    day: { dayIndex: Math.floor(DAY_START / 86_400_000), startEquity: "100", snapshotAtMs: DAY_START, startBackstop: "100", startPositions: { "HYPE/USDC": { size: "0.5", mid: "40" } } },
    ordersToday: 2,
    orderCounter: 7,
    firedAt: { dca: T0 - 2 * 3_600_000 },
    botPrefixes: ["0x" + "12".repeat(8), prefix],
    botOids: [11, 12],
    lastTickMs: T0 - 60_000,
    recent: [{ at_ms: T0 - 120_000, kind: "order", rule_id: "dca", detail: "buy 0.5 HYPE/USDC @ 40.4 Ioc: filled", cloid: `${prefix}0000000000000007`, oid: 12 }],
    fills: {
      cursorMs: DAY_START + 1000,
      seen: [{ k: "t12", t: DAY_START + 1000 }],
      totalComplete: true,
      completeFromMs: 0,
      todayFromMs: DAY_START,
      total: { "HYPE/USDC": agg },
      today: { "HYPE/USDC": agg },
      botFillsToday: 1,
      botOidsToday: [12],
      basis: { [prefix]: { "HYPE/USDC": { size: "0.5", cost: "20.2" } } },
      foreignFills: 3,
    },
    filledOrdersToday: 1,
    filledOidsToday: [12],
    ...extra,
  };
}

/** Writes a complete v1 state dir and returns what was written. */
function writeV1Dir(dir: string, extra: Partial<EngineStateV1> = {}, rules: RuleSetV1 = dcaRules()) {
  const env = v1Envelope(rules, T0 - 5 * 3_600_000);
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", `${env.hash}.json`), JSON.stringify(env));
  writeFileSync(join(dir, "active.json"), JSON.stringify({ hash: env.hash, activated_at_ms: T0 - 5 * 3_600_000 }));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ startMs: T0 - 3 * 86_400_000 }));
  writeFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at_ms: T0 - 120_000, kind: "order", rule_id: "dca", detail: "old order", cloid: "0x1" })}\n`);
  const state = v1State(env.hash, extra);
  writeFileSync(join(dir, "engine-state.json"), JSON.stringify(state));
  return { env, state, files: { engine: readFileSync(join(dir, "engine-state.json"), "utf8"), active: readFileSync(join(dir, "active.json"), "utf8") } };
}

const withFundedHl = (h: ReturnType<typeof harness>): void => {
  h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "80", hold: "0" }, { coin: "HYPE", total: "0.5", hold: "0" }]);
  h.hl.setApprovedAgents(HL_ACCOUNT, [{ address: h.address, name: "agent-treasury valid_until", validUntilMs: T0 + 30 * 86_400_000 }]);
};

describe("migrateV1 (pure)", () => {
  const hash = hashRuleSet(dcaRules());

  it("moves every per-rule field, the position and the order ids to bot 'default' and keeps the account fields", () => {
    const v1 = v1State(hash);
    const { state, prefixes } = migrateV1(v1);
    const d = state.bots["default"];
    expect(state.version).toBe(2);
    expect(d).toMatchObject({ rulesHash: hash, firedAt: v1.firedAt, ordersToday: 2, filledOrdersToday: 1, filledOidsToday: [12], halt: null, stoppedDayIndex: null });
    expect(d?.agg).toMatchObject({ totalComplete: true, botFillsToday: 1, botOidsToday: [12], total: v1.fills?.total, today: v1.fills?.today, basis: v1.fills?.basis });
    expect(d?.startPositions).toEqual({ "HYPE/USDC": { size: "0.5", mid: "40" } });
    expect(state.oidBot).toEqual({ "11": "default", "12": "default" });
    expect(state.account).toMatchObject({ day: v1.day, orderCounter: 7, ordersToday: 2, lastTickMs: v1.lastTickMs, recent: v1.recent });
    expect(state.account.fillCursor).toEqual({ cursorMs: DAY_START + 1000, seen: [{ k: "t12", t: DAY_START + 1000 }], completeFromMs: 0, todayFromMs: DAY_START, foreignFills: 3 });
    expect(prefixes).toEqual(["0x" + "12".repeat(8), cloidPrefix(hash)]);
  });

  it("a halt goes to the account AND to default", () => {
    const halt = { reason: "KILLED" as const, atMs: T0, detail: "kill switch: test" };
    const { state } = migrateV1(v1State(hash, { halt }));
    expect(state.account.halt).toEqual(halt);
    expect(state.bots["default"]?.halt).toEqual(halt);
  });

  it("a loss stop with DAILY_LOSS_STOP stays with default, EQUITY_DROP becomes the account's", () => {
    const day = v1State(hash).day?.dayIndex ?? 0;
    const a = migrateV1(v1State(hash, { stoppedDayIndex: day, stopReason: "DAILY_LOSS_STOP" })).state;
    expect(a.bots["default"]).toMatchObject({ stoppedDayIndex: day, stopReason: "DAILY_LOSS_STOP" });
    expect(a.account.stoppedDayIndex).toBeNull();
    const b = migrateV1(v1State(hash, { stoppedDayIndex: day, stopReason: "EQUITY_DROP" })).state;
    expect(b.account).toMatchObject({ stoppedDayIndex: day, stopReason: "EQUITY_DROP" });
    expect(b.bots["default"]?.stoppedDayIndex).toBeNull();
    // a stop without a recorded reason (oldest files) was the daily loss stop
    const c = migrateV1(v1State(hash, { stoppedDayIndex: day, stopReason: null })).state;
    expect(c.bots["default"]?.stopReason).toBe("DAILY_LOSS_STOP");
  });

  it("a partial history (totalComplete false) is kept as such: the bot will not sell until re-created", () => {
    const v1 = v1State(hash);
    if (v1.fills) {
      v1.fills.totalComplete = false;
      delete v1.fills.completeFromMs;
    }
    const { state } = migrateV1(v1);
    expect(state.bots["default"]?.agg.totalComplete).toBe(false);
    expect(state.account.fillCursor?.completeFromMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a v1 state without a tracker migrates to an empty default bot; does not mutate its input", () => {
    const v1 = v1State(hash, { fills: null });
    const copy = structuredClone(v1);
    const { state } = migrateV1(v1);
    expect(v1).toEqual(copy);
    expect(state.account.fillCursor).toBeNull();
    expect(state.bots["default"]?.agg.total).toEqual({});
  });
});

describe("registry migration (active.json -> bots.json)", () => {
  it("creates bot 'default' with the active hash, every remembered prefix and the legacy v1 hash; renames active.json", () => {
    const dir = tmpDir();
    const { env } = writeV1Dir(dir);
    const reg = openRegistry(dir, { legacyPrefixes: ["0x" + "12".repeat(8), cloidPrefix(env.hash)], startMs: T0 - 3 * 86_400_000 });
    const d = reg.get("default");
    expect(d).toMatchObject({ id: "default", name: "DCA", active_hash: env.hash, archived_at_ms: null, created_at_ms: T0 - 3 * 86_400_000 });
    expect(d?.hashes).toEqual([
      { prefix: "0x" + "12".repeat(8), hash: null, activated_at_ms: T0 - 5 * 3_600_000 },
      { prefix: cloidPrefix(env.hash), hash: env.hash, activated_at_ms: T0 - 5 * 3_600_000 },
    ]);
    expect(reg.legacyV1()).toEqual({ bot_id: "default", hash: env.hash });
    expect(existsSync(join(dir, "active.json"))).toBe(false);
    expect(existsSync(join(dir, "active.v1.json"))).toBe(true);
    expect(reg.prefixMap().get("0x" + "12".repeat(8))).toBe("default");
  });

  it("is idempotent: a second open changes nothing and never overwrites bots.json", () => {
    const dir = tmpDir();
    const { env } = writeV1Dir(dir);
    openRegistry(dir, { legacyPrefixes: [cloidPrefix(env.hash)] });
    const first = readFileSync(join(dir, "bots.json"), "utf8");
    const again = openRegistry(dir, { legacyPrefixes: ["0x" + "ff".repeat(8)] });
    expect(readFileSync(join(dir, "bots.json"), "utf8")).toBe(first);
    expect(again.get("default")?.hashes.map((h) => h.prefix)).toEqual([cloidPrefix(env.hash)]);
  });

  it("finishes a migration that crashed between writing bots.json and renaming active.json", () => {
    const dir = tmpDir();
    const { env } = writeV1Dir(dir);
    openRegistry(dir, { legacyPrefixes: [cloidPrefix(env.hash)] });
    copyFileSync(join(dir, "active.v1.json"), join(dir, "active.json")); // as if the rename never happened
    openRegistry(dir);
    expect(existsSync(join(dir, "active.json"))).toBe(false);
    expect(readFileSync(join(dir, "active.v1.json"), "utf8")).toContain(env.hash);
  });

  it("refuses (throws) on a malformed active.json instead of inventing a bot", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "active.json"), "{not json");
    expect(() => openRegistry(dir)).toThrow(/active\.json/);
    expect(existsSync(join(dir, "bots.json"))).toBe(false);
  });

  it("prefixes without an active rule set (rules were never confirmed or the file is gone) still create a draft default bot", () => {
    const dir = tmpDir();
    const reg = openRegistry(dir, { legacyPrefixes: ["0x" + "12".repeat(8)] });
    expect(reg.get("default")).toMatchObject({ active_hash: null });
    expect(reg.prefixMap().get("0x" + "12".repeat(8))).toBe("default");
  });

  it("a fresh directory gets no bot and writes nothing", () => {
    const dir = tmpDir();
    const reg = openRegistry(dir);
    expect(reg.list()).toEqual([]);
    expect(existsSync(join(dir, "bots.json"))).toBe(false);
  });
});

describe("the live worker's state dir, end to end through TradingService", () => {
  it("migrates on start: bots.json, engine-state v2 with the v1 backup, active.json renamed, nothing lost", () => {
    const dir = tmpDir();
    const w = writeV1Dir(dir);
    const h = harness({ dir });
    expect(j(join(dir, "engine-state.json")).version).toBe(2);
    expect(readFileSync(join(dir, "engine-state.v1.json"), "utf8")).toBe(w.files.engine);
    expect(readFileSync(join(dir, "active.v1.json"), "utf8")).toBe(w.files.active);
    expect(existsSync(join(dir, "active.json"))).toBe(false);
    const bots = j(join(dir, "bots.json"));
    expect(bots.bots).toHaveLength(1);
    expect(bots.bots[0]).toMatchObject({ id: "default", active_hash: w.env.hash });
    expect(bots.bots[0].hashes.map((x: { prefix: string }) => x.prefix)).toContain(cloidPrefix(w.env.hash));
    const st = j(join(dir, "engine-state.json"));
    expect(st.account.orderCounter).toBe(7);
    expect(st.oidBot).toEqual({ "11": "default", "12": "default" });
    expect(st.bots.default.agg.total["HYPE/USDC"]).toMatchObject({ dq: "0.5" });
    // the old log is untouched and gets one migration line appended
    expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toContain("old order");
    expect(h.service.registry.legacyV1()?.hash).toBe(w.env.hash);
  });

  it("the v1-signed envelope is still accepted (running), the position stays with default, the counter continues", async () => {
    const dir = tmpDir();
    const w = writeV1Dir(dir);
    const h = harness({ dir });
    withFundedHl(h);
    h.hl.addFill(HL_ACCOUNT, { oid: 12, tid: 12, cloid: `${cloidPrefix(w.env.hash)}0000000000000007`, pair: "HYPE/USDC", side: "buy", price: "40.4", size: "0.5", feeUsdc: "0.01", timeMs: DAY_START + 1000 });
    await h.service.tick();
    const st = h.service.status();
    expect(st.state).toBe("running");
    expect(st.warnings.filter((x) => x.includes("refused"))).toEqual([]);
    expect(st.bots).toEqual([{ id: "default", name: "DCA", state: "running" }]);
    expect(st.active_rules).toMatchObject({ hash: w.env.hash, name: "DCA" });
    const d = await h.service.botDetail("default");
    expect(d.rules?.message).not.toContain("bot:"); // still the v1 message: valid only for this migrated hash
    // the fixture's 0.01 USDC fee is read as a base-token fee by the migration estimate (fee / price): slightly below 0.5, never above
    expect(d.positions).toHaveLength(1);
    expect(Number(d.positions[0]?.size)).toBeLessThan(0.5);
    expect(Number(d.positions[0]?.size)).toBeGreaterThan(0.499);
    // the DCA rule was due (fired 2 h ago, every 1h): one order, continuing the cloid counter at 8, prefix unchanged
    expect(h.hl.placed).toHaveLength(1);
    expect(h.hl.placed[0]?.cloid).toBe(`${cloidPrefix(w.env.hash)}0000000000000008`);
  });

  it("is idempotent across restarts: the second start changes no file", () => {
    const dir = tmpDir();
    writeV1Dir(dir);
    const h = harness({ dir });
    const snap = (): string[] => ["bots.json", "engine-state.json", "engine-state.v1.json", "active.v1.json"].map((f) => readFileSync(join(dir, f), "utf8"));
    const before = snap();
    const log = readFileSync(join(dir, "log.jsonl"), "utf8");
    const s2 = new TradingService({
      settings: { vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", account: HL_ACCOUNT, hard: h.routeDeps.confirmCtx.hard, tickSec: 60, deadmanSec: 180, stateDir: dir },
      hl: h.hl,
      wallet: h.wallet,
      store: h.store,
      confirmCtx: h.routeDeps.confirmCtx,
      readVault: () => Promise.resolve(h.vault.view),
      funder: null,
      now: () => h.clock.t,
    });
    expect(snap()).toEqual(before);
    expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toBe(log);
    expect(s2.registry.list()).toHaveLength(1);
  });

  it("finishes a migration that crashed after bots.json but before the engine state was converted", () => {
    const dir = tmpDir();
    const w = writeV1Dir(dir);
    openRegistry(dir, { legacyPrefixes: [cloidPrefix(w.env.hash)] }); // the first half of the migration
    expect(j(join(dir, "engine-state.json")).version).toBe(1);
    const h = harness({ dir });
    expect(j(join(dir, "engine-state.json")).version).toBe(2);
    expect(h.service.registry.get("default")?.active_hash).toBe(w.env.hash);
  });

  it("a v1 halt survives: the migrated worker is halted until a NEW signed confirmation", async () => {
    const dir = tmpDir();
    writeV1Dir(dir, { halt: { reason: "KILLED", atMs: T0 - 1000, detail: "kill switch: before upgrade" } });
    const h = harness({ dir });
    withFundedHl(h);
    expect(h.service.status().state).toBe("halted");
    await h.service.tick();
    expect(h.service.status()).toMatchObject({ state: "halted", state_reason: "KILLED" });
    expect(h.hl.placed).toHaveLength(0);
    // a new confirm for 'default' (now a v2 message) clears it
    await h.confirmDirect(dcaRules(), "default");
    expect(h.service.status().state).toBe("running");
  });

  it("the old endpoints keep working on the migrated dir: /status, /rules, /log, /kill", async () => {
    const dir = tmpDir();
    const w = writeV1Dir(dir);
    const h = harness({ dir });
    withFundedHl(h);
    await h.service.tick();
    const s = await (await h.app.request("/trading/status", { headers: { "x-forwarded-for": "9.9.9.9" } })).json();
    expect(s).toMatchObject({ enabled: true, state: "running", active_rules: { hash: w.env.hash }, max_bots: 3 });
    expect(s.bots).toEqual([{ id: "default", name: "DCA", state: "running" }]);
    const r = await (await h.app.request("/trading/rules", { headers: h.authed() })).json();
    expect(r.active.hash).toBe(w.env.hash);
    expect(r.history.map((x: { hash: string }) => x.hash)).toEqual([w.env.hash]);
    const l = await (await h.app.request("/trading/log?limit=5", { headers: h.authed() })).json();
    expect(l.entries.length).toBeGreaterThan(0);
    expect(l.entries.every((e: { bot_id: string | null }) => "bot_id" in e)).toBe(true);
    const k = await h.app.request("/trading/kill", { method: "POST", headers: h.authed(), body: "{}" });
    expect(k.status).toBe(200);
    expect(h.service.status().state).toBe("halted");
  });

  it("the legacy v1 message is accepted ONLY for the migrated hash of bot 'default'", async () => {
    const dir = tmpDir();
    const w = writeV1Dir(dir);
    const near = freshNear();
    const store = new RulesStore(dir);
    const reg = openRegistry(dir, { legacyPrefixes: [cloidPrefix(w.env.hash)] });
    const ctx = makeCtx(near);
    const legacy = reg.legacyV1()?.hash ?? null;
    const def = reg.get("default");
    if (!def) throw new Error("no default bot");
    expect(await store.loadBot(def, ctx, { legacyV1Hash: legacy })).toMatchObject({ status: "ok" });
    // a different v1-signed envelope (written by hand) is not covered by the legacy allowance
    const other = { ...dcaRules(), name: "Other" };
    const env2 = v1Envelope(other, T0);
    writeFileSync(join(dir, "rules", `${env2.hash}.json`), JSON.stringify(env2));
    expect(await store.loadBot({ ...def, active_hash: env2.hash }, ctx, { legacyV1Hash: legacy })).toMatchObject({ status: "refused", code: "MESSAGE_MISMATCH" });
    // the same legacy envelope for any other bot id is refused too
    expect(await store.loadBot({ ...def, id: "other-bot" }, ctx, { legacyV1Hash: legacy })).toMatchObject({ status: "refused", code: "MESSAGE_MISMATCH" });
    // and without the registry's legacy marker it is refused for default as well
    expect(await store.loadBot(def, ctx, { legacyV1Hash: null })).toMatchObject({ status: "refused", code: "MESSAGE_MISMATCH" });
  });

  it("re-signing 'default' after the migration writes a v2 message and the same hash keeps its prefix/bot", async () => {
    const dir = tmpDir();
    const w = writeV1Dir(dir);
    const h = harness({ dir });
    withFundedHl(h);
    const env = await h.confirmDirect(dcaRules(), "default");
    expect(env.hash).toBe(w.env.hash);
    expect(env.message).toContain("bot: default");
    expect(h.service.registry.get("default")?.hashes.filter((x) => x.prefix === cloidPrefix(w.env.hash))).toHaveLength(1);
  });

  it("a corrupted engine-state.json still refuses to trade, migrates nothing and leaves the v1 files untouched", async () => {
    const dir = tmpDir();
    writeV1Dir(dir, {});
    writeFileSync(join(dir, "engine-state.json"), JSON.stringify({ version: 1, halt: null, orderCounter: -5 }));
    const h = harness({ dir });
    await h.service.tick();
    expect(h.service.status().state_reason).toBe("STATE_CORRUPT");
    expect(existsSync(join(dir, "engine-state.v1.json"))).toBe(false);
    // the registry migration did not run either (it would have lost the older prefixes): active.json is still there
    expect(existsSync(join(dir, "bots.json"))).toBe(false);
    expect(existsSync(join(dir, "active.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
