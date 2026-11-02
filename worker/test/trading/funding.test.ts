import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Funder, checkFundingConfig, toMicroLenient } from "../../src/trading/funding.js";
import type { FundingClient, FundingConfig } from "../../src/trading/funding.js";
import type { TradingState } from "../../src/trading/types.js";

const MASTER = "0xAbCdEf0123456789aBcDeF0123456789abCDEF01";
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
  budgetError: Error | null = null;
  outcome: Outcome = { status: "submitted", payoutId: "7" };
  payError: Error | null = null;
  statuses: Record<string, string> = {};
  statusError = false;
  calls: { chain: string; address: string; amountUsdc: string; memo?: string | undefined }[] = [];
  gate: Promise<void> | null = null;
  getBudget() {
    return this.budgetError ? Promise.reject(this.budgetError) : Promise.resolve(structuredClone(this.budget));
  }
  async requestPayment(req: Parameters<FundingClient["requestPayment"]>[0]) {
    this.calls.push(req);
    if (this.gate) await this.gate;
    if (this.payError) throw this.payError;
    return this.outcome;
  }
  recent: { id: string; chain: string; address: string; createdAtMs: number; status: string }[] = [];
  recentError = false;
  listRecentPayouts() {
    return this.recentError ? Promise.reject(new Error("rpc")) : Promise.resolve(structuredClone(this.recent));
  }
  getPaymentStatus(id: string) {
    if (this.statusError) return Promise.reject(new Error("rpc"));
    return Promise.resolve({ payoutId: id, status: this.statuses[id] ?? "Sent" } as Awaited<ReturnType<FundingClient["getPaymentStatus"]>>);
  }
}

let now: number;
let dir: string;
let client: FakeClient;
const cfg = (o: Partial<FundingConfig> = {}): FundingConfig => ({
  enabled: true,
  masterAddress: MASTER,
  topupUsdc: "20",
  floorUsdc: "10",
  stateDir: dir,
  now: () => now,
  ...o,
});
const funder = (o: Partial<FundingConfig> = {}) => new Funder(client, cfg(o));
const low = { state: "running" as TradingState, freeUsdc: "3.5" };
const persisted = () => JSON.parse(readFileSync(join(dir, "funding.json"), "utf8")) as Record<string, unknown>;
const sdkErr = (code: string) => Object.assign(new Error(`sdk ${code}`), { code });

beforeEach(() => {
  now = 1_800_000_000_000;
  dir = mkdtempSync(join(tmpdir(), "funding-"));
  client = new FakeClient();
});

describe("config checks", () => {
  it("validates address, minimum and floor", () => {
    expect(checkFundingConfig({ masterAddress: MASTER, topupUsdc: "20", floorUsdc: "10" })).toBeNull();
    expect(checkFundingConfig({ masterAddress: "0x12", topupUsdc: "20", floorUsdc: "10" })).toMatch(/HL_MASTER/);
    expect(checkFundingConfig({ masterAddress: MASTER, topupUsdc: "1.99", floorUsdc: "10" })).toMatch(/at least 2/);
    expect(checkFundingConfig({ masterAddress: MASTER, topupUsdc: "20", floorUsdc: "0" })).toMatch(/greater than 0/);
    expect(checkFundingConfig({ masterAddress: MASTER, topupUsdc: "abc", floorUsdc: "1" })).toMatch(/decimal/);
    expect(toMicroLenient("1.123456789")).toBe(1_123_456n);
    expect(toMicroLenient("-1")).toBeNull();
    expect(toMicroLenient("1e3")).toBeNull();
  });
  it("bad config sends nothing", async () => {
    expect(await funder({ topupUsdc: "1" }).maybeTopUp(low)).toMatchObject({ action: "skipped", reason: "bad_config" });
    expect(await funder({ masterAddress: "nope" }).maybeTopUp(low)).toMatchObject({ action: "skipped", reason: "bad_config" });
    expect(client.calls).toEqual([]);
  });
});

describe("when to top up", () => {
  it("disabled", async () => {
    expect(await funder({ enabled: false }).maybeTopUp(low)).toMatchObject({ reason: "disabled" });
    expect(client.calls).toEqual([]);
  });
  it("only below the floor", async () => {
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "10" })).toMatchObject({ reason: "above_floor" });
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "10.000001" })).toMatchObject({ reason: "above_floor" });
    expect(client.calls).toEqual([]);
    expect((await funder().maybeTopUp({ state: "running", freeUsdc: "9.999999" })).action).toBe("submitted");
  });
  it("blocked in halted / stopped_today / paused_onchain / error / not_configured", async () => {
    for (const state of ["halted", "stopped_today", "paused_onchain", "error", "not_configured"] as const)
      expect(await funder().maybeTopUp({ state, freeUsdc: "0" })).toMatchObject({ reason: "state_blocks" });
    expect(client.calls).toEqual([]);
  });
  it("allowed while waiting for rules or the API wallet (initial funding)", async () => {
    expect((await funder().maybeTopUp({ state: "no_rules", freeUsdc: "0" })).action).toBe("submitted");
  });
  it("unreadable balance", async () => {
    expect(await funder().maybeTopUp({ state: "running", freeUsdc: "NaN" })).toMatchObject({ reason: "bad_balance" });
    expect(client.calls).toEqual([]);
  });
});

