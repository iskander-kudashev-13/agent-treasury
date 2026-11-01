//! # Agent Treasury vault
//!
//! A USDC (NEP-141) treasury that any number of AI agents can spend from, each **only within its own mandate**.
//!
//! - The owner funds the vault (`ft_transfer_call` → [`Contract::ft_on_transfer`]), sets a vault-wide [`Policy`]
//!   (daily cap + global pause), creates agents with mandates, approves TEE images, and can always pause or withdraw.
//! - An agent is either a **TEE agent** (Shade Agent v2: registers with a hardware attestation, see `agent.rs`) or a
//!   **key agent** (an account holding a function-call key limited to this vault). Agents can only call
//!   [`Contract::request_payment`], which checks the mandate and the vault policy on-chain and either rejects with a
//!   machine-readable reason, parks the payment for owner approval, or transfers USDC to a NEAR Intents 1Click deposit
//!   address.
//!
//! Design decisions: `docs/adr/0001` (vault = Shade Agent contract), `0002` (payout flow, trust boundaries),
//! `0003` (agents and mandates, exact interface). Feature spec: `AGENT_ACCESS.md`.

use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
    env::{self, block_timestamp_ms},
    json_types::{U64, U128},
    log, near, require,
    serde::Serialize,
    serde_json,
    store::{IterableMap, IterableSet, LookupMap, Vector},
};
use shade_attestation::{
    attestation::{AcceptedDstackAttestation, DstackAttestation},
    measurements::{FullMeasurements, FullMeasurementsHex, create_mock_full_measurements_hex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

pub use agent::{AgentRemovalReason, AgentView, TeeView};
pub use events::Event;
pub use frequency::{Frequency, ScheduleEnd};
pub use views::{BalanceView, BudgetView, ContractInfo, PolicyView, RecipientView, UpcomingItem};

mod agent;
mod events;
mod frequency;
mod owner;
mod payment;
mod views;

#[cfg(test)]
mod tests;

pub type Ppid = HexBytes<16>;
pub type AgentId = String;
pub type RecipientId = u32;
pub type ScheduleId = u32;
pub type PayoutId = u64;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const DAY_MS: u64 = 86_400_000;
/// The treasury token is USDC (6 decimals); used only to format human-readable rejection details.
pub const TOKEN_DECIMALS: u32 = 6;

// --- Gas budget ---------------------------------------------------------------------------------
// NEAR cross-contract calls are asynchronous: a payment creates a receipt for the token contract and a callback
// receipt back to this contract. Each receipt gets its gas up front from the caller's prepaid gas.
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(30);
pub const GAS_FT_BALANCE_OF: Gas = Gas::from_tgas(5);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(20);
/// Minimum prepaid gas for `request_payment` / `request_payout` / `approve_payout` (attach 100–150 TGas).
pub const MIN_GAS_PAYMENT: Gas = Gas::from_tgas(100);
pub const MIN_GAS_WITHDRAW: Gas = Gas::from_tgas(60);

// --- Bounds (the contract pays for its own storage, keep entries small and counts capped) -------
pub const MAX_ID_LEN: usize = 32;
pub const MAX_LABEL_LEN: usize = 64;
pub const MAX_CHAIN_LEN: usize = 16;
pub const MAX_ASSET_LEN: usize = 128;
pub const MAX_ADDRESS_LEN: usize = 128;
pub const MAX_TX_HASH_LEN: usize = 128;
pub const MAX_MEMO_LEN: usize = 140;
pub const MAX_CHAINS_PER_MANDATE: usize = 16;
pub const MAX_ALLOWLIST_PER_MANDATE: usize = 50;
pub const MAX_RECIPIENTS_PER_MANDATE: usize = 100;
/// Open approvals per agent: bounds storage an agent can make the vault pay for.
pub const MAX_OPEN_APPROVALS_PER_AGENT: u32 = 5;
/// Consecutive failed transfers (per agent and per Fixed recipient) before the owner must reset.
pub const MAX_FAILED_ATTEMPTS: u32 = 3;
/// Ring buffer size of the rejection log.
pub const REJECTIONS_CAP: u32 = 200;
/// Rejection-log entries per agent per day (rejections are still returned; this only protects the shared log).
pub const MAX_LOGGED_REJECTIONS_PER_AGENT_PER_DAY: u32 = 50;
/// Pending approvals older than this cannot be approved (1Click deposit addresses expire).
pub const MAX_APPROVAL_AGE_MS: u64 = 72 * 3_600_000;
/// A `Transferring` payout older than this can be settled manually by the owner (`force_settle_transfer`).
pub const STUCK_TRANSFER_MS: u64 = 3_600_000;
/// Default grace period after a scheduled due date before the payment needs owner approval.
pub const DEFAULT_OVERDUE_GRACE_MS: u64 = 3 * DAY_MS;
/// Bounds for view gas.
pub const MAX_SCHEDULES: u32 = 500;
pub const MAX_UPCOMING_WINDOW_MS: u64 = 62 * DAY_MS;
pub const MAX_UPCOMING_PER_SCHEDULE: usize = 62;
pub const MAX_UPCOMING_ITEMS: usize = 500;
/// Bound on date steps a view walks per schedule (protects view gas for very old / dense schedules).
pub const MAX_CURSOR_STEPS: u32 = 1_000;
/// Minimum gap between the two balance reads of `credit_refund` / `sync_surplus`.
pub const SURPLUS_CONFIRM_MS: u64 = 60_000;
pub const MIN_OVERDUE_GRACE_MS: u64 = 3_600_000;
pub const MAX_OVERDUE_GRACE_MS: u64 = 30 * DAY_MS;

/// Vault-wide rules applied on top of every mandate.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Max total reserved for payments per UTC day across all agents.
    pub daily_limit: U128,
    /// Smallest payment any agent may request. Every payment costs the vault NEAR (deposit-account storage
    /// registration + a payout record), so dust payments would let a compromised agent drain it.
    pub min_payment: U128,
    /// A scheduled payment requested later than `due + overdue_grace_ms` needs owner approval (agent was offline).
    pub overdue_grace_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    /// 1Click `blockchain` id, e.g. `base`, `sol`, `arb`, `near`.
    pub chain: String,
    pub address: String,
    pub label: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipientsMode {
    /// Only vault recipients listed in `mandate.recipients`, only their configured amount, only when due.
    Fixed,
    /// Only destinations in `mandate.allowlist`, any amount within limits.
    Allowlist,
    /// Any address on an allowed chain, any amount within limits.
    Open,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mandate {
    pub daily_limit: U128,
    pub per_tx_limit: U128,
    /// Amounts strictly above need owner approval.
    pub approval_threshold: U128,
    pub allowed_chains: Vec<String>,
    pub recipients_mode: RecipientsMode,
    pub allowlist: Vec<Destination>,
    pub recipients: Vec<RecipientId>,
    /// Unix ms; `None` = no expiry.
    pub expires_at: Option<U64>,
    /// Max payments (pending or transferred, incl. failed) per UTC day. Bounds NEAR/storage cost per agent.
    pub max_payments_per_day: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentKind {
    Tee,
    Key,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStatus {
    Active,
    Paused,
    /// Terminal.
    Revoked,
}

/// TEE registration of a `Tee` agent (Shade Agent v2 attestation result).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct TeeRegistration {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub id: AgentId,
    pub name: String,
    pub kind: AgentKind,
    /// The account that calls `request_payment`. For an unpinned TEE agent: `None` until it registers.
    pub account_id: Option<AccountId>,
    /// TEE agents: if true, only `account_id` may register into this slot.
    pub account_pinned: bool,
    /// Key agents: the function-call key on `account_id` (informational; the runtime enforces the key's limits).
    pub public_key: Option<PublicKey>,
    pub mandate: Mandate,
    pub status: AgentStatus,
    pub spent_today: u128,
    /// Payouts created today (pending or transfer); rolls with `day_index`.
    pub payments_today: u32,
    /// Rejection-log entries written today; rolls with `day_index`.
    pub rejections_logged_today: u32,
    pub day_index: u64,
    pub created_at_ms: u64,
    pub last_request_at_ms: Option<u64>,
    pub failed_transfers: u32,
    pub open_approvals: u32,
    pub tee: Option<TeeRegistration>,
}

/// Address book entry. Amounts and dates live on schedules (ADR-0004).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientInput {
    pub label: String,
    /// 1Click `blockchain` id of the payout chain.
    pub destination_chain: String,
    /// 1Click `assetId` from `GET /v0/tokens`.
    pub destination_asset: String,
    pub destination_address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recipient {
    pub label: String,
    pub destination_chain: String,
    pub destination_asset: String,
    pub destination_address: String,
    pub created_at_ms: U64,
    /// Time of the last payment to this recipient that reserved funds (any source).
    pub last_paid_at_ms: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleStatus {
    Active,
    Paused,
    Ended,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleInput {
    pub recipient_id: RecipientId,
    pub amount: U128,
    pub frequency: Frequency,
    pub start_at: U64,
    pub end: ScheduleEnd,
    /// Executing agent; its mandate must allow this recipient, chain and amount.
    pub agent_id: AgentId,
}

/// A scheduled payment paid by its agent on the dates it describes (ADR-0004).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub id: ScheduleId,
    pub recipient_id: RecipientId,
    pub amount: U128,
    pub frequency: Frequency,
    pub start_at: U64,
    pub end: ScheduleEnd,
    pub agent_id: AgentId,
    pub status: ScheduleStatus,
    pub last_paid_at: Option<U64>,
    /// The occurrence (due date) that was paid last; next dates are computed after it.
    pub last_occurrence_paid: Option<U64>,
    /// The last occurrence that was paid **or skipped** (owner rejected it); new dates are computed after it.
    pub last_occurrence_handled: Option<U64>,
    pub paid_count: u32,
    pub created_at: U64,
    /// Earliest unpaid occurrence; `None` once nothing is left to pay.
    pub next_due_at: Option<U64>,
    /// Payout awaiting approval or in flight. Blocks new requests.
    pub open_payout: Option<U64>,
    pub failed_attempts: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurplusProbe {
    pub surplus: U128,
    pub at_ms: u64,
    pub outflow_epoch: u64,
}

/// Schedule fields a payout changed when it reserved funds (restored if the transfer fails).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleSnapshot {
    pub next_due_at: Option<U64>,
    pub last_paid_at: Option<U64>,
    pub last_occurrence_paid: Option<U64>,
    pub last_occurrence_handled: Option<U64>,
    pub paid_count: u32,
    pub status: ScheduleStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    /// Above the agent's approval threshold; waiting for the owner. Nothing reserved yet.
    PendingApproval,
    /// Owner rejected (or the agent was revoked while pending).
    Rejected,
    /// Funds reserved, `ft_transfer` to the 1Click deposit address in flight.
    Transferring,
    /// Tokens are at the 1Click deposit address.
    Sent,
    /// Agent reported 1Click `SUCCESS`.
    Confirmed,
    /// Transfer failed (reservation released) or agent reported 1Click `FAILED`.
    Failed,
    /// Agent reported 1Click `REFUNDED`; the owner credits returned tokens via `credit_refund`.
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub id: U64,
    pub agent_id: AgentId,
    /// Account that requested it.
    pub agent_account: Option<AccountId>,
    /// Set for scheduled payments (UI source tag "scheduled"); `None` = on demand.
    pub schedule_id: Option<ScheduleId>,
    pub recipient_id: Option<RecipientId>,
    /// The due date this scheduled payment covers.
    pub occurrence_at: Option<U64>,
    /// Intended destination as declared by the agent (audit). The vault cannot verify the 1Click quote.
    pub chain: String,
    pub address: String,
    pub amount: U128,
    /// Untrusted text from the agent. Displayed only, never interpreted.
    pub memo: Option<String>,
    pub status: PayoutStatus,
    /// Why it waits for the owner: `ABOVE_THRESHOLD` or `OVERDUE_NEEDS_APPROVAL`.
    pub approval_reason: Option<String>,
    pub deposit_address: Option<AccountId>,
    /// 1Click quote deadline declared by the agent; `approve_payout` refuses after it.
    pub deposit_expires_at_ms: Option<U64>,
    pub tx_hash: Option<String>,
    pub created_at_ms: U64,
    pub updated_at_ms: U64,
    /// Day index the reservation was counted in (to release daily counters correctly on failure).
    pub reserved_day: Option<U64>,
    /// Schedule state before this payout reserved funds (restored on failure).
    pub prev_schedule: Option<ScheduleSnapshot>,
    /// Recipient's `last_paid_at_ms` before this payout reserved funds (restored on failure).
    pub prev_recipient_last_paid_at_ms: Option<U64>,
    /// True once the tokens actually left the vault.
    pub funds_left: bool,
    pub refund_credited: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    pub agent_id: AgentId,
    pub at: U64,
    pub reason: String,
    pub detail: String,
    pub chain: String,
    pub address: String,
    pub amount: U128,
}

/// Result of `request_payment` (and `request_payout`). Serialized externally tagged, e.g.
/// `{"Rejected":{"reason":"AGENT_PAUSED","detail":"…"}}` or `{"Submitted":{"payout_id":"7"}}`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentResult {
    Rejected {
        reason: String,
        detail: String,
    },
    /// `reason`: `ABOVE_THRESHOLD` or `OVERDUE_NEEDS_APPROVAL`.
    PendingApproval {
        payout_id: U64,
        reason: String,
    },
    /// `ft_transfer` to the deposit address succeeded.
    Submitted {
        payout_id: U64,
    },
    /// `ft_transfer` failed; the reservation was released.
    TransferFailed {
        payout_id: U64,
    },
}

/// Machine-readable rejection reasons (AGENT_ACCESS §3.4 + ADR-0003 §3).
pub mod reason {
    pub const VAULT_PAUSED: &str = "VAULT_PAUSED";
    pub const AGENT_NOT_FOUND: &str = "AGENT_NOT_FOUND";
    pub const AGENT_REVOKED: &str = "AGENT_REVOKED";
    pub const AGENT_PAUSED: &str = "AGENT_PAUSED";
    pub const ATTESTATION_INVALID: &str = "ATTESTATION_INVALID";
    pub const AGENT_EXPIRED: &str = "AGENT_EXPIRED";
    pub const TOO_MANY_FAILED_TRANSFERS: &str = "TOO_MANY_FAILED_TRANSFERS";
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const INVALID_DEPOSIT_ADDRESS: &str = "INVALID_DEPOSIT_ADDRESS";
    pub const CHAIN_NOT_ALLOWED: &str = "CHAIN_NOT_ALLOWED";
    pub const RECIPIENT_NOT_ALLOWED: &str = "RECIPIENT_NOT_ALLOWED";
    pub const AMOUNT_MISMATCH: &str = "AMOUNT_MISMATCH";
    pub const NOT_DUE: &str = "NOT_DUE";
    pub const PAYOUT_IN_PROGRESS: &str = "PAYOUT_IN_PROGRESS";
    pub const BELOW_MIN_PAYMENT: &str = "BELOW_MIN_PAYMENT";
    pub const AGENT_DAILY_COUNT_EXCEEDED: &str = "AGENT_DAILY_COUNT_EXCEEDED";
    pub const PER_TX_LIMIT_EXCEEDED: &str = "PER_TX_LIMIT_EXCEEDED";
    pub const AGENT_DAILY_LIMIT_EXCEEDED: &str = "AGENT_DAILY_LIMIT_EXCEEDED";
    pub const VAULT_DAILY_LIMIT_EXCEEDED: &str = "VAULT_DAILY_LIMIT_EXCEEDED";
    pub const INSUFFICIENT_BALANCE: &str = "INSUFFICIENT_BALANCE";
    pub const TOO_MANY_PENDING_APPROVALS: &str = "TOO_MANY_PENDING_APPROVALS";
    pub const SCHEDULE_NOT_FOUND: &str = "SCHEDULE_NOT_FOUND";
    pub const SCHEDULE_NOT_ACTIVE: &str = "SCHEDULE_NOT_ACTIVE";
    // `PendingApproval.reason` values (not rejections).
    pub const ABOVE_THRESHOLD: &str = "ABOVE_THRESHOLD";
    pub const OVERDUE_NEEDS_APPROVAL: &str = "OVERDUE_NEEDS_APPROVAL";
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    Recipients,
    Agents,
    AgentByAccount,
    Payouts,
    Approvals,
    Rejections,
    ApprovedMeasurements,
    ApprovedPpids,
    WhitelistedAgentsForLocal,
    /// Map agent_id → that agent's payout index.
    AgentPayoutsIndex,
    /// One `Vector<PayoutId>` per agent, prefixed by sha256(agent_id). Append new keys only.
    AgentPayouts {
        agent_hash: Vec<u8>,
    },
    Schedules,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub proposed_owner: Option<AccountId>,
    /// The only NEP-141 token this vault accepts and pays out (USDC).
    pub treasury_token: AccountId,
    pub policy: Policy,
    /// Global kill switch. The owner can still withdraw.
    pub paused: bool,

    /// Spendable tokens (internal accounting).
    pub balance: u128,
    /// Reserved by transfers whose callback has not run yet (the `ft_transfer` may already have executed).
    pub in_flight: u128,
    pub spent_today: u128,
    pub day_index: u64,
    /// Incremented on every successful outflow callback; guards balance checks that span blocks.
    pub outflow_epoch: u64,
    /// First read of a two-phase untracked-token check (`credit_refund` / `sync_surplus`).
    pub surplus_probe: Option<SurplusProbe>,
    /// NEAR attached to `storage_deposit` for a fresh 1Click deposit account (USDC: 0.00125 NEAR).
    pub storage_deposit_yocto: u128,

    pub recipients: IterableMap<RecipientId, Recipient>,
    pub next_recipient_id: RecipientId,
    pub schedules: IterableMap<ScheduleId, Schedule>,
    pub next_schedule_id: ScheduleId,
    pub agents: IterableMap<AgentId, Agent>,
    pub agent_by_account: LookupMap<AccountId, AgentId>,
    pub payouts: Vector<Payout>,
    pub agent_payouts: LookupMap<AgentId, Vector<PayoutId>>,
    /// Payout ids in `PendingApproval`.
    pub approvals: IterableSet<PayoutId>,
    /// Ring buffer of the last `REJECTIONS_CAP` rejections; `rejections_head` is the next slot to overwrite once full.
    pub rejections: Vector<Rejection>,
    pub rejections_head: u32,

    // --- Shade Agent v2 trust anchors (adapted from NearDeFi/shade-agent-template, Apache-2.0) ---
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: u64,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub approved_ppids: IterableSet<Ppid>,
    pub whitelisted_agents_for_local: IterableSet<AccountId>,
}

#[near]
impl Contract {
    /// `#[private]`: only the vault account itself can initialize it (deploy + init in one transaction).
    #[init]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        treasury_token: AccountId,
        policy: Policy,
        requires_tee: bool,
        attestation_expiration_time_ms: U64,
        storage_deposit_yocto: Option<U128>,
        allow_insecure_local_mode: Option<bool>,
    ) -> Self {
        // Local mode skips TEE attestation (dev only). It must be asked for explicitly, never by accident.
        require!(
            requires_tee || allow_insecure_local_mode == Some(true),
            "requires_tee = false needs allow_insecure_local_mode = true (development only, never with real funds)"
        );
        Self {
            owner_id,
            proposed_owner: None,
            treasury_token,
            policy,
            paused: false,
            balance: 0,
            in_flight: 0,
            spent_today: 0,
            day_index: block_timestamp_ms() / DAY_MS,
            outflow_epoch: 0,
            surplus_probe: None,
            storage_deposit_yocto: storage_deposit_yocto.map(|v| v.0).unwrap_or(1_250_000_000_000_000_000_000),
            recipients: IterableMap::new(StorageKey::Recipients),
            next_recipient_id: 0,
            schedules: IterableMap::new(StorageKey::Schedules),
            next_schedule_id: 0,
            agents: IterableMap::new(StorageKey::Agents),
            agent_by_account: LookupMap::new(StorageKey::AgentByAccount),
            payouts: Vector::new(StorageKey::Payouts),
            agent_payouts: LookupMap::new(StorageKey::AgentPayoutsIndex),
            approvals: IterableSet::new(StorageKey::Approvals),
            rejections: Vector::new(StorageKey::Rejections),
            rejections_head: 0,
            requires_tee,
            attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
        }
    }

    /// Called by `update_contract` right after deploying new code. Same layout for now; when the state struct
    /// changes, read the old struct here and convert it.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("No state to migrate"))
    }
}

impl Contract {
    pub(crate) fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Caller is not the owner");
    }

    /// Owner + exactly 1 yoctoNEAR. Attaching a deposit is impossible with a function-call access key, so these
    /// methods need a full-access key / wallet confirmation.
    pub(crate) fn require_owner_one_yocto(&self) {
        self.require_owner();
        require!(env::attached_deposit() == ONE_YOCTO, "Requires attached deposit of exactly 1 yoctoNEAR");
    }

    /// Reset the vault daily counter when the UTC day changes.
    pub(crate) fn roll_day(&mut self) {
        let today = block_timestamp_ms() / DAY_MS;
        if today != self.day_index {
            self.day_index = today;
            self.spent_today = 0;
        }
    }

    pub(crate) fn vault_spent_today(&self) -> u128 {
        if block_timestamp_ms() / DAY_MS == self.day_index { self.spent_today } else { 0 }
    }

    pub(crate) fn payout_mut(&mut self, payout_id: PayoutId) -> &mut Payout {
        let idx = u32::try_from(payout_id).unwrap_or_else(|_| env::panic_str("Payout not found"));
        self.payouts.get_mut(idx).unwrap_or_else(|| env::panic_str("Payout not found"))
    }

    pub(crate) fn payout_ref(&self, payout_id: PayoutId) -> Option<&Payout> {
        u32::try_from(payout_id).ok().and_then(|idx| self.payouts.get(idx))
    }

    pub(crate) fn agent_mut(&mut self, agent_id: &AgentId) -> &mut Agent {
        self.agents.get_mut(agent_id).unwrap_or_else(|| env::panic_str("Agent not found"))
    }
}

impl Agent {
    fn is_today(&self) -> bool {
        block_timestamp_ms() / DAY_MS == self.day_index
    }

    pub(crate) fn spent_today(&self) -> u128 {
        if self.is_today() { self.spent_today } else { 0 }
    }

    pub(crate) fn payments_today(&self) -> u32 {
        if self.is_today() { self.payments_today } else { 0 }
    }

    pub(crate) fn roll_day(&mut self) {
        let today = block_timestamp_ms() / DAY_MS;
        if today != self.day_index {
            self.day_index = today;
            self.spent_today = 0;
            self.payments_today = 0;
            self.rejections_logged_today = 0;
        }
    }
}

/// Addresses are compared case-insensitively for EVM (`0x…`) and exactly otherwise (base58 is case-sensitive).
pub(crate) fn same_address(a: &str, b: &str) -> bool {
    if a.starts_with("0x") || a.starts_with("0X") { a.eq_ignore_ascii_case(b) } else { a == b }
}

/// 1Click ORIGIN_CHAIN deposit addresses for NEAR assets are 64-char lowercase hex implicit accounts.
pub(crate) fn is_implicit_account(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

pub(crate) fn is_valid_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `1500000` → `"1.5"` (USDC, 6 decimals). For human-readable rejection details only.
pub(crate) fn fmt_amount(amount: u128) -> String {
    let unit = 10u128.pow(TOKEN_DECIMALS);
    let whole = amount / unit;
    let frac = amount % unit;
    if frac == 0 {
        return whole.to_string();
    }
    let frac_str = format!("{:0width$}", frac, width = TOKEN_DECIMALS as usize);
    format!("{whole}.{}", frac_str.trim_end_matches('0'))
}
