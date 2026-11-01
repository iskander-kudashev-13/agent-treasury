/**
 * Read-only access to the vault over NEAR RPC (`call_function` view calls), parsed with zod. Shapes follow
 * docs/adr/0003-agents-and-mandates.md and docs/adr/0004-schedules.md. Unknown extra fields are kept (looseObject).
 * This module has NO signing capability: it only receives a `view` function.
 */
import { z } from "zod";
import { endFromWire, frequencyFromWire } from "./frequency.js";
import type { EndRule, Frequency } from "./frequency.js";

export type ViewFn = (method: string, args: Record<string, unknown>) => Promise<unknown>;

const u128 = z.string().regex(/^\d+$/);
const u64 = z.string().regex(/^\d+$/);

const destination = z.looseObject({ chain: z.string(), address: z.string(), label: z.string().nullable().optional() });

export const mandateSchema = z.looseObject({
  daily_limit: u128,
  per_tx_limit: u128,
  approval_threshold: u128,
  allowed_chains: z.array(z.string()),
  recipients_mode: z.enum(["Fixed", "Allowlist", "Open"]),
  allowlist: z.array(destination),
  recipients: z.array(z.number().int()),
  expires_at: u64.nullable(),
  max_payments_per_day: z.number().int(),
});
export type Mandate = z.infer<typeof mandateSchema>;

export const agentSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["Tee", "Key"]),
  account_id: z.string().nullable().optional(),
  mandate: mandateSchema,
  status: z.enum(["Active", "Paused", "Revoked"]),
  spent_today: u128.optional(),
  last_request_at: u64.nullable().optional(),
  failed_transfers: z.number().int().optional(),
  open_approvals: z.number().int().optional(),
});
export type Agent = z.infer<typeof agentSchema>;

const budgetSchema = z.looseObject({
  agent_id: z.string(),
  remaining_today: u128,
  vault_remaining_today: u128,
  per_tx_limit: u128,
  approval_threshold: u128,
  allowed_chains: z.array(z.string()),
  recipients_mode: z.string(),
  recipients: z.array(z.number().int()),
  expires_at: u64.nullable(),
  status: z.string(),
  vault_paused: z.boolean(),
  balance: u128,
  min_payment: u128.optional(),
  max_payments_per_day: z.number().int().optional(),
  payments_today: z.number().int().optional(),
});
export type Budget = z.infer<typeof budgetSchema>;

const policySchema = z.looseObject({
  daily_limit: u128,
  min_payment: u128,
  paused: z.boolean(),
  overdue_grace_ms: u64.optional(),
});
export type Policy = z.infer<typeof policySchema>;

const balanceSchema = z.looseObject({
  balance: u128,
  in_flight: u128.optional(),
  spent_today: u128.optional(),
  remaining_today: u128.optional(),
});
export type Balance = z.infer<typeof balanceSchema>;

export const recipientSchema = z.looseObject({
  id: z.number().int(),
  label: z.string(),
  destination_chain: z.string(),
  destination_asset: z.string().optional(),
  destination_address: z.string(),
  last_paid_at_ms: u64.nullable().optional(),
});
export type Recipient = z.infer<typeof recipientSchema>;

const scheduleRaw = z.looseObject({
  id: z.number().int(),
  recipient_id: z.number().int(),
  amount: u128,
  frequency: z.unknown(),
  start_at: u64,
  end: z.unknown(),
  agent_id: z.string(),
  status: z.enum(["Active", "Paused", "Ended"]),
  last_paid_at: u64.nullable().optional(),
  paid_count: z.number().int().optional(),
  created_at: u64.optional(),
  next_due_at: u64.nullable().optional(),
  open_payout: u64.nullable().optional(),
  failed_attempts: z.number().int().optional(),
});

export interface Schedule {
  id: number;
  recipient_id: number;
  amount: bigint;
  frequency: Frequency;
  start_at: number;
  end: EndRule;
  agent_id: string;
  status: "Active" | "Paused" | "Ended";
  last_paid_at: number | null;
  paid_count: number;
  next_due_at: number | null;
  open_payout: string | null;
  failed_attempts: number;
}

function parseSchedule(raw: unknown): Schedule {
  const s = scheduleRaw.parse(raw);
  const frequency = frequencyFromWire(s.frequency);
  const end = endFromWire(s.end);
  if (!frequency || !end) throw new Error(`schedule ${s.id}: unrecognized frequency/end encoding`);
  return {
    id: s.id,
    recipient_id: s.recipient_id,
    amount: BigInt(s.amount),
    frequency,
    start_at: Number(s.start_at),
    end,
    agent_id: s.agent_id,
    status: s.status,
    last_paid_at: s.last_paid_at ? Number(s.last_paid_at) : null,
    paid_count: s.paid_count ?? 0,
    next_due_at: s.next_due_at ? Number(s.next_due_at) : null,
    open_payout: s.open_payout ?? null,
    failed_attempts: s.failed_attempts ?? 0,
  };
}

const upcomingRaw = z.looseObject({
  schedule_id: z.number().int(),
  recipient_id: z.number().int(),
  agent_id: z.string(),
  amount: u128,
  due_at: u64,
  will_need_approval: z.boolean(),
});
export interface UpcomingItem {
  schedule_id: number;
  recipient_id: number;
  agent_id: string;
  amount: bigint;
  due_at: number;
  will_need_approval: boolean;
}

