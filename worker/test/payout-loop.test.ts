import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE_USDC, DEPOSIT, FakeVault, NEAR_USDC, VAULT_ID, makeLoop, recipient, schedule, startFakeOneClick } from "./fakes.js";
import type { FakeOneClick } from "./fakes.js";

let oc: FakeOneClick;
let vault: FakeVault;

beforeEach(async () => {
  oc = await startFakeOneClick();
  vault = new FakeVault();
});
afterEach(async () => {
  await oc.close();
});

const realQuotes = () => oc.quotes.filter((q) => q.dry === false);

describe("happy path", () => {
  it("quotes, pays, submits the deposit, polls and reports Confirmed", async () => {
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.outcome).toBe("ok");
    const res = run?.results[0];
    expect(res?.outcome).toBe("confirmed");
    expect(res?.destinationTxHash).toBe("0xDEST");

    // dry quote first, then the real one, with the agreed parameters and no msg
    expect(oc.quotes.map((q) => q.dry)).toEqual([true, false]);
    expect(realQuotes()[0]).toMatchObject({
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: NEAR_USDC,
      destinationAsset: BASE_USDC,
      amount: "1000000",
      refundTo: VAULT_ID,
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      depositType: "ORIGIN_CHAIN",
    });
    expect(realQuotes()[0]).not.toHaveProperty("msg");
    expect(realQuotes()[0]).not.toHaveProperty("customRecipientMsg");

    expect(vault.requestCalls).toHaveLength(1);
    expect(vault.requestCalls[0]).toMatchObject({ scheduleId: 0, depositAddress: DEPOSIT });
    // deposit_expires_at_ms = the quote deadline (30 min for a normal payment)
    const exp = vault.requestCalls[0]?.depositExpiresAtMs ?? 0;
    expect(exp - Date.now()).toBeGreaterThan(25 * 60_000);
    expect(exp - Date.now()).toBeLessThan(31 * 60_000);
    expect(oc.submits).toEqual([{ txHash: "NEAR_TX_HASH", depositAddress: DEPOSIT, nearSenderAccount: "a".repeat(64) }]);
    expect(vault.reports).toEqual([{ payoutId: "0", status: "Confirmed", txHash: "0xDEST" }]);
  });

  it("is single-flight", async () => {
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const [a, b] = await Promise.all([loop.run("manual"), loop.run("manual")]);
    expect([a, b].filter((x) => x === undefined)).toHaveLength(1);
    expect(vault.requestCalls).toHaveLength(1);
  });

  it("keeps a bounded ring buffer of runs, newest first", async () => {
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    vault.schedules = [];
    for (let i = 0; i < 55; i++) await loop.run("schedule");
    const runs = loop.recentRuns();
    expect(runs).toHaveLength(50);
    expect(runs[0]?.id).toBe(55);
  });

  it("does nothing while the vault is paused", async () => {
    vault.paused = true;
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    await loop.run("manual");
    expect(oc.quotes).toHaveLength(0);
    expect(vault.requestCalls).toHaveLength(0);
  });
});

describe("dry run", () => {
  it("only asks for dry quotes and never touches the vault's write methods", async () => {
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url, settings: { dryRun: true } });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("dry_run_quoted");
    expect(oc.quotes.every((q) => q.dry === true)).toBe(true);
    expect(vault.requestCalls).toHaveLength(0);
    expect(vault.reports).toHaveLength(0);
  });
});

describe("pending approval", () => {
  it("logs and skips: no deposit/submit, no polling", async () => {
    vault.mode = "pending";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("pending_approval");
    expect(oc.submits).toHaveLength(0);
    expect(oc.statusCalls).toHaveLength(0);
    expect(vault.reports).toHaveLength(0);
  });
});

