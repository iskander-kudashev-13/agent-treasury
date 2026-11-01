import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { z } from "zod";
import { SdkError, errMsg } from "./errors.js";

/**
 * JSON interface of the vault, exactly as in docs/adr/0003-agents-and-mandates.md.
 * Amounts are U128 decimal strings in USDC base units, times are U64 strings in ms.
 */
const u128 = z.string().regex(/^\d+$/);
const u64 = z.string().regex(/^\d+$/);

export const RECIPIENTS_MODES = ["Fixed", "Allowlist", "Open"] as const;
export type RecipientsMode = (typeof RECIPIENTS_MODES)[number];
export const AGENT_STATUSES = ["Active", "Paused", "Revoked"] as const;

const destinationSchema = z.looseObject({ chain: z.string(), address: z.string(), label: z.string().nullish() });
export type VaultDestination = z.infer<typeof destinationSchema>;

export const budgetViewSchema = z.looseObject({
  agent_id: z.string(),
  remaining_today: u128,
  vault_remaining_today: u128,
  per_tx_limit: u128,
  approval_threshold: u128,
  allowed_chains: z.array(z.string()),
  recipients_mode: z.enum(RECIPIENTS_MODES),
  allowlist: z.array(destinationSchema),
  recipients: z.array(z.number().int()).optional(),
  expires_at: u64.nullable(),
  status: z.enum(AGENT_STATUSES),
  vault_paused: z.boolean(),
  balance: u128,
  min_payment: u128,
  max_payments_per_day: z.number().int(),
  payments_today: z.number().int(),
});
export type BudgetView = z.infer<typeof budgetViewSchema>;

export const agentViewSchema = z.looseObject({ id: z.string(), account_id: z.string().nullable(), status: z.enum(AGENT_STATUSES) });
export type AgentView = z.infer<typeof agentViewSchema>;

