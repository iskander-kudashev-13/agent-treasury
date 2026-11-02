/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TradingService, vaultViewFromBudget } from "../../src/trading/service.js";
import { dcaRules, harness, T0 } from "./harness.js";
import { HL_ACCOUNT } from "./fixtures.js";

const lowBalance = [{ coin: "USDC", total: "5", hold: "0" }];

describe("service: tick then funding", () => {
  it("no rules: tick runs, then funding tops up once with the exact configured amount to the HL master", async () => {
    const h = harness();
    h.hl.setBalances(HL_ACCOUNT, lowBalance);
    await h.service.tick();
    const st = h.service.status();
    expect(st.state).toBe("no_rules");
    expect(st.last_tick_ms).toBe(T0);
    expect(h.client.requests).toEqual([{ chain: "hypercore", address: HL_ACCOUNT, amountUsdc: "20", memo: "hl-trader top-up" }]);
    // the tick's HL reads happened before the funding call (funding uses what the tick read)
    expect(h.hl.callLog().includes("read:getSpotBalances")).toBe(true);
    expect(h.client.watched).toEqual(["7"]);
    expect(h.service.readLog(10).some((e) => e.kind === "topup" && e.detail.startsWith("submitted: payout 7"))).toBe(true);
    // a second tick does not top up again (payout in flight)
    h.clock.t += 60_000;
    await h.service.tick();
    expect(h.client.requests).toHaveLength(1);
  });

  it("above the floor: no top-up", async () => {
    const h = harness();
    await h.service.tick();
    expect(h.client.requests).toHaveLength(0);
  });

  it("halted: no top-up even when below the floor", async () => {
    const h = harness();
    h.hl.setBalances(HL_ACCOUNT, lowBalance);
    await h.service.kill("test");
    await h.service.tick();
    expect(h.service.status().state).toBe("halted");
    expect(h.client.requests).toHaveLength(0);
  });

  it("topups disabled (no funder): never calls the vault client", async () => {
    const h = harness({ topup: false });
    h.hl.setBalances(HL_ACCOUNT, lowBalance);
    await h.service.tick();
    expect(h.client.requests).toHaveLength(0);
  });

  it("with confirmed rules: the dead-man switch is set before the order and the order uses a cloid of the rule hash", async () => {
    const h = harness();
    const env = await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(1);
    const log = h.hl.callLog();
    expect(log.indexOf("scheduleCancel")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("scheduleCancel")).toBeLessThan(log.indexOf("place"));
    expect(h.hl.placed[0]?.cloid.startsWith(`0x${env.hash.slice(0, 16)}`)).toBe(true);
    const st = h.service.status();
    expect(st.state).toBe("running");
    expect(st.active_rules).toMatchObject({ hash: env.hash, name: "DCA", confirmed_by: "owner.test.near" });
    expect(st.dead_man.cancel_at_ms).toBe(T0 + 180_000);
  });

  it("vault paused on-chain: no order, state paused_onchain", async () => {
    const h = harness();
    h.vault.view = { ...h.vault.view, status: "Paused" };
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(0);
    expect(h.service.status().state).toBe("paused_onchain");
  });

  it("vault unreadable: fails closed (no order)", async () => {
    const h = harness();
    h.vault.down = true;
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(0);
    expect(h.service.status().state).toBe("error");
  });
});

describe("service: rules are verified fresh on every tick", () => {
  it("owner changed after confirmation: rules are refused, no order, reason visible", async () => {
    const h = harness();
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(1);
    h.near.owner = "someone.else.near";
    h.clock.t += 2 * 3_600_000;
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(1);
    const st = h.service.status();
    expect(st.state).toBe("no_rules");
    expect(st.state_reason).toBe("RULES_REFUSED");
    expect(st.state_detail).toContain("NOT_OWNER");
  });

  it("tampered rules file: refused", async () => {
    const h = harness();
    const env = await h.confirmDirect(dcaRules());
    const p = join(h.dir, "rules", `${env.hash}.json`);
    const j = JSON.parse(readFileSync(p, "utf8")) as typeof env;
    j.rules.limits.max_order_usdc = "13";
    writeFileSync(p, JSON.stringify(j));
    h.clock.t += 2 * 3_600_000;
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(1);
    expect(h.service.status().state_reason).toBe("RULES_REFUSED");
  });
});