describe("quote mismatch aborts before request_payout", () => {
  const cases: [string, (q: { quoteRequest: Record<string, unknown>; quote: Record<string, unknown> }) => void, RegExp][] = [
    ["recipient", (q) => (q.quoteRequest.recipient = "0x2222222222222222222222222222222222222222"), /recipient mismatch/],
    ["destinationAsset", (q) => (q.quoteRequest.destinationAsset = "nep141:other.omft.near"), /destinationAsset mismatch/],
    ["amountIn", (q) => (q.quote.amountIn = "2000000"), /amountIn/],
    ["refundTo", (q) => (q.quoteRequest.refundTo = "attacker.near"), /refundTo/],
    ["msg", (q) => (q.quoteRequest.msg = "x"), /msg/],
    ["depositAddress shape", (q) => (q.quote.depositAddress = "attacker.near"), /64-hex/],
    ["deadline too close", (q) => (q.quote.deadline = new Date(Date.now() + 60_000).toISOString()), /deadline/],
  ];
  it.each(cases)("%s", async (_name, tamper, re) => {
    oc.tamper = tamper;
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("aborted");
    expect(run?.results[0]?.message).toMatch(re);
    expect(vault.requestCalls).toHaveLength(0);
    expect(oc.submits).toHaveLength(0);
  });

  it("accepts EVM address casing differences only", async () => {
    vault.recipients = [recipient({ destination_address: "0xAbCdEf0000000000000000000000000000000001" })];
    oc.tamper = (q) => (q.quoteRequest.recipient = "0xabcdef0000000000000000000000000000000001");
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("confirmed");
  });

  it("rejects an asset that /v0/tokens does not list, before any quote", async () => {
    oc.tokens = oc.tokens.filter((t) => t.assetId !== BASE_USDC);
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("aborted");
    expect(oc.quotes).toHaveLength(0);
  });

  it("rejects a chain / token blockchain mismatch", async () => {
    vault.recipients = [recipient({ destination_chain: "sol" })];
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("aborted");
    expect(vault.requestCalls).toHaveLength(0);
  });
});

describe("terminal statuses", () => {
  it.each([
    ["REFUNDED", "Refunded", "refunded"],
    ["FAILED", "Failed", "failed"],
  ] as const)("%s is reported as %s", async (s, reported, outcome) => {
    oc.statusSequence = ["PROCESSING", s];
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe(outcome);
    expect(vault.reports).toEqual([{ payoutId: "0", status: reported, txHash: "ORIGIN_HASH" }]);
  });

  it("retries the (idempotent) report call", async () => {
    vault.reportFailures = 2;
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("confirmed");
    expect(vault.reports).toHaveLength(1);
  });
});

describe("request_payout ambiguity", () => {
  it("call throws but the vault shows the payout: continues, does not call again", async () => {
    vault.mode = "throw_after_execute";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(vault.requestCalls).toHaveLength(1);
    expect(run?.results[0]?.outcome).toBe("confirmed");
    // tx hash is unknown after a thrown call, so deposit/submit is skipped; polling still finishes the job
    expect(oc.submits).toHaveLength(0);
  });

  it("call throws and the vault shows nothing: aborts, never retried", async () => {
    vault.mode = "throw_no_effect";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(vault.requestCalls).toHaveLength(1);
    expect(run?.results[0]?.outcome).toBe("aborted");
    expect(oc.statusCalls).toHaveLength(0);
  });

  it("ft_transfer failure (payout Failed) is reported as failed, nothing polled", async () => {
    vault.mode = "transfer_fails";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("failed");
    expect(oc.statusCalls).toHaveLength(0);
  });
});

describe("timeouts", () => {
  it("a slow 1Click quote times out and request_payout is never called", async () => {
    oc.quoteDelayMs = 400;
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url, timeoutMs: 100 });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("error");
    expect(run?.results[0]?.message).toMatch(/timed out/);
    expect(vault.requestCalls).toHaveLength(0);
  });

  it("status polling is bounded: leaves the payout Sent, then the next run reconciles it", async () => {
    oc.statusSequence = ["PROCESSING"];
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url, settings: { pollTimeoutMs: 60_000 } });
    const first = await loop.run("manual");
    expect(first?.results[0]?.outcome).toBe("poll_timeout");
    expect(vault.reports).toHaveLength(0);
    expect(oc.statusCalls.length).toBeGreaterThan(1);
    expect(oc.statusCalls.length).toBeLessThan(15);

    oc.statusSequence = ["SUCCESS"];
    vault.schedules = []; // nothing new is due
    const second = await loop.run("schedule");
    expect(second?.reconciled).toEqual([{ payoutId: "0", status: "Confirmed" }]);
    expect(vault.reports).toEqual([{ payoutId: "0", status: "Confirmed", txHash: "0xDEST" }]);
  });

  it("tolerates transient status errors until the deadline", async () => {
    oc.failStatusWith500 = true;
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url, settings: { pollTimeoutMs: 30_000 } });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("poll_timeout");
    expect(vault.reports).toHaveLength(0);
  });
});

