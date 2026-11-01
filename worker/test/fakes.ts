import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { PayoutLoop } from "../src/payout-loop.js";
import type { LoopSettings, OneClickPort } from "../src/payout-loop.js";
import { OneClickClient } from "../src/oneclick.js";
import type { ReportedStatus, Vault, VaultPayout, VaultRecipient, VaultSchedule } from "../src/vault.js";

export const VAULT_ID = "vault.test.near";
export const AGENT_ID = "a".repeat(64);
export const TREASURY = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_USDC = `nep141:${TREASURY}`;
export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const DEPOSIT = "b".repeat(64);
export const RECIPIENT_ADDR = "0x1111111111111111111111111111111111111111";

/** Address book entry. */
export function recipient(over: Partial<VaultRecipient> = {}): VaultRecipient {
  return {
    id: 0,
    label: "Maria",
    destination_chain: "base",
    destination_asset: BASE_USDC,
    destination_address: RECIPIENT_ADDR,
    ...over,
  };
}

export function schedule(over: Partial<VaultSchedule> = {}): VaultSchedule {
  return {
    id: 0,
    recipient_id: 0,
    amount: "1000000",
    frequency: "Once",
    start_at: "1",
    agent_id: "payroll",
    status: "Active",
    next_due_at: "1",
    open_payout: null,
    paid_count: 0,
    failed_attempts: 0,
    ...over,
  };
}

export type VaultMode = "ok" | "pending" | "rejected" | "throw_after_execute" | "throw_no_effect" | "transfer_fails";

export interface PaymentCall {
  scheduleId: number;
  depositAddress: string;
  depositExpiresAtMs: number;
}

export class FakeVault implements Vault {
  recipients: VaultRecipient[] = [recipient()];
  schedules: VaultSchedule[] = [schedule()];
  /** Marks every due item overdue (the vault then parks the payment for approval). */
  overdue = false;
  payouts: VaultPayout[] = [];
  paused = false;
  agentStatus = "Active";
  approvalThreshold = "1000000000";
  mode: VaultMode = "ok";
  requestCalls: PaymentCall[] = [];
  reports: { payoutId: string; status: ReportedStatus; txHash: string | undefined }[] = [];
  reportFailures = 0;

  getContractInfo() {
    return Promise.resolve({ owner_id: "owner.near", treasury_token: TREASURY, requires_tee: false });
  }
  isPaused() {
    return Promise.resolve(this.paused);
  }
  getAgentBudget() {
    return Promise.resolve({
      agent_id: "payroll",
      remaining_today: "100000000",
      vault_remaining_today: "100000000",
      per_tx_limit: "5000000000",
      approval_threshold: this.approvalThreshold,
      allowed_chains: ["base"],
      recipients_mode: "Fixed",
      recipients: [0],
      expires_at: null,
      status: this.agentStatus,
      vault_paused: this.paused,
      balance: "100000000",
    });
  }
  getRejections() {
    return Promise.resolve([]);
  }
  getDue() {
    const now = Date.now();
    return Promise.resolve(
      this.schedules
        .filter((s) => s.status === "Active" && s.open_payout === null && s.next_due_at !== null && Number(s.next_due_at) <= now)
        .map((s) => ({ ...s, overdue: this.overdue })),
    );
  }
  getSchedule(id: number) {
    const s = this.schedules.find((x) => x.id === id);
    return Promise.resolve(s ? { ...s } : null);
  }
  getUpcoming() {
    return Promise.resolve([]);
  }
  getRecipient(id: number) {
    const r = this.recipients.find((x) => x.id === id);
    return Promise.resolve(r ? { ...r } : null);
  }
  getPayout(id: string) {
    const p = this.payouts.find((x) => x.id === id);
    return Promise.resolve(p ? { ...p } : null);
  }
  getRecentPayouts(limit: number) {
    return Promise.resolve(this.payouts.slice(-limit).map((p) => ({ ...p })));
  }

  private addPayout(a: PaymentCall, status: VaultPayout["status"]) {
    const sch = this.schedules.find((x) => x.id === a.scheduleId);
    const p: VaultPayout = {
      id: String(this.payouts.length),
      agent_id: "payroll",
      schedule_id: a.scheduleId,
      recipient_id: sch?.recipient_id ?? null,
      amount: sch?.amount ?? "0",
      status,
      approval_reason: status === "PendingApproval" ? (this.overdue ? "OVERDUE_NEEDS_APPROVAL" : "ABOVE_THRESHOLD") : null,
      deposit_address: a.depositAddress,
      deposit_expires_at_ms: String(a.depositExpiresAtMs),
      agent_account: AGENT_ID,
      tx_hash: null,
      created_at_ms: String(Date.now()),
      updated_at_ms: String(Date.now()),
    };
    this.payouts.push(p);
    if (sch) {
      sch.open_payout = p.id;
      // A Once schedule has a single occurrence: paying it ends the schedule.
      if (status === "Sent") {
        sch.status = "Ended";
        sch.next_due_at = null;
      }
    }
    return p;
  }

