/**
 * Migration of a COPY of the real live testnet state dir (written by the single-bot worker before ADR-0006) through the real
 * TradingService, store, registry, confirmer and router. FakeHl replays what HL testnet reported for that account (the three
 * real PURR fills, real balances); no network, no real keys (the API wallet comes from a test key; `api-wallet.json` and `lock`
 * are NOT copied). The source directory is only read; a digest of every file is compared before and after.
 *
 * Source: `LIVE_V1_STATE_DIR`, default the session backup `trading-state-3.backup-v1`. Skipped when it does not exist (CI).
 */
/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../../src/ai/session.js";
import { RulesConfirmer } from "../../src/trading/confirm.js";
import type { ConfirmCtx } from "../../src/trading/confirm.js";
import { resolveBot } from "../../src/trading/engine/fills.js";
import { FakeHl } from "../../src/trading/hl/fake.js";
import { createPairInfoProvider } from "../../src/trading/pairs.js";
import { createTradingRouter } from "../../src/trading/route.js";
import { TradingService } from "../../src/trading/service.js";
import { RulesStore } from "../../src/trading/store.js";
import type { HlFill, HlSpotPair } from "../../src/trading/types.js";
import { ApiWalletManager } from "../../src/trading/wallet.js";
import { HARD, tmpDir } from "./fixtures.js";

const SRC =
  process.env["LIVE_V1_STATE_DIR"] ??
  "/private/tmp/claude-501/-Users-iskander-faggod-Desktop-agent-treasury/acaebd01-7007-45e2-b1ee-672f52efb453/scratchpad/trading-state-3.backup-v1";
const HAVE_SRC = existsSync(join(SRC, "engine-state.json")) && existsSync(join(SRC, "active.json"));

// Facts of the live deployment (all public: testnet account ids, the HL address, the signed envelope).
const VAULT = "at-trade-11030006.testnet";
const OWNER = "at-owner-11012309.testnet";
const OWNER_PK = "ed25519:7juqPUvvXtuHeRX3qPHQnva7i7b31n3YBw1Xbnd18SuQ";
const HL_ACCOUNT = "0x072994Aa1Bdb9886Ce04f6D42c6ee513fA92ab0d";
const ACTIVE = "bb49a14c0945f933396fe3a0c17ac91fa6fc1dcb74c28b255666bab95b3f005d";
const OLD = "e03cba1bab25b0c55b113e13de91031e8dd807c1ef5a0cca4a6a9705749deea0";
const PREFIX = "0xbb49a14c0945f933";
const OLD_PREFIX = "0xe03cba1bab25b0c5";
/** Files never copied out of the source (the real API wallet key, the process lock). */
const NOT_COPIED = new Set(["api-wallet.json", "lock"]);
const TEST_KEY = `0x${"0".repeat(63)}7`;
const SECRET = "s".repeat(40);

/** The three fills HL testnet returns for the account since TRADING_START_MS (userFillsByTime, read-only, 2026-11-03). */
const LIVE_FILLS: HlFill[] = [
  { oid: 64358416012, tid: 231004134394788, cloid: `${PREFIX}0000000000000001`, timeMs: 1793653702504 },
  { oid: 64361661559, tid: 220891448149363, cloid: `${PREFIX}0000000000000002`, timeMs: 1793657316203 },
  { oid: 64364910370, tid: 811075342416911, cloid: `${PREFIX}0000000000000003`, timeMs: 1793660936237 },
].map((f) => ({ ...f, pair: "PURR/USDC", side: "buy" as const, price: "4.5795", size: "3", feeUsdc: "0.00961695", feeToken: "PURR", feeAmount: "0.0021" }));
/** spotClearinghouseState of the account at the same time. */
const LIVE_PURR = "8.9937";
const LIVE_USDC = "957.7845";
const PURR: HlSpotPair = { name: "PURR/USDC", base: "PURR", assetId: 10000, szDecimals: 0, volume24hUsdc: "5000000", midUsdc: "4.5795" };

/** Same UTC day as the backup (day 20759), 6.7 minutes after its last tick. */
const NOW = 1793662000000;
const DAY_20760 = 20760 * 86_400_000;

function digestDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

function copyState(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(src)) {
    if (NOT_COPIED.has(name)) continue;
    const p = join(src, name);
    if (statSync(p).isDirectory()) copyState(p, join(dst, name));
    else copyFileSync(p, join(dst, name));
  }
}

const j = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

