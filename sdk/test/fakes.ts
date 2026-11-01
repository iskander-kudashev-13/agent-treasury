import { randomBytes } from "node:crypto";
import type { OneClickPort } from "../src/client.js";
import type { QuoteRequest, QuoteResponse, StatusResponse, Token } from "../src/oneclick.js";
import type { AgentView, BudgetView, PaymentResult, ReportedStatus, RequestPaymentArgs, VaultPayout, VaultPort } from "../src/vault.js";

export const VAULT = "vault.owner.testnet";
export const AGENT_ACCOUNT = "procurement.owner.testnet";
export const TREASURY_TOKEN = "usdc.fake.testnet";
export const ORIGIN_ASSET = `nep141:${TREASURY_TOKEN}`;
export const BASE_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const EVM = "0x1111111111111111111111111111111111111111";
export const NOW = Date.parse("2026-11-10T12:00:00Z");

const tok = (assetId: string, blockchain: string, symbol: string, decimals = 6): Token => ({ assetId, decimals, blockchain, symbol });
export const TOKENS: Token[] = [
  tok(ORIGIN_ASSET, "near", "USDC"),
  tok(BASE_ASSET, "base", "USDC"),
  tok("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "sol", "USDC"),
  tok("nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", "tron", "USDT"),
];

export function budget(over: Partial<BudgetView> = {}): BudgetView {
  return {
    agent_id: "procurement",
    remaining_today: "200000000",
    vault_remaining_today: "1000000000",
    per_tx_limit: "100000000",
    approval_threshold: "100000000",
    allowed_chains: ["base", "sol", "tron"],
    recipients_mode: "Open",
    allowlist: [],
    recipients: [],
    expires_at: null,
    status: "Active",
    vault_paused: false,
    balance: "5000000000",
    min_payment: "1000000",
    max_payments_per_day: 10,
    payments_today: 0,
    ...over,
  };
}

export class FakeVault implements VaultPort {
  budgetView = budget();
  result: PaymentResult = { Submitted: { payout_id: "7" } };
  txHash: string | undefined = "TXHASH1";
  payouts = new Map<string, VaultPayout>();
  calls: RequestPaymentArgs[] = [];
  reports: { payoutId: string; status: ReportedStatus; txHash?: string | undefined }[] = [];
  reportFailures = 0;

  getContractInfo() {
    return Promise.resolve({ owner_id: "owner.testnet", treasury_token: TREASURY_TOKEN });
  }
  getAgentByAccount(accountId: string): Promise<AgentView | null> {
    return Promise.resolve(accountId === AGENT_ACCOUNT ? { id: "procurement", account_id: accountId, status: "Active" } : null);
  }
  getAgentBudget() {
    return Promise.resolve(this.budgetView);
  }
  getPayout(id: string) {
    return Promise.resolve(this.payouts.get(id) ?? null);
  }
  requestPayment(args: RequestPaymentArgs) {
    this.calls.push(args);
    return Promise.resolve({ result: this.result, txHash: this.txHash });
  }
  reportPayoutStatus(args: { payoutId: string; status: ReportedStatus; txHash?: string | undefined }) {
    if (this.reportFailures > 0) {
      this.reportFailures--;
      return Promise.reject(new Error("rpc down"));
    }
    this.reports.push(args);
    return Promise.resolve();
  }
}

export class FakeOneClick implements OneClickPort {
  quotes: QuoteRequest[] = [];
  submits: { txHash: string; depositAddress: string; nearSenderAccount: string }[] = [];
  statuses: StatusResponse[] = [{ status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ hash: "0xdest" }] } }];
  statusCalls = 0;
  /** Mutates the real-quote response to simulate a tampering / buggy 1Click. */
  tamper: ((r: QuoteResponse) => void) | undefined;
  failSubmit = false;
  deposit = randomBytes(32).toString("hex");

  getTokens() {
    return Promise.resolve(TOKENS);
  }
  findToken(assetId: string) {
    return Promise.resolve(TOKENS.find((t) => t.assetId === assetId));
  }
  quote(req: QuoteRequest): Promise<QuoteResponse> {
    this.quotes.push(req);
    const out = BigInt(req.amount) - 2400n;
    const r: QuoteResponse = {
      quoteRequest: { ...req },
      quote: {
        ...(req.dry ? {} : { depositAddress: this.deposit }),
        amountIn: req.amount,
        amountOut: out.toString(),
        minAmountOut: ((out * 99n) / 100n).toString(),
        deadline: req.deadline,
        timeEstimate: 12,
      },
    };
    if (!req.dry) this.tamper?.(r);
    return Promise.resolve(r);
  }
  submitDeposit(args: { txHash: string; depositAddress: string; nearSenderAccount: string }) {
    if (this.failSubmit) return Promise.reject(new Error("boom"));
    this.submits.push(args);
    return Promise.resolve();
  }
  getStatus(): Promise<StatusResponse> {
    const s = this.statuses[Math.min(this.statusCalls, this.statuses.length - 1)];
    this.statusCalls++;
    return Promise.resolve(s ?? { status: "PROCESSING" });
  }
}

export function payout(over: Partial<VaultPayout> = {}): VaultPayout {
  return {
    id: "7",
    agent_id: "procurement",
    chain: "base",
    address: EVM,
    amount: "50000000",
    memo: "invoice 42",
    status: "Sent",
    deposit_address: "a".repeat(64),
    deposit_expires_at_ms: null,
    tx_hash: "TXHASH1",
    ...over,
  };
}