describe("service: single flight", () => {
  it("a second tick() while one runs returns the same promise and reads HL once", async () => {
    const h = harness();
    let release!: () => void;
    h.hl.gate = new Promise<void>((r) => {
      release = r;
    });
    const a = h.service.tick();
    const b = h.service.tick();
    expect(b).toBe(a);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.hl.midsCalls).toBe(1);
    expect(h.service.isTicking()).toBe(true);
    release();
    await a;
    expect(h.service.isTicking()).toBe(false);
    h.hl.gate = null;
    await h.service.tick();
    expect(h.hl.midsCalls).toBe(2);
  });

  it("tickFresh waits for the running tick and then runs another", async () => {
    const h = harness();
    let release!: () => void;
    h.hl.gate = new Promise<void>((r) => {
      release = r;
    });
    const a = h.service.tick();
    const f = h.service.tickFresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.hl.midsCalls).toBe(1);
    h.hl.gate = null;
    release();
    await Promise.all([a, f]);
    expect(h.hl.midsCalls).toBe(2);
  });

  it("a kill that arrives during a tick is not overwritten by the tick's result", async () => {
    const h = harness();
    let release!: () => void;
    h.hl.gate = new Promise<void>((r) => {
      release = r;
    });
    const t = h.service.tick();
    await new Promise((r) => setTimeout(r, 10));
    const k = await h.service.kill("during tick");
    expect(k.state).toBe("halted");
    release();
    await t;
    expect(h.service.status().state).toBe("halted");
    // and it stays halted on the next tick and across a restart
    await h.service.tick();
    expect(h.service.status().state_reason).toBe("KILLED");
    const again = new TradingService({ ...restartDeps(h) });
    expect(again.status().state).toBe("halted");
  });

  it("start() runs ticks one after another on the timer and stop() ends it", async () => {
    const h = harness();
    const svc = new TradingService({ ...restartDeps(h), settings: { ...restartDeps(h).settings, tickSec: 15 } });
    svc.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.status().last_tick_ms).toBe(T0);
    svc.stop();
  });
});

function restartDeps(h: ReturnType<typeof harness>) {
  return {
    settings: { vault: "vault.test.near", agentId: "hl-trader", hlNetwork: "testnet" as const, account: HL_ACCOUNT, hard: h.routeDeps.confirmCtx.hard, tickSec: 60, deadmanSec: 180, stateDir: h.dir },
    hl: h.hl,
    wallet: h.wallet,
    store: h.store,
    confirmCtx: h.routeDeps.confirmCtx,
    readVault: () => Promise.resolve(h.vault.view),
    funder: h.funder,
    now: () => h.clock.t,
  };
}

describe("service: persistence across restart", () => {
  it("fired cooldowns and the halt survive; the same rule does not fire twice", async () => {
    const h = harness();
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(1);
    // restart: new service on the same state dir
    h.clock.t += 60_000;
    const s2 = new TradingService(restartDeps(h));
    await s2.tick();
    expect(h.hl.placed).toHaveLength(1); // 1h interval not elapsed, state restored
    h.clock.t += 3_600_000;
    await s2.tick();
    expect(h.hl.placed).toHaveLength(2);
    // restart again after a kill
    await s2.kill();
    const s3 = new TradingService(restartDeps(h));
    expect(s3.status().state).toBe("halted");
    await s3.tick();
    expect(h.hl.placed).toHaveLength(2);
    expect(s3.status().state_reason).toBe("KILLED");
  });

  it("a corrupt engine-state.json makes the service refuse to trade", async () => {
    const h = harness();
    await h.confirmDirect(dcaRules());
    writeFileSync(join(h.dir, "engine-state.json"), "{not json");
    const s2 = new TradingService(restartDeps(h));
    h.clock.t += 2 * 3_600_000;
    await s2.tick();
    const st = s2.status();
    expect(st.state).toBe("error");
    expect(st.state_reason).toBe("STATE_CORRUPT");
    expect(h.hl.placed).toHaveLength(1);
  });

  it("the funded-since baseline is the first tick and is persisted", async () => {
    const h = harness();
    await h.service.tick();
    expect(JSON.parse(readFileSync(join(h.dir, "meta.json"), "utf8"))).toEqual({ startMs: T0 });
  });

  it("log.jsonl is append-only and readLog returns newest first with a limit", async () => {
    const h = harness();
    await h.service.kill("one");
    h.clock.t += 1000;
    await h.service.kill("two");
    const all = h.service.readLog(50);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all[0]?.at_ms).toBeGreaterThanOrEqual(all[all.length - 1]?.at_ms ?? 0);
    expect(h.service.readLog(1)).toHaveLength(1);
    const raw = readFileSync(join(h.dir, "log.jsonl"), "utf8").trim().split("\n");
    expect(raw.length).toBe(all.length);
  });
});