export const PAYOUT_STATUSES = ["PendingApproval", "Transferring", "Sent", "Confirmed", "Failed", "Refunded", "Rejected"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export type ReportedStatus = Extract<PayoutStatus, "Confirmed" | "Refunded" | "Failed">;

export const payoutSchema = z.looseObject({
  id: u64,
  agent_id: z.string(),
  chain: z.string(),
  address: z.string(),
  amount: u128,
  memo: z.string().nullable(),
  status: z.enum(PAYOUT_STATUSES),
  deposit_address: z.string().nullable(),
  deposit_expires_at_ms: u64.nullable().optional(),
  tx_hash: z.string().nullable(),
  schedule_id: z.union([z.number().int(), u64]).nullable().optional(),
  occurrence_at: u64.nullable().optional(),
  approval_reason: z.string().nullable().optional(),
});
export type VaultPayout = z.infer<typeof payoutSchema>;

const contractInfoSchema = z.looseObject({ owner_id: z.string(), treasury_token: z.string() });
export type ContractInfo = z.infer<typeof contractInfoSchema>;

export const paymentResultSchema = z.union([
  z.object({ Rejected: z.object({ reason: z.string(), detail: z.string() }) }),
  z.object({ PendingApproval: z.object({ payout_id: u64, reason: z.string().optional() }) }),
  z.object({ Submitted: z.object({ payout_id: u64 }) }),
  z.object({ TransferFailed: z.object({ payout_id: u64 }) }),
]);
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export interface RequestPaymentArgs {
  chain: string;
  address: string;
  /** U128 base units. */
  amount: string;
  memo?: string | undefined;
  depositAddress: string;
  depositExpiresAtMs: number;
}

/** What the SDK needs from the vault. `NearVaultPort` is the real one; tests use a fake. */
export interface VaultPort {
  getContractInfo(): Promise<ContractInfo>;
  getAgentByAccount(accountId: string): Promise<AgentView | null>;
  getAgentBudget(agentId: string): Promise<BudgetView>;
  getPayout(payoutId: string): Promise<VaultPayout | null>;
  /** Signed. A rejection is AMBIGUOUS (`SdkError` code AMBIGUOUS_SUBMISSION): the tx may still have executed. */
  requestPayment(args: RequestPaymentArgs): Promise<{ result: PaymentResult; txHash: string | undefined }>;
  /** Signed. Idempotent on the contract side. */
  reportPayoutStatus(args: { payoutId: string; status: ReportedStatus; txHash?: string | undefined }): Promise<void>;
}

/** 150 TGas (contract minimum 100): request_payment schedules storage_deposit + ft_transfer + callback. Unused gas is refunded. */
export const AGENT_CALL_GAS = 150_000_000_000_000n;
/** The only methods this SDK ever signs. The function-call key is restricted to the same list on-chain. */
export type AgentMethod = "request_payment" | "report_payout_status";

export const defaultRpcUrl = (network: "mainnet" | "testnet"): string =>
  network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";

const txOutcomeSchema = z.looseObject({
  status: z.union([z.looseObject({ SuccessValue: z.string() }), z.looseObject({ Failure: z.unknown() }), z.string()]),
  transaction: z.looseObject({ hash: z.string() }).optional(),
});

export interface NearVaultPortOptions {
  vaultId: string;
  network: "mainnet" | "testnet";
  agentAccountId: string;
  agentPrivateKey?: string | undefined;
  rpcUrl?: string | undefined;
  viewTimeoutMs?: number;
  callTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export class NearVaultPort implements VaultPort {
  private readonly provider: JsonRpcProvider;
  private readonly account: Account | undefined;
  private readonly vaultId: string;
  private readonly viewTimeoutMs: number;
  private readonly callTimeoutMs: number;
  /** Serializes signed calls: one key = one nonce sequence. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: NearVaultPortOptions) {
    this.vaultId = opts.vaultId;
    this.viewTimeoutMs = opts.viewTimeoutMs ?? 30_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 90_000;
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl ?? defaultRpcUrl(opts.network) }, { retries: 3, backoff: 2, wait: 1000 });
    if (opts.agentPrivateKey) {
      let kp: KeyPair;
      try {
        kp = KeyPair.fromString(opts.agentPrivateKey as KeyPairString);
      } catch {
        throw new SdkError("CONFIG", "agentPrivateKey is not a valid key string (expected ed25519:...)");
      }
      this.account = new Account(opts.agentAccountId, this.provider, kp.toString());
    }
  }

  private async view<T>(method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown;
    try {
      raw = await withTimeout(this.provider.callFunction({ contractId: this.vaultId, method, args }), this.viewTimeoutMs, `view ${method}`);
    } catch (e) {
      throw new SdkError("VAULT_ERROR", `vault view ${method} failed: ${errMsg(e)}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new SdkError("VAULT_ERROR", `vault view ${method} returned an unexpected shape: ${parsed.error.message}`);
    return parsed.data;
  }

  getContractInfo() {
    return this.view("get_contract_info", {}, contractInfoSchema);
  }

  getAgentByAccount(accountId: string) {
    return this.view("get_agent_by_account", { account_id: accountId }, agentViewSchema.nullable());
  }

  getAgentBudget(agentId: string) {
    return this.view("get_agent_budget", { agent_id: agentId }, budgetViewSchema);
  }

  getPayout(payoutId: string) {
    return this.view("get_payout", { payout_id: payoutId }, payoutSchema.nullable());
  }

  /** The single place that signs. Only the two whitelisted methods, 150 TGas, zero deposit. */
  private signedCall(method: AgentMethod, args: Record<string, unknown>): Promise<{ value: string | undefined; txHash: string | undefined }> {
    const account = this.account;
    if (!account) return Promise.reject(new SdkError("NO_SIGNING_KEY", "no agentPrivateKey configured: this client is read-only"));
    const run = async () => {
      let raw: unknown;
      try {
        raw = await withTimeout(
          account.callFunctionRaw({
            contractId: this.vaultId,
            methodName: method,
            args,
            gas: AGENT_CALL_GAS,
            deposit: 0n,
            waitUntil: "EXECUTED_OPTIMISTIC",
          }),
          this.callTimeoutMs,
          `call ${method}`,
        );
      } catch (e) {
        throw new SdkError(
          "AMBIGUOUS_SUBMISSION",
          `${method} may or may not have executed (${errMsg(e)}). Do not retry blindly: check the payment list / dashboard first.`,
        );
      }
      const out = txOutcomeSchema.safeParse(raw);
      if (!out.success) throw new SdkError("AMBIGUOUS_SUBMISSION", `${method}: unreadable transaction outcome`);
      const txHash = out.data.transaction?.hash;
      const st = out.data.status;
      if (typeof st === "string") throw new SdkError("AMBIGUOUS_SUBMISSION", `${method}: transaction not finished (${st}), tx ${txHash ?? "unknown"}`);
      if ("Failure" in st) throw new SdkError("VAULT_ERROR", `${method} failed on-chain: ${JSON.stringify(st.Failure).slice(0, 400)}`);
      return { value: "SuccessValue" in st && typeof st.SuccessValue === "string" ? st.SuccessValue : undefined, txHash };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async requestPayment(args: RequestPaymentArgs) {
    const { value, txHash } = await this.signedCall("request_payment", {
      chain: args.chain,
      address: args.address,
      amount: args.amount,
      ...(args.memo !== undefined ? { memo: args.memo } : {}),
      deposit_address: args.depositAddress,
      deposit_expires_at_ms: String(args.depositExpiresAtMs),
    });
    if (value === undefined || value === "") throw new SdkError("AMBIGUOUS_SUBMISSION", `request_payment returned no value (tx ${txHash ?? "unknown"})`);
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
      throw new SdkError("AMBIGUOUS_SUBMISSION", `request_payment returned unparsable data (tx ${txHash ?? "unknown"})`);
    }
    const result = paymentResultSchema.safeParse(json);
    if (!result.success) throw new SdkError("AMBIGUOUS_SUBMISSION", `request_payment returned an unknown result (tx ${txHash ?? "unknown"})`);
    return { result: result.data, txHash };
  }

  async reportPayoutStatus(args: { payoutId: string; status: ReportedStatus; txHash?: string | undefined }) {
    await this.signedCall("report_payout_status", {
      payout_id: args.payoutId,
      status: args.status,
      ...(args.txHash !== undefined ? { tx_hash: args.txHash } : {}),
    });
  }
}
