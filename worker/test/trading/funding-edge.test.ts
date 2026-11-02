/**
 * Funding money-path edge cases not covered by funding.test.ts: budget races, vault paused mid-flight, restart with
 * persisted markers (Funder and TradingService.resumeWatches), Refunded payouts, allowlist variants, exact boundaries.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Funder } from "../../src/trading/funding.js";
import type { FundingClient, FundingConfig, VaultPayoutLite } from "../../src/trading/funding.js";
import type { TradingState } from "../../src/trading/types.js";
import { harness } from "./harness.js";
import { HL_ACCOUNT } from "./fixtures.js";

const MASTER = "0xAbCdEf0123456789aBcDeF0123456789abCDEF01";
const HOUR = 3_600_000;
type Budget = Awaited<ReturnType<FundingClient["getBudget"]>>;
type Outcome = Awaited<ReturnType<FundingClient["requestPayment"]>>;

const goodBudget = (): Budget => ({
  agentId: "hl-trader",
  status: "Active",
  remainingTodayUsdc: "50",
  vaultRemainingTodayUsdc: "1000",
  perTxLimitUsdc: "25",
  approvalThresholdUsdc: "25",
  allowedChains: ["hypercore"],
  recipientsMode: "Allowlist",
  allowlist: [{ chain: "hypercore", address: MASTER.toLowerCase(), label: "Owner HL" }],
  vaultPaused: false,
  vaultBalanceUsdc: "500",
  minPaymentUsdc: "1",
  paymentsLeftToday: 2,
});

class FakeClient implements FundingClient {
  budget: Budget = goodBudget();
  budgetReads = 0;
  outcome: Outcome = { status: "submitted", payoutId: "7" };
  statuses: Record<string, string> = {};
  calls: { chain: string; address: string; amountUsdc: string }[] = [];
  /** Runs between the budget read and the payment request (simulates the vault changing in between). */
  beforePay: (() => void) | null = null;
  /** What the vault's payout list says (attempt reconciliation); `null` = unreadable. */
  recent: VaultPayoutLite[] | null = [];
  listRecentPayouts() {
    return this.recent === null ? Promise.reject(new Error("rpc")) : Promise.resolve(structuredClone(this.recent));
  }
  getBudget() {
    this.budgetReads += 1;
    return Promise.resolve(structuredClone(this.budget));
  }
  requestPayment(req: Parameters<FundingClient["requestPayment"]>[0]) {
    this.beforePay?.();
    this.calls.push(req);
    return Promise.resolve(this.outcome);
  }
  getPaymentStatus(id: string) {
    return Promise.resolve({ payoutId: id, status: this.statuses[id] ?? "Sent" } as Awaited<ReturnType<FundingClient["getPaymentStatus"]>>);
  }
}

let now: number;
let dir: string;
let client: FakeClient;
const cfg = (o: Partial<FundingConfig> = {}): FundingConfig => ({ enabled: true, masterAddress: MASTER, topupUsdc: "20", floorUsdc: "10", stateDir: dir, now: () => now, ...o });
const funder = (o: Partial<FundingConfig> = {}) => new Funder(client, cfg(o));
const low = { state: "running" as TradingState, freeUsdc: "3.5" };
const persisted = () => JSON.parse(readFileSync(join(dir, "funding.json"), "utf8")) as Record<string, unknown>;
const writeState = (p: Record<string, unknown>): void => {
  writeFileSync(join(dir, "funding.json"), JSON.stringify({ inflight: null, lastFailureAtMs: null, lastFailureReason: null, lastConfirmedAtMs: null, ...p }));
};

beforeEach(() => {
  now = 1_800_000_000_000;
  dir = mkdtempSync(join(tmpdir(), "funding-edge-"));
  client = new FakeClient();
});

describe("budget changes between the check and the request", () => {
  it("the vault tightens the budget in between: the vault's rejection is honoured, no retry, back-off", async () => {
    client.beforePay = () => {
      client.budget.remainingTodayUsdc = "5";
    };
    client.outcome = { status: "rejected", reason: "daily_limit", detail: "remaining 5 < 20" };
    expect(await funder().maybeTopUp(low)).toEqual({ action: "rejected", reason: "daily_limit", detail: "remaining 5 < 20" });
    expect(client.calls).toHaveLength(1);
    expect(persisted()["inflight"]).toBeNull();
    expect(persisted()["lastFailureReason"]).toContain("daily_limit");
    // Next tick inside the back-off: no budget read, no call.
    const reads = client.budgetReads;
    now += 10 * 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff" });
    expect(client.budgetReads).toBe(reads);
    // After the back-off the fresh budget (still 5) refuses locally: never a smaller "fitting" amount.
    now += HOUR;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "budget_insufficient" });
    expect(client.calls).toHaveLength(1);
  });

  it("the budget is re-read on every decision (no cache): a mandate fixed later unblocks, one broken later blocks", async () => {
    client.budget.allowlist.push({ chain: "hypercore", address: MASTER.toLowerCase() });
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "mandate_mismatch" });
    client.budget = goodBudget();
    expect((await funder().maybeTopUp(low)).action).toBe("submitted");
    client.statuses["7"] = "Confirmed";
    now += 11 * 60_000;
    await funder().maybeTopUp(low); // clears in-flight, then settling
    now += 11 * 60_000;
    client.budget.allowlist.push({ chain: "base", address: MASTER.toLowerCase() });
    // the top-up was credited (free rose above 3.5) and spent again down to 4: below the floor, mandate now broken
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "4" })).toMatchObject({ reason: "mandate_mismatch" });
    expect(client.calls).toHaveLength(1);
    expect(client.budgetReads).toBe(3);
  });
});