describe("destination and mandate guards", () => {
  it("sends exactly the configured amount to the master address on hypercore", async () => {
    const r = await funder().maybeTopUp(low);
    expect(r).toEqual({ action: "submitted", payoutId: "7" });
    expect(client.calls).toEqual([{ chain: "hypercore", address: MASTER, amountUsdc: "20", memo: "hl-trader top-up" }]);
  });
  it("refuses when the allowlist differs, has extra entries, wrong chain or wrong mode", async () => {
    const mutate: ((b: Budget) => void)[] = [
      (b) => (b.allowlist = [{ chain: "hypercore", address: "0x1111111111111111111111111111111111111111" }]),
      (b) => b.allowlist.push({ chain: "base", address: "0x1111111111111111111111111111111111111111" }),
      (b) => (b.allowlist = [{ chain: "base", address: MASTER }]),
      (b) => (b.allowlist = []),
      (b) => (b.recipientsMode = "Open" as Budget["recipientsMode"]),
      (b) => (b.allowedChains = ["hypercore", "base"]),
    ];
    for (const m of mutate) {
      client.budget = goodBudget();
      m(client.budget);
      expect(await funder().maybeTopUp(low)).toMatchObject({ action: "skipped", reason: "mandate_mismatch" });
    }
    expect(client.calls).toEqual([]);
  });
  it("accepts a mixed-case allowlist address", async () => {
    client.budget.allowlist = [{ chain: "HyperCore", address: MASTER.toUpperCase().replace("0X", "0x") }];
    expect((await funder().maybeTopUp(low)).action).toBe("submitted");
  });
  it("refuses a paused / revoked agent, paused vault, expired mandate", async () => {
    for (const m of [
      (b: Budget) => (b.status = "Paused"),
      (b: Budget) => (b.status = "Revoked"),
      (b: Budget) => (b.vaultPaused = true),
      (b: Budget) => (b.expiresAt = new Date(now - 1).toISOString()),
    ]) {
      client.budget = goodBudget();
      m(client.budget);
      expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "agent_not_active" });
    }
    expect(client.calls).toEqual([]);
  });
  it("refuses locally when the budget cannot cover the whole amount (never splits)", async () => {
    for (const m of [
      (b: Budget) => (b.remainingTodayUsdc = "19.99"),
      (b: Budget) => (b.perTxLimitUsdc = "10"),
      (b: Budget) => (b.paymentsLeftToday = 0),
      (b: Budget) => (b.vaultBalanceUsdc = "5"),
      (b: Budget) => (b.vaultRemainingTodayUsdc = "1"),
      (b: Budget) => (b.minPaymentUsdc = "30"),
    ]) {
      client.budget = goodBudget();
      m(client.budget);
      expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "budget_insufficient" });
    }
    expect(client.calls).toEqual([]);
  });
  it("unreadable budget or garbage amounts in it send nothing", async () => {
    client.budgetError = new Error("rpc");
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "budget_unreadable" });
    client.budgetError = null;
    client.budget.remainingTodayUsdc = "lots";
    expect((await funder().maybeTopUp(low)).action).toBe("error");
    expect(client.calls).toEqual([]);
  });
});