describe("service: kill sequence", () => {
  const restingOrder = {
    oid: 555,
    cloid: `0x${"ab".repeat(16)}`,
    market: "spot" as const,
    pair: "HYPE/USDC",
    side: "buy" as const,
    price: "39",
    size: "1",
    placedAtMs: T0,
  };

  it("halts, cancels every spot order, schedules the cancel a few seconds out", async () => {
    const h = harness();
    h.hl.setOpenOrders(HL_ACCOUNT, [restingOrder]);
    const r = await h.service.kill("panic");
    expect(r).toEqual({ state: "halted", cancelled_orders: 1, steps: { cancel_all: "ok", schedule_cancel: "ok", state_saved: "ok", tick_wait: "ok" } });
    expect(h.hl.cancelled).toEqual([{ assetId: 10107, oid: 555 }]);
    expect(h.hl.scheduleCancelCalls).toEqual([T0 + 6000]);
    const st = h.service.status();
    expect(st.state).toBe("halted");
    expect(st.state_reason).toBe("KILLED");
    expect(st.state_detail).toContain("panic");
    expect(JSON.parse(readFileSync(join(h.dir, "engine-state.json"), "utf8")).halt.reason).toBe("KILLED");
  });

  it("reports each step on its own: cancel fails, schedule still attempted", async () => {
    const h = harness();
    h.hl.setOpenOrders(HL_ACCOUNT, [restingOrder]);
    h.hl.failNext("cancelOrders");
    const r = await h.service.kill();
    expect(r.steps).toEqual({ cancel_all: "failed", schedule_cancel: "ok", state_saved: "ok", tick_wait: "ok" });
    expect(r.cancelled_orders).toBe(0);
    expect(h.service.status().state).toBe("halted");
  });

  it("schedule fails, cancel still done", async () => {
    const h = harness();
    h.hl.setOpenOrders(HL_ACCOUNT, [restingOrder]);
    h.hl.failNext("scheduleCancel");
    const r = await h.service.kill();
    expect(r).toMatchObject({ cancelled_orders: 1, steps: { cancel_all: "ok", schedule_cancel: "failed" } });
  });

  it("HL entirely down: still halted, both steps failed", async () => {
    const h = harness();
    h.hl.failNext("getOpenOrders");
    h.hl.failNext("scheduleCancel");
    const r = await h.service.kill();
    expect(r.steps).toEqual({ cancel_all: "failed", schedule_cancel: "failed", state_saved: "ok", tick_wait: "ok" });
    expect(h.service.status().state).toBe("halted");
  });

  it("the next tick keeps cancelling while halted", async () => {
    const h = harness();
    h.hl.failNext("getOpenOrders");
    await h.service.kill();
    h.hl.setOpenOrders(HL_ACCOUNT, [restingOrder]);
    await h.service.tick();
    expect(h.hl.cancelled.map((c) => c.oid)).toEqual([555]);
  });
});

describe("service: perp alarm and activation", () => {
  it("perp position halts; assertMayActivate is 409 while open, passes once closed", async () => {
    const h = harness();
    h.hl.setPerp(HL_ACCOUNT, { positions: [{ coin: "ETH", size: "0.1" }], openPerpOrders: 0, accountValueUsdc: "50" });
    await h.service.tick();
    expect(h.service.status()).toMatchObject({ state: "halted", state_reason: "PERP_POSITION_DETECTED" });
    await expect(h.service.assertMayActivate()).rejects.toMatchObject({ status: 409, code: "PERP_STILL_OPEN" });
    h.hl.setPerp(HL_ACCOUNT, { positions: [], openPerpOrders: 0, accountValueUsdc: "0" });
    await expect(h.service.assertMayActivate()).resolves.toBeUndefined();
  });

  it("HL unreadable during the check: 502, not a pass", async () => {
    const h = harness();
    h.hl.setPerp(HL_ACCOUNT, { positions: [{ coin: "ETH", size: "1" }], openPerpOrders: 0, accountValueUsdc: "50" });
    await h.service.tick();
    h.hl.failNext("getPerpState");
    await expect(h.service.assertMayActivate()).rejects.toMatchObject({ status: 502, code: "HL_UNAVAILABLE" });
  });

  it("a kill halt does not need the perp check", async () => {
    const h = harness();
    await h.service.kill();
    await expect(h.service.assertMayActivate()).resolves.toBeUndefined();
  });
});

describe("service: rotate", () => {
  it("generated key: new address, HL adapter rebuilt, state awaiting_api_wallet", async () => {
    const h = harness({ envKey: undefined });
    const old = h.address;
    const addr = await h.service.rotateApiWallet();
    expect(addr).not.toBe(old);
    expect(h.hlCreated).toEqual([addr]);
    const st = h.service.status();
    expect(st.api_wallet.address).toBe(addr);
    expect(st.state).toBe("awaiting_api_wallet");
  });

  it("env-fixed key cannot be rotated", async () => {
    const h = harness();
    await expect(h.service.rotateApiWallet()).rejects.toMatchObject({ status: 400, code: "ROTATE_REFUSED" });
  });
});

describe("vaultViewFromBudget", () => {
  const raw = { agent_id: "hl-trader", status: "Active", vault_paused: false, remaining_today: "50000000", per_tx_limit: "25000000", payments_today: 1, max_payments_per_day: 2, expires_at: "1800000000000" };
  it("maps the contract JSON", () => {
    expect(vaultViewFromBudget(raw)).toEqual({ vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 1, maxPaymentsPerDay: 2, expiresAtMs: 1800000000000 });
    expect(vaultViewFromBudget({ ...raw, expires_at: null }).expiresAtMs).toBeNull();
  });
  it("rejects an unexpected shape", () => {
    expect(() => vaultViewFromBudget({ ...raw, status: "Weird" })).toThrow();
    expect(() => vaultViewFromBudget({})).toThrow();
  });
});