function liveWorld(dir: string) {
  const clock = { t: NOW };
  const hl = new FakeHl({ now: () => clock.t, pairs: [PURR] });
  hl.account = HL_ACCOUNT.toLowerCase();
  const wallet = new ApiWalletManager({ stateDir: dir, envKey: TEST_KEY, now: () => clock.t });
  hl.setApprovedAgents(HL_ACCOUNT, [{ address: wallet.address(), name: "agent-treasury valid_until", validUntilMs: NOW + 30 * 86_400_000 }]);
  hl.setBalances(HL_ACCOUNT, [
    { coin: "USDC", total: LIVE_USDC, hold: "0" },
    { coin: "PURR", total: LIVE_PURR, hold: "0" },
  ]);
  for (const f of LIVE_FILLS) hl.addFill(HL_ACCOUNT, f);
  const keys: Record<string, "full"> = { [`${OWNER}|${OWNER_PK}`]: "full" };
  const ctx: ConfirmCtx = {
    vault: VAULT,
    agentId: "hl-trader",
    hlNetwork: "testnet",
    hlAccount: HL_ACCOUNT,
    hard: HARD,
    accessKey: (acc, pk) => Promise.resolve(keys[`${acc}|${pk}`] ?? "none"),
    vaultOwner: () => Promise.resolve(OWNER),
  };
  const store = new RulesStore(dir, () => clock.t);
  const mk = () =>
    new TradingService({
      settings: { vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", account: HL_ACCOUNT, hard: HARD, tickSec: 60, deadmanSec: 180, stateDir: dir },
      hl,
      wallet,
      store,
      confirmCtx: ctx,
      readVault: () =>
        Promise.resolve({ vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: NOW + 30 * 86_400_000 }),
      funder: null,
      now: () => clock.t,
    });
  const service = mk();
  const pairs = createPairInfoProvider(() => service.hlPort(), { now: () => clock.t });
  const confirmer = new RulesConfirmer({ ctx, store, registry: service.registry, maxBots: 3, getPairInfo: () => pairs.getPairInfo(), deadManAvailable: () => service.deadManAvailable(), now: () => clock.t });
  const app = new Hono().route("/trading", createTradingRouter({ service, confirmer, store, confirmCtx: ctx, sessionSecret: SECRET, vault: VAULT, trustProxy: true, now: () => clock.t }));
  const authed = (): Record<string, string> => ({
    authorization: `Bearer ${signToken(SECRET, { sub: OWNER, vault: VAULT, iat: clock.t, exp: clock.t + 3_600_000 })}`,
    "content-type": "application/json",
    "x-forwarded-for": "9.9.9.9",
  });
  return { clock, hl, service, store, app, authed, mk };
}

describe.skipIf(!HAVE_SRC)("the REAL live testnet state dir (copy), migrated by TradingService", () => {
  let before: Record<string, string> = {};
  beforeAll(() => {
    before = digestDir(SRC);
  });
  afterAll(() => {
    // read-only source: nothing was written, renamed or added
    expect(digestDir(SRC)).toEqual(before);
  });

  const fresh = () => {
    const dir = tmpDir();
    copyState(SRC, dir);
    expect(existsSync(join(dir, "api-wallet.json"))).toBe(false);
    return { dir, ...liveWorld(dir) };
  };

  it("the copy is the v1 layout the test assumes (guards against pointing at an already-migrated dir)", () => {
    expect(j(join(SRC, "engine-state.json")).version).toBe(1);
    expect(j(join(SRC, "active.json")).hash).toBe(ACTIVE);
    expect(existsSync(join(SRC, "bots.json"))).toBe(false);
  });

  it("start: bot 'default' with the active hash bb49a14c0945f933..., both remembered prefixes, legacy v1 marker; v1 files kept", () => {
    const w = fresh();
    const origEngine = readFileSync(join(SRC, "engine-state.json"), "utf8");
    const origActive = readFileSync(join(SRC, "active.json"), "utf8");
    const reg = w.service.registry;
    expect(reg.list().map((b) => b.id)).toEqual(["default"]);
    const d = reg.get("default");
    expect(d).toMatchObject({ id: "default", name: "PURR hourly DCA with take profit", active_hash: ACTIVE, archived_at_ms: null, created_at_ms: 1793649336612 });
    expect(d?.hashes.map((h) => [h.prefix, h.hash])).toEqual([
      [OLD_PREFIX, null],
      [PREFIX, ACTIVE],
    ]);
    expect(reg.legacyV1()).toEqual({ bot_id: "default", hash: ACTIVE });
    expect(existsSync(join(w.dir, "active.json"))).toBe(false);
    expect(readFileSync(join(w.dir, "active.v1.json"), "utf8")).toBe(origActive);
    expect(readFileSync(join(w.dir, "engine-state.v1.json"), "utf8")).toBe(origEngine);
    const st = j(join(w.dir, "engine-state.json"));
    expect(st.version).toBe(2);
    expect(st.account.orderCounter).toBe(3);
    expect(st.account.day.dayIndex).toBe(20759);
    expect(st.account.deadManGatedAtMs).toBe(1793660555806);
    expect(st.oidBot).toEqual({ "64358416012": "default", "64361661559": "default", "64364910370": "default" });
    expect(st.bots.default.rulesHash).toBe(ACTIVE);
    expect(st.bots.default.firedAt).toEqual({ "buy-hourly": 1793660933019 });
    expect(st.bots.default.agg.total["PURR/USDC"]).toMatchObject({ dq: "9", cash: "-41.2155" });
    expect(st.bots.default.agg.basis).toEqual({ [PREFIX]: { "PURR/USDC": { size: "6", cost: "27.477" } } });
    // the old rule set e03c... was the first bot's too (it has no owner on record)
    expect(w.service.rulesHistory("default").map((x) => x.hash)).toEqual([OLD, ACTIVE]);
  });

  it("the live PURR buys (cloids and oids) all attribute to 'default'", () => {
    const w = fresh();
    const pm = w.service.registry.prefixMap();
    const oidBot = j(join(w.dir, "engine-state.json")).oidBot;
    for (const f of LIVE_FILLS) {
      expect(resolveBot(f, pm, {})).toBe("default"); // by cloid prefix alone
      expect(resolveBot({ ...f, cloid: null }, new Map(), oidBot)).toBe("default"); // and by remembered oid alone
    }
  });

  it("first tick: running with the v1-signed envelope, PURR position from the bot's own fills, no order (1h DCA not due)", async () => {
    const w = fresh();
    await w.service.tick();
    const st = w.service.status();
    expect(st.warnings.filter((x) => /refused|foreign|partial/.test(x))).toEqual([]);
    expect(st).toMatchObject({ state: "running", active_rules: { hash: ACTIVE, confirmed_by: OWNER } });
    expect(st.bots).toEqual([{ id: "default", name: "PURR hourly DCA with take profit", state: "running" }]);
    const d = await w.service.botDetail("default");
    expect(d.rules?.message).not.toContain("bot:");
    const pos = d.positions.find((p) => p.pair === "PURR/USDC");
    // 3 buys x 3 PURR minus the 3 x 0.0021 PURR base-token fee (rebuilt by migrateV1 from the v1 fee total)
    expect(pos?.size).toBe("8.9937");
    expect(pos?.avg_cost).toBe("4.5795");
    expect(w.hl.placed).toHaveLength(0); // buy-hourly fired at 1793660933019, due again only after 1793664533019
    // nothing re-counted: the cursor de-duplicated the replayed fill, sums unchanged
    const s2 = j(join(w.dir, "engine-state.json"));
    expect(s2.bots.default.agg.total["PURR/USDC"].dq).toMatch(/^9(\.0+)?$/);
    expect(s2.account.fillCursor.foreignFills).toBe(0);
  });

  // ADR-0006 section 3 / fills.ts: a bot's position = dq - base-token fees. The migrated sums have no `feeBase`, so 'default'
  // thinks it holds 9 PURR while the account (and its own fills) hold 8.9937. A 100% sell is then sized from 9.
  it("migrated position takes off the base-token buy fees of v1 fills (9 instead of 8.9937 PURR) - engine/migrate.ts migrateTracker() copies `total` without feeBase", async () => {
    const w = fresh();
    await w.service.tick();
    const d = await w.service.botDetail("default");
    expect(d.positions.find((p) => p.pair === "PURR/USDC")?.size).toBe("8.9937");
  });

  it("the order counter continues: the next DCA order carries ...0004 with the same prefix (next UTC day, mid 3)", async () => {
    const w = fresh();
    await w.service.tick();
    // next day, mid low enough that 9 PURR + a 15 USDC buy stay under the rule set's 45 USDC cap
    w.hl.setMid("PURR/USDC", "3");
    w.clock.t = DAY_20760 + 3_600_000;
    await w.service.tick();
    expect(w.service.status().state).toBe("running");
    expect(w.hl.placed).toHaveLength(1);
    expect(w.hl.placed[0]?.cloid).toBe(`${PREFIX}0000000000000004`);
    expect(w.hl.placed[0]?.assetId).toBe(10000);
    expect(j(join(w.dir, "engine-state.json")).account.orderCounter).toBe(4);
  });

  it("old endpoints work on the migrated dir: /status, /rules, /log, /bots, /bots/default, /kill", async () => {
    const w = fresh();
    await w.service.tick();
    const s = await (await w.app.request("/trading/status", { headers: { "x-forwarded-for": "9.9.9.9" } })).json();
    expect(s).toMatchObject({ enabled: true, state: "running", vault: VAULT, active_rules: { hash: ACTIVE }, bots: [{ id: "default", state: "running" }] });
    const r = await (await w.app.request("/trading/rules", { headers: w.authed() })).json();
    expect(r.active.hash).toBe(ACTIVE);
    expect(r.history.map((x: any) => x.hash)).toEqual([OLD, ACTIVE]);
    const l = await (await w.app.request("/trading/log?limit=200", { headers: w.authed() })).json();
    // pre-migration order lines (no bot_id in the file) are reported as bot 'default'
    const orders = l.entries.filter((e: any) => e.kind === "order");
    expect(orders.map((e: any) => e.cloid)).toEqual([3, 2, 1].map((n) => `${PREFIX}000000000000000${n}`));
    expect(orders.every((e: any) => e.bot_id === "default")).toBe(true);
    expect(l.entries.some((e: any) => /migrated to version 2/.test(e.detail))).toBe(true);
    const list = await w.app.request("/trading/bots", { headers: w.authed() });
    expect(list.status).toBe(200);
    const det = await (await w.app.request("/trading/bots/default", { headers: w.authed() })).json();
    expect(det.bot).toMatchObject({ id: "default", state: "running", pairs: ["PURR/USDC"] });
    const k = await w.app.request("/trading/kill", { method: "POST", headers: w.authed(), body: "{}" });
    expect(k.status).toBe(200);
    expect(w.service.status().state).toBe("halted");
  });

  it("restart is idempotent: a second start changes no file and keeps the counter, sums and registry", async () => {
    const w = fresh();
    const files = ["bots.json", "engine-state.json", "engine-state.v1.json", "active.v1.json", "log.jsonl"];
    const snap = (): string[] => files.map((f) => readFileSync(join(w.dir, f), "utf8"));
    const first = snap();
    const s2 = w.mk();
    expect(snap()).toEqual(first);
    expect(s2.registry.list()).toEqual(w.service.registry.list());
    // and the restarted service trades exactly like the first one would
    await s2.tick();
    expect(s2.status().state).toBe("running");
    w.hl.setMid("PURR/USDC", "3");
    w.clock.t = DAY_20760 + 3_600_000;
    await s2.tick();
    expect(w.hl.placed.map((o) => o.cloid)).toEqual([`${PREFIX}0000000000000004`]);
    const s3 = w.mk();
    expect(s3.registry.list()).toHaveLength(1);
    expect(j(join(w.dir, "engine-state.json")).account.orderCounter).toBe(4);
    expect(readFileSync(join(w.dir, "engine-state.v1.json"), "utf8")).toBe(readFileSync(join(SRC, "engine-state.json"), "utf8"));
  });

  it("re-signing the same rules for 'default' after the migration needs a v2 message; the real v1 signature cannot be replayed through confirm", async () => {
    const w = fresh();
    const env = j(join(w.dir, "rules", `${ACTIVE}.json`));
    const ch = await w.app.request("/trading/rules/challenge", { method: "POST", headers: w.authed(), body: JSON.stringify({ rules: env.rules, bot_id: "default" }) });
    expect(ch.status).toBe(200);
    const c = await ch.json();
    expect(c.message).toContain("bot: default");
    // the stored (real) v1 signature + its own nonce: unknown nonce
    const replay = await w.app.request("/trading/rules/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({ rules: env.rules, account_id: OWNER, public_key: OWNER_PK, signature: env.signature, nonce: env.nonce, bot_id: "default" }),
    });
    expect(replay.status).toBe(401);
    // the real v1 signature with the fresh nonce: the signature does not cover this message
    const swapped = await w.app.request("/trading/rules/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({ rules: env.rules, account_id: OWNER, public_key: OWNER_PK, signature: env.signature, nonce: c.nonce, bot_id: "default" }),
    });
    expect(swapped.status).toBe(401);
    expect(await swapped.json()).toMatchObject({ code: "BAD_SIGNATURE" });
    // nothing changed: default still runs the legacy envelope
    expect(w.service.registry.get("default")?.active_hash).toBe(ACTIVE);
    expect(j(join(w.dir, "rules", `${ACTIVE}.json`)).signature).toBe(env.signature);
  });
});