describe("SDK results", () => {
  it("rejected: no retry in the back-off window, also after restart; retried after it", async () => {
    client.outcome = { status: "rejected", reason: "over_limit", detail: "too much" };
    expect(await funder().maybeTopUp(low)).toEqual({ action: "rejected", reason: "over_limit", detail: "too much" });
    expect(client.calls).toHaveLength(1);
    expect(persisted()["inflight"]).toBeNull();
    now += 59 * 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff" });
    expect(client.calls).toHaveLength(1);
    now += 2 * 60_000;
    await funder().maybeTopUp(low);
    expect(client.calls).toHaveLength(2);
  });
  it("transfer_failed: back-off, nothing in flight", async () => {
    client.outcome = { status: "transfer_failed", payoutId: "9" };
    expect(await funder().maybeTopUp(low)).toEqual({ action: "transfer_failed", payoutId: "9" });
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff" });
    expect(client.calls).toHaveLength(1);
  });
  it("pending_approval blocks further top-ups until the payout is terminal", async () => {
    client.outcome = { status: "pending_approval", payoutId: "11", depositExpiresAt: "x" };
    expect(await funder().maybeTopUp(low)).toEqual({ action: "pending_approval", payoutId: "11" });
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    }
    client.statusError = true;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    expect(client.calls).toHaveLength(1);
  });
  it("submitted -> Confirmed: clears in-flight, waits to settle, then may top up again", async () => {
    await funder().maybeTopUp(low);
    client.statuses["7"] = "Confirmed";
    now += 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "settling" });
    expect(persisted()["inflight"]).toBeNull();
    now += 11 * 60_000;
    client.outcome = { status: "submitted", payoutId: "8" };
    // The Confirmed top-up must show in the balance (3.5 -> 9) or funding stops with not_credited.
    expect(await funder().maybeTopUp({ ...low, freeUsdc: "9" })).toEqual({ action: "submitted", payoutId: "8" });
    expect(client.calls).toHaveLength(2);
  });
  it("submitted -> Failed / Refunded / Rejected: back-off applies before a retry", async () => {
    for (const st of ["Failed", "Refunded", "Rejected"]) {
      client = new FakeClient();
      dir = mkdtempSync(join(tmpdir(), "funding-"));
      await funder().maybeTopUp(low);
      client.statuses["7"] = st;
      now += 60_000;
      expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff" });
      expect(client.calls).toHaveLength(1);
    }
  });
  it("safety valve: a payout stuck for 80 h stops blocking (then back-off still applies)", async () => {
    await funder().maybeTopUp(low);
    now += 81 * 3_600_000;
    await funder().maybeTopUp(low);
    expect(client.calls).toHaveLength(1);
    now += 61 * 60_000;
    await funder().maybeTopUp(low);
    expect(client.calls).toHaveLength(2);
  });
});

describe("crash safety and ambiguity", () => {
  it("AMBIGUOUS_SUBMISSION keeps a blocking marker for 2 h", async () => {
    client.payError = sdkErr("AMBIGUOUS_SUBMISSION");
    expect((await funder().maybeTopUp(low)).action).toBe("ambiguous");
    expect(persisted()["inflight"]).toMatchObject({ kind: "attempt" });
    client.payError = null;
    now += 119 * 60_000;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    expect(client.calls).toHaveLength(1);
    now += 2 * 60_000;
    expect((await funder().maybeTopUp(low)).action).toBe("submitted");
  });
  it("an untyped exception is treated as ambiguous (the tx may have been sent)", async () => {
    client.payError = new Error("socket hang up");
    expect((await funder().maybeTopUp(low)).action).toBe("ambiguous");
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
  });
  it("a typed SDK error before signing (quote check etc.) clears the marker and backs off", async () => {
    client.payError = sdkErr("QUOTE_CHECK_FAILED");
    expect(await funder().maybeTopUp(low)).toMatchObject({ action: "error" });
    expect(persisted()["inflight"]).toBeNull();
    client.payError = null;
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "backoff" });
    expect(client.calls).toHaveLength(1);
  });
  it("the attempt marker is on disk BEFORE the signed call (crash mid-call blocks a restart)", async () => {
    let release!: () => void;
    client.gate = new Promise<void>((r) => (release = r));
    const p = funder().maybeTopUp(low);
    await vi.waitFor(() => {
      expect(persisted()["inflight"]).toMatchObject({ kind: "attempt", amountUsdc: "20" });
    });
    // "restart": a new Funder (the process died, the call result was lost)
    expect(await funder().maybeTopUp(low)).toMatchObject({ reason: "in_flight" });
    release();
    await p;
  });
  it("concurrent calls on one Funder produce one request", async () => {
    let release!: () => void;
    client.gate = new Promise<void>((r) => (release = r));
    const f = funder();
    const a = f.maybeTopUp(low);
    const b = f.maybeTopUp(low);
    const second = await b;
    release();
    await a;
    expect(second).toMatchObject({ action: "skipped", reason: "in_flight" });
    expect(client.calls).toHaveLength(1);
  });
  it("a corrupt state file never sends money (reported as error)", async () => {
    writeFileSync(join(dir, "funding.json"), "{broken");
    expect((await funder().maybeTopUp(low)).action).toBe("error");
    expect(client.calls).toEqual([]);
  });
  it("clearInFlight lets an operator release a checked attempt", async () => {
    client.payError = sdkErr("AMBIGUOUS_SUBMISSION");
    const f = funder();
    await f.maybeTopUp(low);
    client.payError = null;
    f.clearInFlight();
    expect(f.inFlight()).toBeNull();
    expect((await f.maybeTopUp(low)).action).toBe("submitted");
  });
});