describe("recipients blocked by the vault", () => {
  it("skips recipients with 3 failed attempts", async () => {
    vault.schedules = [schedule({ failed_attempts: 3 })];
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results).toHaveLength(0);
    expect(oc.quotes).toHaveLength(0);
  });
});

describe("PaymentResult variants", () => {
  it("Rejected: logged in the run, not retried, nothing submitted", async () => {
    vault.mode = "rejected";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]).toMatchObject({ outcome: "rejected", message: "NOT_DUE: period not elapsed" });
    expect(vault.requestCalls).toHaveLength(1);
    expect(oc.submits).toHaveLength(0);
    expect(oc.statusCalls).toHaveLength(0);
  });

  it("PendingApproval: a 24h quote is requested above the approval threshold", async () => {
    vault.mode = "pending";
    vault.approvalThreshold = "500000"; // amount 1_000_000 is above it
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]).toMatchObject({ outcome: "pending_approval", payoutId: "0" });
    const exp = vault.requestCalls[0]?.depositExpiresAtMs ?? 0;
    expect(exp - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(oc.statusCalls).toHaveLength(0);
  });

  it("an owner-approved payout (Sent by the vault itself) is picked up and reported by the next run", async () => {
    vault.mode = "pending";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    await loop.run("manual");
    // the owner approves: the vault transfers on its own and the payout becomes Sent
    const p = vault.payouts[0];
    if (p) p.status = "Sent";
    oc.statusSequence = ["SUCCESS"];
    vault.schedules = [];
    const second = await loop.run("schedule");
    expect(second?.reconciled).toEqual([{ payoutId: "0", status: "Confirmed" }]);
    expect(vault.reports).toEqual([{ payoutId: "0", status: "Confirmed", txHash: "0xDEST" }]);
  });

  it("TransferFailed: logged as failed, no polling", async () => {
    vault.mode = "transfer_fails";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("failed");
    expect(oc.statusCalls).toHaveLength(0);
  });

  it("does nothing when the agent is paused or revoked", async () => {
    vault.agentStatus = "Paused";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    await loop.run("manual");
    expect(oc.quotes).toHaveLength(0);
  });
});

describe("schedules", () => {
  it("a Once schedule is paid exactly once across runs", async () => {
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    expect((await loop.run("manual"))?.results[0]?.outcome).toBe("confirmed");
    expect((await loop.run("schedule"))?.results).toHaveLength(0);
    expect(vault.requestCalls).toHaveLength(1);
  });

  it("a schedule that is not yet due is not paid", async () => {
    vault.schedules = [schedule({ next_due_at: String(Date.now() + 3_600_000) })];
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results).toHaveLength(0);
    expect(oc.quotes).toHaveLength(0);
  });

  it("overdue: requests a 24h quote and the vault parks it with OVERDUE_NEEDS_APPROVAL", async () => {
    vault.overdue = true;
    vault.mode = "pending";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("pending_approval");
    expect(run?.results[0]?.message).toContain("OVERDUE_NEEDS_APPROVAL");
    expect((vault.requestCalls[0]?.depositExpiresAtMs ?? 0) - Date.now()).toBeGreaterThan(23 * 3600_000);
  });

  it("pending approval above the threshold reports ABOVE_THRESHOLD", async () => {
    vault.mode = "pending";
    vault.approvalThreshold = "1";
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.message).toContain("ABOVE_THRESHOLD");
  });

  it("aborts when the recipient is missing from the address book", async () => {
    vault.recipients = [];
    const { loop } = makeLoop({ vault, oneclickUrl: oc.url });
    const run = await loop.run("manual");
    expect(run?.results[0]?.outcome).toBe("aborted");
    expect(vault.requestCalls).toHaveLength(0);
  });
});
