/* Test-only: HTTP bodies and persisted JSON are asserted as loosely typed data. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkError } from "agent-treasury-sdk";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { Funder } from "../../src/trading/funding.js";
import type { FundingClient, FundingConfig } from "../../src/trading/funding.js";
import { NktkasHl } from "../../src/trading/hl/nktkas.js";
import type { HlExchangeApi, HlInfoApi } from "../../src/trading/hl/nktkas.js";
import { publicText } from "../../src/trading/service.js";
import { dcaRules, harness } from "./harness.js";
import { HL_ACCOUNT } from "./fixtures.js";

const HOUR = 3_600_000;

async function post(app: ReturnType<typeof harness>["app"], path: string, headers: Record<string, string>, body: unknown) {
  return app.request(`/trading${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("review fix 1: kill during a running tick", () => {
  it("no order after kill resolves, and the kill's scheduleCancel is the last one", async () => {
    const h = harness({ topup: false });
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(1);

    h.clock.t += 2 * HOUR; // the 1h interval rule is due again
    let release: () => void = () => undefined;
    h.hl.gate = new Promise<void>((r) => {
      release = r;
    });
    const tick = h.service.tick(); // parked inside getMids
    await vi.waitFor(() => {
      expect(h.hl.midsCalls).toBeGreaterThan(0);
    });
    expect(h.service.isTicking()).toBe(true);

    const killP = h.service.kill("test");
    release();
    const result = await killP;
    await tick;

    expect(h.hl.placed).toHaveLength(1); // the due order was NOT placed
    const last = h.hl.scheduleCancelCalls[h.hl.scheduleCancelCalls.length - 1];
    expect(last).toBe(h.clock.t + 6_000);
    expect(result.steps.tick_wait).toBe("ok");
    expect(h.service.status().state).toBe("halted");
    // and later ticks cannot move the dead-man switch past the kill's
    const before = h.hl.scheduleCancelCalls.length;
    await h.service.tick();
    expect(h.hl.scheduleCancelCalls).toHaveLength(before);
    expect(h.hl.placed).toHaveLength(1);
  });
});

describe("review fix 6/7: write-ahead and failed state writes", () => {
  it("an unwritable state file blocks the order, the next tick, and shows in the kill result", async () => {
    const h = harness({ topup: false });
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(1);
    const file = join(h.dir, "engine-state.json");
    rmSync(file);
    mkdirSync(file); // a directory in the way: rename onto it fails

    h.clock.t += 2 * HOUR;
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(1); // write-ahead failed -> no order
    expect(h.service.status().state).toBe("error");

    h.clock.t += 60_000;
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(1);
    expect(h.service.status().state_reason).toBe("STATE_WRITE_FAILED");

    const k = await h.service.kill();
    expect(k.steps.state_saved).toBe("failed");
    expect(h.service.status().state).toBe("halted");

    rmSync(file, { recursive: true });
    const k2 = await h.service.kill();
    expect(k2.steps.state_saved).toBe("ok");
    expect(JSON.parse(readFileSync(file, "utf8")).account.halt.reason).toBe("KILLED");
  });

  it("counters reach the disk before the order is placed", async () => {
    const h = harness({ topup: false });
    const seen: unknown[] = [];
    const orig = h.hl.placeSpotOrder.bind(h.hl);
    h.hl.placeSpotOrder = (o) => {
      seen.push(JSON.parse(readFileSync(join(h.dir, "engine-state.json"), "utf8")).account.orderCounter);
      return orig(o);
    };
    await h.confirmDirect(dcaRules());
    expect(seen).toEqual([1]);
  });
});

describe("review fix 4: live pair volume in the tick", () => {
  it("skips with PAIR_LOW_VOLUME when 24h volume is under the hard minimum", async () => {
    const h = harness({ topup: false });
    await h.confirmDirect(dcaRules());
    h.clock.t += 2 * HOUR;
    const p = h.hl.pairs[0];
    if (!p) throw new Error("no pair");
    p.volume24hUsdc = "1";
    await h.service.tick();
    expect(h.hl.placed).toHaveLength(1);
    expect(h.service.readLog(20).some((e) => e.kind === "skip" && e.detail.startsWith("PAIR_LOW_VOLUME"))).toBe(true);
  });
});

describe("review fix 5: kill works when NEAR RPC is down", () => {
  it("accepts a valid owner session token without a fresh owner read", async () => {
    const h = harness({ topup: false });
    h.near.rpcDown = true;
    const r = await post(h.app, "/kill", h.authed(), {});
    expect(r.status).toBe(200);
  });
  it("still refuses a token of another account once the owner is known", async () => {
    const h = harness({ topup: false });
    expect((await post(h.app, "/kill", h.authed(), {})).status).toBe(200); // learns the owner
    h.near.rpcDown = true;
    expect((await post(h.app, "/kill", h.authed("mallory.near"), {})).status).toBe(403);
  });
  it("rotate keeps requiring a fresh owner check", async () => {
    const h = harness({ topup: false });
    h.near.rpcDown = true;
    expect((await post(h.app, "/api-wallet/rotate", h.authed(), {})).status).toBe(502);
  });
});

describe("review suggestions: status text, rotate, config", () => {
  it("publicText strips URLs and query strings and caps the length", () => {
    expect(publicText("fetch failed https://rpc.example.com/x?api_key=SECRET now")).toBe("fetch failed [url] now");
    expect(publicText("x".repeat(500))).toHaveLength(200);
    expect(publicText(null)).toBeNull();
  });
  it("rotate waits for a running tick", async () => {
    const h = harness({ topup: false, envKey: undefined });
    let release: () => void = () => undefined;
    h.hl.gate = new Promise<void>((r) => {
      release = r;
    });
    const t = h.service.tick();
    await vi.waitFor(() => {
      expect(h.service.isTicking()).toBe(true);
    });
    let done = false;
    const rot = h.service.rotateApiWallet().then(() => {
      done = true;
    });
    await new Promise((r) => setImmediate(r)); // a full macrotask turn: every pending microtask has run
    expect(done).toBe(false);
    h.hl.gate = null;
    release();
    await Promise.all([t, rot]);
    expect(done).toBe(true);
  });
  it("config refuses HL_API_WALLET_PRIVATE_KEY on mainnet", () => {
    const env = {
      TRADING_ENABLED: "true",
      AI_SESSION_SECRET: "s".repeat(40),
      HL_MASTER_ADDRESS: HL_ACCOUNT,
      HL_NETWORK: "mainnet",
      TRADING_ALLOW_MAINNET: "true",
      HL_API_WALLET_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      TRADER_NEAR_ACCOUNT_ID: "t.near",
      TRADER_NEAR_PRIVATE_KEY: "ed25519:x",
      VAULT_CONTRACT_ID: "v.near",
      NEAR_NETWORK: "mainnet",
      RUN_MODE: "local",
    };
    expect(() => loadConfig(env)).toThrow(/HL_API_WALLET_PRIVATE_KEY/);
  });
});

describe("review fix 2/3 and suggestions: funding", () => {
  const MASTER = HL_ACCOUNT;
  class Client implements FundingClient {
    calls = 0;
    payError: unknown = null;
    recent: { id: string; chain: string; address: string; createdAtMs: number; status: string }[] = [];
    recentError = false;
    statuses: Record<string, string> = {};
    getBudget() {
      return Promise.resolve({
        agentId: "hl-trader",
        status: "Active",
        remainingTodayUsdc: "50",
        vaultRemainingTodayUsdc: "1000",
        perTxLimitUsdc: "25",
        approvalThresholdUsdc: "25",
        allowedChains: ["hypercore"],
        recipientsMode: "Allowlist",
        allowlist: [{ chain: "hypercore", address: MASTER }],
        vaultPaused: false,
        vaultBalanceUsdc: "500",
        minPaymentUsdc: "1",
        paymentsLeftToday: 2,
      } as Awaited<ReturnType<FundingClient["getBudget"]>>);
    }
    requestPayment() {
      this.calls += 1;
      if (this.payError instanceof Error) return Promise.reject(this.payError);
      return Promise.resolve({ status: "submitted", payoutId: "9" } as Awaited<ReturnType<FundingClient["requestPayment"]>>);
    }
    getPaymentStatus(id: string) {
      return Promise.resolve({ payoutId: id, status: this.statuses[id] ?? "Sent" } as Awaited<ReturnType<FundingClient["getPaymentStatus"]>>);
    }
    listRecentPayouts() {
      return this.recentError ? Promise.reject(new Error("rpc")) : Promise.resolve(this.recent);
    }
  }
  let now = 1_000_000_000;
  const mk = (c: Client, dir: string, o: Partial<FundingConfig> = {}) =>
    new Funder(c, { enabled: true, masterAddress: MASTER, topupUsdc: "20", floorUsdc: "10", stateDir: dir, now: () => now, ...o });
  const low = { state: "running" as const, freeUsdc: "3" };
  const dirOf = () => mkdtempSync(join(tmpdir(), "funding-fix-"));
  const marker = (dir: string): unknown => (JSON.parse(readFileSync(join(dir, "funding.json"), "utf8")) as { inflight: unknown }).inflight;

  it("VAULT_ERROR from a signed call keeps the attempt marker (ambiguous)", async () => {
    const c = new Client();
    const dir = dirOf();
    c.payError = new SdkError("VAULT_ERROR", "view failed after signing");
    const r = await mk(c, dir).maybeTopUp(low);
    expect(r.action).toBe("ambiguous");
    expect(marker(dir)).toMatchObject({ kind: "attempt" });
  });

  it("a pre-signing code clears the marker", async () => {
    for (const code of ["INVALID_INPUT", "ONECLICK_ERROR", "QUOTE_CHECK_FAILED", "UNSUPPORTED_ASSET", "NO_SIGNING_KEY"] as const) {
      const c = new Client();
      const dir = dirOf();
      c.payError = new SdkError(code, "x");
      expect((await mk(c, dir).maybeTopUp(low)).action).toBe("error");
      expect(marker(dir)).toBeNull();
    }
  });

  it("an expired attempt is adopted when the vault shows a matching payout", async () => {
    const c = new Client();
    const dir = dirOf();
    c.payError = new SdkError("AMBIGUOUS_SUBMISSION", "timeout");
    await mk(c, dir).maybeTopUp(low);
    expect(c.calls).toBe(1);
    c.recent = [{ id: "41", chain: "hypercore", address: MASTER.toLowerCase(), createdAtMs: now + 5_000, status: "Sent" }];
    now += 3 * HOUR;
    const r = await mk(c, dir).maybeTopUp(low);
    expect(r).toMatchObject({ action: "skipped", reason: "in_flight" });
    expect(c.calls).toBe(1); // no duplicate
    expect(marker(dir)).toMatchObject({ kind: "payout", payoutId: "41" });
  });

  it("an expired attempt stays blocked while the vault list cannot be read, and clears when the vault says nothing exists", async () => {
    const c = new Client();
    const dir = dirOf();
    c.payError = new SdkError("AMBIGUOUS_SUBMISSION", "timeout");
    await mk(c, dir).maybeTopUp(low);
    c.payError = null;
    now += 3 * HOUR;
    c.recentError = true;
    expect(await mk(c, dir).maybeTopUp(low)).toMatchObject({ action: "skipped", reason: "in_flight" });
    expect(c.calls).toBe(1);
    c.recentError = false;
    c.recent = [{ id: "3", chain: "hypercore", address: MASTER, createdAtMs: now - 10 * HOUR, status: "Confirmed" }]; // older payout: not ours
    expect((await mk(c, dir).maybeTopUp(low)).action).toBe("submitted");
    expect(c.calls).toBe(2);
  });

  it("a fresh attempt is adopted even before it expires (crash between the call and the save)", async () => {
    const c = new Client();
    const dir = dirOf();
    c.payError = new SdkError("AMBIGUOUS_SUBMISSION", "timeout");
    await mk(c, dir).maybeTopUp(low);
    c.recent = [{ id: "50", chain: "hypercore", address: MASTER, createdAtMs: now + 1, status: "Transferring" }];
    now += 60_000;
    await mk(c, dir).maybeTopUp(low);
    expect(marker(dir)).toMatchObject({ kind: "payout", payoutId: "50" });
  });

  it("no top-up while equity already covers the position cap plus the floor", async () => {
    const c = new Client();
    const r = await mk(c, dirOf()).maybeTopUp({ ...low, equityUsdc: "60", maxPositionUsdc: "40" });
    expect(r).toMatchObject({ action: "skipped", reason: "equity_sufficient" });
    expect(c.calls).toBe(0);
  });

  it("a Confirmed top-up with no ledger inflow blocks further top-ups until cleared", async () => {
    const c = new Client();
    const dir = dirOf();
    const none = { ...low, inflowSince: () => Promise.resolve("0") };
    await mk(c, dir).maybeTopUp(low); // submitted, payout 9
    c.statuses["9"] = "Confirmed";
    now += 60_000;
    expect(await mk(c, dir).maybeTopUp(none)).toMatchObject({ reason: "settling" });
    now += 11 * 60_000;
    expect(await mk(c, dir).maybeTopUp(none)).toMatchObject({ action: "skipped", reason: "not_credited" });
    now += 5 * HOUR;
    expect(await mk(c, dir).maybeTopUp({ ...low, inflowSince: () => Promise.resolve("19.9") })).toMatchObject({ reason: "not_credited" }); // sticky
    expect(c.calls).toBe(1);
    mk(c, dir).clearInFlight();
    expect((await mk(c, dir).maybeTopUp(low)).action).toBe("submitted");
  });

  it("a credited top-up that the engine already spent (free USDC did not rise) does not block", async () => {
    const c = new Client();
    const dir = dirOf();
    const since: number[] = [];
    const inflow = {
      ...low,
      inflowSince: (s: number) => {
        since.push(s);
        return Promise.resolve("19.96");
      },
    };
    await mk(c, dir).maybeTopUp(low);
    c.statuses["9"] = "Confirmed";
    now += 60_000;
    await mk(c, dir).maybeTopUp(inflow);
    now += 11 * 60_000;
    await mk(c, dir).maybeTopUp({ ...inflow, freeUsdc: "25" }); // runs the credit check only
    expect(since).toHaveLength(1);
    now += HOUR;
    const last = await mk(c, dir).maybeTopUp(low);
    expect(last).toMatchObject({ action: "submitted" });
  });

  it("an unreadable ledger neither blocks nor clears the check", async () => {
    const c = new Client();
    const dir = dirOf();
    await mk(c, dir).maybeTopUp(low);
    c.statuses["9"] = "Confirmed";
    now += 60_000;
    await mk(c, dir).maybeTopUp(low);
    now += 11 * 60_000;
    expect((await mk(c, dir).maybeTopUp({ ...low, inflowSince: () => Promise.reject(new Error("hl down")) })).action).toBe("submitted");
  });
});

describe("review suggestion: price and size are asserted before signing", () => {
  it("refuses a price with too many significant figures and a size with too many decimals", async () => {
    const tokens = [
      { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, isCanonical: true },
      { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 150, isCanonical: true },
    ];
    const meta = { universe: [{ tokens: [150, 0], name: "@107", index: 107, isCanonical: true }], tokens };
    const info = { spotMetaAndAssetCtxs: vi.fn(() => Promise.resolve([meta, [{ coin: "@107", midPx: "84", dayNtlVlm: "1", markPx: "1", prevDayPx: "1" }]])) };
    const ex = { order: vi.fn(() => Promise.resolve({})) };
    const hl = new NktkasHl({ info: info as unknown as HlInfoApi, exchange: ex as unknown as HlExchangeApi });
    const base = { assetId: 10107, isBuy: true, tif: "Ioc" as const, cloid: `0x${"ab".repeat(16)}` };
    await expect(hl.placeSpotOrder({ ...base, price: "84.123456", size: "0.12" })).rejects.toThrow(/tick rules/);
    await expect(hl.placeSpotOrder({ ...base, price: "84.3", size: "0.123" })).rejects.toThrow(/lot size/);
    expect(ex.order).not.toHaveBeenCalled();
  });
});

describe("vaultViewFromBudget: unknown agent", () => {
  it("explains a missing hl-trader agent instead of a schema error", async () => {
    const { vaultViewFromBudget } = await import("../../src/trading/service.js");
    expect(() => vaultViewFromBudget(null, "hl-trader")).toThrow(/agent 'hl-trader' not found in the vault/);
  });
});

describe("dead-man volume gate through the service (FakeHl returns HL's refusal)", () => {
  const GATE = new Error("Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.");
  it("trades with IOC, reports dead_man.available=false, and limit orders only warn in the challenge", async () => {
    const h = harness({ topup: false });
    h.hl.scheduleCancelError = GATE;
    await h.confirmDirect(dcaRules());
    expect(h.hl.placed).toHaveLength(1);
    expect(h.hl.placed[0]?.tif).toBe("Ioc");
    const st = h.service.status();
    expect(st.state).toBe("running");
    expect(st.dead_man).toMatchObject({ available: false, reason: "DEADMAN_VOLUME_GATED" });
    expect(h.service.deadManAvailable()).toBe(false);
    const limit = dcaRules();
    limit.rules[0] = { id: "lim", pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "0.5", ttl: "1h" } } };
    const ch = await h.confirmer.challenge(limit);
    expect(ch.warnings.some((w) => w.startsWith("LIMIT_NEEDS_DEADMAN"))).toBe(true);
  });
});