describe("vault paused mid-flight", () => {
  it("paused after submit: stays in flight while Sent, then Failed -> back-off, then still paused -> nothing sent", async () => {
    expect((await funder().maybeTopUp(low)).action).toBe("submitted");
    client.budget.vaultPaused = true;
    now += 5 * 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    client.statuses["7"] = "Failed";
    now += 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff" });
    now += HOUR + 1;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "agent_not_active", detail: "vault paused" });
    expect(client.calls).toHaveLength(1);
  });

  it("vault paused between the budget read and the call: the contract rejects, the funder backs off", async () => {
    client.beforePay = () => {
      client.budget.vaultPaused = true;
    };
    client.outcome = { status: "rejected", reason: "paused", detail: "vault is paused" };
    expect((await funder().maybeTopUp(low)).action).toBe("rejected");
    now += HOUR + 1;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "agent_not_active" });
    expect(client.calls).toHaveLength(1);
  });

  it("service: vault paused on-chain -> engine paused_onchain -> funder never asked for money", async () => {
    const h = harness();
    h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "1", hold: "0" }]);
    h.vault.view = { ...h.vault.view, vaultPaused: true };
    await h.service.tick();
    expect(h.service.status().state).toBe("paused_onchain");
    expect(h.client.requests).toEqual([]);
  });
});

describe("restart with persisted markers", () => {
  it("attempt marker from a crashed process: blocks for 2 h from its own timestamp, then the budget is checked again", async () => {
    writeState({ inflight: { kind: "attempt", atMs: now - HOUR, amountUsdc: "20" } });
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    expect(client.budgetReads).toBe(0);
    now += HOUR - 1;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    now += 1;
    client.budget.paymentsLeftToday = 0;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "budget_insufficient" });
    expect(persisted()["inflight"]).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it("an attempt marker is resolved before the balance decides (the earlier top-up may have landed)", async () => {
    writeState({ inflight: { kind: "attempt", atMs: now, amountUsdc: "20" } });
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "25" })).toMatchObject({ reason: "in_flight" });
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    expect(client.calls).toEqual([]);
  });

  it("attempt marker whose payout DID reach the vault: adopted as that payout, never a second request", async () => {
    writeState({ inflight: { kind: "attempt", atMs: now - 3 * HOUR, amountUsdc: "20" } });
    client.recent = [{ id: "55", chain: "hypercore", address: MASTER.toLowerCase(), createdAtMs: now - 3 * HOUR + 1_000, status: "Sent" }];
    const r = await funder().maybeTopUp(low);
    expect(r).toMatchObject({ reason: "in_flight" });
    expect(r.action === "skipped" ? r.detail : "").toContain("adopted payout 55");
    expect(persisted()["inflight"]).toMatchObject({ kind: "payout", payoutId: "55" });
    client.statuses["55"] = "Refunded";
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff", detail: "payout 55 ended as Refunded" });
    expect(client.calls).toEqual([]);
  });

  it("attempt marker: a payout to another address or created long before the attempt is not adopted", async () => {
    writeState({ inflight: { kind: "attempt", atMs: now - 3 * HOUR, amountUsdc: "20" } });
    client.recent = [
      { id: "60", chain: "hypercore", address: "0x2222222222222222222222222222222222222222", createdAtMs: now - 3 * HOUR, status: "Sent" },
      { id: "61", chain: "hypercore", address: MASTER.toLowerCase(), createdAtMs: now - 5 * HOUR, status: "Confirmed" },
    ];
    expect((await funder().maybeTopUp(low)).action).toBe("submitted");
    expect(client.calls).toHaveLength(1);
  });

  it("attempt marker past 2 h with an unreadable vault payout list stays blocked (fail closed)", async () => {
    writeState({ inflight: { kind: "attempt", atMs: now - 3 * HOUR, amountUsdc: "20" } });
    client.recent = null;
    const r = await funder().maybeTopUp(low);
    expect(r).toMatchObject({ reason: "in_flight" });
    expect(r.action === "skipped" ? r.detail : "").toContain("unreadable");
    expect(client.calls).toEqual([]);
  });

  it("payout marker without a payoutId (corrupt) stays blocked until the safety valve", async () => {
    writeState({ inflight: { kind: "payout", atMs: now, amountUsdc: "20" } });
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    now += 79 * HOUR;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    expect(client.calls).toEqual([]);
  });

  it("service start: a payout in flight that is still Sent is watched again (terminal status gets reported)", async () => {
    const h = harness();
    writeFileSync(join(h.dir, "funding.json"), JSON.stringify({ inflight: { kind: "payout", payoutId: "42", atMs: h.clock.t, amountUsdc: "20" }, lastFailureAtMs: null, lastFailureReason: null, lastConfirmedAtMs: null }));
    h.hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "1", hold: "0" }]);
    h.service.start();
    await h.service.tick();
    await new Promise((r) => setTimeout(r, 10));
    h.service.stop();
    expect(h.client.watched).toEqual(["42"]);
    expect(h.client.requests).toEqual([]); // the in-flight payout blocks a second one
  });
});

