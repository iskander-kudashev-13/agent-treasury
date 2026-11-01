export type PayoutStatus =
  | "PendingApproval"
  | "Rejected"
  | "Transferring"
  | "Sent"
  | "Confirmed"
  | "Failed"
  | "Refunded";

export interface Policy {
  daily_limit: string;
  min_payment: string;
  overdue_grace_ms: string;
}
export interface PolicyView extends Policy {
  paused: boolean;
}
export interface BalanceView {
  balance: string;
  in_flight: string;
  spent_today: string;
  remaining_today: string;
  day_index: string;
}
export interface ContractInfo {
  owner_id: string;
  treasury_token: string;
  requires_tee: boolean;
  attestation_expiration_time_ms: string;
  storage_deposit_yocto: string;
  version: string;
  proposed_owner?: string | null;
  next_recipient_id: number;
  next_schedule_id: number;
}
/** Address book entry (ADR-0004): no amount or period, those live on schedules. */
export interface RecipientInput {
  label: string;
  destination_chain: string;
  destination_asset: string;
  destination_address: string;
}
export interface RecipientView extends RecipientInput {
  id: number;
  created_at_ms: string;
  last_paid_at_ms: string | null;
  active_schedules: number;
}

/** serde externally tagged enums */
export type Frequency = "Once" | { Weekly: { weekday: number } } | { Monthly: { day: number } } | { EveryNDays: { n: number } };
export type ScheduleEnd = "Never" | { AfterCount: { count: number } } | { On: { at: string } };
export type ScheduleStatus = "Active" | "Paused" | "Ended";
export interface ScheduleInput {
  recipient_id: number;
  amount: string;
  frequency: Frequency;
  start_at: string;
  end: ScheduleEnd;
  agent_id: string;
}
export interface Schedule extends ScheduleInput {
  id: number;
  status: ScheduleStatus;
  last_paid_at: string | null;
  last_occurrence_paid: string | null;
  paid_count: number;
  created_at: string;
  next_due_at: string | null;
  open_payout: string | null;
  failed_attempts: number;
}
export interface DueItem extends Schedule {
  overdue: boolean;
}
export interface UpcomingItem {
  schedule_id: number;
  recipient_id: number;
  agent_id: string;
  amount: string;
  due_at: string;
  will_need_approval: boolean;
}
export interface Payout {
  id: string;
  agent_id: string;
  agent_account: string | null;
  schedule_id: number | null;
  occurrence_at: string | null;
  /** ABOVE_THRESHOLD | OVERDUE_NEEDS_APPROVAL */
  approval_reason: string | null;
  recipient_id: number | null;
  chain: string;
  address: string;
  amount: string;
  /** Untrusted text from the agent: render as plain text only. */
  memo: string | null;
  status: PayoutStatus;
  deposit_address: string | null;
  deposit_expires_at_ms: string | null;
  tx_hash: string | null;
  created_at_ms: string;
  updated_at_ms: string;
  funds_left?: boolean;
  refund_credited?: boolean;
}
export type AgentKind = "Tee" | "Key";
export type AgentStatus = "Active" | "Paused" | "Revoked";
export interface Destination {
  chain: string;
  address: string;
  label: string | null;
}
export interface Mandate {
  daily_limit: string;
  per_tx_limit: string;
  approval_threshold: string;
  allowed_chains: string[];
  recipients_mode: "Fixed" | "Allowlist" | "Open";
  allowlist: Destination[];
  recipients: number[];
  expires_at: string | null;
  max_payments_per_day: number;
}
export interface AgentView {
  id: string;
  name: string;
  kind: AgentKind;
  account_id: string | null;
  public_key: string | null;
  /** TEE slot bound to its account for good (only `unbind_agent` / `revoke_agent` release it). Key agents: false. */
  account_pinned: boolean;
  mandate: Mandate;
  status: AgentStatus;
  spent_today: string;
  day_index: string;
  created_at: string;
  last_request_at: string | null;
  failed_transfers: number;
  open_approvals: number;
  tee: { measurements: unknown; ppid: string; valid_until_ms: string; valid: boolean; reasons: string[] } | null;
}
export interface Rejection {
  agent_id: string;
  at: string;
  reason: string;
  detail: string;
  chain: string;
  address: string;
  amount: string;
}
export interface WorkerStatus {
  mode: "local" | "tee" | string;
  agentAccountId?: string | null;
  registered?: boolean;
  valid?: boolean;
  lastRun?: unknown;
  nextRun?: unknown;
  attestation?: unknown;
}