const dueRaw = z.looseObject({ overdue: z.boolean().optional() });

export const payoutSchema = z.looseObject({
  id: u64,
  agent_id: z.string(),
  schedule_id: z.number().int().nullable().optional(),
  recipient_id: z.number().int().nullable().optional(),
  chain: z.string().optional(),
  address: z.string().optional(),
  amount: u128,
  memo: z.string().nullable().optional(),
  status: z.string(),
  created_at_ms: u64.optional(),
  updated_at_ms: u64.optional(),
});
export type Payout = z.infer<typeof payoutSchema>;

export const rejectionSchema = z.looseObject({
  agent_id: z.string(),
  at: u64,
  reason: z.string(),
  detail: z.string(),
  chain: z.string().optional(),
  address: z.string().optional(),
  amount: u128.optional(),
});
export type Rejection = z.infer<typeof rejectionSchema>;

const contractInfoSchema = z.looseObject({
  owner_id: z.string(),
  next_recipient_id: z.number().int().optional(),
  next_schedule_id: z.number().int().optional(),
});
export type ContractInfo = z.infer<typeof contractInfoSchema>;

const PAGE = 50;
const MAX_ITEMS = 500;

export class VaultReader {
  constructor(private readonly view: ViewFn) {}

  private async list<T>(method: string, args: Record<string, unknown>, schema: z.ZodType<T>, cap = MAX_ITEMS): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; out.length < cap; from += PAGE) {
      const page = z.array(schema).parse(await this.view(method, { ...args, from_index: from, limit: PAGE }));
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out.slice(0, cap);
  }

  async contractInfo(): Promise<ContractInfo> {
    return contractInfoSchema.parse(await this.view("get_contract_info", {}));
  }
  async policy(): Promise<Policy> {
    return policySchema.parse(await this.view("get_policy", {}));
  }
  async balance(): Promise<Balance> {
    return balanceSchema.parse(await this.view("get_balance", {}));
  }
  agents(): Promise<Agent[]> {
    return this.list("get_agents", {}, agentSchema);
  }
  async agent(id: string): Promise<Agent | null> {
    const r = await this.view("get_agent", { agent_id: id });
    return r === null ? null : agentSchema.parse(r);
  }
  async agentBudget(id: string): Promise<Budget | null> {
    const r = await this.view("get_agent_budget", { agent_id: id });
    return r === null ? null : budgetSchema.parse(r);
  }
  recipients(): Promise<Recipient[]> {
    return this.list("get_recipients", {}, recipientSchema);
  }
  async recipient(id: number): Promise<Recipient | null> {
    const r = await this.view("get_recipient", { recipient_id: id });
    return r === null ? null : recipientSchema.parse(r);
  }
  async schedules(filter: { agent_id?: string; recipient_id?: number } = {}): Promise<Schedule[]> {
    const raw = await this.list("get_schedules", filter, z.unknown());
    return raw.map(parseSchedule);
  }
  async schedule(id: number): Promise<Schedule | null> {
    const r = await this.view("get_schedule", { schedule_id: id });
    return r === null ? null : parseSchedule(r);
  }
  /** Window <= 62 days (contract limit); the caller clamps. */
  async upcoming(fromMs: number, toMs: number): Promise<UpcomingItem[]> {
    const raw = await this.list("get_upcoming", { from_ms: String(fromMs), to_ms: String(toMs) }, upcomingRaw);
    return raw.map((u) => ({
      schedule_id: u.schedule_id,
      recipient_id: u.recipient_id,
      agent_id: u.agent_id,
      amount: BigInt(u.amount),
      due_at: Number(u.due_at),
      will_need_approval: u.will_need_approval,
    }));
  }
  async due(nowMs: number): Promise<{ schedule: Schedule; overdue: boolean }[]> {
    const raw = z.array(z.unknown()).parse(await this.view("get_due", { now_ms: String(nowMs) }));
    return raw.map((r) => ({ schedule: parseSchedule(r), overdue: dueRaw.parse(r).overdue ?? false }));
  }
  /** Newest first, at most `limit` (<= 200). */
  async payouts(limit: number, agentId?: string): Promise<Payout[]> {
    const countRaw = agentId
      ? await this.view("get_agent_payouts_count", { agent_id: agentId })
      : await this.view("get_payouts_count", {});
    const count = typeof countRaw === "number" ? countRaw : Number(u64.parse(countRaw));
    const n = Math.min(limit, 200, count);
    const out: Payout[] = [];
    for (let from = count - n; from < count; from += PAGE) {
      const page = z.array(payoutSchema).parse(
        await this.view("get_payouts", { from_index: from, limit: Math.min(PAGE, count - from), ...(agentId ? { agent_id: agentId } : {}) }),
      );
      out.push(...page);
    }
    return out.reverse();
  }
  async rejections(limit: number, agentId?: string): Promise<Rejection[]> {
    const r = await this.view("get_rejections", { from_index: 0, limit: Math.min(limit, 50), ...(agentId ? { agent_id: agentId } : {}) });
    return z.array(rejectionSchema).parse(r);
  }
  async pendingApprovals(): Promise<Payout[]> {
    return z.array(payoutSchema).parse(await this.view("get_pending_approvals", {}));
  }
}