describe("payout reported Refunded", () => {
  it("clears in-flight with the reason, backs off, and the retry is exactly one full top-up", async () => {
    expect((await funder().maybeTopUp(low)).action).toBe("submitted");
    client.statuses["7"] = "Refunded";
    now += 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff", detail: "payout 7 ended as Refunded" });
    expect(persisted()["inflight"]).toBeNull();
    now += HOUR;
    client.outcome = { status: "submitted", payoutId: "8" };
    expect(await funder().maybeTopUp(low)).toEqual({ action: "submitted", payoutId: "8" });
    expect(client.calls.map((c) => c.amountUsdc)).toEqual(["20", "20"]);
  });
});

describe("allowlist variants that must refuse", () => {
  const variants: [string, (b: Budget) => void][] = [
    ["the master address twice", (b) => b.allowlist.push({ chain: "hypercore", address: MASTER })],
    ["master on hypercore plus master on another chain", (b) => b.allowlist.push({ chain: "arb", address: MASTER })],
    ["a second hypercore address", (b) => b.allowlist.push({ chain: "hypercore", address: "0x2222222222222222222222222222222222222222" })],
    ["extra entry first, master second", (b) => b.allowlist.unshift({ chain: "hypercore", address: "0x2222222222222222222222222222222222222222" })],
    ["master address with a near-miss chain", (b) => (b.allowlist = [{ chain: "hypercore-testnet", address: MASTER }])],
    ["Fixed mode", (b) => (b.recipientsMode = "Fixed" as Budget["recipientsMode"])],
    ["allowed_chains is another single chain", (b) => (b.allowedChains = ["base"])],
  ];
  for (const [name, m] of variants) {
    it(name, async () => {
      m(client.budget);
      expect(await funder().maybeTopUp(low)).toMatchObject({ action: "skipped", reason: "mandate_mismatch" });
      expect(client.calls).toEqual([]);
    });
  }
});

describe("amount boundaries (top-up = 20 USDC)", () => {
  const ok: [string, (b: Budget) => void][] = [
    ["per_tx exactly 20", (b) => (b.perTxLimitUsdc = "20")],
    ["remaining today exactly 20", (b) => (b.remainingTodayUsdc = "20.000000")],
    ["vault remaining exactly 20", (b) => (b.vaultRemainingTodayUsdc = "20")],
    ["vault balance exactly 20", (b) => (b.vaultBalanceUsdc = "20")],
    ["min payment exactly 20", (b) => (b.minPaymentUsdc = "20")],
    ["one payment left", (b) => (b.paymentsLeftToday = 1)],
  ];
  for (const [name, m] of ok) {
    it(`sends at ${name}`, async () => {
      m(client.budget);
      expect((await funder().maybeTopUp(low)).action).toBe("submitted");
      expect(client.calls).toEqual([{ chain: "hypercore", address: MASTER, amountUsdc: "20", memo: "hl-trader top-up" }]);
    });
  }
  const no: [string, (b: Budget) => void][] = [
    ["per_tx 1 micro below", (b) => (b.perTxLimitUsdc = "19.999999")],
    ["remaining 1 micro below", (b) => (b.remainingTodayUsdc = "19.999999")],
    ["remaining below with 7 decimals (truncated, still below)", (b) => (b.remainingTodayUsdc = "19.9999999")],
    ["vault remaining 1 micro below", (b) => (b.vaultRemainingTodayUsdc = "19.999999")],
    ["vault balance 1 micro below", (b) => (b.vaultBalanceUsdc = "19.999999")],
    ["min payment 1 micro above", (b) => (b.minPaymentUsdc = "20.000001")],
  ];
  for (const [name, m] of no) {
    it(`refuses at ${name}`, async () => {
      m(client.budget);
      expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "budget_insufficient" });
      expect(client.calls).toEqual([]);
    });
  }
  it("floor boundary: free == floor is above the floor; 1 micro below tops up", async () => {
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "10" })).toMatchObject({ reason: "above_floor" });
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "10.000000" })).toMatchObject({ reason: "above_floor" });
    expect((await funder().maybeTopUp({ state: "running", freeUsdc: "9.999999" })).action).toBe("submitted");
  });
  it("negative or signed free balance is not a number to top up on", async () => {
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "-1" })).toMatchObject({ reason: "bad_balance" });
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "+1" })).toMatchObject({ reason: "bad_balance" });
    expect(client.calls).toEqual([]);
  });
});
