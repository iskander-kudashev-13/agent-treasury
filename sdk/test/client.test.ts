import { describe, expect, it } from "vitest";
import { createTreasuryClient, SdkError } from "../src/index.js";
import type { PaymentOutcome, TreasuryClientConfig } from "../src/index.js";
import type { StatusResponse } from "../src/oneclick.js";
import { AGENT_ACCOUNT, BASE_ASSET, budget, EVM, FakeOneClick, FakeVault, NOW, ORIGIN_ASSET, payout, VAULT } from "./fakes.js";

function setup(over: Partial<TreasuryClientConfig> = {}) {
  const vault = new FakeVault();
  const oneclick = new FakeOneClick();
  const logs: string[] = [];
  let clock = NOW;
  const client = createTreasuryClient({
    vaultId: VAULT,
    network: "testnet",
    agentAccountId: AGENT_ACCOUNT,
    oneclick: { baseUrl: "http://unused", mode: "live" },
    deps: {
      vault,
      oneclick,
      now: () => clock,
      sleep: () => {
        clock += 10_000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
    },
    ...over,
  });
  return { client, vault, oneclick, logs };
}

const pay = { chain: "base", address: EVM, amountUsdc: "50" };

describe("getBudget / listAllowedRecipients", () => {
  it("formats amounts as USDC strings", async () => {
    const { client, vault } = setup();
    vault.budgetView = budget({ expires_at: String(NOW + 1000) });
    const b = await client.getBudget();
    expect(b).toMatchObject({ agentId: "procurement", remainingTodayUsdc: "200", perTxLimitUsdc: "100", approvalThresholdUsdc: "100", vaultBalanceUsdc: "5000" });
    expect(b.expiresAt).toBe(new Date(NOW + 1000).toISOString());
  });

  it("lists the allowlist only in Allowlist mode", async () => {
    const { client, vault } = setup();
    expect(await client.listAllowedRecipients()).toEqual([]);
    vault.budgetView = budget({ recipients_mode: "Allowlist", allowlist: [{ chain: "base", address: EVM, label: "Acme" }] });
    expect(await client.listAllowedRecipients()).toEqual([{ chain: "base", address: EVM, label: "Acme" }]);
  });

  it("fails clearly for an account that is not an agent", async () => {
    const { client } = setup({ agentAccountId: "stranger.testnet" });
    await expect(client.getBudget()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("quotePayment", () => {
  it("combines the mandate preview with a dry quote", async () => {
    const { client, oneclick } = setup();
    const q = await client.quotePayment(pay);
    expect(q).toMatchObject({ ok: true, needsApproval: false, estimatedFeeUsdc: "0.0024", estimatedReceiveUsdc: "49.9976", estimatedArrivalS: 12 });
    expect(oneclick.quotes).toHaveLength(1);
    expect(oneclick.quotes[0]?.dry).toBe(true);
  });

  it("reports needs_approval above the threshold", async () => {
    const { client, vault } = setup();
    vault.budgetView = budget({ per_tx_limit: "500000000", remaining_today: "500000000" });
    expect((await client.quotePayment({ ...pay, amountUsdc: "150" })).needsApproval).toBe(true);
  });

  it("returns the would-reject reason and skips 1Click", async () => {
    const { client, vault, oneclick } = setup();
    vault.budgetView = budget({ remaining_today: "10000000" });
    expect(await client.quotePayment(pay)).toMatchObject({ ok: false, wouldRejectReason: "AGENT_DAILY_LIMIT_EXCEEDED", needsApproval: false });
    expect(oneclick.quotes).toHaveLength(0);
  });

  it("explains that tron has no USDC", async () => {
    const { client } = setup();
    const q = await client.quotePayment({ chain: "tron", address: "T" + "a".repeat(33), amountUsdc: "5" });
    expect(q.ok).toBe(false);
    expect(q.quoteError).toMatch(/only USDT/);
  });

  it("never signs", async () => {
    const { client, vault } = setup();
    await client.quotePayment(pay);
    expect(vault.calls).toHaveLength(0);
  });
});

describe("requestPayment", () => {
  it("builds the exact request: EXACT_INPUT, refund to vault, no msg, 30 min deadline", async () => {
    const { client, vault, oneclick } = setup();
    await client.requestPayment({ ...pay, memo: "invoice 42" });
    const q = oneclick.quotes[0];
    expect(q).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      originAsset: ORIGIN_ASSET,
      destinationAsset: BASE_ASSET,
      amount: "50000000",
      refundTo: VAULT,
      refundType: "ORIGIN_CHAIN",
      recipient: EVM,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(NOW + 30 * 60_000).toISOString(),
    });
    expect(q).not.toHaveProperty("msg");
    expect(vault.calls[0]).toEqual({
      chain: "base",
      address: EVM,
      amount: "50000000",
      memo: "invoice 42",
      depositAddress: oneclick.deposit,
      depositExpiresAtMs: NOW + 30 * 60_000,
    });
  });

  it("uses a 24 h deadline above the approval threshold", async () => {
    const { client, vault, oneclick } = setup();
    vault.budgetView = budget({ per_tx_limit: "500000000", remaining_today: "500000000" });
    vault.result = { PendingApproval: { payout_id: "9", reason: "ABOVE_THRESHOLD" } };
    const r = await client.requestPayment({ ...pay, amountUsdc: "150" });
    expect(oneclick.quotes[0]?.deadline).toBe(new Date(NOW + 24 * 3600_000).toISOString());
    expect(r).toEqual({ status: "pending_approval", payoutId: "9", reason: "ABOVE_THRESHOLD", depositExpiresAt: new Date(NOW + 24 * 3600_000).toISOString() });
    expect(oneclick.submits).toHaveLength(0);
  });

  it("accepts chain aliases and sends the canonical id", async () => {
    const { client, vault } = setup();
    await client.requestPayment({ chain: "Solana", address: "So11111111111111111111111111111111111111112", amountUsdc: "5" });
    expect(vault.calls[0]?.chain).toBe("sol");
  });

  it("maps Rejected (and still reaches the contract so it is logged)", async () => {
    const { client, vault, oneclick } = setup();
    vault.budgetView = budget({ remaining_today: "1000000" });
    vault.result = { Rejected: { reason: "AGENT_DAILY_LIMIT_EXCEEDED", detail: "Daily limit for agent 'procurement' is 200 USDC." } };
    const r = await client.requestPayment(pay);
    expect(r).toEqual({ status: "rejected", reason: "AGENT_DAILY_LIMIT_EXCEEDED", detail: "Daily limit for agent 'procurement' is 200 USDC." });
    expect(vault.calls).toHaveLength(1);
    expect(oneclick.submits).toHaveLength(0);
  });

  it("maps TransferFailed", async () => {
    const { client, vault, oneclick } = setup();
    vault.result = { TransferFailed: { payout_id: "3" } };
    expect(await client.requestPayment(pay)).toEqual({ status: "transfer_failed", payoutId: "3" });
    expect(oneclick.submits).toHaveLength(0);
  });

  it("maps Submitted: deposit/submit with the tx hash, then watches and reports", async () => {
    const { client, vault, oneclick } = setup();
    vault.payouts.set("7", payout());
    const r = await client.requestPayment(pay);
    expect(r).toEqual({ status: "submitted", payoutId: "7", nearTx: "TXHASH1" });
    expect(oneclick.submits).toEqual([{ txHash: "TXHASH1", depositAddress: oneclick.deposit, nearSenderAccount: VAULT }]);
    const w = client.watchPayment("7"); // same watch as the one started by requestPayment
    expect(await w.done).toEqual({ kind: "reported", status: "Confirmed", txHash: "0xdest" });
    expect(vault.reports).toEqual([{ payoutId: "7", status: "Confirmed", txHash: "0xdest" }]);
  });

  it("a failing deposit/submit is not fatal", async () => {
    const { client, oneclick, logs } = setup();
    oneclick.failSubmit = true;
    expect((await client.requestPayment(pay)).status).toBe("submitted");
    expect(logs.join()).toMatch(/deposit\/submit failed/);
  });

  it("rejects bad input before any network call", async () => {
    const { client, vault, oneclick } = setup();
    for (const bad of [
      { ...pay, amountUsdc: "1.2345678" },
      { ...pay, amountUsdc: "-5" },
      { ...pay, address: "0xabc" },
      { ...pay, memo: "x".repeat(141) },
      { ...pay, chain: "" },
    ]) {
      await expect(client.requestPayment(bad)).rejects.toBeInstanceOf(SdkError);
    }
    expect(oneclick.quotes).toHaveLength(0);
    expect(vault.calls).toHaveLength(0);
  });

  it("refuses tron (USDT only) before quoting", async () => {
    const { client, oneclick, vault } = setup();
    await expect(client.requestPayment({ chain: "tron", address: "T" + "a".repeat(33), amountUsdc: "5" })).rejects.toMatchObject({ code: "UNSUPPORTED_ASSET" });
    expect(oneclick.quotes).toHaveLength(0);
    expect(vault.calls).toHaveLength(0);
  });

  it("read-only client cannot request payments", async () => {
    const { client } = setup({ deps: undefined, agentPrivateKey: undefined });
    // without injected deps the real NearVaultPort is built; it must never be reached
    await expect(client.requestPayment(pay)).rejects.toMatchObject({ code: "NO_SIGNING_KEY" });
  });
});

describe("quote tampering aborts before request_payment", () => {
  const cases: [string, (r: Parameters<NonNullable<FakeOneClick["tamper"]>>[0]) => void, RegExp][] = [
    ["different recipient", (r) => (r.quoteRequest.recipient = "0x2222222222222222222222222222222222222222"), /recipient mismatch/],
    ["different destination asset", (r) => (r.quoteRequest.destinationAsset = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"), /destinationAsset/],
    ["different amountIn", (r) => (r.quote.amountIn = "49000000"), /amountIn/],
    ["different request amount", (r) => (r.quoteRequest.amount = "1"), /amount mismatch/],
    ["refund to someone else", (r) => (r.quoteRequest.refundTo = "attacker.near"), /refundTo/],
    ["non-implicit deposit address", (r) => (r.quote.depositAddress = "attacker.near"), /64-hex/],
    ["short deposit address", (r) => (r.quote.depositAddress = "ab".repeat(10)), /64-hex/],
    ["missing deposit address", (r) => delete r.quote.depositAddress, /64-hex/],
    ["deadline too close", (r) => (r.quote.deadline = new Date(NOW + 60_000).toISOString()), /deadline/],
    ["msg injected", (r) => (r.quoteRequest.msg = "x"), /msg/],
    ["dry quote returned", (r) => (r.quoteRequest.dry = true), /dry/],
    ["wrong swap type", (r) => (r.quoteRequest.swapType = "EXACT_OUTPUT"), /swapType/],
  ];
  it.each(cases)("%s", async (_name, mutate, re) => {
    const { client, vault, oneclick } = setup();
    oneclick.tamper = mutate;
    await expect(client.requestPayment(pay)).rejects.toMatchObject({ code: "QUOTE_CHECK_FAILED", message: expect.stringMatching(re) as unknown });
    expect(vault.calls).toHaveLength(0);
  });

  it("EVM address casing differences are fine", async () => {
    const { client, oneclick, vault } = setup();
    oneclick.tamper = (r) => (r.quoteRequest.recipient = EVM.toUpperCase().replace("0X", "0x"));
    expect((await client.requestPayment(pay)).status).toBe("submitted");
    expect(vault.calls).toHaveLength(1);
  });
});

const rpcStatus = (chainId: string): typeof fetch => () => Promise.resolve(new Response(JSON.stringify({ result: { chain_id: chainId } })));

describe("simulated 1Click", () => {
  it("is refused when a testnet-labelled client talks to a mainnet RPC", async () => {
    for (const fetchFn of [rpcStatus("mainnet"), (() => Promise.reject(new Error("down"))) as typeof fetch]) {
      const vault = new FakeVault();
      const client = createTreasuryClient({
        vaultId: VAULT,
        network: "testnet",
        rpcUrl: "https://free.rpc.fastnear.com",
        agentAccountId: AGENT_ACCOUNT,
        oneclick: { baseUrl: "x", mode: "simulated" },
        deps: { vault, log: () => undefined, fetchFn },
      });
      await expect(client.requestPayment(pay)).rejects.toMatchObject({ code: "CONFIG" });
      expect(vault.calls).toHaveLength(0);
    }
  });

  it("is refused on mainnet", () => {
    expect(() =>
      createTreasuryClient({ vaultId: VAULT, network: "mainnet", agentAccountId: AGENT_ACCOUNT, oneclick: { baseUrl: "x", mode: "simulated" } }),
    ).toThrow(/only allowed with network "testnet"/);
  });

  it("works end to end on testnet with a fake vault", async () => {
    const vault = new FakeVault();
    const client = createTreasuryClient({
      vaultId: VAULT,
      network: "testnet",
      agentAccountId: AGENT_ACCOUNT,
      oneclick: { baseUrl: "x", mode: "simulated" },
      deps: { vault, log: () => undefined, sleep: () => Promise.resolve(), fetchFn: rpcStatus("testnet") },
    });
    vault.payouts.set("7", payout());
    const r: PaymentOutcome = await client.requestPayment(pay);
    expect(r.status).toBe("submitted");
    expect(vault.calls[0]?.depositAddress).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("watchPayment / getPaymentStatus", () => {
  it("polls until terminal and maps REFUNDED / FAILED", async () => {
    const table: [StatusResponse, { status: string; txHash: string | undefined }][] = [
      [{ status: "REFUNDED", swapDetails: { originChainTxHashes: [{ hash: "ORIG" }] } }, { status: "Refunded", txHash: "ORIG" }],
      [{ status: "FAILED" }, { status: "Failed", txHash: undefined }],
    ];
    for (const [s, expected] of table) {
      const { client, vault, oneclick } = setup();
      vault.payouts.set("7", payout());
      oneclick.statuses = [{ status: "PENDING_DEPOSIT" }, { status: "PROCESSING" }, s];
      const out = await client.watchPayment("7").done;
      expect(out).toMatchObject({ kind: "reported", status: expected.status });
      expect(vault.reports).toEqual([{ payoutId: "7", status: expected.status, txHash: expected.txHash }]);
      expect(oneclick.statusCalls).toBe(3);
    }
  });

  it("is idempotent per payout and can be cancelled / times out", async () => {
    const { client, vault, oneclick } = setup({ watchTimeoutMs: 60_000 });
    vault.payouts.set("7", payout());
    oneclick.statuses = [{ status: "PROCESSING" }];
    const a = client.watchPayment("7");
    expect(client.watchPayment("7")).toBe(a);
    expect(await a.done).toEqual({ kind: "timeout" });
    vault.payouts.set("8", payout({ id: "8" }));
    const b = client.watchPayment("8");
    b.cancel();
    expect(await b.done).toEqual({ kind: "cancelled" });
    expect(vault.reports).toHaveLength(0);
  });

  it("retries report_payout_status", async () => {
    const { client, vault } = setup();
    vault.payouts.set("7", payout());
    vault.reportFailures = 2;
    expect(await client.watchPayment("7").done).toMatchObject({ kind: "reported" });
  });

  it("does not watch other agents' payouts", async () => {
    const { client, vault } = setup();
    vault.payouts.set("7", payout({ agent_id: "payroll" }));
    expect(await client.watchPayment("7").done).toMatchObject({ kind: "error" });
    await expect(client.getPaymentStatus("7")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getPaymentStatus merges vault and 1Click data", async () => {
    const { client, vault, oneclick } = setup();
    vault.payouts.set("7", payout({ status: "Confirmed" }));
    oneclick.statuses = [{ status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ hash: "0xdest" }] } }];
    expect(await client.getPaymentStatus("7")).toEqual({
      payoutId: "7",
      status: "Confirmed",
      chain: "base",
      address: EVM,
      amountUsdc: "50",
      source: "on_demand",
      memo: "invoice 42",
      nearTx: "TXHASH1",
      intentsStatus: "SUCCESS",
      destinationTx: "0xdest",
    });
    client.stop();
  });

  it("getPaymentStatus skips 1Click for payments awaiting approval", async () => {
    const { client, vault, oneclick } = setup();
    vault.payouts.set("7", payout({ status: "PendingApproval" }));
    const s = await client.getPaymentStatus("7");
    expect(s.status).toBe("PendingApproval");
    expect(oneclick.statusCalls).toBe(0);
  });
});
