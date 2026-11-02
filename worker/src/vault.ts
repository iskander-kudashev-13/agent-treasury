import { z } from "zod";

/** Mirrors `PayoutStatus` in contract/src/lib.rs (serialized as the variant name). */
export const PAYOUT_STATUSES = [
  "PendingApproval",
  "Rejected",
  "Transferring",
  "Sent",
  "Confirmed",
  "Failed",
  "Refunded",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export type ReportedStatus = Extract<PayoutStatus, "Confirmed" | "Refunded" | "Failed">;

const u64 = z.string().regex(/^\d+$/);

/** Address book entry (ADR-0004): where to pay. Amount and timing live in schedules. */
const recipientSchema = z.looseObject({
  id: z.number().int(),
  label: z.string(),
  destination_chain: z.string(),
  destination_asset: z.string(),
  destination_address: z.string(),
  created_at_ms: u64.optional(),
  last_paid_at_ms: u64.nullable().optional(),
  active_schedules: z.number().int().optional(),
});
export type VaultRecipient = z.infer<typeof recipientSchema>;

const scheduleSchema = z.looseObject({
  id: z.number().int(),
  recipient_id: z.number().int(),
  amount: u64,
  frequency: z.unknown(),
  start_at: u64,
  agent_id: z.string(),
  status: z.enum(["Active", "Paused", "Ended"]),
  next_due_at: u64.nullable(),
  open_payout: u64.nullable(),
  paid_count: z.number().int().optional(),
  failed_attempts: z.number().int().optional(),
});
export type VaultSchedule = z.infer<typeof scheduleSchema>;

/** `DueItem`: schedule fields flattened plus `overdue`. */
const dueItemSchema = scheduleSchema.extend({ overdue: z.boolean() });
export type DueItem = z.infer<typeof dueItemSchema>;

const upcomingItemSchema = z.looseObject({
  schedule_id: z.number().int(),
  recipient_id: z.number().int(),
  agent_id: z.string(),
  amount: u64,
  due_at: u64,
  will_need_approval: z.boolean(),
});
export type UpcomingItem = z.infer<typeof upcomingItemSchema>;

const payoutSchema = z.looseObject({
  id: u64,
  agent_id: z.string(),
  schedule_id: z.number().int().nullable().optional(),
  recipient_id: z.number().int().nullable(),
  occurrence_at: u64.nullable().optional(),
  approval_reason: z.string().nullable().optional(),
  chain: z.string().optional(),
  address: z.string().optional(),
  amount: u64,
  status: z.enum(PAYOUT_STATUSES),
  deposit_address: z.string().nullable(),
  deposit_expires_at_ms: u64.nullable().optional(),
  agent_account: z.string().nullable(),
  tx_hash: z.string().nullable(),
  created_at_ms: u64,
  updated_at_ms: u64,
});
export type VaultPayout = z.infer<typeof payoutSchema>;

const contractInfoSchema = z.looseObject({
  owner_id: z.string(),
  treasury_token: z.string(),
  requires_tee: z.boolean(),
  version: z.string().optional(),
});
export type ContractInfo = z.infer<typeof contractInfoSchema>;

const budgetSchema = z.looseObject({
  agent_id: z.string(),
  remaining_today: u64,
  vault_remaining_today: u64,
  per_tx_limit: u64,
  approval_threshold: u64,
  min_payment: u64.optional(),
  max_payments_per_day: z.number().int().nullable().optional(),
  payments_today: z.number().int().optional(),
  allowed_chains: z.array(z.string()),
  recipients_mode: z.string(),
  recipients: z.array(z.number().int()),
  expires_at: u64.nullable(),
  status: z.string(),
  vault_paused: z.boolean(),
  balance: u64,
});
export type AgentBudget = z.infer<typeof budgetSchema>;

const rejectionSchema = z.looseObject({
  agent_id: z.string(),
  at: u64,
  reason: z.string(),
  detail: z.string(),
  chain: z.string(),
  address: z.string(),
  amount: u64,
});
export type Rejection = z.infer<typeof rejectionSchema>;

/** `PaymentResult` as serialized by the contract: externally tagged. */
const paymentResultSchema = z.union([
  z.object({ Rejected: z.object({ reason: z.string(), detail: z.string() }) }),
  z.object({ PendingApproval: z.object({ payout_id: u64, reason: z.string().optional() }) }),
  z.object({ Submitted: z.object({ payout_id: u64 }) }),
  z.object({ TransferFailed: z.object({ payout_id: u64 }) }),
]);
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export interface PaymentArgs {
  scheduleId: number;
  depositAddress: string;
  /** Quote deadline in ms; always sent (required by the vault above the approval threshold / when overdue). */
  depositExpiresAtMs: number;
}

const policySchema = z.looseObject({ paused: z.boolean() });

/** What the payout loop needs from the vault. Implemented by `NearVault` and by a fake in tests. */
export interface Vault {
  getContractInfo(): Promise<ContractInfo>;
  isPaused(): Promise<boolean>;
  /** `get_due({ agent_id })`: this agent's schedules that can be paid now. */
  getDue(nowMs: number): Promise<DueItem[]>;
  getSchedule(id: number): Promise<VaultSchedule | null>;
  /** `get_upcoming`: expected payments in [fromMs, toMs] (all agents), sorted by due date. */
  getUpcoming(fromMs: number, toMs: number, limit: number): Promise<UpcomingItem[]>;
  getAgentBudget(): Promise<AgentBudget | null>;
  /** Newest first. */
  getRejections(limit: number): Promise<Rejection[]>;
  /** Address book entry. */
  getRecipient(id: number): Promise<VaultRecipient | null>;
  getPayout(id: string): Promise<VaultPayout | null>;
  /** Newest `limit` payouts of this agent (scan window), oldest first. */
  getRecentPayouts(limit: number): Promise<VaultPayout[]>;
  /**
   * `Sent` payouts of Key agents created after `sinceMs` (all agents, paged backwards), oldest first. The worker finishes
   * them because a Key agent's process (MCP in a chat client) is often gone after the owner approves (ADR-0002).
   */
  getSentKeyAgentPayouts(opts: { sinceMs: number; pageSize: number; maxPages: number }): Promise<VaultPayout[]>;
  /**
   * Sends `request_payout({schedule_id, deposit_address, deposit_expires_at_ms})`. `result` is the parsed `PaymentResult` (undefined if the call result was not understood).
   * A rejection of the promise is AMBIGUOUS (the tx may still have executed): callers must re-read vault state,
   * never blindly retry.
   */
  requestPayment(args: PaymentArgs): Promise<{ txHash: string | undefined; result: PaymentResult | undefined }>;
  /** Idempotent on the contract side (repeating the same terminal status is a no-op). */
  reportPayoutStatus(args: { payoutId: string; status: ReportedStatus; txHash: string | undefined }): Promise<void>;
}

export interface NearVaultDeps {
  /** Read-only call (RPC `call_function`). */
  view: (method: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Signed call from the agent account (ShadeClient.call). */
  call: (method: string, args: Record<string, unknown>, opts: { gas: string; deposit: string }) => Promise<unknown>;
  /** Hash of the last tx the agent signed (single-flight loop makes this unambiguous). */
  takeLastTxHash: () => string | undefined;
  viewTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** 150 TGas (contract minimum is 100): request_payout schedules storage_deposit + ft_transfer + callback. Unused gas is refunded. */
export const REQUEST_PAYOUT_GAS = "150000000000000";

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

export class NearVault implements Vault {
  constructor(
    private readonly deps: NearVaultDeps,
    private readonly agentId: string,
  ) {}

  private async v<T>(method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const raw = await withTimeout(this.deps.view(method, args), this.deps.viewTimeoutMs ?? 30_000, `view ${method}`);
    return schema.parse(raw);
  }

  getContractInfo() {
    return this.v("get_contract_info", {}, contractInfoSchema);
  }

  async isPaused() {
    return (await this.v("get_policy", {}, policySchema)).paused;
  }

  getDue(nowMs: number) {
    return this.v("get_due", { agent_id: this.agentId, now_ms: String(nowMs) }, z.array(dueItemSchema));
  }

  getSchedule(id: number) {
    return this.v("get_schedule", { schedule_id: id }, scheduleSchema.nullable());
  }

  getUpcoming(fromMs: number, toMs: number, limit: number) {
    return this.v("get_upcoming", { from_ms: String(fromMs), to_ms: String(toMs), limit }, z.array(upcomingItemSchema));
  }

  getAgentBudget() {
    return this.v("get_agent_budget", { agent_id: this.agentId }, budgetSchema.nullable());
  }

  getRejections(limit: number) {
    return this.v("get_rejections", { agent_id: this.agentId, limit }, z.array(rejectionSchema));
  }

  getRecipient(id: number) {
    return this.v("get_recipient", { recipient_id: id }, recipientSchema.nullable());
  }

  getPayout(id: string) {
    return this.v("get_payout", { payout_id: id }, payoutSchema.nullable());
  }

  async getRecentPayouts(limit: number) {
    // Page from the end of the agent's own list (from_index is a u32 position within it).
    const count = await this.v("get_agent_payouts_count", { agent_id: this.agentId }, z.number().int().nonnegative());
    const from = Math.max(0, count - limit);
    return this.v("get_payouts", { from_index: from, limit, agent_id: this.agentId }, z.array(payoutSchema));
  }

  async getSentKeyAgentPayouts(opts: { sinceMs: number; pageSize: number; maxPages: number }) {
    // Payout ids are creation order, but a Key payout becomes `Sent` only when the owner approves it (up to 72 h
    // later, MAX_APPROVAL_AGE). A fixed "newest N" window would lose it on a busy vault, so page backwards until the
    // payouts are older than `sinceMs` (creation time), bounded by `maxPages`.
    const count = Number(await this.v("get_payouts_count", {}, u64));
    const sent: VaultPayout[] = [];
    let end = count;
    for (let page = 0; end > 0 && page < opts.maxPages; page++) {
      const from = Math.max(0, end - opts.pageSize);
      const batch = await this.v("get_payouts", { from_index: from, limit: end - from }, z.array(payoutSchema));
      sent.push(...batch.filter((p) => p.status === "Sent"));
      end = from;
      if (batch.length === 0 || batch.every((p) => Number(p.created_at_ms) < opts.sinceMs)) break;
    }
    // Look up only the agents that appear here (no assumption about the number of agents in the vault).
    const ids = [...new Set(sent.map((p) => p.agent_id))];
    const kinds = new Map<string, string>();
    for (const id of ids) {
      const a = await this.v("get_agent", { agent_id: id }, z.looseObject({ kind: z.string() }).nullable());
      if (a) kinds.set(id, a.kind);
    }
    return sent.filter((p) => kinds.get(p.agent_id) === "Key").sort((a, b) => Number(a.id) - Number(b.id));
  }

  async requestPayment(args: PaymentArgs) {
    const raw = await withTimeout(
      this.deps.call(
        "request_payout",
        {
          schedule_id: args.scheduleId,
          deposit_address: args.depositAddress,
          deposit_expires_at_ms: String(args.depositExpiresAtMs),
        },
        { gas: REQUEST_PAYOUT_GAS, deposit: "0" },
      ),
      this.deps.callTimeoutMs ?? 120_000,
      "call request_payout",
    );
    const parsed = paymentResultSchema.safeParse(raw);
    return { txHash: this.deps.takeLastTxHash(), result: parsed.success ? parsed.data : undefined };
  }

  async reportPayoutStatus(args: { payoutId: string; status: ReportedStatus; txHash: string | undefined }) {
    await withTimeout(
      this.deps.call(
        "report_payout_status",
        { payout_id: args.payoutId, status: args.status, tx_hash: args.txHash ?? null },
        { gas: "30000000000000", deposit: "0" },
      ),
      this.deps.callTimeoutMs ?? 120_000,
      "call report_payout_status",
    );
  }
}