  requestPayment(a: PaymentCall) {
    this.requestCalls.push(a);
    const last = () => String(this.payouts.length - 1);
    switch (this.mode) {
      case "throw_no_effect":
        return Promise.reject(new Error("RPC timeout"));
      case "rejected":
        return Promise.resolve({ txHash: "TX_REJ", result: { Rejected: { reason: "NOT_DUE", detail: "period not elapsed" } } });
      case "pending":
        this.addPayout(a, "PendingApproval");
        return Promise.resolve({ txHash: "TX_PENDING", result: { PendingApproval: { payout_id: last(), reason: this.overdue ? "OVERDUE_NEEDS_APPROVAL" : "ABOVE_THRESHOLD" } } });
      case "transfer_fails":
        this.addPayout(a, "Failed");
        return Promise.resolve({ txHash: "TX_FAIL", result: { TransferFailed: { payout_id: last() } } });
      case "throw_after_execute":
        this.addPayout(a, "Sent");
        return Promise.reject(new Error("RPC dropped the response"));
      case "ok":
        this.addPayout(a, "Sent");
        return Promise.resolve({ txHash: "NEAR_TX_HASH", result: { Submitted: { payout_id: last() } } });
    }
  }

  reportPayoutStatus(a: { payoutId: string; status: ReportedStatus; txHash: string | undefined }) {
    if (this.reportFailures > 0) {
      this.reportFailures--;
      return Promise.reject(new Error("report failed"));
    }
    this.reports.push(a);
    const p = this.payouts.find((x) => x.id === a.payoutId);
    if (p) p.status = a.status;
    return Promise.resolve();
  }
}

export interface FakeOneClick {
  url: string;
  close: () => Promise<void>;
  quotes: Record<string, unknown>[];
  submits: Record<string, unknown>[];
  statusCalls: string[];
  /** Mutate to tamper with the real (non-dry) quote response. */
  tamper: (resp: { quoteRequest: Record<string, unknown>; quote: Record<string, unknown> }) => void;
  statusSequence: string[];
  tokens: { assetId: string; decimals: number; blockchain: string; symbol: string }[];
  quoteDelayMs: number;
  failStatusWith500: boolean;
}

/** A local Hono server that speaks enough of the 1Click API. */
export async function startFakeOneClick(): Promise<FakeOneClick> {
  const state: FakeOneClick = {
    url: "",
    close: () => Promise.resolve(),
    quotes: [],
    submits: [],
    statusCalls: [],
    tamper: () => undefined,
    statusSequence: ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"],
    tokens: [
      { assetId: NEAR_USDC, decimals: 6, blockchain: "near", symbol: "USDC" },
      { assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC" },
    ],
    quoteDelayMs: 0,
    failStatusWith500: false,
  };
  const app = new Hono();
  app.get("/v0/tokens", (c) => c.json(state.tokens));
  app.post("/v0/quote", async (c) => {
    const req = await c.req.json<Record<string, unknown>>();
    state.quotes.push(req);
    if (state.quoteDelayMs > 0) await new Promise((r) => setTimeout(r, state.quoteDelayMs));
    const dry = req.dry === true;
    const resp = {
      correlationId: "c1",
      timestamp: new Date().toISOString(),
      signature: "ed25519:x",
      quoteRequest: { ...req },
      quote: {
        ...(dry ? {} : { depositAddress: DEPOSIT }),
        amountIn: req.amount as string,
        amountOut: "997398",
        amountOutFormatted: "0.997398",
        minAmountOut: "987424",
        deadline: req.deadline as string,
        timeEstimate: 22,
        withdrawFee: "2400",
      },
    };
    if (!dry) state.tamper(resp);
    return c.json(resp);
  });
  app.post("/v0/deposit/submit", async (c) => {
    state.submits.push(await c.req.json<Record<string, unknown>>());
    return c.json({});
  });
  app.get("/v0/status", (c) => {
    state.statusCalls.push(c.req.query("depositAddress") ?? "");
    if (state.failStatusWith500) return c.json({ message: "boom" }, 500);
    const status = state.statusSequence.length > 1 ? state.statusSequence.shift() : state.statusSequence[0];
    return c.json({
      status,
      swapDetails: {
        originChainTxHashes: [{ hash: "ORIGIN_HASH" }],
        destinationChainTxHashes: status === "SUCCESS" ? [{ hash: "0xDEST", explorerUrl: "https://basescan.org/tx/0xDEST" }] : [],
      },
    });
  });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => {
      resolve(s);
    });
  });
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  return state;
}

export function makeLoop(opts: {
  vault: Vault;
  oneclickUrl: string;
  settings?: Partial<LoopSettings>;
  timeoutMs?: number;
  oneclick?: OneClickPort;
}) {
  const clock = { t: Date.now() };
  const client = new OneClickClient({ baseUrl: opts.oneclickUrl, apiKey: undefined, timeoutMs: opts.timeoutMs ?? 2000 });
  const loop = new PayoutLoop({
    vault: opts.vault,
    oneclick: opts.oneclick ?? client,
    settings: {
      dryRun: false,
      vaultId: VAULT_ID,
      agentAccountId: AGENT_ID,
      slippageBps: 100,
      quoteTtlMs: 30 * 60_000,
      approvalQuoteTtlMs: 24 * 60 * 60_000,
      pollTimeoutMs: 20 * 60_000,
      pollInitialMs: 5000,
      pollMaxMs: 30_000,
      reconcileWindow: 50,
      ...opts.settings,
    },
    // Fake clock: sleeping advances time instantly, so backoff/timeouts are tested without waiting.
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
    now: () => clock.t,
    log: () => undefined,
  });
  return { loop, clock };
}
