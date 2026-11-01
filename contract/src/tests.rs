//! Unit tests for the multi-agent vault with schedules (AGENT_ACCESS §3.7, ADR-0003, ADR-0004), run on near-sdk's
//! mocked blockchain.
//!
//! How the harness works:
//! - [`H`] owns the `Contract` and a mocked clock (`now`, ms). Every call goes through `as_owner()` / `as_(account,
//!   deposit)` / `as_callback(result)`, which re-create the mocked context (predecessor, deposit, timestamp, 300 TGas)
//!   while keeping contract storage.
//! - Unit tests call methods directly, so `#[private]` / `#[payable]` wrappers are NOT exercised; the contract's own
//!   `require_owner*` checks are. Cross-contract results are simulated by calling the callback with a mocked
//!   `PromiseResult` (5-arg `testing_env!`).
//! - TEE agents run in local mode (`requires_tee = false`): whitelisted account + mock measurements + default PPID.
//! - The check-order tests build one request that violates several rules at once; some violations are injected by
//!   writing contract state directly (e.g. `failed_transfers = 3`) so that they can be combined freely.

use crate::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};
use shade_attestation::attestation::create_mock_dstack_attestation;
use std::panic::{AssertUnwindSafe, catch_unwind};

// --- fixtures ------------------------------------------------------------------------------------

/// Noon UTC of some day, so `+/- a few hours` stays in the same day index.
const T0: u64 = 20_000 * DAY_MS + DAY_MS / 2;
const USDC: u128 = 1_000_000;
const FUND: u128 = 10_000 * USDC;
const VAULT_DAILY: u128 = 2_000 * USDC;
const AGENT_DAILY: u128 = 1_000 * USDC;
const PER_TX: u128 = 500 * USDC;
const THRESHOLD: u128 = 300 * USDC;
const AMOUNT: u128 = 100 * USDC;
/// Above the approval threshold, within per_tx_limit.
const LARGE: u128 = 400 * USDC;
const PERIOD: u64 = 30 * DAY_MS;
const ATTESTATION_TTL: u64 = 365 * DAY_MS;
/// Default vault min payment: one base unit, so limit tests can probe with `1`. Dust tests raise it.
const MIN_PAYMENT: u128 = 1;
const MAX_PER_DAY: u32 = 20;
/// Default 1Click quote deadline sent with every request (required above the approval threshold).
const DEADLINE: u64 = T0 + 30 * DAY_MS;
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

const CHAIN: &str = "base";
const ASSET: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_ADDR: &str = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const PROCUREMENT: &str = "procurement";
const PAYROLL: &str = "payroll";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn vault() -> AccountId {
    acc("vault.near")
}
fn owner() -> AccountId {
    acc("owner.near")
}
fn token() -> AccountId {
    acc("usdc.near")
}
/// Key agent account (setup A: sub-account of the owner holding a function-call key).
fn key_acc() -> AccountId {
    acc("procurement.owner.near")
}
fn key_acc2() -> AccountId {
    acc("ops.owner.near")
}
/// TEE agent accounts (in TEE mode these would be implicit accounts generated in the enclave).
fn tee_acc() -> AccountId {
    acc("payroll-worker.near")
}
fn tee_acc2() -> AccountId {
    acc("payroll-worker-2.near")
}
fn stranger() -> AccountId {
    acc("mallory.near")
}
/// A 64-hex implicit account, the shape of a 1Click deposit address.
fn dep(n: u8) -> String {
    hex::encode([n; 32])
}
fn evm_addr(n: u8) -> String {
    format!("0x{}", hex::encode([n; 20]))
}

const GRACE: u64 = DEFAULT_OVERDUE_GRACE_MS;
/// 2026-12-01T09:30:00Z (a Tuesday). Calendar tests run around this date.
const DEC1: u64 = 1_796_117_400_000;

fn default_policy() -> Policy {
    Policy { daily_limit: U128(VAULT_DAILY), min_payment: U128(MIN_PAYMENT), overdue_grace_ms: U64(GRACE) }
}
fn policy(daily: u128) -> Policy {
    Policy { daily_limit: U128(daily), ..default_policy() }
}
fn policy_min(daily: u128, min_payment: u128) -> Policy {
    Policy { daily_limit: U128(daily), min_payment: U128(min_payment), ..default_policy() }
}

fn mandate(mode: RecipientsMode) -> Mandate {
    Mandate {
        daily_limit: U128(AGENT_DAILY),
        per_tx_limit: U128(PER_TX),
        approval_threshold: U128(THRESHOLD),
        allowed_chains: vec![CHAIN.to_string(), "sol".to_string(), "near".to_string()],
        recipients_mode: mode,
        allowlist: vec![],
        recipients: vec![],
        expires_at: None,
        max_payments_per_day: MAX_PER_DAY,
    }
}
fn open_mandate() -> Mandate {
    mandate(RecipientsMode::Open)
}
fn fixed_mandate(rids: Vec<RecipientId>) -> Mandate {
    Mandate { recipients: rids, ..mandate(RecipientsMode::Fixed) }
}
fn destination(chain: &str, address: &str) -> Destination {
    Destination { chain: chain.to_string(), address: address.to_string(), label: None }
}
fn allowlist_mandate(list: Vec<Destination>) -> Mandate {
    Mandate { allowlist: list, ..mandate(RecipientsMode::Allowlist) }
}

fn recipient_input(label: &str, address: String) -> RecipientInput {
    RecipientInput {
        label: label.to_string(),
        destination_chain: CHAIN.to_string(),
        destination_asset: ASSET.to_string(),
        destination_address: address,
    }
}

/// Every 30 days from `start`, forever (the old "period" semantics).
fn every_period() -> Frequency {
    Frequency::EveryNDays { n: (PERIOD / DAY_MS) as u16 }
}
fn schedule_input(rid: RecipientId, agent: &str, amount: u128, frequency: Frequency, start: u64) -> ScheduleInput {
    ScheduleInput {
        recipient_id: rid,
        amount: U128(amount),
        frequency,
        start_at: U64(start),
        end: ScheduleEnd::Never,
        agent_id: agent.to_string(),
    }
}

fn ok_result() -> PromiseResult {
    PromiseResult::Successful(vec![])
}
fn balance_result(actual: u128) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&U128(actual)).unwrap())
}

/// `(receiver, method, attached yocto)` for every function call scheduled in the current mocked receipt.
fn scheduled_calls() -> Vec<(AccountId, String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, attached_deposit, .. } => {
                    Some((receiver.clone(), String::from_utf8(method_name).unwrap(), attached_deposit.as_yoctonear()))
                }
                _ => None,
            })
        })
        .collect()
}

/// Function-call args (JSON) of the scheduled call `method`.
fn scheduled_args(method: &str) -> serde_json::Value {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == method.as_bytes() => {
                Some(serde_json::from_slice(&args).unwrap())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no scheduled call {method}"))
}

/// Runs `f`, asserts it panics with a message containing `expected`.
fn expect_panic<R, F: FnOnce() -> R>(f: F, expected: &str) {
    let err =
        catch_unwind(AssertUnwindSafe(f)).err().unwrap_or_else(|| panic!("expected panic containing {expected:?}"));
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(expected), "panic message {msg:?} does not contain {expected:?}");
}

fn rejection_of(res: PromiseOrValue<PaymentResult>) -> (String, String) {
    match res {
        PromiseOrValue::Value(PaymentResult::Rejected { reason, detail }) => (reason, detail),
        PromiseOrValue::Value(other) => panic!("expected Rejected, got {other:?}"),
        PromiseOrValue::Promise(_) => panic!("expected Rejected, got a transfer promise"),
    }
}

/// A payment request as an agent would send it.
#[derive(Clone, Debug)]
struct Req {
    chain: String,
    address: String,
    amount: u128,
    memo: Option<String>,
    schedule_id: Option<ScheduleId>,
    deposit: String,
    expires: Option<u64>,
}

impl Req {
    fn open(amount: u128) -> Self {
        Self::to(CHAIN, &evm_addr(0x99), amount)
    }
    fn to(chain: &str, address: &str, amount: u128) -> Self {
        Req {
            chain: chain.to_string(),
            address: address.to_string(),
            amount,
            memo: None,
            schedule_id: None,
            deposit: dep(1),
            expires: Some(DEADLINE),
        }
    }
}

/// Everything money-related a rejection must not touch.
#[derive(Debug, PartialEq)]
struct Money {
    balance: u128,
    in_flight: u128,
    vault_spent: u128,
    payouts: u32,
    approvals: u32,
    agents: Vec<(AgentId, u128, u32, u32, u32, AgentStatus)>,
    recipients: Vec<(RecipientId, Recipient)>,
    schedules: Vec<Schedule>,
}

// --- harness -------------------------------------------------------------------------------------

struct H {
    c: Contract,
    now: u64,
}

impl H {
    /// Initialized vault: no agents, no funds.
    fn bare() -> Self {
        Self::bare_at(T0)
    }

    /// Initialized vault at clock `now`.
    fn bare_at(now: u64) -> Self {
        // Each harness starts from empty storage, even when several are created in one test (table-driven loops).
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        testing_env!(Self::ctx_at(&vault(), NO_DEPOSIT, now, Gas::from_tgas(300)).build());
        let c = Contract::new(owner(), token(), default_policy(), false, U64(ATTESTATION_TTL), None, Some(true));
        H { c, now }
    }

    /// Funded vault with the Open key agent `procurement`.
    fn new() -> Self {
        let mut h = Self::bare();
        h.fund(FUND);
        h.add_key(PROCUREMENT, key_acc(), open_mandate());
        h
    }

    /// `new()` + `n` recipients + registered TEE agent `payroll` with a Fixed mandate over all of them + one schedule
    /// per recipient (AMOUNT every 30 days from T0, executed by `payroll`). Returns the schedule ids; schedule `i`
    /// pays recipient `i` (both start at 0 in a fresh vault).
    fn with_payroll(n: u8) -> (Self, Vec<ScheduleId>) {
        let mut h = Self::new();
        let rids: Vec<RecipientId> = (0..n).map(|i| h.add_recipient(evm_addr(0x10 + i))).collect();
        h.add_tee(PAYROLL, None, fixed_mandate(rids.clone()));
        h.trust_local(&tee_acc());
        assert!(h.register(PAYROLL, &tee_acc()));
        let sids: Vec<ScheduleId> =
            rids.iter().map(|rid| h.add_schedule(schedule_input(*rid, PAYROLL, AMOUNT, every_period(), T0))).collect();
        assert_eq!(sids, rids);
        (h, sids)
    }

    /// Funded vault at `now` with recipient 0 (`evm_addr(0x10)`), Fixed key agent `fx` (`key_acc2`) over it, and one
    /// schedule (id 0) of `amount` with `freq` from `start` ending `end`.
    fn sched_vault(now: u64, freq: Frequency, start: u64, end: ScheduleEnd, amount: u128) -> (Self, ScheduleId) {
        let mut h = Self::bare_at(now);
        h.fund(FUND);
        let rid = h.add_recipient(evm_addr(0x10));
        h.add_key("fx", key_acc2(), fixed_mandate(vec![rid]));
        let sid = h.add_schedule(ScheduleInput { end, ..schedule_input(rid, "fx", amount, freq, start) });
        (h, sid)
    }

    fn ctx_at(pred: &AccountId, deposit: NearToken, now_ms: u64, gas: Gas) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(vault())
            .signer_account_id(pred.clone())
            .predecessor_account_id(pred.clone())
            .attached_deposit(deposit)
            .block_timestamp(now_ms * 1_000_000)
            .prepaid_gas(gas);
        b
    }

    fn set(&self, pred: &AccountId, deposit: NearToken, gas: Gas) {
        testing_env!(Self::ctx_at(pred, deposit, self.now, gas).build());
    }
    fn as_(&mut self, who: &AccountId, deposit: NearToken) -> &mut Contract {
        self.set(who, deposit, Gas::from_tgas(300));
        &mut self.c
    }
    fn as_with_gas(&mut self, who: &AccountId, deposit: NearToken, gas: Gas) -> &mut Contract {
        self.set(who, deposit, gas);
        &mut self.c
    }
    /// Owner with exactly 1 yoctoNEAR attached.
    fn as_owner(&mut self) -> &mut Contract {
        self.as_(&owner(), ONE_YOCTO)
    }
    fn as_owner_no_deposit(&mut self) -> &mut Contract {
        self.as_(&owner(), NO_DEPOSIT)
    }
    /// The vault calling itself with the given promise result (callbacks are `#[private]`).
    fn as_callback(&mut self, result: PromiseResult) -> &mut Contract {
        testing_env!(
            Self::ctx_at(&vault(), NO_DEPOSIT, self.now, Gas::from_tgas(300)).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        &mut self.c
    }
    /// Read-only access at the current mocked time. Keeps the current context (and its logs) when the clock has not
    /// moved since the last call, so log assertions can follow view calls.
    fn view(&self) -> &Contract {
        self.sync_clock();
        &self.c
    }
    fn sync_clock(&self) {
        if env::block_timestamp_ms() != self.now {
            self.set(&stranger(), NO_DEPOSIT, Gas::from_tgas(300));
        }
    }
    fn advance(&mut self, ms: u64) {
        self.now += ms;
    }

    fn fund(&mut self, amount: u128) {
        let res = self.as_(&token(), NO_DEPOSIT).ft_on_transfer(owner(), U128(amount), String::new());
        assert!(matches!(res, PromiseOrValue::Value(U128(0))));
    }

    // --- agents ---

    fn add_key(&mut self, id: &str, account: AccountId, m: Mandate) -> AgentView {
        self.as_owner().add_agent(id.to_string(), format!("{id} agent"), AgentKind::Key, Some(account), None, m)
    }
    fn add_tee(&mut self, id: &str, pinned: Option<AccountId>, m: Mandate) -> AgentView {
        self.as_owner().add_agent(id.to_string(), format!("{id} agent"), AgentKind::Tee, pinned, None, m)
    }
    /// Local-mode trust anchors for `a`: whitelist + mock measurements + default PPID.
    fn trust_local(&mut self, a: &AccountId) {
        self.as_owner().whitelist_agent_for_local(a.clone());
        self.as_owner().approve_measurements(create_mock_full_measurements_hex());
        self.as_owner().approve_ppids(vec![Ppid::default()]);
    }
    fn register(&mut self, id: &str, a: &AccountId) -> bool {
        self.as_(a, NO_DEPOSIT).register_agent(id.to_string(), create_mock_dstack_attestation())
    }
    fn agent(&self, id: &str) -> &Agent {
        self.c.agents.get(&id.to_string()).expect("agent exists")
    }
    fn agent_mut(&mut self, id: &str) -> &mut Agent {
        self.c.agents.get_mut(&id.to_string()).expect("agent exists")
    }
    /// Owner replaces the mandate via `update_mandate`, starting from the current one.
    fn edit_mandate(&mut self, id: &str, f: impl FnOnce(&mut Mandate)) {
        let mut m = self.agent(id).mandate.clone();
        f(&mut m);
        self.as_owner().update_mandate(id.to_string(), m);
    }

    // --- recipients ---

    fn add_recipient(&mut self, address: String) -> RecipientId {
        let label = format!("r{}", self.c.next_recipient_id);
        self.as_owner().add_recipient(recipient_input(&label, address))
    }
    fn recipient(&self, rid: RecipientId) -> Recipient {
        self.c.recipients.get(&rid).cloned().expect("recipient exists")
    }

    // --- schedules ---

    fn add_schedule(&mut self, input: ScheduleInput) -> ScheduleId {
        self.as_owner().add_schedule(input)
    }
    fn schedule(&self, sid: ScheduleId) -> Schedule {
        self.c.schedules.get(&sid).cloned().expect("schedule exists")
    }
    fn schedule_mut(&mut self, sid: ScheduleId) -> &mut Schedule {
        self.c.schedules.get_mut(&sid).expect("schedule exists")
    }
    /// The schedule's current terms as an input (to tweak and pass to `update_schedule`).
    fn schedule_terms(&self, sid: ScheduleId) -> ScheduleInput {
        let s = self.schedule(sid);
        ScheduleInput {
            recipient_id: s.recipient_id,
            amount: s.amount,
            frequency: s.frequency,
            start_at: s.start_at,
            end: s.end,
            agent_id: s.agent_id,
        }
    }
    /// Owner changes a schedule's terms via `update_schedule`, starting from the current ones.
    fn edit_schedule(&mut self, sid: ScheduleId, f: impl FnOnce(&mut ScheduleInput)) {
        let mut input = self.schedule_terms(sid);
        f(&mut input);
        self.as_owner().update_schedule(sid, input);
    }
    /// The request an agent sends for schedule `sid`: its recipient's chain and address, its amount. Quote deadline
    /// relative to the current clock (needed for approvals).
    fn fixed_req(&self, sid: ScheduleId) -> Req {
        let s = self.schedule(sid);
        let r = self.recipient(s.recipient_id);
        Req {
            schedule_id: Some(sid),
            expires: Some(self.now + 30 * DAY_MS),
            ..Req::to(&r.destination_chain, &r.destination_address, s.amount.0)
        }
    }
    /// Account of the agent that executes schedule `sid`.
    fn sched_caller(&self, sid: ScheduleId) -> AccountId {
        self.agent(&self.schedule(sid).agent_id).account_id.clone().expect("agent bound")
    }
    fn pay_sched(&mut self, sid: ScheduleId) -> PromiseOrValue<PaymentResult> {
        let (who, r) = (self.sched_caller(sid), self.fixed_req(sid));
        self.pay(&who, &r)
    }
    fn sched_code(&mut self, sid: ScheduleId) -> String {
        rejection_of(self.pay_sched(sid)).0
    }
    /// Pays schedule `sid` now; transfer succeeds. Returns the payout id.
    fn paid_sched(&mut self, sid: ScheduleId) -> PayoutId {
        let (who, r) = (self.sched_caller(sid), self.fixed_req(sid));
        self.paid(&who, &r)
    }
    /// Schedule request that must park for approval; returns (payout id, reason).
    fn pending_sched(&mut self, sid: ScheduleId) -> (PayoutId, String) {
        match self.pay_sched(sid) {
            PromiseOrValue::Value(PaymentResult::PendingApproval { payout_id, reason: why }) => (payout_id.0, why),
            PromiseOrValue::Value(v) => panic!("expected PendingApproval, got {v:?}"),
            PromiseOrValue::Promise(_) => panic!("expected PendingApproval, got a promise"),
        }
    }
    fn set_now(&mut self, t: u64) {
        assert!(t >= self.now, "clock goes forward only");
        self.now = t;
    }

    // --- payments ---

    fn pay(&mut self, who: &AccountId, r: &Req) -> PromiseOrValue<PaymentResult> {
        self.as_(who, NO_DEPOSIT).request_payment(
            r.chain.clone(),
            r.address.clone(),
            U128(r.amount),
            r.memo.clone(),
            r.schedule_id,
            r.deposit.clone(),
            r.expires.map(U64),
        )
    }
    fn rejected(&mut self, who: &AccountId, r: &Req) -> (String, String) {
        rejection_of(self.pay(who, r))
    }
    fn reject_code(&mut self, who: &AccountId, r: &Req) -> String {
        self.rejected(who, r).0
    }
    /// Request that must start a transfer; returns the payout id (status `Transferring`).
    fn submit(&mut self, who: &AccountId, r: &Req) -> PayoutId {
        match self.pay(who, r) {
            PromiseOrValue::Promise(p) => drop(p),
            PromiseOrValue::Value(v) => panic!("expected a transfer promise, got {v:?}"),
        }
        let id = u64::from(self.c.payouts.len() - 1);
        assert_eq!(self.payout(id).status, PayoutStatus::Transferring);
        id
    }
    /// Request that must create a `PendingApproval` payout; returns its id.
    fn pending(&mut self, who: &AccountId, r: &Req) -> PayoutId {
        match self.pay(who, r) {
            PromiseOrValue::Value(PaymentResult::PendingApproval { payout_id, reason: why }) => {
                assert_eq!(why, reason::ABOVE_THRESHOLD);
                payout_id.0
            }
            PromiseOrValue::Value(v) => panic!("expected PendingApproval, got {v:?}"),
            PromiseOrValue::Promise(_) => panic!("expected PendingApproval, got a promise"),
        }
    }
    /// Simulates the result of the payout's `storage_deposit + ft_transfer` batch.
    fn settle(&mut self, id: PayoutId, success: bool) -> PaymentResult {
        let r = if success { ok_result() } else { PromiseResult::Failed };
        self.as_callback(r).on_transfer_result(U64(id))
    }
    /// Full happy path: request, transfer succeeds. Returns the payout id (status `Sent`).
    fn paid(&mut self, who: &AccountId, r: &Req) -> PayoutId {
        let id = self.submit(who, r);
        assert_eq!(self.settle(id, true), PaymentResult::Submitted { payout_id: U64(id) });
        id
    }
    /// Owner approves; returns nothing, the transfer promise is scheduled.
    fn approve(&mut self, id: PayoutId) {
        drop(self.as_owner().approve_payout(U64(id)));
    }

    fn payout(&self, id: PayoutId) -> Payout {
        self.c.get_payout(U64(id)).expect("payout exists")
    }
    fn money(&self) -> Money {
        self.sync_clock();
        Money {
            balance: self.c.balance,
            in_flight: self.c.in_flight,
            vault_spent: self.c.vault_spent_today(),
            payouts: self.c.payouts.len(),
            approvals: self.c.approvals.len(),
            agents: self
                .c
                .agents
                .values()
                .map(|a| {
                    (a.id.clone(), a.spent_today(), a.payments_today(), a.open_approvals, a.failed_transfers, a.status)
                })
                .collect(),
            recipients: self.c.recipients.iter().map(|(id, r)| (*id, r.clone())).collect(),
            schedules: self.c.schedules.values().cloned().collect(),
        }
    }
    fn agent_spent(&self, id: &str) -> u128 {
        self.sync_clock();
        self.agent(id).spent_today()
    }
    fn vault_spent(&self) -> u128 {
        self.view().get_balance().spent_today.0
    }
}

// --- init ----------------------------------------------------------------------------------------

#[test]
fn new_initializes_state() {
    let h = H::bare();
    let info = h.view().get_contract_info();
    assert_eq!(info.owner_id, owner());
    assert_eq!(info.treasury_token, token());
    assert!(!info.requires_tee);
    assert_eq!(info.attestation_expiration_time_ms.0, ATTESTATION_TTL);
    assert_eq!(info.storage_deposit_yocto.0, 1_250_000_000_000_000_000_000);
    assert_eq!(h.c.day_index, T0 / DAY_MS);
    assert_eq!((h.c.balance, h.c.in_flight, h.c.spent_today), (0, 0, 0));
    let p = h.view().get_policy();
    assert_eq!((p.daily_limit, p.paused), (U128(VAULT_DAILY), false));
    assert!(h.view().get_agents(None, None).is_empty());
    assert!(h.view().get_rejections(None, None, None).is_empty());
}

// --- add_agent / update_mandate ------------------------------------------------------------------

#[test]
fn add_key_agent_records_account_and_key() {
    let mut h = H::bare();
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    let v = h.as_owner().add_agent(
        PROCUREMENT.into(),
        "Procurement".into(),
        AgentKind::Key,
        Some(key_acc()),
        Some(pk.clone()),
        open_mandate(),
    );
    assert_eq!(v.id, PROCUREMENT);
    assert_eq!(v.kind, AgentKind::Key);
    assert_eq!(v.account_id, Some(key_acc()));
    assert!(!v.account_pinned);
    assert_eq!(v.public_key, Some(pk));
    assert_eq!(v.status, AgentStatus::Active);
    assert_eq!((v.spent_today, v.created_at, v.last_request_at), (U128(0), U64(T0), None));
    assert_eq!((v.failed_transfers, v.open_approvals), (0, 0));
    assert!(v.tee.is_none());
    assert_eq!(v.mandate, open_mandate());
    assert!(get_logs().iter().any(|l| l.contains("agent_added")));
    assert_eq!(h.view().get_agent_by_account(key_acc()).map(|a| a.id), Some(PROCUREMENT.to_string()));
    assert_eq!(h.view().get_agents(None, None).len(), 1);
    assert!(h.view().get_agent("nope".into()).is_none());
}

#[test]
fn add_tee_agent_pinned_and_unpinned() {
    let mut h = H::new();
    let v = h.add_tee(PAYROLL, None, open_mandate());
    assert_eq!((v.account_id, v.account_pinned), (None, false));
    let v = h.add_tee("pinned", Some(tee_acc()), open_mandate());
    assert_eq!((v.account_id, v.account_pinned), (Some(tee_acc()), true));
    assert!(v.tee.is_none(), "not registered yet");
}

#[test]
fn add_agent_validation() {
    type Case = (&'static str, fn(&mut H), &'static str);
    let cases: Vec<Case> = vec![
        ("empty id", |h| drop(h.add_key("", stranger(), open_mandate())), "Agent id must match"),
        ("uppercase id", |h| drop(h.add_key("Bad", stranger(), open_mandate())), "Agent id must match"),
        ("underscore id", |h| drop(h.add_key("a_b", stranger(), open_mandate())), "Agent id must match"),
        ("33-char id", |h| drop(h.add_key(&"a".repeat(33), stranger(), open_mandate())), "Agent id must match"),
        ("duplicate id", |h| drop(h.add_key(PROCUREMENT, stranger(), open_mandate())), "Agent id already exists"),
        (
            "empty name",
            |h| {
                h.as_owner().add_agent("x".into(), "".into(), AgentKind::Key, Some(stranger()), None, open_mandate());
            },
            "Invalid name",
        ),
        (
            "long name",
            |h| {
                h.as_owner().add_agent(
                    "x".into(),
                    "n".repeat(MAX_LABEL_LEN + 1),
                    AgentKind::Key,
                    Some(stranger()),
                    None,
                    open_mandate(),
                );
            },
            "Invalid name",
        ),
        (
            "key without account",
            |h| {
                h.as_owner().add_agent("x".into(), "x".into(), AgentKind::Key, None, None, open_mandate());
            },
            "Key agents need account_id",
        ),
        (
            "account = owner",
            |h| drop(h.add_key("x", owner(), open_mandate())),
            "cannot be the owner, the vault or the token",
        ),
        (
            "account = vault",
            |h| drop(h.add_key("x", vault(), open_mandate())),
            "cannot be the owner, the vault or the token",
        ),
        (
            "account = token",
            |h| drop(h.add_key("x", token(), open_mandate())),
            "cannot be the owner, the vault or the token",
        ),
        ("tee pinned = owner", |h| drop(h.add_tee("x", Some(owner()), open_mandate())), "cannot be the owner"),
        ("account already bound", |h| drop(h.add_key("x", key_acc(), open_mandate())), "Account is already bound"),
        (
            "per_tx > daily",
            |h| {
                let m = Mandate { per_tx_limit: U128(AGENT_DAILY + 1), ..open_mandate() };
                drop(h.add_key("x", stranger(), m));
            },
            "per_tx_limit must not exceed daily_limit",
        ),
        (
            "no chains",
            |h| drop(h.add_key("x", stranger(), Mandate { allowed_chains: vec![], ..open_mandate() })),
            "allowed_chains must have 1..=16 entries",
        ),
        (
            "17 chains",
            |h| {
                let chains = (0..17).map(|i| format!("c{i}")).collect();
                drop(h.add_key("x", stranger(), Mandate { allowed_chains: chains, ..open_mandate() }));
            },
            "allowed_chains must have 1..=16 entries",
        ),
        (
            "bad chain id",
            |h| drop(h.add_key("x", stranger(), Mandate { allowed_chains: vec!["".into()], ..open_mandate() })),
            "Invalid chain id",
        ),
        (
            "max_payments_per_day = 0",
            |h| drop(h.add_key("x", stranger(), Mandate { max_payments_per_day: 0, ..open_mandate() })),
            "max_payments_per_day must be at least 1",
        ),
        (
            "fixed without recipients",
            |h| drop(h.add_key("x", stranger(), fixed_mandate(vec![]))),
            "Fixed mandate needs recipients",
        ),
        (
            "fixed with unknown recipient",
            |h| drop(h.add_key("x", stranger(), fixed_mandate(vec![42]))),
            "unknown recipient",
        ),
        (
            "allowlist mode without allowlist",
            |h| drop(h.add_key("x", stranger(), allowlist_mandate(vec![]))),
            "Allowlist mandate needs an allowlist",
        ),
        (
            "allowlist bad address",
            |h| drop(h.add_key("x", stranger(), allowlist_mandate(vec![destination(CHAIN, "")]))),
            "Invalid allowlist address",
        ),
        (
            "allowlist too long",
            |h| {
                let list = (0..=MAX_ALLOWLIST_PER_MANDATE).map(|i| destination(CHAIN, &format!("a{i}"))).collect();
                drop(h.add_key("x", stranger(), allowlist_mandate(list)));
            },
            "allowlist too long",
        ),
    ];
    for (name, call, expected) in cases {
        let mut h = H::new();
        let before = (h.c.agents.len(), h.view().get_agent_by_account(stranger()).is_some());
        let r = catch_unwind(AssertUnwindSafe(|| call(&mut h)));
        let err = r.err().unwrap_or_else(|| panic!("{name}: expected panic"));
        let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(msg.contains(expected), "{name}: {msg:?} does not contain {expected:?}");
        assert_eq!(before.0, h.c.agents.len(), "{name}: agent stored");
    }
}

#[test]
fn update_mandate_replaces_rules_and_keeps_counters() {
    let mut h = H::new();
    h.paid(&key_acc(), &Req::open(AMOUNT));
    let m = Mandate { daily_limit: U128(150 * USDC), per_tx_limit: U128(100 * USDC), ..open_mandate() };
    h.as_owner().update_mandate(PROCUREMENT.into(), m.clone());
    assert_eq!(h.agent(PROCUREMENT).mandate, m);
    assert_eq!(h.agent_spent(PROCUREMENT), AMOUNT, "changing limits does not reset today's spend");
    assert_eq!(h.reject_code(&key_acc(), &Req::open(AMOUNT)), reason::AGENT_DAILY_LIMIT_EXCEEDED);
    // Validation applies to updates as well.
    expect_panic(
        || {
            h.as_owner()
                .update_mandate(PROCUREMENT.into(), Mandate { per_tx_limit: U128(AGENT_DAILY + 1), ..open_mandate() })
        },
        "per_tx_limit must not exceed daily_limit",
    );
    expect_panic(|| h.as_owner().update_mandate("nope".into(), open_mandate()), "Agent not found");
    expect_panic(|| h.as_owner_no_deposit().update_mandate(PROCUREMENT.into(), open_mandate()), "1 yoctoNEAR");
}

// --- Open / Allowlist / Fixed --------------------------------------------------------------------

#[test]
fn open_accepts_any_address_on_allowed_chain() {
    let mut h = H::new();
    for (i, (chain, address)) in
        [(CHAIN, evm_addr(1)), (CHAIN, evm_addr(2)), ("sol", SOL_ADDR.to_string()), ("near", "bob.near".to_string())]
            .into_iter()
            .enumerate()
    {
        let r = Req { deposit: dep(i as u8 + 1), ..Req::to(chain, &address, AMOUNT) };
        let id = h.paid(&key_acc(), &r);
        let p = h.payout(id);
        assert_eq!((p.chain.as_str(), p.address.as_str()), (chain, address.as_str()));
    }
    assert_eq!(h.reject_code(&key_acc(), &Req::to("tron", "TXYZ", AMOUNT)), reason::CHAIN_NOT_ALLOWED);
    // Chain ids are exact.
    assert_eq!(h.reject_code(&key_acc(), &Req::to("BASE", &evm_addr(1), AMOUNT)), reason::CHAIN_NOT_ALLOWED);
}

#[test]
fn allowlist_rejects_unknown_and_accepts_known() {
    let mut h = H::new();
    let evm_mixed = "0xAbCdEf0000000000000000000000000000000001";
    h.add_key(
        "allow",
        key_acc2(),
        allowlist_mandate(vec![destination(CHAIN, evm_mixed), destination("sol", SOL_ADDR)]),
    );
    let a = key_acc2();
    // Known destinations pass; EVM is case-insensitive.
    h.paid(&a, &Req::to(CHAIN, evm_mixed, AMOUNT));
    h.paid(&a, &Req::to(CHAIN, &evm_mixed.to_lowercase(), AMOUNT));
    h.paid(&a, &Req::to(CHAIN, &format!("0x{}", evm_mixed[2..].to_uppercase()), AMOUNT));
    h.paid(&a, &Req::to("sol", SOL_ADDR, AMOUNT));
    // Unknown address, non-EVM case change, same address on another (allowed) chain.
    for r in [
        Req::to(CHAIN, &evm_addr(0xee), AMOUNT),
        Req::to("sol", &SOL_ADDR.to_lowercase(), AMOUNT),
        Req::to("sol", evm_mixed, AMOUNT),
        Req::to(CHAIN, SOL_ADDR, AMOUNT),
    ] {
        let (code, detail) = h.rejected(&a, &r);
        assert_eq!(code, reason::RECIPIENT_NOT_ALLOWED, "{r:?}");
        assert!(detail.contains("allowlist"), "{detail}");
    }
}

#[test]
fn fixed_pays_only_its_due_schedules_with_exact_amounts() {
    let (mut h, sids) = H::with_payroll(2);
    let (s0, s1) = (sids[0], sids[1]);
    let t = tee_acc();
    // A schedule of another agent (Open procurement) for a recipient outside payroll's mandate.
    let outside_rid = h.add_recipient(evm_addr(0x77));
    let outside = h.add_schedule(schedule_input(outside_rid, PROCUREMENT, AMOUNT, every_period(), T0));

    // On demand (no schedule) is never allowed for a Fixed agent, even to its own recipient's address.
    let (code, detail) = h.rejected(&t, &Req { schedule_id: None, ..h.fixed_req(s0) });
    assert_eq!(code, reason::RECIPIENT_NOT_ALLOWED);
    assert!(detail.contains("only pays its scheduled payments"), "{detail}");
    // Unknown schedule; another agent's schedule; wrong address / chain.
    assert_eq!(h.reject_code(&t, &Req { schedule_id: Some(99), ..h.fixed_req(s0) }), reason::SCHEDULE_NOT_FOUND);
    assert_eq!(h.reject_code(&t, &h.fixed_req(outside)), reason::RECIPIENT_NOT_ALLOWED);
    assert_eq!(h.reject_code(&t, &Req { address: evm_addr(0xee), ..h.fixed_req(s0) }), reason::RECIPIENT_NOT_ALLOWED);
    assert_eq!(h.reject_code(&t, &Req { chain: "sol".into(), ..h.fixed_req(s0) }), reason::RECIPIENT_NOT_ALLOWED);
    // Exact amount only (both directions).
    for amount in [AMOUNT - 1, AMOUNT + 1] {
        let (code, detail) = h.rejected(&t, &Req { amount, ..h.fixed_req(s0) });
        assert_eq!(code, reason::AMOUNT_MISMATCH);
        assert!(detail.contains("exactly 100 USDC"), "{detail}");
    }
    // EVM address match is case-insensitive.
    let upper = format!("0x{}", h.recipient(0).destination_address[2..].to_uppercase());
    let id = h.submit(&t, &Req { address: upper, ..h.fixed_req(s0) });
    let p = h.payout(id);
    assert_eq!((p.schedule_id, p.recipient_id, p.agent_id.as_str()), (Some(s0), Some(0), PAYROLL));
    assert_eq!((p.amount, p.occurrence_at), (U128(AMOUNT), Some(U64(T0))));
    // While in flight the occurrence is already reserved (NOT_DUE precedes PAYOUT_IN_PROGRESS in the check order);
    // after success: NOT_DUE until the next date.
    assert_eq!(h.reject_code(&t, &h.fixed_req(s0)), reason::NOT_DUE);
    h.settle(id, true);
    assert_eq!(h.reject_code(&t, &h.fixed_req(s0)), reason::NOT_DUE);
    // The other schedule is independent.
    h.paid(&t, &h.fixed_req(s1));
    h.advance(PERIOD - 1);
    let (code, detail) = h.rejected(&t, &h.fixed_req(s0));
    assert_eq!(code, reason::NOT_DUE);
    assert!(detail.contains("not due yet"), "{detail}");
    h.advance(1);
    h.paid(&t, &h.fixed_req(s0));
    // Paused schedule.
    h.as_owner_no_deposit().pause_schedule(s1);
    let (code, detail) = h.rejected(&t, &h.fixed_req(s1));
    assert_eq!(code, reason::SCHEDULE_NOT_ACTIVE);
    assert!(detail.contains("Paused"), "{detail}");
}

#[test]
fn fixed_non_evm_address_is_exact() {
    let mut h = H::new();
    let mut input = recipient_input("sol", SOL_ADDR.into());
    input.destination_chain = "sol".into();
    let rid = h.as_owner().add_recipient(input);
    h.add_key("fx", key_acc2(), fixed_mandate(vec![rid]));
    let sid = h.add_schedule(schedule_input(rid, "fx", AMOUNT, every_period(), T0));
    assert_eq!(
        h.reject_code(&key_acc2(), &Req { address: SOL_ADDR.to_lowercase(), ..h.fixed_req(sid) }),
        reason::RECIPIENT_NOT_ALLOWED
    );
    h.paid(&key_acc2(), &h.fixed_req(sid));
}

#[test]
fn request_payout_wrapper_fills_destination_from_schedule() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    let res = h.as_(&tee_acc(), NO_DEPOSIT).request_payout(sid, dep(3), None);
    assert!(matches!(res, PromiseOrValue::Promise(_)));
    drop(res);
    let p = h.payout(0);
    let r = h.recipient(0);
    assert_eq!((p.chain, p.address, p.amount), (r.destination_chain, r.destination_address, U128(AMOUNT)));
    assert_eq!((p.schedule_id, p.recipient_id, p.memo, p.deposit_expires_at_ms), (Some(sid), Some(0), None, None));
    assert_eq!(p.deposit_address, Some(acc(&dep(3))));
    h.settle(0, true);
    // Wrapper goes through the same checks.
    let (code, _) = rejection_of(h.as_(&tee_acc(), NO_DEPOSIT).request_payout(sid, dep(3), None));
    assert_eq!(code, reason::NOT_DUE);
    // Unknown schedule: SCHEDULE_NOT_FOUND, no payout. Agent checks still come first.
    let (code, _) = rejection_of(h.as_(&tee_acc(), NO_DEPOSIT).request_payout(99, dep(3), None));
    assert_eq!(code, reason::SCHEDULE_NOT_FOUND);
    let (code, _) = rejection_of(h.as_(&stranger(), NO_DEPOSIT).request_payout(99, dep(3), None));
    assert_eq!(code, reason::AGENT_NOT_FOUND);
    // Bad deposit address is checked before the schedule.
    let (code, _) = rejection_of(h.as_(&tee_acc(), NO_DEPOSIT).request_payout(99, "x.near".into(), None));
    assert_eq!(code, reason::INVALID_DEPOSIT_ADDRESS);
    assert_eq!(h.c.payouts.len(), 1);
}

#[test]
fn request_payout_wrapper_can_create_pending_approval() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    h.edit_schedule(sid, |s| s.amount = U128(LARGE));
    let (code, _) = rejection_of(h.as_(&tee_acc(), NO_DEPOSIT).request_payout(sid, dep(3), None));
    assert_eq!(code, reason::INVALID_REQUEST, "approval needs the quote deadline");
    let res = h.as_(&tee_acc(), NO_DEPOSIT).request_payout(sid, dep(3), Some(U64(DEADLINE)));
    let PromiseOrValue::Value(PaymentResult::PendingApproval { payout_id, reason: why }) = res else {
        panic!("expected PendingApproval");
    };
    assert_eq!(why, reason::ABOVE_THRESHOLD);
    let p = h.payout(payout_id.0);
    assert_eq!(
        (p.deposit_expires_at_ms, p.approval_reason.as_deref()),
        (Some(U64(DEADLINE)), Some(reason::ABOVE_THRESHOLD))
    );
}

#[test]
fn open_agent_cannot_pay_another_agents_schedule() {
    let (mut h, sids) = H::with_payroll(1);
    // An Open agent passing payroll's schedule id is refused and the schedule is untouched.
    let before = h.schedule(sids[0]);
    assert_eq!(h.reject_code(&key_acc(), &h.fixed_req(sids[0])), reason::RECIPIENT_NOT_ALLOWED);
    // Paying the same address on demand is fine and does not touch the schedule or the recipient's history.
    let id = h.paid(&key_acc(), &Req { schedule_id: None, ..h.fixed_req(sids[0]) });
    let p = h.payout(id);
    assert_eq!((p.schedule_id, p.recipient_id, p.occurrence_at), (None, None, None));
    assert_eq!(h.schedule(sids[0]), before);
    assert_eq!(h.recipient(0).last_paid_at_ms, None);
    h.paid(&tee_acc(), &h.fixed_req(sids[0]));
}

#[test]
fn open_and_allowlist_agents_can_execute_their_own_schedules() {
    let mut h = H::new();
    let rid = h.add_recipient(evm_addr(0x42));
    h.add_key("allow", key_acc2(), allowlist_mandate(vec![destination(CHAIN, &evm_addr(0x42))]));
    let s_open = h.add_schedule(schedule_input(rid, PROCUREMENT, AMOUNT, every_period(), T0));
    let s_allow = h.add_schedule(schedule_input(rid, "allow", AMOUNT, every_period(), T0));
    h.paid_sched(s_open);
    h.paid_sched(s_allow);
    assert_eq!(h.sched_code(s_open), reason::NOT_DUE);
    assert_eq!(h.sched_code(s_allow), reason::NOT_DUE);
    assert_eq!(h.recipient(rid).last_paid_at_ms, Some(U64(T0)));
    // On-demand payments keep working for them.
    h.paid(&key_acc2(), &Req::to(CHAIN, &evm_addr(0x42), AMOUNT));
}

// --- rejection codes and check order -------------------------------------------------------------

struct Attempt {
    caller: AccountId,
    agent: &'static str,
    /// The schedule being paid (state edits target it even if the request names another id).
    sid: Option<ScheduleId>,
    req: Req,
}

struct Violation {
    code: &'static str,
    /// Substring of the detail (distinguishes codes that occur at several steps).
    hint: &'static str,
    /// Only for requests that pay a schedule (ADR-0004 §3 steps marked S).
    scheduled_only: bool,
    tee_only: bool,
    apply: fn(&mut H, &mut Attempt),
}

/// All of AGENT_ACCESS §3.4 + ADR-0003 §3 + ADR-0004 §3, in documented order. Each violation alone yields its code.
fn violations() -> Vec<Violation> {
    fn v(code: &'static str, hint: &'static str, apply: fn(&mut H, &mut Attempt)) -> Violation {
        Violation { code, hint, scheduled_only: false, tee_only: false, apply }
    }
    fn sched(code: &'static str, hint: &'static str, apply: fn(&mut H, &mut Attempt)) -> Violation {
        Violation { scheduled_only: true, ..v(code, hint, apply) }
    }
    vec![
        v(reason::VAULT_PAUSED, "paused by its owner", |h, _| h.as_owner_no_deposit().pause()),
        v(reason::AGENT_PAUSED, "is paused", |h, a| h.as_owner_no_deposit().pause_agent(a.agent.into())),
        Violation {
            tee_only: true,
            ..v(reason::ATTESTATION_INVALID, "InvalidMeasurements", |h, _| {
                h.as_owner_no_deposit().remove_measurements(create_mock_full_measurements_hex())
            })
        },
        v(reason::AGENT_EXPIRED, "expired", |h, a| {
            let now = h.now;
            h.agent_mut(a.agent).mandate.expires_at = Some(U64(now - 1));
        }),
        v(reason::TOO_MANY_FAILED_TRANSFERS, "failed transfers in a row", |h, a| {
            h.agent_mut(a.agent).failed_transfers = MAX_FAILED_ATTEMPTS
        }),
        v(reason::INVALID_REQUEST, "memo", |_, a| a.req.memo = Some("m".repeat(MAX_MEMO_LEN + 1))),
        v(reason::INVALID_DEPOSIT_ADDRESS, "deposit_address", |_, a| a.req.deposit = "not-a-deposit.near".into()),
        sched(reason::SCHEDULE_NOT_FOUND, "does not exist", |_, a| a.req.schedule_id = Some(999)),
        sched(reason::RECIPIENT_NOT_ALLOWED, "removed from the address book", |h, a| {
            let rid = h.schedule(a.sid.unwrap()).recipient_id;
            h.c.recipients.remove(&rid);
        }),
        v(reason::CHAIN_NOT_ALLOWED, "is not allowed", |h, a| {
            h.agent_mut(a.agent).mandate.allowed_chains = vec!["tron".into()]
        }),
        // 5 (scheduled): schedule is active, belongs to the caller, destination matches, mandate allows it.
        sched(reason::SCHEDULE_NOT_ACTIVE, "Paused", |h, a| {
            h.schedule_mut(a.sid.unwrap()).status = ScheduleStatus::Paused
        }),
        sched(reason::RECIPIENT_NOT_ALLOWED, "not assigned to agent", |h, a| {
            h.schedule_mut(a.sid.unwrap()).agent_id = "someone-else".into()
        }),
        // Wrong destination (scheduled: differs from the recipient; on demand: not in the allowlist).
        v(reason::RECIPIENT_NOT_ALLOWED, "", |_, a| a.req.address = evm_addr(0xee)),
        sched(reason::RECIPIENT_NOT_ALLOWED, "no longer allows", |h, a| {
            let m = &mut h.agent_mut(a.agent).mandate;
            m.recipients = vec![77];
            m.allowlist = vec![destination(CHAIN, &evm_addr(0xab))];
        }),
        sched(reason::AMOUNT_MISMATCH, "exactly", |_, a| a.req.amount = AMOUNT - 1),
        sched(reason::NOT_DUE, "not due", |h, a| {
            let now = h.now;
            h.schedule_mut(a.sid.unwrap()).next_due_at = Some(U64(now + 2));
        }),
        sched(reason::TOO_MANY_FAILED_TRANSFERS, "Payments of schedule", |h, a| {
            h.schedule_mut(a.sid.unwrap()).failed_attempts = MAX_FAILED_ATTEMPTS
        }),
        sched(reason::PAYOUT_IN_PROGRESS, "already pending", |h, a| {
            h.schedule_mut(a.sid.unwrap()).open_payout = Some(U64(999))
        }),
        v(reason::BELOW_MIN_PAYMENT, "smallest payment", |h, _| h.c.policy.min_payment = U128(AMOUNT + 1)),
        v(reason::PER_TX_LIMIT_EXCEEDED, "Per-payment limit", |h, a| {
            h.agent_mut(a.agent).mandate.per_tx_limit = U128(AMOUNT / 2)
        }),
        v(reason::AGENT_DAILY_LIMIT_EXCEEDED, "already spent today", |h, a| {
            let today = h.now / DAY_MS;
            let ag = h.agent_mut(a.agent);
            ag.spent_today = ag.mandate.daily_limit.0 - AMOUNT + 1;
            ag.day_index = today;
        }),
        v(reason::AGENT_DAILY_COUNT_EXCEEDED, "payments per day", |h, a| {
            let today = h.now / DAY_MS;
            let ag = h.agent_mut(a.agent);
            ag.payments_today = ag.mandate.max_payments_per_day;
            ag.day_index = today;
        }),
        v(reason::VAULT_DAILY_LIMIT_EXCEEDED, "vault-wide", |h, _| {
            h.c.day_index = h.now / DAY_MS;
            h.c.spent_today = VAULT_DAILY - AMOUNT + 1;
        }),
        v(reason::INSUFFICIENT_BALANCE, "available", |h, _| h.c.balance = AMOUNT - 1),
        // Step 12: only when approval is needed. Missing quote deadline first, then the cap.
        v(reason::INVALID_REQUEST, "deposit_expires_at_ms", |h, a| {
            h.agent_mut(a.agent).mandate.approval_threshold = U128(AMOUNT / 2);
            a.req.expires = None;
        }),
        v(reason::TOO_MANY_PENDING_APPROVALS, "waiting for owner approval", |h, a| {
            let ag = h.agent_mut(a.agent);
            ag.mandate.approval_threshold = U128(AMOUNT / 2);
            ag.open_approvals = MAX_OPEN_APPROVALS_PER_AGENT;
        }),
    ]
}

/// Fixed TEE agent `payroll` paying its due schedule: passes all checks.
fn fixed_base() -> (H, Attempt) {
    let (h, sids) = H::with_payroll(1);
    let req = h.fixed_req(sids[0]);
    (h, Attempt { caller: tee_acc(), agent: PAYROLL, sid: Some(sids[0]), req })
}

/// Allowlist key agent paying its due schedule to an allowlisted recipient: passes all checks.
fn allowlist_scheduled_base() -> (H, Attempt) {
    let mut h = H::new();
    let addr = evm_addr(0x42);
    let rid = h.add_recipient(addr.clone());
    h.add_key("allow", key_acc2(), allowlist_mandate(vec![destination(CHAIN, &addr)]));
    let sid = h.add_schedule(schedule_input(rid, "allow", AMOUNT, every_period(), T0));
    let req = h.fixed_req(sid);
    (h, Attempt { caller: key_acc2(), agent: "allow", sid: Some(sid), req })
}

/// Allowlist key agent, on-demand request to its allowlisted destination: passes all checks.
fn allowlist_base() -> (H, Attempt) {
    let mut h = H::new();
    let addr = evm_addr(0x42);
    h.add_key("allow", key_acc2(), allowlist_mandate(vec![destination(CHAIN, &addr)]));
    (h, Attempt { caller: key_acc2(), agent: "allow", sid: None, req: Req::to(CHAIN, &addr, AMOUNT) })
}

/// Applies `vs` (latest first, so status changes happen after state edits), sends the request and checks the
/// rejection side effects. Returns (reason, detail).
fn run_violations(
    base: fn() -> (H, Attempt),
    vs: &[&Violation],
    pre: Option<fn(&mut H, &mut Attempt)>,
) -> (String, String) {
    let (mut h, mut at) = base();
    for v in vs.iter().rev() {
        (v.apply)(&mut h, &mut at);
    }
    if let Some(pre) = pre {
        pre(&mut h, &mut at);
    }
    h.advance(1);
    let before = h.money();
    let rejections_before = h.c.rejections.len();
    let known = h.c.agent_by_account.get(&at.caller).cloned();
    let caller = at.caller.clone();
    let (code, detail) = h.rejected(&caller, &at.req);
    assert_eq!(h.money(), before, "rejection {code} changed money state");
    let logged = known.clone().filter(|id| h.agent(id).status != AgentStatus::Revoked);
    if let Some(id) = &known {
        assert_eq!(h.agent(id).last_request_at_ms, Some(h.now), "{code}: last_request_at not updated");
    }
    match logged {
        Some(id) => {
            assert_eq!(h.c.rejections.len(), rejections_before + 1, "{code}: no log entry");
            let e = h.view().get_rejections(None, Some(1), None).remove(0);
            assert_eq!(
                (e.agent_id.as_str(), e.reason.as_str(), e.amount, e.at, e.chain.as_str(), e.address.as_str()),
                (
                    id.as_str(),
                    code.as_str(),
                    U128(at.req.amount),
                    U64(h.now),
                    at.req.chain.as_str(),
                    at.req.address.as_str()
                )
            );
            assert_eq!(e.detail, detail);
            assert!(get_logs().iter().any(|l| l.contains("payment_rejected")));
        }
        None => {
            assert_eq!(h.c.rejections.len(), rejections_before, "unknown caller / revoked agent must not be logged")
        }
    }
    (code, detail)
}

fn fixed_violations() -> Vec<Violation> {
    violations()
}
fn allowlist_scheduled_violations() -> Vec<Violation> {
    violations().into_iter().filter(|v| !v.tee_only).collect()
}
fn allowlist_violations() -> Vec<Violation> {
    violations().into_iter().filter(|v| !v.scheduled_only && !v.tee_only).collect()
}

type Base = fn() -> (H, Attempt);

fn bases() -> Vec<(&'static str, Base, Vec<Violation>)> {
    vec![
        ("fixed", fixed_base as Base, fixed_violations()),
        ("allowlist scheduled", allowlist_scheduled_base, allowlist_scheduled_violations()),
        ("allowlist", allowlist_base, allowlist_violations()),
    ]
}

fn assert_code(got: &(String, String), want: &Violation, ctx: &str) {
    assert_eq!(got.0, want.code, "{ctx}: detail {:?}", got.1);
    assert!(got.1.contains(want.hint), "{ctx}: detail {:?} lacks {:?}", got.1, want.hint);
}

#[test]
fn base_requests_pass_all_checks() {
    for (_, base, _) in bases() {
        let (mut h, at) = base();
        let id = h.submit(&at.caller, &at.req);
        assert_eq!(h.settle(id, true), PaymentResult::Submitted { payout_id: U64(id) });
    }
}

#[test]
fn every_rejection_code_is_reachable() {
    let mut seen: Vec<&str> = Vec::new();
    for (name, base, vs) in bases() {
        for v in &vs {
            let got = run_violations(base, &[v], None);
            assert_code(&got, v, &format!("{name}: alone {}", v.code));
            seen.push(v.code);
        }
    }
    // AGENT_NOT_FOUND and AGENT_REVOKED (tested in their own order tests) complete the list.
    seen.push(reason::AGENT_NOT_FOUND);
    seen.push(reason::AGENT_REVOKED);
    for code in [
        reason::VAULT_PAUSED,
        reason::AGENT_NOT_FOUND,
        reason::AGENT_REVOKED,
        reason::AGENT_PAUSED,
        reason::ATTESTATION_INVALID,
        reason::AGENT_EXPIRED,
        reason::TOO_MANY_FAILED_TRANSFERS,
        reason::INVALID_REQUEST,
        reason::INVALID_DEPOSIT_ADDRESS,
        reason::CHAIN_NOT_ALLOWED,
        reason::RECIPIENT_NOT_ALLOWED,
        reason::AMOUNT_MISMATCH,
        reason::NOT_DUE,
        reason::PAYOUT_IN_PROGRESS,
        reason::BELOW_MIN_PAYMENT,
        reason::PER_TX_LIMIT_EXCEEDED,
        reason::AGENT_DAILY_LIMIT_EXCEEDED,
        reason::AGENT_DAILY_COUNT_EXCEEDED,
        reason::VAULT_DAILY_LIMIT_EXCEEDED,
        reason::INSUFFICIENT_BALANCE,
        reason::TOO_MANY_PENDING_APPROVALS,
        reason::SCHEDULE_NOT_FOUND,
        reason::SCHEDULE_NOT_ACTIVE,
    ] {
        assert!(seen.contains(&code), "{code} not covered");
    }
}

#[test]
fn check_order_consecutive_pairs_first_wins() {
    for (name, base, vs) in bases() {
        for w in vs.windows(2) {
            let got = run_violations(base, &[&w[0], &w[1]], None);
            assert_code(&got, &w[0], &format!("{name}: {} + {}", w[0].code, w[1].code));
        }
    }
}

#[test]
fn check_order_first_violation_beats_all_later_ones() {
    for (name, base, vs) in bases() {
        for i in 0..vs.len() {
            let tail: Vec<&Violation> = vs[i..].iter().collect();
            let got = run_violations(base, &tail, None);
            assert_code(&got, &vs[i], &format!("{name}: {} + all later", vs[i].code));
        }
    }
}

#[test]
fn agent_not_found_and_revoked_order() {
    let vs = fixed_violations();
    // Everything after the AGENT_* step.
    let later: Vec<&Violation> = vs.iter().skip(2).collect();
    let unknown: fn(&mut H, &mut Attempt) = |_, a| a.caller = stranger();
    let revoked: fn(&mut H, &mut Attempt) = |h, a| h.as_owner().revoke_agent(a.agent.into());

    assert_eq!(run_violations(fixed_base, &later, Some(unknown)).0, reason::AGENT_NOT_FOUND);
    assert_eq!(run_violations(fixed_base, &later, Some(revoked)).0, reason::AGENT_REVOKED);
    // VAULT_PAUSED beats both.
    let paused = &vs[0];
    assert_eq!(run_violations(fixed_base, &[paused], Some(unknown)).0, reason::VAULT_PAUSED);
    assert_eq!(run_violations(fixed_base, &[paused], Some(revoked)).0, reason::VAULT_PAUSED);
    // Revoked beats paused (a revoked agent cannot be paused afterwards, so pause first).
    let pause_then_revoke: fn(&mut H, &mut Attempt) = |h, a| {
        h.as_owner_no_deposit().pause_agent(a.agent.into());
        h.as_owner().revoke_agent(a.agent.into());
    };
    assert_eq!(run_violations(fixed_base, &later, Some(pause_then_revoke)).0, reason::AGENT_REVOKED);
}

#[test]
fn unknown_caller_gets_agent_not_found_and_no_log_entry() {
    let mut h = H::new();
    let before = h.money();
    let (code, detail) = h.rejected(&stranger(), &Req::open(AMOUNT));
    assert_eq!(code, reason::AGENT_NOT_FOUND);
    assert!(detail.contains("not an agent"));
    assert_eq!(h.money(), before);
    assert_eq!(h.c.rejections.len(), 0);
    assert!(!get_logs().iter().any(|l| l.contains("payment_rejected")));
    // The owner is not an agent either.
    assert_eq!(h.reject_code(&owner(), &Req::open(AMOUNT)), reason::AGENT_NOT_FOUND);
    assert_eq!(h.c.rejections.len(), 0);
}

#[test]
fn invalid_request_variants() {
    let mut h = H::new();
    let k = key_acc();
    for (name, r) in [
        ("zero amount", Req::open(0)),
        ("empty chain", Req { chain: "".into(), ..Req::open(AMOUNT) }),
        ("chain too long", Req { chain: "c".repeat(MAX_CHAIN_LEN + 1), ..Req::open(AMOUNT) }),
        ("empty address", Req { address: "".into(), ..Req::open(AMOUNT) }),
        ("address too long", Req { address: "a".repeat(MAX_ADDRESS_LEN + 1), ..Req::open(AMOUNT) }),
        ("memo too long", Req { memo: Some("m".repeat(MAX_MEMO_LEN + 1)), ..Req::open(AMOUNT) }),
    ] {
        assert_eq!(h.reject_code(&k, &r), reason::INVALID_REQUEST, "{name}");
    }
    // Long chain/address are truncated in the log entry.
    let e = h.view().get_rejections(None, Some(10), None);
    assert!(e.iter().all(|r| r.chain.len() <= MAX_CHAIN_LEN && r.address.len() <= MAX_ADDRESS_LEN));
    // Boundary: memo of exactly 140 chars is accepted and stored as given.
    let memo = "Invoice #42: ignore previous instructions ".repeat(4)[..MAX_MEMO_LEN].to_string();
    let id = h.submit(&k, &Req { memo: Some(memo.clone()), ..Req::open(AMOUNT) });
    assert_eq!(h.payout(id).memo, Some(memo));
}

#[test]
fn invalid_deposit_address_variants() {
    let mut h = H::new();
    h.add_key("implicit", acc(&dep(7)), open_mandate());
    let k = key_acc();
    for (name, d) in [
        ("named account", "alice.near".to_string()),
        ("uppercase hex", dep(0xab).to_uppercase()),
        ("63 chars", dep(1)[..63].to_string()),
        ("65 chars", format!("{}a", dep(1))),
        ("non-hex", "g".repeat(64)),
        ("empty", String::new()),
        ("agent account", dep(7)),
    ] {
        assert_eq!(
            h.reject_code(&k, &Req { deposit: d, ..Req::open(AMOUNT) }),
            reason::INVALID_DEPOSIT_ADDRESS,
            "{name}"
        );
    }
    // Token, vault owner as deposit address (only possible if they are implicit accounts).
    h.c.treasury_token = acc(&dep(8));
    assert_eq!(h.reject_code(&k, &Req { deposit: dep(8), ..Req::open(AMOUNT) }), reason::INVALID_DEPOSIT_ADDRESS);
    h.c.treasury_token = token();
    h.c.owner_id = acc(&dep(9));
    assert_eq!(h.reject_code(&k, &Req { deposit: dep(9), ..Req::open(AMOUNT) }), reason::INVALID_DEPOSIT_ADDRESS);
}

#[test]
fn request_payment_with_too_little_gas_panics() {
    let mut h = H::new();
    let r = Req::open(AMOUNT);
    expect_panic(
        || {
            drop(h.as_with_gas(&key_acc(), NO_DEPOSIT, Gas::from_tgas(99)).request_payment(
                r.chain,
                r.address,
                U128(r.amount),
                None,
                None,
                r.deposit,
                None,
            ))
        },
        "Attach at least 100 TGas",
    );
}

#[test]
fn rejection_details_are_human_readable() {
    let mut h = H::new();
    h.paid(&key_acc(), &Req::open(300 * USDC));
    h.paid(&key_acc(), &Req::open(300 * USDC));
    h.paid(&key_acc(), &Req::open(150 * USDC + 500_000));
    let (code, detail) = h.rejected(&key_acc(), &Req::open(300 * USDC));
    assert_eq!(code, reason::AGENT_DAILY_LIMIT_EXCEEDED);
    assert_eq!(detail, "Daily limit for agent 'procurement' is 1000 USDC; 750.5 already spent today; requested 300.");
}

// --- limits --------------------------------------------------------------------------------------

#[test]
fn per_tx_limit_boundary() {
    let mut h = H::new();
    let m = Mandate { approval_threshold: U128(PER_TX), ..open_mandate() };
    h.as_owner().update_mandate(PROCUREMENT.into(), m);
    h.paid(&key_acc(), &Req::open(PER_TX));
    assert_eq!(h.reject_code(&key_acc(), &Req::open(PER_TX + 1)), reason::PER_TX_LIMIT_EXCEEDED);
}

#[test]
fn agent_and_vault_daily_limits_are_independent_and_both_enforced() {
    let mut h = H::new();
    let m = Mandate { approval_threshold: U128(PER_TX), ..open_mandate() };
    h.as_owner().update_mandate(PROCUREMENT.into(), m.clone());
    h.add_key("ops", key_acc2(), m);
    h.as_owner().set_policy(policy(1_500 * USDC));
    let (a, b) = (key_acc(), key_acc2());

    // A spends exactly its daily limit (boundary is allowed), then is blocked by its own limit.
    h.paid(&a, &Req::open(PER_TX));
    h.paid(&a, &Req::open(PER_TX));
    assert_eq!((h.agent_spent(PROCUREMENT), h.vault_spent()), (AGENT_DAILY, AGENT_DAILY));
    assert_eq!(h.reject_code(&a, &Req::open(1)), reason::AGENT_DAILY_LIMIT_EXCEEDED);
    // B has its own budget...
    h.paid(&b, &Req::open(PER_TX));
    assert_eq!(h.agent_spent("ops"), PER_TX);
    // ...but the vault cap (1500) is now reached even though B spent only 500 of its 1000.
    let (code, detail) = h.rejected(&b, &Req::open(1));
    assert_eq!(code, reason::VAULT_DAILY_LIMIT_EXCEEDED);
    assert!(detail.contains("1500 USDC"), "{detail}");
    // Budget view = min(agent, vault).
    let budget = h.view().get_agent_budget("ops".into()).unwrap();
    assert_eq!((budget.remaining_today, budget.vault_remaining_today), (U128(0), U128(0)));

    // Day rollover resets both.
    h.advance(DAY_MS);
    assert_eq!((h.agent_spent(PROCUREMENT), h.agent_spent("ops"), h.vault_spent()), (0, 0, 0));
    assert_eq!(h.view().get_agent(PROCUREMENT.into()).unwrap().spent_today, U128(0));
    h.paid(&a, &Req::open(PER_TX));
    h.paid(&b, &Req::open(PER_TX));
    assert_eq!((h.agent_spent(PROCUREMENT), h.agent_spent("ops"), h.vault_spent()), (PER_TX, PER_TX, AGENT_DAILY));
    assert_eq!(h.c.spent_today, AGENT_DAILY);
    assert_eq!(h.c.day_index, (T0 + DAY_MS) / DAY_MS);
}

#[test]
fn vault_daily_limit_exact_boundary_allowed() {
    let mut h = H::new();
    h.as_owner().set_policy(policy(2 * AMOUNT));
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.paid(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(h.reject_code(&key_acc(), &Req::open(1)), reason::VAULT_DAILY_LIMIT_EXCEEDED);
}

#[test]
fn insufficient_balance() {
    let mut h = H::bare();
    h.fund(AMOUNT);
    h.add_key(PROCUREMENT, key_acc(), open_mandate());
    assert_eq!(h.reject_code(&key_acc(), &Req::open(AMOUNT + 1)), reason::INSUFFICIENT_BALANCE);
    h.paid(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(h.reject_code(&key_acc(), &Req::open(1)), reason::INSUFFICIENT_BALANCE);
}

#[test]
fn get_agent_budget_reports_min_of_agent_and_vault() {
    let mut h = H::new();
    assert!(h.view().get_agent_budget("nope".into()).is_none());
    let b = h.view().get_agent_budget(PROCUREMENT.into()).unwrap();
    assert_eq!((b.remaining_today, b.vault_remaining_today), (U128(AGENT_DAILY), U128(VAULT_DAILY)));
    assert_eq!((b.per_tx_limit, b.approval_threshold, b.balance), (U128(PER_TX), U128(THRESHOLD), U128(FUND)));
    assert_eq!(b.allowed_chains, open_mandate().allowed_chains);
    assert_eq!(
        (b.recipients_mode, b.status, b.vault_paused, b.expires_at),
        (RecipientsMode::Open, AgentStatus::Active, false, None)
    );
    // Agent-limited.
    h.paid(&key_acc(), &Req::open(THRESHOLD));
    let b = h.view().get_agent_budget(PROCUREMENT.into()).unwrap();
    assert_eq!(b.remaining_today, U128(AGENT_DAILY - THRESHOLD));
    assert_eq!(b.vault_remaining_today, U128(VAULT_DAILY - THRESHOLD));
    // Vault-limited.
    h.as_owner().set_policy(policy(THRESHOLD + AMOUNT));
    let b = h.view().get_agent_budget(PROCUREMENT.into()).unwrap();
    assert_eq!((b.remaining_today, b.vault_remaining_today), (U128(AMOUNT), U128(AMOUNT)));
    h.as_owner_no_deposit().pause();
    h.as_owner_no_deposit().pause_agent(PROCUREMENT.into());
    let b = h.view().get_agent_budget(PROCUREMENT.into()).unwrap();
    assert!(b.vault_paused);
    assert_eq!(b.status, AgentStatus::Paused);
    // Next day: virtual rollover in the view.
    h.advance(DAY_MS);
    let b = h.view().get_agent_budget(PROCUREMENT.into()).unwrap();
    assert_eq!(b.remaining_today, U128(THRESHOLD + AMOUNT));
}

// --- pause / revoke / expiry ---------------------------------------------------------------------

#[test]
fn pause_agent_blocks_only_that_agent() {
    let (mut h, sids) = H::with_payroll(1);
    h.as_owner_no_deposit().pause_agent(PROCUREMENT.into());
    assert_eq!(h.view().get_agent(PROCUREMENT.into()).unwrap().status, AgentStatus::Paused);
    assert_eq!(h.reject_code(&key_acc(), &Req::open(AMOUNT)), reason::AGENT_PAUSED);
    // The other agent keeps working.
    h.paid(&tee_acc(), &h.fixed_req(sids[0]));
    h.as_owner().resume_agent(PROCUREMENT.into());
    h.paid(&key_acc(), &Req::open(AMOUNT));
    expect_panic(|| h.as_owner_no_deposit().resume_agent(PROCUREMENT.into()), "1 yoctoNEAR");
    expect_panic(|| h.as_owner_no_deposit().pause_agent("nope".into()), "Agent not found");
}

#[test]
fn global_pause_blocks_all_agents() {
    let (mut h, sids) = H::with_payroll(1);
    h.as_owner_no_deposit().pause();
    assert!(get_logs().iter().any(|l| l.contains("\"paused\"")));
    assert_eq!(h.reject_code(&key_acc(), &Req::open(AMOUNT)), reason::VAULT_PAUSED);
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sids[0])), reason::VAULT_PAUSED);
    expect_panic(|| h.as_owner_no_deposit().resume(), "1 yoctoNEAR");
    h.as_owner().resume();
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.paid(&tee_acc(), &h.fixed_req(sids[0]));
}

#[test]
fn revoked_agent_never_pays_again() {
    let mut h = H::new();
    h.as_owner().revoke_agent(PROCUREMENT.into());
    assert_eq!(h.view().get_agent(PROCUREMENT.into()).unwrap().status, AgentStatus::Revoked);
    assert_eq!(h.reject_code(&key_acc(), &Req::open(AMOUNT)), reason::AGENT_REVOKED);
    expect_panic(|| h.as_owner().resume_agent(PROCUREMENT.into()), "Agent is revoked");
    expect_panic(|| h.as_owner_no_deposit().pause_agent(PROCUREMENT.into()), "Agent is revoked");
    expect_panic(|| h.as_owner().update_mandate(PROCUREMENT.into(), open_mandate()), "Agent is revoked");
    expect_panic(|| h.as_owner().revoke_agent(PROCUREMENT.into()), "Agent already revoked");
    // Even global resume / new day / failure reset do not bring it back.
    h.as_owner().resume();
    h.as_owner().reset_agent_failures(PROCUREMENT.into());
    h.advance(DAY_MS);
    assert_eq!(h.reject_code(&key_acc(), &Req::open(AMOUNT)), reason::AGENT_REVOKED);
    // The account stays mapped, so it cannot be re-added under a new id either.
    expect_panic(|| drop(h.add_key("procurement-2", key_acc(), open_mandate())), "Account is already bound");
    // Revoked agents do not write to the shared rejection log (still get the reason back).
    assert!(h.view().get_rejections(None, None, Some(PROCUREMENT.into())).is_empty());
    assert_eq!(h.agent(PROCUREMENT).last_request_at_ms, Some(h.now));
}

#[test]
fn revoke_rejects_its_open_approvals_only() {
    let (mut h, sids) = H::with_payroll(1);
    h.add_key("ops", key_acc2(), open_mandate());
    let p1 = h.pending(&key_acc(), &Req::open(LARGE));
    let p2 = h.pending(&key_acc(), &Req { deposit: dep(2), ..Req::open(LARGE) });
    let other = h.pending(&key_acc2(), &Req::open(LARGE));
    // Schedule with a pending approval: revoke must clear the schedule's open slot, not skip its date.
    h.edit_schedule(sids[0], |s| s.amount = U128(LARGE));
    let fixed = h.pending(&tee_acc(), &h.fixed_req(sids[0]));
    assert_eq!(h.schedule(sids[0]).open_payout, Some(U64(fixed)));

    h.as_owner().revoke_agent(PROCUREMENT.into());
    assert_eq!(h.payout(p1).status, PayoutStatus::Rejected);
    assert_eq!(h.payout(p2).status, PayoutStatus::Rejected);
    assert_eq!(h.payout(other).status, PayoutStatus::PendingApproval);
    assert_eq!(h.agent(PROCUREMENT).open_approvals, 0);
    let pending: Vec<u64> = h.view().get_pending_approvals().iter().map(|p| p.id.0).collect();
    assert_eq!(pending.len(), 2);
    assert!(pending.contains(&other) && pending.contains(&fixed));
    expect_panic(|| drop(h.as_owner().approve_payout(U64(p1))), "Payout is not pending approval");
    assert_eq!(h.c.balance, FUND);

    h.as_owner().revoke_agent(PAYROLL.into());
    assert_eq!(h.payout(fixed).status, PayoutStatus::Rejected);
    let s = h.schedule(sids[0]);
    assert_eq!((s.open_payout, s.next_due_at, s.paid_count), (None, Some(U64(T0)), 0), "revoke does not skip the date");
    assert_eq!(h.recipient(0).last_paid_at_ms, None);
    // A revoked agent cannot be given new schedules.
    expect_panic(|| h.add_schedule(schedule_input(0, PAYROLL, AMOUNT, every_period(), T0)), "Agent is revoked");
}

#[test]
fn expired_agent_rejected() {
    let mut h = H::new();
    let exp = T0 + 1_000;
    h.edit_mandate(PROCUREMENT, |m| m.expires_at = Some(U64(exp)));
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.advance(1_000); // now == expires_at → still valid (rule is now > expires_at)
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.advance(1);
    let (code, detail) = h.rejected(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(code, reason::AGENT_EXPIRED);
    assert!(detail.contains("procurement"));
    // Owner extends the mandate.
    h.edit_mandate(PROCUREMENT, |m| m.expires_at = None);
    h.paid(&key_acc(), &Req::open(AMOUNT));
}

// --- approvals -----------------------------------------------------------------------------------

#[test]
fn above_threshold_creates_pending_without_reservation() {
    let mut h = H::new();
    let before = h.money();
    let r = Req { memo: Some("Invoice 7".into()), expires: Some(T0 + DAY_MS), ..Req::open(LARGE) };
    let id = h.pending(&key_acc(), &r);
    assert!(scheduled_calls().is_empty(), "no transfer for a pending payout");
    let p = h.payout(id);
    assert_eq!(p.status, PayoutStatus::PendingApproval);
    assert_eq!((p.amount, p.agent_id.as_str(), p.memo.as_deref()), (U128(LARGE), PROCUREMENT, Some("Invoice 7")));
    assert_eq!((p.deposit_address, p.deposit_expires_at_ms), (Some(acc(&dep(1))), Some(U64(T0 + DAY_MS))));
    assert_eq!(p.agent_account, Some(key_acc()));
    let now = h.money();
    assert_eq!((now.balance, now.in_flight, now.vault_spent), (before.balance, 0, 0));
    assert_eq!(h.agent_spent(PROCUREMENT), 0);
    assert_eq!(h.agent(PROCUREMENT).open_approvals, 1);
    assert_eq!(h.agent(PROCUREMENT).last_request_at_ms, Some(T0));
    assert_eq!(h.view().get_pending_approvals().len(), 1);
    assert!(get_logs().iter().any(|l| l.contains("payout_pending_approval")));
    // Exactly at the threshold: no approval needed.
    h.submit(&key_acc(), &Req::open(THRESHOLD));
}

#[test]
fn approve_transfers_to_stored_deposit_address() {
    let mut h = H::new();
    let id = h.pending(&key_acc(), &Req { deposit: dep(5), ..Req::open(LARGE) });
    h.approve(id);
    assert_eq!(
        scheduled_calls(),
        vec![
            (token(), "storage_deposit".to_string(), 1_250_000_000_000_000_000_000),
            (token(), "ft_transfer".to_string(), 1),
            (vault(), "on_transfer_result".to_string(), 0),
        ]
    );
    assert_eq!(scheduled_args("ft_transfer")["receiver_id"], dep(5));
    assert_eq!(scheduled_args("ft_transfer")["amount"], LARGE.to_string());
    assert_eq!(h.payout(id).status, PayoutStatus::Transferring);
    assert_eq!(
        (h.c.balance, h.c.in_flight, h.vault_spent(), h.agent_spent(PROCUREMENT)),
        (FUND - LARGE, LARGE, LARGE, LARGE)
    );
    assert_eq!(h.agent(PROCUREMENT).open_approvals, 0);
    assert!(h.view().get_pending_approvals().is_empty());
    assert_eq!(h.settle(id, true), PaymentResult::Submitted { payout_id: U64(id) });
    assert_eq!(h.payout(id).status, PayoutStatus::Sent);
    // Double approve / reject after execution.
    expect_panic(|| h.approve(id), "Payout is not pending approval");
    expect_panic(|| h.as_owner_no_deposit().reject_payout(U64(id), None), "Payout is not pending approval");
    expect_panic(|| h.approve(77), "Payout not found");
}

#[test]
fn approve_rechecks_daily_limit_at_approval_time() {
    let mut h = H::new();
    let id = h.pending(&key_acc(), &Req::open(LARGE));
    // Meanwhile the agent spends 900 of its 1000 budget with under-threshold payments.
    for i in 0..3u8 {
        h.paid(&key_acc(), &Req { deposit: dep(10 + i), ..Req::open(THRESHOLD) });
    }
    let before = h.money();
    expect_panic(|| h.approve(id), "AGENT_DAILY_LIMIT_EXCEEDED: Daily limit for agent 'procurement'");
    assert_eq!(h.payout(id).status, PayoutStatus::PendingApproval);
    assert_eq!(h.agent(PROCUREMENT).open_approvals, 1);
    assert_eq!(h.money(), before);
    // Next day the budget is back and the same approval goes through.
    h.advance(DAY_MS);
    h.approve(id);
    assert_eq!(h.settle(id, true), PaymentResult::Submitted { payout_id: U64(id) });
}

#[test]
fn approve_rechecks_all_rules_table() {
    type Case = (&'static str, fn(&mut H));
    let cases: Vec<Case> = vec![
        (reason::VAULT_PAUSED, |h| h.as_owner_no_deposit().pause()),
        (reason::AGENT_PAUSED, |h| h.as_owner_no_deposit().pause_agent(PROCUREMENT.into())),
        (reason::AGENT_EXPIRED, |h| {
            h.edit_mandate(PROCUREMENT, |m| m.expires_at = Some(U64(T0 + 10)));
            h.advance(11);
        }),
        (reason::TOO_MANY_FAILED_TRANSFERS, |h| {
            for _ in 0..MAX_FAILED_ATTEMPTS {
                let id = h.submit(&key_acc(), &Req { deposit: dep(3), ..Req::open(AMOUNT) });
                h.settle(id, false);
            }
        }),
        (reason::CHAIN_NOT_ALLOWED, |h| h.edit_mandate(PROCUREMENT, |m| m.allowed_chains = vec!["sol".into()])),
        (reason::RECIPIENT_NOT_ALLOWED, |h| {
            h.edit_mandate(PROCUREMENT, |m| {
                m.recipients_mode = RecipientsMode::Allowlist;
                m.allowlist = vec![destination(CHAIN, &evm_addr(0x01))];
            })
        }),
        (reason::INVALID_DEPOSIT_ADDRESS, |h| drop(h.add_key("squatter", acc(&dep(1)), open_mandate()))),
        (reason::PER_TX_LIMIT_EXCEEDED, |h| h.edit_mandate(PROCUREMENT, |m| m.per_tx_limit = U128(LARGE - 1))),
        (reason::AGENT_DAILY_LIMIT_EXCEEDED, |h| {
            h.paid(&key_acc(), &Req::open(THRESHOLD));
            h.paid(&key_acc(), &Req::open(THRESHOLD));
            h.paid(&key_acc(), &Req::open(THRESHOLD)); // 900 + 400 > 1000
        }),
        (reason::BELOW_MIN_PAYMENT, |h| h.as_owner().set_policy(policy_min(VAULT_DAILY, LARGE + 1))),
        (reason::VAULT_DAILY_LIMIT_EXCEEDED, |h| h.as_owner().set_policy(policy(LARGE - 1))),
        (reason::INSUFFICIENT_BALANCE, |h| drop(h.as_owner().withdraw(U128(FUND - LARGE + 1), None))),
    ];
    for (code, mutate) in cases {
        let mut h = H::new();
        let id = h.pending(&key_acc(), &Req::open(LARGE));
        mutate(&mut h);
        expect_panic(|| h.approve(id), &format!("{code}:"));
        assert_eq!(h.payout(id).status, PayoutStatus::PendingApproval, "{code}");
        // The owner can still reject it.
        h.as_owner_no_deposit().reject_payout(U64(id), None);
        assert_eq!(h.payout(id).status, PayoutStatus::Rejected, "{code}");
    }
}

#[test]
fn approve_after_deposit_deadline_panics() {
    let mut h = H::new();
    let id = h.pending(&key_acc(), &Req { expires: Some(T0 + 1_000), ..Req::open(LARGE) });
    h.advance(1_000); // deadline reached: approve requires now < deadline
    expect_panic(|| h.approve(id), "deposit address of this payout expired");
    assert_eq!(h.payout(id).status, PayoutStatus::PendingApproval);
    h.as_owner_no_deposit().reject_payout(U64(id), None);
    // Past deadline at request time: stored, but can never be approved.
    let id = h.pending(&key_acc(), &Req { expires: Some(T0), ..Req::open(LARGE) });
    expect_panic(|| h.approve(id), "expired");
    // Before the deadline it works.
    let id = h.pending(&key_acc(), &Req { expires: Some(h.now + 1), ..Req::open(LARGE) });
    h.approve(id);
    assert_eq!(h.payout(id).status, PayoutStatus::Transferring);
}

#[test]
fn approve_requires_gas_and_one_yocto() {
    let mut h = H::new();
    let id = h.pending(&key_acc(), &Req::open(LARGE));
    expect_panic(
        || drop(h.as_with_gas(&owner(), ONE_YOCTO, Gas::from_tgas(99)).approve_payout(U64(id))),
        "Attach at least 100 TGas",
    );
    expect_panic(|| drop(h.as_owner_no_deposit().approve_payout(U64(id))), "1 yoctoNEAR");
    expect_panic(|| drop(h.as_(&key_acc(), ONE_YOCTO).approve_payout(U64(id))), "Caller is not the owner");
}

#[test]
fn reject_pending_payout_moves_no_money() {
    let mut h = H::new();
    let id = h.pending(&key_acc(), &Req::open(LARGE));
    let before = h.money();
    h.as_owner_no_deposit().reject_payout(U64(id), None);
    assert!(scheduled_calls().is_empty());
    assert_eq!(h.payout(id).status, PayoutStatus::Rejected);
    assert!(get_logs().iter().any(|l| l.contains("payout_rejected")));
    let after = h.money();
    assert_eq!((after.balance, after.in_flight, after.vault_spent), (before.balance, 0, 0));
    assert_eq!(h.agent(PROCUREMENT).open_approvals, 0);
    expect_panic(|| h.as_owner_no_deposit().reject_payout(U64(id), None), "Payout is not pending approval");
    expect_panic(|| h.approve(id), "Payout is not pending approval");
    expect_panic(|| h.as_(&key_acc(), NO_DEPOSIT).reject_payout(U64(id), None), "Caller is not the owner");
}

#[test]
fn open_approvals_cap_is_five() {
    let mut h = H::new();
    let ids: Vec<PayoutId> = (0..MAX_OPEN_APPROVALS_PER_AGENT as u8)
        .map(|i| h.pending(&key_acc(), &Req { deposit: dep(i + 1), ..Req::open(LARGE) }))
        .collect();
    assert_eq!(h.view().get_agent(PROCUREMENT.into()).unwrap().open_approvals, MAX_OPEN_APPROVALS_PER_AGENT);
    let payouts = h.c.payouts.len();
    let (code, detail) = h.rejected(&key_acc(), &Req::open(LARGE));
    assert_eq!(code, reason::TOO_MANY_PENDING_APPROVALS);
    assert!(detail.contains("max 5"), "{detail}");
    assert_eq!(h.c.payouts.len(), payouts);
    assert_eq!(h.view().get_rejections(None, Some(1), None)[0].reason, reason::TOO_MANY_PENDING_APPROVALS);
    // Under-threshold payments are not affected by the cap.
    h.paid(&key_acc(), &Req::open(AMOUNT));
    // Other agents have their own counter.
    h.add_key("ops", key_acc2(), open_mandate());
    h.pending(&key_acc2(), &Req::open(LARGE));
    // Rejecting one frees a slot; approving one also does.
    h.as_owner_no_deposit().reject_payout(U64(ids[0]), None);
    h.pending(&key_acc(), &Req::open(LARGE));
    assert_eq!(h.reject_code(&key_acc(), &Req::open(LARGE)), reason::TOO_MANY_PENDING_APPROVALS);
    h.approve(ids[1]);
    h.pending(&key_acc(), &Req::open(LARGE));
    assert_eq!(h.agent(PROCUREMENT).open_approvals, MAX_OPEN_APPROVALS_PER_AGENT);
}

#[test]
fn scheduled_pending_approval_blocks_schedule_and_approve_executes_it() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    h.edit_schedule(sid, |s| s.amount = U128(LARGE));
    let id = h.pending(&tee_acc(), &h.fixed_req(sid));
    let p = h.payout(id);
    assert_eq!((p.schedule_id, p.recipient_id, p.occurrence_at), (Some(sid), Some(0), Some(U64(T0))));
    assert_eq!(p.approval_reason.as_deref(), Some(reason::ABOVE_THRESHOLD));
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.next_due_at, s.paid_count), (Some(U64(id)), Some(U64(T0)), 0), "nothing paid yet");
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sid)), reason::PAYOUT_IN_PROGRESS);
    assert!(h.view().get_due(None, Some(PAYROLL.into()), None, None).is_empty());
    // Its own open slot does not count as "in progress" for approval.
    h.advance(10);
    h.approve(id);
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.paid_count, s.last_paid_at), (Some(U64(id)), 1, Some(U64(T0 + 10))));
    assert_eq!((s.last_occurrence_paid, s.next_due_at), (Some(U64(T0)), Some(U64(T0 + PERIOD))));
    assert_eq!(h.recipient(0).last_paid_at_ms, Some(U64(T0 + 10)));
    h.settle(id, true);
    assert_eq!(h.schedule(sid).open_payout, None);
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sid)), reason::NOT_DUE);
}

#[test]
fn scheduled_reject_skips_the_occurrence() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    h.edit_schedule(sid, |s| s.amount = U128(LARGE));
    let id = h.pending(&tee_acc(), &h.fixed_req(sid));
    h.advance(5);
    h.as_owner().reject_payout(U64(id), None);
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.next_due_at, s.paid_count), (None, Some(U64(T0 + PERIOD)), 0));
    assert_eq!((s.last_paid_at, s.status), (None, ScheduleStatus::Active));
    assert_eq!(h.recipient(0).last_paid_at_ms, None);
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sid)), reason::NOT_DUE);
    assert_eq!(h.c.balance, FUND);
    assert_eq!(h.agent(PAYROLL).open_approvals, 0);
}

#[test]
fn update_recipient_cancels_pending_approval_and_remove_needs_ended_schedules() {
    let (mut h, sids) = H::with_payroll(2);
    for sid in &sids {
        h.edit_schedule(*sid, |s| s.amount = U128(LARGE));
    }
    let p0 = h.pending(&tee_acc(), &h.fixed_req(sids[0]));
    let p1 = h.pending(&tee_acc(), &h.fixed_req(sids[1]));
    // Changing the destination rejects the pending approval (it was quoted to the old address), without skipping.
    h.as_owner().update_recipient(0, recipient_input("r0", evm_addr(0x55)));
    assert_eq!(h.payout(p0).status, PayoutStatus::Rejected);
    let s = h.schedule(sids[0]);
    assert_eq!((s.open_payout, s.next_due_at), (None, Some(U64(T0))));
    // The new address is now the schedule's destination.
    assert_eq!(h.recipient(0).destination_address, evm_addr(0x55));
    // Remove is refused while a non-ended schedule references the recipient.
    expect_panic(|| h.as_owner().remove_recipient(1), "End its 1 schedules first");
    assert_eq!(h.view().get_recipient(1).unwrap().active_schedules, 1);
    // end_schedule rejects the pending approval, then remove works.
    h.as_owner().end_schedule(sids[1]);
    assert_eq!(h.payout(p1).status, PayoutStatus::Rejected);
    assert_eq!(h.agent(PAYROLL).open_approvals, 0);
    assert_eq!(h.view().get_recipient(1).unwrap().active_schedules, 0);
    h.as_owner().remove_recipient(1);
    assert!(h.view().get_recipient(1).is_none());
    expect_panic(|| h.as_owner().remove_recipient(1), "Recipient not found");
    // The ended schedule still references the removed recipient: requests for it are refused.
    assert_eq!(h.reject_code(&tee_acc(), &Req::to(CHAIN, &evm_addr(0x11), LARGE)), reason::RECIPIENT_NOT_ALLOWED);
    assert_eq!(
        h.reject_code(&tee_acc(), &Req { schedule_id: Some(sids[1]), ..Req::to(CHAIN, &evm_addr(0x11), LARGE) }),
        reason::RECIPIENT_NOT_ALLOWED,
        "removed recipient is reported before the schedule status (ADR-0004 review fix)"
    );
}

#[test]
fn remove_recipient_counts_paused_schedules_and_ignores_ended() {
    let (mut h, sids) = H::with_payroll(1);
    let extra = h.add_schedule(schedule_input(0, PAYROLL, AMOUNT, Frequency::Weekly { weekday: 3 }, T0));
    h.as_owner_no_deposit().pause_schedule(extra);
    expect_panic(|| h.as_owner().remove_recipient(0), "End its 2 schedules first");
    h.as_owner().end_schedule(sids[0]);
    expect_panic(|| h.as_owner().remove_recipient(0), "End its 1 schedules first");
    h.as_owner().end_schedule(extra);
    h.as_owner().remove_recipient(0);
}

#[test]
fn schedule_and_recipient_cannot_be_changed_while_transfer_in_flight() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    h.submit(&tee_acc(), &h.fixed_req(sid));
    let before = h.schedule(sid);
    expect_panic(|| h.as_owner().update_recipient(0, recipient_input("r0", evm_addr(0x55))), "in flight");
    expect_panic(|| h.as_owner().remove_recipient(0), "End its 1 schedules first");
    expect_panic(|| h.edit_schedule(sid, |s| s.amount = U128(AMOUNT + 1)), "in flight");
    expect_panic(|| h.as_owner().end_schedule(sid), "in flight");
    assert_eq!(h.schedule(sid), before);
    // Pausing (restrictive) is allowed while in flight; a failure then restores the date but keeps the pause.
    h.as_owner_no_deposit().pause_schedule(sid);
    let id = u64::from(h.c.payouts.len() - 1);
    h.settle(id, false);
    let s = h.schedule(sid);
    assert_eq!(
        (s.status, s.next_due_at, s.paid_count, s.open_payout),
        (ScheduleStatus::Paused, Some(U64(T0)), 0, None)
    );
    // After settlement the owner can change it again.
    h.as_owner().resume_schedule(sid);
    h.edit_schedule(sid, |s| s.amount = U128(AMOUNT + 1));
    h.as_owner().end_schedule(sid);
}

// --- transfer and callback -----------------------------------------------------------------------

#[test]
fn successful_request_reserves_both_counters_and_schedules_transfer() {
    let mut h = H::new();
    let r = Req { memo: Some("design work".into()), deposit: dep(4), ..Req::open(AMOUNT) };
    let id = h.submit(&key_acc(), &r);
    assert_eq!(
        scheduled_calls(),
        vec![
            (token(), "storage_deposit".to_string(), 1_250_000_000_000_000_000_000),
            (token(), "ft_transfer".to_string(), 1),
            (vault(), "on_transfer_result".to_string(), 0),
        ]
    );
    let sd = scheduled_args("storage_deposit");
    assert_eq!((sd["account_id"].as_str(), sd["registration_only"].as_bool()), (Some(dep(4).as_str()), Some(true)));
    let ft = scheduled_args("ft_transfer");
    assert_eq!((ft["receiver_id"].as_str(), ft["amount"].as_str()), (Some(dep(4).as_str()), Some("100000000")));
    assert!(ft.get("msg").is_none(), "plain ft_transfer, no msg");
    assert_eq!(scheduled_args("on_transfer_result")["payout_id"], id.to_string());
    assert_eq!(
        (h.c.balance, h.c.in_flight, h.vault_spent(), h.agent_spent(PROCUREMENT)),
        (FUND - AMOUNT, AMOUNT, AMOUNT, AMOUNT)
    );
    let p = h.payout(id);
    assert_eq!(
        (p.agent_id.as_str(), p.agent_account, p.memo.as_deref()),
        (PROCUREMENT, Some(key_acc()), Some("design work"))
    );
    assert_eq!((p.reserved_day, p.funds_left, p.created_at_ms), (Some(U64(T0 / DAY_MS)), false, U64(T0)));
    assert_eq!(h.agent(PROCUREMENT).last_request_at_ms, Some(T0));
    assert!(get_logs().iter().any(|l| l.contains("payout_transferring")));
}

#[test]
fn transfer_success_marks_sent_and_resets_failure_counters() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    for _ in 0..2 {
        let id = h.submit(&tee_acc(), &h.fixed_req(sid));
        assert_eq!(h.settle(id, false), PaymentResult::TransferFailed { payout_id: U64(id) });
    }
    assert_eq!((h.agent(PAYROLL).failed_transfers, h.schedule(sid).failed_attempts), (2, 2));
    let e0 = h.c.outflow_epoch;
    let id = h.submit(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(h.settle(id, true), PaymentResult::Submitted { payout_id: U64(id) });
    let p = h.payout(id);
    assert_eq!((p.status, p.funds_left), (PayoutStatus::Sent, true));
    assert_eq!((h.agent(PAYROLL).failed_transfers, h.schedule(sid).failed_attempts), (0, 0));
    assert_eq!(
        (h.c.balance, h.c.in_flight, h.vault_spent(), h.agent_spent(PAYROLL)),
        (FUND - AMOUNT, 0, AMOUNT, AMOUNT)
    );
    assert_eq!(h.c.outflow_epoch, e0 + 1);
    assert!(get_logs().iter().any(|l| l.contains("payout_sent")));
}

#[test]
fn failed_transfer_releases_agent_and_vault_reservations() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    // A previous successful occurrence, so last_paid_at must be restored to it (not cleared).
    h.paid(&tee_acc(), &h.fixed_req(sid));
    h.advance(PERIOD);
    h.paid(&key_acc(), &Req::open(AMOUNT)); // another agent's spend on the same day
    let before = h.money();
    let sched_before = h.schedule(sid);
    let (agent_before, vault_before) = (h.agent_spent(PAYROLL), h.vault_spent());
    let id = h.submit(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(h.agent_spent(PAYROLL), agent_before + AMOUNT);
    assert_eq!(h.vault_spent(), vault_before + AMOUNT);
    assert_eq!(h.recipient(0).last_paid_at_ms, Some(U64(h.now)));
    let p = h.payout(id);
    assert_eq!(p.prev_recipient_last_paid_at_ms, Some(U64(T0)));
    let snap = p.prev_schedule.expect("snapshot stored");
    assert_eq!(
        (snap.next_due_at, snap.paid_count, snap.last_paid_at, snap.last_occurrence_paid),
        (Some(U64(T0 + PERIOD)), 1, Some(U64(T0)), Some(U64(T0)))
    );

    assert_eq!(h.settle(id, false), PaymentResult::TransferFailed { payout_id: U64(id) });
    let p = h.payout(id);
    assert_eq!((p.status, p.funds_left), (PayoutStatus::Failed, false));
    assert_eq!((h.c.balance, h.c.in_flight), (before.balance, 0));
    assert_eq!((h.agent_spent(PAYROLL), h.vault_spent()), (agent_before, vault_before));
    assert_eq!(h.agent_spent(PROCUREMENT), AMOUNT, "other agent untouched");
    assert_eq!(h.recipient(0).last_paid_at_ms, Some(U64(T0)));
    assert_eq!(h.schedule(sid), Schedule { failed_attempts: 1, ..sched_before });
    assert_eq!(h.agent(PAYROLL).failed_transfers, 1);
    assert!(get_logs().iter().any(|l| l.contains("payout_transfer_failed")));
    // The same occurrence is due again immediately.
    let id = h.paid(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(h.payout(id).occurrence_at, Some(U64(T0 + PERIOD)));
}

#[test]
fn failed_approved_transfer_releases_reservations() {
    let mut h = H::new();
    let id = h.pending(&key_acc(), &Req::open(LARGE));
    h.approve(id);
    assert_eq!(h.settle(id, false), PaymentResult::TransferFailed { payout_id: U64(id) });
    assert_eq!((h.c.balance, h.c.in_flight, h.vault_spent(), h.agent_spent(PROCUREMENT)), (FUND, 0, 0, 0));
    assert_eq!(h.agent(PROCUREMENT).open_approvals, 0);
}

#[test]
fn three_failed_transfers_block_agent_until_reset() {
    let mut h = H::new();
    for _ in 0..MAX_FAILED_ATTEMPTS {
        let id = h.submit(&key_acc(), &Req::open(AMOUNT));
        h.settle(id, false);
    }
    let (code, detail) = h.rejected(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(code, reason::TOO_MANY_FAILED_TRANSFERS);
    assert!(detail.contains("Agent 'procurement' had 3"), "{detail}");
    assert_eq!(h.view().get_agent(PROCUREMENT.into()).unwrap().failed_transfers, 3);
    expect_panic(|| h.as_owner_no_deposit().reset_agent_failures(PROCUREMENT.into()), "1 yoctoNEAR");
    h.as_owner().reset_agent_failures(PROCUREMENT.into());
    h.paid(&key_acc(), &Req::open(AMOUNT));
}

#[test]
fn three_failed_transfers_block_schedule_until_reset() {
    let (mut h, sids) = H::with_payroll(2);
    let sid = sids[0];
    for _ in 0..MAX_FAILED_ATTEMPTS {
        let id = h.submit(&tee_acc(), &h.fixed_req(sid));
        h.settle(id, false);
    }
    // Agent counter first (check order), then the schedule counter.
    assert!(h.rejected(&tee_acc(), &h.fixed_req(sid)).1.contains("Agent 'payroll'"));
    h.as_owner().reset_agent_failures(PAYROLL.into());
    let (code, detail) = h.rejected(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(code, reason::TOO_MANY_FAILED_TRANSFERS);
    assert!(detail.contains("Payments of schedule 0 failed 3 times"), "{detail}");
    // Not in the due list; the other schedule is.
    let due: Vec<ScheduleId> = h.view().get_due(None, None, None, None).iter().map(|d| d.schedule.id).collect();
    assert_eq!(due, vec![sids[1]]);
    expect_panic(|| h.as_owner_no_deposit().reset_schedule_failures(sid), "1 yoctoNEAR");
    expect_panic(|| h.as_owner().reset_schedule_failures(99), "Schedule not found");
    h.as_owner().reset_schedule_failures(sid);
    assert_eq!(h.schedule(sid).failed_attempts, 0);
    let id = h.paid(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(h.payout(id).occurrence_at, Some(U64(T0)), "still the first occurrence");
}

#[test]
fn transfer_failure_on_later_day_does_not_touch_new_days_counters() {
    let mut h = H::new();
    let old = h.submit(&key_acc(), &Req::open(AMOUNT));
    h.advance(DAY_MS);
    h.submit(&key_acc(), &Req { deposit: dep(2), ..Req::open(THRESHOLD) });
    h.settle(old, false);
    assert_eq!((h.vault_spent(), h.agent_spent(PROCUREMENT)), (THRESHOLD, THRESHOLD));
    assert_eq!((h.c.balance, h.c.in_flight), (FUND - THRESHOLD, THRESHOLD));
}

#[test]
fn transfer_failure_on_later_day_before_any_rollover() {
    let mut h = H::new();
    let old = h.submit(&key_acc(), &Req::open(AMOUNT));
    h.advance(DAY_MS); // nobody rolled the day yet
    h.settle(old, false);
    assert_eq!((h.vault_spent(), h.agent_spent(PROCUREMENT), h.c.balance), (0, 0, FUND));
    h.advance(DAY_MS); // and the counters are not corrupted by the later rollover
    assert_eq!((h.vault_spent(), h.agent_spent(PROCUREMENT)), (0, 0));
}

#[test]
fn callback_for_non_transferring_payout_is_ignored() {
    let mut h = H::new();
    let id = h.paid(&key_acc(), &Req::open(AMOUNT));
    let snapshot = h.money();
    h.settle(id, false);
    assert_eq!(h.payout(id).status, PayoutStatus::Sent);
    assert_eq!(h.money(), snapshot);
    let pending = h.pending(&key_acc(), &Req::open(LARGE));
    h.settle(pending, true);
    assert_eq!(h.payout(pending).status, PayoutStatus::PendingApproval);
    h.settle(999, true); // unknown id: no panic
}

#[test]
fn transfer_result_too_long_counts_as_success() {
    let mut h = H::new();
    let id = h.submit(&key_acc(), &Req::open(AMOUNT));
    let res = h.as_callback(PromiseResult::Successful(vec![b'x'; 100])).on_transfer_result(U64(id));
    assert_eq!(res, PaymentResult::Submitted { payout_id: U64(id) });
    assert_eq!(h.payout(id).status, PayoutStatus::Sent);
}

#[test]
fn pause_does_not_block_in_flight_callback() {
    let mut h = H::new();
    let id = h.submit(&key_acc(), &Req::open(AMOUNT));
    h.as_owner_no_deposit().pause();
    h.as_owner().revoke_agent(PROCUREMENT.into());
    assert_eq!(h.settle(id, false), PaymentResult::TransferFailed { payout_id: U64(id) });
    assert_eq!(h.c.balance, FUND);
}

// --- status reports ------------------------------------------------------------------------------

#[test]
fn report_payout_status_by_creator_owner_and_others() {
    let (mut h, _) = H::with_payroll(1);
    h.add_key("ops", key_acc2(), open_mandate());
    let id = h.paid(&key_acc(), &Req::open(AMOUNT));
    for who in [key_acc2(), tee_acc(), stranger(), token()] {
        expect_panic(
            || h.as_(&who, NO_DEPOSIT).report_payout_status(U64(id), PayoutStatus::Confirmed, None),
            "Only the agent that created the payout or the owner",
        );
    }
    assert_eq!(h.payout(id).status, PayoutStatus::Sent);
    // Creator.
    let before = h.money();
    h.as_(&key_acc(), NO_DEPOSIT).report_payout_status(U64(id), PayoutStatus::Confirmed, Some("0xabc".into()));
    let p = h.payout(id);
    assert_eq!((p.status, p.tx_hash.as_deref()), (PayoutStatus::Confirmed, Some("0xabc")));
    assert_eq!(h.money(), before, "status reports never move money");
    assert!(get_logs().iter().any(|l| l.contains("payout_status_reported")));
    // Owner.
    let id2 = h.paid(&key_acc(), &Req::open(AMOUNT));
    h.as_owner_no_deposit().report_payout_status(U64(id2), PayoutStatus::Refunded, None);
    assert_eq!(h.payout(id2).status, PayoutStatus::Refunded);
    // Revoked creator loses the right; owner keeps it.
    let id3 = h.paid(&key_acc(), &Req::open(AMOUNT));
    h.as_owner().revoke_agent(PROCUREMENT.into());
    expect_panic(
        || h.as_(&key_acc(), NO_DEPOSIT).report_payout_status(U64(id3), PayoutStatus::Confirmed, None),
        "Only the agent that created the payout or the owner",
    );
    h.as_owner_no_deposit().report_payout_status(U64(id3), PayoutStatus::Failed, None);
    expect_panic(
        || h.as_owner_no_deposit().report_payout_status(U64(99), PayoutStatus::Failed, None),
        "Payout not found",
    );
}

#[test]
fn report_payout_status_transitions() {
    let mut h = H::new();
    let k = key_acc();
    // Only from Sent.
    let transferring = h.submit(&k, &Req::open(AMOUNT));
    let pending = h.pending(&k, &Req::open(LARGE));
    for id in [transferring, pending] {
        expect_panic(
            || h.as_(&k, NO_DEPOSIT).report_payout_status(U64(id), PayoutStatus::Confirmed, None),
            "not in Sent state",
        );
    }
    // Only to Confirmed / Refunded / Failed.
    h.settle(transferring, true);
    for s in [PayoutStatus::Sent, PayoutStatus::Transferring, PayoutStatus::PendingApproval, PayoutStatus::Rejected] {
        expect_panic(|| h.as_(&k, NO_DEPOSIT).report_payout_status(U64(transferring), s, None), "Status must be");
    }
    expect_panic(
        || {
            h.as_(&k, NO_DEPOSIT).report_payout_status(
                U64(transferring),
                PayoutStatus::Confirmed,
                Some("h".repeat(MAX_TX_HASH_LEN + 1)),
            )
        },
        "tx_hash too long",
    );
    h.as_(&k, NO_DEPOSIT).report_payout_status(U64(transferring), PayoutStatus::Confirmed, Some("h1".into()));
    // Repeat = no-op (tx hash not overwritten); terminal → other terminal rejected.
    h.as_(&k, NO_DEPOSIT).report_payout_status(U64(transferring), PayoutStatus::Confirmed, Some("h2".into()));
    assert_eq!(h.payout(transferring).tx_hash.as_deref(), Some("h1"));
    expect_panic(
        || h.as_(&k, NO_DEPOSIT).report_payout_status(U64(transferring), PayoutStatus::Refunded, None),
        "not in Sent state",
    );
}

// --- TEE registration ----------------------------------------------------------------------------

#[test]
fn register_agent_binds_unpinned_slot() {
    let mut h = H::new();
    h.add_tee(PAYROLL, None, open_mandate());
    // Unbound slot: nobody can pay through it yet.
    assert_eq!(h.reject_code(&tee_acc(), &Req::open(AMOUNT)), reason::AGENT_NOT_FOUND);
    h.trust_local(&tee_acc());
    assert!(h.register(PAYROLL, &tee_acc()));
    assert!(get_logs().iter().any(|l| l.contains("agent_registered")));
    let v = h.view().get_agent(PAYROLL.into()).unwrap();
    assert_eq!(v.account_id, Some(tee_acc()));
    let tee = v.tee.expect("tee view");
    assert_eq!((tee.valid, tee.valid_until_ms), (true, U64(T0 + ATTESTATION_TTL)));
    assert_eq!(tee.measurements, create_mock_full_measurements_hex());
    assert_eq!(h.view().get_agent_by_account(tee_acc()).map(|a| a.id), Some(PAYROLL.to_string()));
    h.paid(&tee_acc(), &Req::open(AMOUNT));
}

#[test]
fn register_agent_failures() {
    let mut h = H::new();
    h.add_tee(PAYROLL, None, open_mandate());
    // Not whitelisted.
    h.as_owner().approve_measurements(create_mock_full_measurements_hex());
    h.as_owner().approve_ppids(vec![Ppid::default()]);
    expect_panic(|| h.register(PAYROLL, &tee_acc()), "whitelisted for local mode");
    h.as_owner().whitelist_agent_for_local(tee_acc());
    // Measurements / PPID not approved.
    h.as_owner_no_deposit().remove_measurements(create_mock_full_measurements_hex());
    expect_panic(|| h.register(PAYROLL, &tee_acc()), "Default measurements must be approved");
    h.as_owner().approve_measurements(create_mock_full_measurements_hex());
    h.as_owner_no_deposit().remove_ppids(vec![Ppid::default()]);
    expect_panic(|| h.register(PAYROLL, &tee_acc()), "Default PPID must be approved");
    h.as_owner().approve_ppids(vec![Ppid::default()]);
    // Unknown slot / key agent slot.
    expect_panic(|| h.register("nope", &tee_acc()), "Agent not found");
    expect_panic(|| h.register(PROCUREMENT, &tee_acc()), "Only TEE agents register");
    // Revoked slot.
    h.add_tee("old", None, open_mandate());
    h.as_owner().revoke_agent("old".into());
    expect_panic(|| h.register("old", &tee_acc()), "Agent is revoked");
    assert!(h.register(PAYROLL, &tee_acc()));
}

#[test]
fn pinned_slot_rejects_other_account() {
    let mut h = H::new();
    h.add_tee(PAYROLL, Some(tee_acc()), open_mandate());
    h.trust_local(&tee_acc());
    h.trust_local(&tee_acc2());
    expect_panic(|| h.register(PAYROLL, &tee_acc2()), "pinned to another account");
    assert!(h.register(PAYROLL, &tee_acc()));
    assert!(h.register(PAYROLL, &tee_acc()), "pinned account may re-register");
    assert_eq!(h.agent(PAYROLL).account_id, Some(tee_acc()));
}

#[test]
fn account_bound_to_another_agent_cannot_register() {
    let mut h = H::new();
    h.add_tee(PAYROLL, None, open_mandate());
    h.add_tee("payroll-b", None, open_mandate());
    h.trust_local(&key_acc());
    h.trust_local(&tee_acc());
    // A key agent's account cannot take over a TEE slot.
    expect_panic(|| h.register(PAYROLL, &key_acc()), "Account is already bound to another agent");
    // Nor can a TEE account bound to one slot register into a second one.
    assert!(h.register(PAYROLL, &tee_acc()));
    expect_panic(|| h.register("payroll-b", &tee_acc()), "Account is already bound to another agent");
}

#[test]
fn register_refuses_to_rebind_live_slot() {
    let (mut h, _) = H::with_payroll(1);
    h.trust_local(&tee_acc2());
    expect_panic(
        || h.register(PAYROLL, &tee_acc2()),
        "Slot is bound to a live agent; the owner must unbind_agent first",
    );
    assert_eq!(h.agent(PAYROLL).account_id, Some(tee_acc()));
    // The bound account itself may refresh its attestation.
    h.advance(10);
    assert!(h.register(PAYROLL, &tee_acc()));
    assert_eq!(h.agent(PAYROLL).tee.as_ref().unwrap().valid_until_ms, T0 + 10 + ATTESTATION_TTL);
}

#[test]
fn rebind_after_unbind_and_old_account_loses_access() {
    let (mut h, sids) = H::with_payroll(1);
    let id = h.paid(&tee_acc(), &h.fixed_req(sids[0]));
    h.trust_local(&tee_acc2());
    // unbind_agent: owner, no deposit; detaches the account and the attestation.
    expect_panic(|| h.as_(&tee_acc(), NO_DEPOSIT).unbind_agent(PAYROLL.into()), "Caller is not the owner");
    h.as_owner().unbind_agent(PAYROLL.into());
    let v = h.view().get_agent(PAYROLL.into()).unwrap();
    assert_eq!((v.account_id, v.tee.is_none()), (None, true));
    assert!(h.view().get_agent_by_account(tee_acc()).is_none());
    assert_eq!(h.reject_code(&tee_acc(), &Req::open(AMOUNT)), reason::AGENT_NOT_FOUND);

    assert!(h.register(PAYROLL, &tee_acc2()));
    assert_eq!(h.agent(PAYROLL).account_id, Some(tee_acc2()));
    let logged = h.c.rejections.len();
    assert_eq!(h.reject_code(&tee_acc(), &Req::open(AMOUNT)), reason::AGENT_NOT_FOUND);
    assert_eq!(h.c.rejections.len(), logged, "old account is unknown now: not logged");
    // Status reports follow the current account.
    expect_panic(
        || h.as_(&tee_acc(), NO_DEPOSIT).report_payout_status(U64(id), PayoutStatus::Confirmed, None),
        "Only the agent that created the payout",
    );
    h.as_(&tee_acc2(), NO_DEPOSIT).report_payout_status(U64(id), PayoutStatus::Confirmed, None);
    // Mandate and history carry over to the new account.
    assert_eq!(h.reject_code(&tee_acc2(), &h.fixed_req(sids[0])), reason::NOT_DUE);
    h.advance(PERIOD);
    h.paid(&tee_acc2(), &h.fixed_req(sids[0]));
}

#[test]
fn rebind_allowed_once_old_attestation_is_invalid() {
    // Expired attestation.
    let mut h = H::new();
    h.as_owner().update_attestation_expiration_time(U64(1_000));
    h.add_tee(PAYROLL, None, open_mandate());
    h.trust_local(&tee_acc());
    h.trust_local(&tee_acc2());
    assert!(h.register(PAYROLL, &tee_acc()));
    h.advance(1_000);
    expect_panic(|| h.register(PAYROLL, &tee_acc2()), "Slot is bound to a live agent");
    h.advance(1);
    assert!(h.register(PAYROLL, &tee_acc2()));
    assert!(h.view().get_agent_by_account(tee_acc()).is_none());
    h.paid(&tee_acc2(), &Req::open(AMOUNT));
    // Old account de-whitelisted (invalid for another reason).
    let (mut h, _) = H::with_payroll(1);
    h.trust_local(&tee_acc2());
    h.as_owner_no_deposit().remove_agent_from_whitelist_for_local(tee_acc());
    assert!(h.register(PAYROLL, &tee_acc2()));
}

#[test]
fn unbind_agent_only_for_unpinned_tee() {
    let mut h = H::new();
    h.add_tee("pinned", Some(tee_acc()), open_mandate());
    expect_panic(|| h.as_owner().unbind_agent("pinned".into()), "Only unpinned TEE agents can be unbound");
    expect_panic(|| h.as_owner().unbind_agent(PROCUREMENT.into()), "Only unpinned TEE agents can be unbound");
    expect_panic(|| h.as_owner().unbind_agent("nope".into()), "Agent not found");
    // Unbinding an unbound slot is harmless.
    h.add_tee(PAYROLL, None, open_mandate());
    h.as_owner().unbind_agent(PAYROLL.into());
}

#[test]
fn register_agent_caller_cannot_be_owner() {
    let mut h = H::new();
    h.add_tee(PAYROLL, None, open_mandate());
    h.trust_local(&owner());
    expect_panic(|| h.register(PAYROLL, &owner()), "Agent account cannot be the owner, the vault or the token");
}

#[test]
fn tee_mode_pinned_account_must_be_implicit() {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    testing_env!(H::ctx_at(&vault(), NO_DEPOSIT, T0, Gas::from_tgas(300)).build());
    let c = Contract::new(owner(), token(), default_policy(), true, U64(ATTESTATION_TTL), None, None);
    let mut h = H { c, now: T0 };
    expect_panic(
        || drop(h.add_tee(PAYROLL, Some(tee_acc()), open_mandate())),
        "A pinned TEE account must be an implicit account",
    );
    let v = h.add_tee(PAYROLL, Some(acc(&dep(0x21))), open_mandate());
    assert!(v.account_pinned);
    h.add_tee("unpinned", None, open_mandate());
    // Key agents may use named accounts in TEE mode.
    h.add_key(PROCUREMENT, key_acc(), open_mandate());
    // Local-mode whitelisting is not available, and named accounts cannot register.
    expect_panic(|| h.as_owner().whitelist_agent_for_local(tee_acc()), "not supported for TEE");
    expect_panic(|| h.register("unpinned", &tee_acc()), "Account ID must be implicit account");
}

#[test]
fn tee_attestation_invalidation_rejects_with_attestation_invalid() {
    type Case = (&'static str, fn(&mut H), fn(&mut H));
    let cases: Vec<Case> = vec![
        (
            "InvalidMeasurements",
            |h| h.as_owner_no_deposit().remove_measurements(create_mock_full_measurements_hex()),
            |h| h.as_owner().approve_measurements(create_mock_full_measurements_hex()),
        ),
        (
            "InvalidPpid",
            |h| h.as_owner_no_deposit().remove_ppids(vec![Ppid::default()]),
            |h| h.as_owner().approve_ppids(vec![Ppid::default()]),
        ),
        (
            "NotWhitelistedForLocal",
            |h| h.as_owner_no_deposit().remove_agent_from_whitelist_for_local(tee_acc()),
            |h| h.as_owner().whitelist_agent_for_local(tee_acc()),
        ),
    ];
    for (hint, break_it, fix_it) in cases {
        let (mut h, sids) = H::with_payroll(1);
        break_it(&mut h);
        let (code, detail) = h.rejected(&tee_acc(), &h.fixed_req(sids[0]));
        assert_eq!(code, reason::ATTESTATION_INVALID, "{hint}");
        assert!(detail.contains(hint), "{detail}");
        let tee = h.view().get_agent(PAYROLL.into()).unwrap().tee.unwrap();
        assert!(!tee.valid);
        assert_eq!(format!("{:?}", tee.reasons), format!("[{hint}]"));
        // Key agents are unaffected by TEE trust anchors.
        h.paid(&key_acc(), &Req::open(AMOUNT));
        fix_it(&mut h);
        h.paid(&tee_acc(), &h.fixed_req(sids[0]));
    }
}

#[test]
fn expired_attestation_rejected_until_reregistered() {
    let mut h = H::new();
    h.as_owner().update_attestation_expiration_time(U64(1_000));
    h.add_tee(PAYROLL, None, open_mandate());
    h.trust_local(&tee_acc());
    assert!(h.register(PAYROLL, &tee_acc()));
    h.advance(1_000);
    h.paid(&tee_acc(), &Req::open(AMOUNT)); // valid_until == now → still valid
    h.advance(1);
    let (code, detail) = h.rejected(&tee_acc(), &Req::open(AMOUNT));
    assert_eq!(code, reason::ATTESTATION_INVALID);
    assert!(detail.contains("ExpiredAttestation"), "{detail}");
    assert!(h.register(PAYROLL, &tee_acc()));
    h.paid(&tee_acc(), &Req::open(AMOUNT));
}

#[test]
fn unregistered_pinned_tee_slot_is_attestation_invalid() {
    let mut h = H::new();
    h.add_tee(PAYROLL, Some(tee_acc()), open_mandate());
    h.trust_local(&tee_acc());
    let (code, detail) = h.rejected(&tee_acc(), &Req::open(AMOUNT));
    assert_eq!(code, reason::ATTESTATION_INVALID);
    assert!(detail.contains("NotRegistered"), "{detail}");
    assert_eq!(h.view().get_rejections(None, None, Some(PAYROLL.into())).len(), 1);
}

// --- views ---------------------------------------------------------------------------------------

#[test]
fn rejection_ring_buffer_keeps_last_200_newest_first() {
    let mut h = H::new();
    h.add_key("ops", key_acc2(), open_mandate());
    h.as_owner_no_deposit().pause();
    let total = REJECTIONS_CAP as u128 + 5;
    for i in 0..total {
        // Two agents alternate; a new day every 100 rejections keeps each under the 50/agent/day log cap.
        if i > 0 && i % 100 == 0 {
            h.advance(DAY_MS);
        }
        let who = if i % 2 == 0 { key_acc() } else { key_acc2() };
        h.advance(1);
        assert_eq!(h.reject_code(&who, &Req::open(i + 1)), reason::VAULT_PAUSED);
    }
    assert_eq!(h.c.rejections.len(), REJECTIONS_CAP);
    let all = h.view().get_rejections(None, Some(1_000), None);
    assert_eq!(all.len(), REJECTIONS_CAP as usize);
    let amounts: Vec<u128> = all.iter().map(|r| r.amount.0).collect();
    let expected: Vec<u128> = (6..=total).rev().collect();
    assert_eq!(amounts, expected, "last 200, newest first");
    assert!(all.windows(2).all(|w| w[0].at.0 > w[1].at.0));
    // Default limit 50, pagination.
    assert_eq!(h.view().get_rejections(None, None, None).len(), 50);
    let page = h.view().get_rejections(Some(10), Some(5), None);
    assert_eq!(page, all[10..15].to_vec());
    // Agent filter (applied before pagination).
    let ops = h.view().get_rejections(None, Some(1_000), Some("ops".into()));
    assert_eq!(ops.len(), 100);
    assert!(ops.iter().all(|r| r.agent_id == "ops" && r.amount.0 % 2 == 0));
    assert!(ops.windows(2).all(|w| w[0].amount.0 > w[1].amount.0));
    assert_eq!(h.view().get_rejections(Some(1), Some(1), Some("ops".into()))[0], ops[1]);
    assert!(h.view().get_rejections(None, None, Some("nope".into())).is_empty());
}

#[test]
fn get_payouts_filters_by_agent_and_paginates() {
    let (mut h, sids) = H::with_payroll(1);
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.paid(&tee_acc(), &h.fixed_req(sids[0]));
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.pending(&key_acc(), &Req::open(LARGE));
    assert_eq!(h.view().get_payouts_count(), U64(4));
    let ids = |v: Vec<Payout>| v.into_iter().map(|p| p.id.0).collect::<Vec<_>>();
    assert_eq!(ids(h.view().get_payouts(None, None, None)), vec![0, 1, 2, 3]);
    assert_eq!(ids(h.view().get_payouts(None, None, Some(PROCUREMENT.into()))), vec![0, 2, 3]);
    assert_eq!(ids(h.view().get_payouts(None, None, Some(PAYROLL.into()))), vec![1]);
    assert_eq!(ids(h.view().get_payouts(Some(1), Some(2), None)), vec![1, 2]);
    assert!(h.view().get_payouts(Some(10), None, None).is_empty());
    assert!(h.view().get_payouts(Some(u32::MAX), Some(u32::MAX), None).is_empty());
    // With agent_id, from_index is the position in that agent's own list (not a payout id).
    assert_eq!(ids(h.view().get_payouts(Some(1), Some(1), Some(PROCUREMENT.into()))), vec![2]);
    assert_eq!(ids(h.view().get_payouts(Some(2), None, Some(PROCUREMENT.into()))), vec![3]);
    assert!(h.view().get_payouts(Some(3), None, Some(PROCUREMENT.into())).is_empty());
    assert!(h.view().get_payouts(Some(u32::MAX), Some(u32::MAX), Some(PROCUREMENT.into())).is_empty());
    assert!(h.view().get_payouts(None, None, Some("nope".into())).is_empty());
    assert_eq!(h.view().get_agent_payouts_count(PROCUREMENT.into()), 3);
    assert_eq!(h.view().get_agent_payouts_count(PAYROLL.into()), 1);
    assert_eq!(h.view().get_agent_payouts_count("nope".into()), 0);
    // Rejected requests are not indexed.
    h.as_owner_no_deposit().pause();
    h.rejected(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(h.view().get_agent_payouts_count(PROCUREMENT.into()), 3);
    assert_eq!(ids(h.view().get_pending_approvals()), vec![3]);
    assert!(h.view().get_payout(U64(4)).is_none());
}

#[test]
fn get_balance_applies_day_rollover_virtually() {
    let mut h = H::new();
    h.paid(&key_acc(), &Req::open(AMOUNT));
    let b = h.view().get_balance();
    assert_eq!(
        (b.balance, b.spent_today, b.remaining_today),
        (U128(FUND - AMOUNT), U128(AMOUNT), U128(VAULT_DAILY - AMOUNT))
    );
    h.advance(DAY_MS);
    let b = h.view().get_balance();
    assert_eq!((b.spent_today, b.remaining_today, b.day_index), (U128(0), U128(VAULT_DAILY), U64(T0 / DAY_MS + 1)));
    assert_eq!(h.c.spent_today, AMOUNT, "stored counter is only reset on the next write");
}

// --- owner-only access ---------------------------------------------------------------------------

type OwnerCall = Box<dyn Fn(&mut Contract)>;

/// Every owner-only method with arguments that would pass any check after the owner check.
fn owner_method_calls() -> Vec<(&'static str, OwnerCall)> {
    vec![
        (
            "add_agent",
            Box::new(|c: &mut Contract| {
                c.add_agent("new".into(), "New".into(), AgentKind::Key, Some(acc("new.near")), None, open_mandate());
            }),
        ),
        ("update_mandate", Box::new(|c: &mut Contract| c.update_mandate(PROCUREMENT.into(), open_mandate()))),
        ("pause_agent", Box::new(|c: &mut Contract| c.pause_agent(PROCUREMENT.into()))),
        ("resume_agent", Box::new(|c: &mut Contract| c.resume_agent(PROCUREMENT.into()))),
        ("revoke_agent", Box::new(|c: &mut Contract| c.revoke_agent(PROCUREMENT.into()))),
        ("reset_agent_failures", Box::new(|c: &mut Contract| c.reset_agent_failures(PROCUREMENT.into()))),
        ("unbind_agent", Box::new(|c: &mut Contract| c.unbind_agent(PAYROLL.into()))),
        ("pin_agent", Box::new(|c: &mut Contract| c.pin_agent(PAYROLL.into()))),
        ("set_policy", Box::new(|c: &mut Contract| c.set_policy(policy(u128::MAX)))),
        ("pause", Box::new(|c: &mut Contract| c.pause())),
        ("resume", Box::new(|c: &mut Contract| c.resume())),
        (
            "add_recipient",
            Box::new(|c: &mut Contract| {
                c.add_recipient(recipient_input("x", evm_addr(1)));
            }),
        ),
        ("update_recipient", Box::new(|c: &mut Contract| c.update_recipient(0, recipient_input("x", evm_addr(1))))),
        // Recipient 1 has no schedules (see `owner_table_vault`).
        ("remove_recipient", Box::new(|c: &mut Contract| c.remove_recipient(1))),
        (
            "add_schedule",
            Box::new(|c: &mut Contract| {
                c.add_schedule(schedule_input(0, PAYROLL, AMOUNT, every_period(), T0));
            }),
        ),
        (
            "update_schedule",
            Box::new(|c: &mut Contract| c.update_schedule(0, schedule_input(0, PAYROLL, AMOUNT, every_period(), T0))),
        ),
        ("pause_schedule", Box::new(|c: &mut Contract| c.pause_schedule(0))),
        ("resume_schedule", Box::new(|c: &mut Contract| c.resume_schedule(0))),
        ("end_schedule", Box::new(|c: &mut Contract| c.end_schedule(0))),
        // Schedule 1 is Ended without an open payout (see `owner_table_vault`).
        ("remove_schedule", Box::new(|c: &mut Contract| c.remove_schedule(1))),
        ("reset_schedule_failures", Box::new(|c: &mut Contract| c.reset_schedule_failures(0))),
        ("approve_payout", Box::new(|c: &mut Contract| drop(c.approve_payout(U64(0))))),
        ("reject_payout", Box::new(|c: &mut Contract| c.reject_payout(U64(0), None))),
        ("withdraw", Box::new(|c: &mut Contract| drop(c.withdraw(U128(1), None)))),
        ("credit_refund", Box::new(|c: &mut Contract| drop(c.credit_refund(U64(0), None)))),
        ("sync_surplus", Box::new(|c: &mut Contract| drop(c.sync_surplus()))),
        ("withdraw_near", Box::new(|c: &mut Contract| drop(c.withdraw_near(U128(1))))),
        (
            "force_settle_transfer",
            Box::new(|c: &mut Contract| {
                c.force_settle_transfer(U64(0), false);
            }),
        ),
        ("set_storage_deposit_yocto", Box::new(|c: &mut Contract| c.set_storage_deposit_yocto(U128(1)))),
        ("propose_owner", Box::new(|c: &mut Contract| c.propose_owner(stranger()))),
        ("update_contract", Box::new(|c: &mut Contract| drop(c.update_contract()))),
        (
            "approve_measurements",
            Box::new(|c: &mut Contract| c.approve_measurements(create_mock_full_measurements_hex())),
        ),
        (
            "remove_measurements",
            Box::new(|c: &mut Contract| c.remove_measurements(create_mock_full_measurements_hex())),
        ),
        ("approve_ppids", Box::new(|c: &mut Contract| c.approve_ppids(vec![Ppid::default()]))),
        ("remove_ppids", Box::new(|c: &mut Contract| c.remove_ppids(vec![Ppid::default()]))),
        (
            "update_attestation_expiration_time",
            Box::new(|c: &mut Contract| c.update_attestation_expiration_time(U64(1))),
        ),
        ("whitelist_agent_for_local", Box::new(|c: &mut Contract| c.whitelist_agent_for_local(stranger()))),
        (
            "remove_agent_from_whitelist_for_local",
            Box::new(|c: &mut Contract| c.remove_agent_from_whitelist_for_local(tee_acc())),
        ),
    ]
}

/// Owner methods that must require exactly 1 yoctoNEAR (they widen trust or move money).
const ONE_YOCTO_METHODS: &[&str] = &[
    "add_agent",
    "update_mandate",
    "resume_agent",
    "reset_agent_failures",
    "set_policy",
    "resume",
    "add_recipient",
    "update_recipient",
    // Terminal / trust-widening since the 2026-11-01 audit (M2).
    "revoke_agent",
    "unbind_agent",
    "pin_agent",
    "remove_recipient",
    "end_schedule",
    "add_schedule",
    "update_schedule",
    "resume_schedule",
    "reset_schedule_failures",
    "approve_payout",
    "withdraw",
    "credit_refund",
    "sync_surplus",
    "withdraw_near",
    "force_settle_transfer",
    "set_storage_deposit_yocto",
    "propose_owner",
    "approve_measurements",
    "approve_ppids",
    "update_attestation_expiration_time",
    "whitelist_agent_for_local",
    "update_contract",
];

/// A vault with a key agent, a registered TEE agent, recipient 0 with active schedule 0 and ended schedule 1,
/// recipient 1 without schedules, and pending approval 0.
fn owner_table_vault() -> H {
    let (mut h, _) = H::with_payroll(1);
    h.add_recipient(evm_addr(0x31));
    let ended = h.add_schedule(schedule_input(0, PAYROLL, AMOUNT, Frequency::Weekly { weekday: 1 }, T0));
    h.as_owner().end_schedule(ended);
    h.pending(&key_acc(), &Req::open(LARGE));
    h
}

#[test]
fn agent_accounts_cannot_call_owner_methods() {
    // Contract-side check, independent of the function-call key's method restriction (AGENT_ACCESS §3.7).
    for caller in [key_acc(), tee_acc(), stranger(), token()] {
        for (name, call) in owner_method_calls() {
            for deposit in [ONE_YOCTO, NO_DEPOSIT] {
                let mut h = owner_table_vault();
                let before =
                    (h.money(), h.c.paused, h.c.policy.clone(), h.c.owner_id.clone(), h.c.proposed_owner.clone());
                let c = h.as_(&caller, deposit);
                expect_panic(|| call(c), "Caller is not the owner");
                let after =
                    (h.money(), h.c.paused, h.c.policy.clone(), h.c.owner_id.clone(), h.c.proposed_owner.clone());
                assert_eq!(before, after, "{name} by {caller} changed state");
                assert_eq!(h.c.agents.len(), 2, "{name} by {caller}");
            }
        }
    }
}

#[test]
fn one_yocto_owner_methods_reject_wrong_deposit() {
    let calls = owner_method_calls();
    for name in ONE_YOCTO_METHODS {
        let (_, call) = calls.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no call for {name}"));
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            let mut h = owner_table_vault();
            let c = h.as_(&owner(), deposit);
            expect_panic(|| call(c), "Requires attached deposit of exactly 1 yoctoNEAR");
        }
    }
}

#[test]
fn restrictive_owner_methods_work_without_deposit() {
    let calls = owner_method_calls();
    for name in [
        "pause_agent",
        "pause",
        // On-demand payout: nothing is skipped, so no deposit.
        "reject_payout",
        "pause_schedule",
        "remove_schedule",
        "remove_measurements",
        "remove_ppids",
        "remove_agent_from_whitelist_for_local",
    ] {
        let (_, call) = calls.iter().find(|(n, _)| *n == name).unwrap();
        let mut h = owner_table_vault();
        // reject_payout(0) needs payout 0 pending: the table vault's pending payout is id 0.
        let c = h.as_(&owner(), NO_DEPOSIT);
        let r = catch_unwind(AssertUnwindSafe(|| call(c)));
        assert!(r.is_ok(), "{name} should work without a deposit");
    }
}

// --- funds ---------------------------------------------------------------------------------------

#[test]
fn withdraw_works_while_paused_and_with_agents_paused_or_revoked() {
    let mut h = H::new();
    h.as_owner_no_deposit().pause();
    h.as_owner().revoke_agent(PROCUREMENT.into());
    drop(h.as_owner().withdraw(U128(500), None));
    assert_eq!(
        scheduled_calls(),
        vec![(token(), "ft_transfer".to_string(), 1), (vault(), "on_withdraw_result".to_string(), 0)]
    );
    assert_eq!(scheduled_args("ft_transfer")["receiver_id"], owner().to_string());
    assert_eq!((h.c.balance, h.c.in_flight), (FUND - 500, 500));
    assert!(h.as_callback(ok_result()).on_withdraw_result(U128(500), owner()));
    assert_eq!((h.c.balance, h.c.in_flight), (FUND - 500, 0));
    // Custom receiver, full balance.
    drop(h.as_owner().withdraw(U128(FUND - 500), Some(stranger())));
    assert_eq!(scheduled_args("ft_transfer")["receiver_id"], stranger().to_string());
    assert_eq!(h.c.balance, 0);
}

#[test]
fn withdraw_bounds_and_failure() {
    let mut h = H::new();
    expect_panic(|| drop(h.as_owner().withdraw(U128(FUND + 1), None)), "Insufficient vault balance");
    expect_panic(|| drop(h.as_owner().withdraw(U128(0), None)), "Amount must be positive");
    expect_panic(
        || drop(h.as_with_gas(&owner(), ONE_YOCTO, Gas::from_tgas(59)).withdraw(U128(1), None)),
        "Attach at least 60 TGas",
    );
    // In-flight payments are not withdrawable; pending approvals reserve nothing.
    h.submit(&key_acc(), &Req::open(AMOUNT));
    h.pending(&key_acc(), &Req::open(LARGE));
    expect_panic(|| drop(h.as_owner().withdraw(U128(FUND), None)), "Insufficient vault balance");
    drop(h.as_owner().withdraw(U128(FUND - AMOUNT), None));
    assert!(!h.as_callback(PromiseResult::Failed).on_withdraw_result(U128(FUND - AMOUNT), owner()));
    assert_eq!((h.c.balance, h.c.in_flight), (FUND - AMOUNT, AMOUNT));
}

#[test]
fn ft_on_transfer_from_wrong_token_panics() {
    let mut h = H::new();
    expect_panic(
        || h.as_(&acc("fake-usdc.near"), NO_DEPOSIT).ft_on_transfer(owner(), U128(1_000), String::new()),
        "Only the treasury token is accepted",
    );
    assert_eq!(h.c.balance, FUND);
}

#[test]
fn ft_on_transfer_from_treasury_token_credits_balance_even_when_paused() {
    let mut h = H::bare();
    h.as_owner_no_deposit().pause();
    let res = h.as_(&token(), NO_DEPOSIT).ft_on_transfer(stranger(), U128(700), "anything".into());
    assert!(matches!(res, PromiseOrValue::Value(U128(0))));
    assert!(get_logs().iter().any(|l| l.contains("\"deposit\"")));
    h.fund(300);
    assert_eq!(h.c.balance, 1_000);
    h.c.balance = u128::MAX;
    expect_panic(|| h.fund(1), "Overflow");
}

fn refunded_payout(status: PayoutStatus) -> (H, PayoutId) {
    let mut h = H::new();
    let id = h.paid(&key_acc(), &Req::open(AMOUNT));
    h.as_(&key_acc(), NO_DEPOSIT).report_payout_status(U64(id), status, None);
    (h, id)
}

impl H {
    /// Owner starts `credit_refund`; returns the outflow epoch captured into the callback.
    fn credit_refund(&mut self, id: PayoutId, amount: Option<u128>) -> u64 {
        drop(self.as_owner().credit_refund(U64(id), amount.map(U128)));
        self.c.outflow_epoch
    }
    /// `on_refund_balance` with the token contract reporting `actual`.
    fn refund_cb(&mut self, id: PayoutId, amount: u128, epoch: u64, actual: u128) -> bool {
        self.as_callback(balance_result(actual)).on_refund_balance(U64(id), U128(amount), U64(epoch))
    }
}

#[test]
fn credit_refund_preconditions() {
    let mut h = H::new();
    let failed = h.submit(&key_acc(), &Req::open(AMOUNT));
    h.settle(failed, false);
    expect_panic(|| h.credit_refund(failed, None), "Funds of this payout never left the vault");
    let sent = h.paid(&key_acc(), &Req::open(AMOUNT));
    expect_panic(|| h.credit_refund(sent, None), "Payout is not refunded or failed");
    h.as_(&key_acc(), NO_DEPOSIT).report_payout_status(U64(sent), PayoutStatus::Confirmed, None);
    expect_panic(|| h.credit_refund(sent, None), "Payout is not refunded or failed");
    let (mut h, id) = refunded_payout(PayoutStatus::Refunded);
    expect_panic(|| h.credit_refund(id, Some(0)), "Refund amount must be in");
    expect_panic(|| h.credit_refund(id, Some(AMOUNT + 1)), "Refund amount must be in");
    expect_panic(|| h.credit_refund(99, None), "Payout not found");
    h.credit_refund(id, None);
    assert_eq!(
        scheduled_calls(),
        vec![(token(), "ft_balance_of".to_string(), 0), (vault(), "on_refund_balance".to_string(), 0)]
    );
}

impl H {
    /// Two-phase credit_refund: probe read, wait 60 s, confirming read. Returns the second callback's result.
    fn refund_two_phase(&mut self, id: PayoutId, amount: u128, first: u128, second: u128) -> bool {
        let epoch = self.credit_refund(id, Some(amount));
        assert!(!self.refund_cb(id, amount, epoch, first), "first read only records a probe");
        self.advance(SURPLUS_CONFIRM_MS);
        let epoch = self.credit_refund(id, Some(amount));
        self.refund_cb(id, amount, epoch, second)
    }
    fn surplus_cb(&mut self, actual: u128) -> u128 {
        drop(self.as_owner().sync_surplus());
        let epoch = self.c.outflow_epoch;
        self.as_callback(balance_result(actual)).on_sync_surplus(U64(epoch)).0
    }
}

#[test]
fn credit_refund_credits_only_when_tokens_arrived_and_once() {
    for status in [PayoutStatus::Refunded, PayoutStatus::Failed] {
        let (mut h, id) = refunded_payout(status);
        // Not arrived yet (both reads show no untracked tokens): nothing credited, probe cleared.
        assert!(!h.refund_two_phase(id, AMOUNT, FUND - AMOUNT, FUND - AMOUNT));
        assert_eq!(h.c.balance, FUND - AMOUNT);
        assert!(h.c.surplus_probe.is_none());
        // Bad results never credit.
        let epoch = h.credit_refund(id, None);
        assert!(!h.as_callback(PromiseResult::Failed).on_refund_balance(U64(id), U128(AMOUNT), U64(epoch)));
        assert!(!h.refund_cb(id, AMOUNT + 1, epoch, FUND * 2));
        assert!(h.c.surplus_probe.is_none(), "rejected before probing");
        // Arrived: probe, then confirm ≥ 60 s later.
        assert!(h.refund_two_phase(id, AMOUNT, FUND, FUND));
        assert_eq!(h.c.balance, FUND);
        assert!(h.payout(id).refund_credited);
        assert!(h.c.surplus_probe.is_none());
        assert!(get_logs().iter().any(|l| l.contains("refund_credited")));
        // Never twice.
        assert!(!h.refund_cb(id, AMOUNT, h.c.outflow_epoch, FUND * 2));
        expect_panic(|| h.credit_refund(id, None), "Refund already credited");
        assert_eq!(h.c.balance, FUND);
    }
}

#[test]
fn partial_refund_credits_only_requested_amount() {
    let (mut h, id) = refunded_payout(PayoutStatus::Refunded);
    assert!(h.refund_two_phase(id, AMOUNT / 2, FUND - AMOUNT / 2, FUND - AMOUNT / 2));
    assert_eq!(h.c.balance, FUND - AMOUNT / 2);
    // Confirmed surplus below the requested amount → refused, probe cleared.
    let (mut h, id) = refunded_payout(PayoutStatus::Refunded);
    assert!(!h.refund_two_phase(id, AMOUNT, FUND, FUND - AMOUNT / 2));
    assert_eq!(h.c.balance, FUND - AMOUNT);
    assert!(h.c.surplus_probe.is_none());
}

#[test]
fn credit_refund_refused_when_outflow_settled_during_check() {
    let (mut h, refunded) = refunded_payout(PayoutStatus::Refunded); // 1Click refund has NOT arrived
    let in_flight = h.submit(&key_acc(), &Req::open(AMOUNT));
    let stale_reading = FUND - AMOUNT; // read before the in-flight transfer leaves
    let epoch = h.credit_refund(refunded, None);
    h.settle(in_flight, true); // outflow settles → epoch bumps
    assert_ne!(h.c.outflow_epoch, epoch);
    assert!(!h.refund_cb(refunded, AMOUNT, epoch, stale_reading));
    assert_eq!(h.c.balance, FUND - 2 * AMOUNT);
    assert!(!h.payout(refunded).refund_credited);
    let epoch = h.credit_refund(refunded, None);
    assert!(!h.refund_cb(refunded, AMOUNT, epoch, FUND - 2 * AMOUNT));
}

#[test]
fn outflow_epoch_bumps_only_on_successful_outflows() {
    let mut h = H::new();
    let e0 = h.c.outflow_epoch;
    let id = h.submit(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(h.c.outflow_epoch, e0, "reserving is not an outflow");
    h.settle(id, false);
    assert_eq!(h.c.outflow_epoch, e0, "failed transfer is not an outflow");
    h.paid(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(h.c.outflow_epoch, e0 + 1);
    drop(h.as_owner().withdraw(U128(10), None));
    h.as_callback(PromiseResult::Failed).on_withdraw_result(U128(10), owner());
    assert_eq!(h.c.outflow_epoch, e0 + 1);
    drop(h.as_owner().withdraw(U128(10), None));
    h.as_callback(ok_result()).on_withdraw_result(U128(10), owner());
    assert_eq!(h.c.outflow_epoch, e0 + 2);
}

#[test]
fn sync_surplus_credits_actual_minus_balance_and_in_flight() {
    let mut h = H::new();
    h.submit(&key_acc(), &Req::open(AMOUNT));
    drop(h.as_owner().sync_surplus());
    assert_eq!(
        scheduled_calls(),
        vec![(token(), "ft_balance_of".to_string(), 0), (vault(), "on_sync_surplus".to_string(), 0)]
    );
    // First read: probe only.
    assert_eq!(h.surplus_cb(FUND + 250), 0);
    let probe = h.c.surplus_probe.clone().expect("probe recorded");
    assert_eq!((probe.surplus, probe.at_ms), (U128(250), h.now));
    assert_eq!(h.c.balance, FUND - AMOUNT);
    // Confirm ≥ 60 s later: credits min(250, 300) = 250.
    h.advance(SURPLUS_CONFIRM_MS);
    assert_eq!(h.surplus_cb(FUND + 300), 250);
    assert_eq!((h.c.balance, h.c.in_flight), (FUND - AMOUNT + 250, AMOUNT));
    assert!(h.c.surplus_probe.is_none());
    assert!(get_logs().iter().any(|l| l.contains("surplus_credited")));
    // No surplus (or a deficit): nothing, in both phases.
    for actual in [FUND + 250, FUND - 1, 0] {
        assert_eq!(h.surplus_cb(actual), 0);
        h.advance(SURPLUS_CONFIRM_MS);
        assert_eq!(h.surplus_cb(actual), 0);
    }
    let epoch = h.c.outflow_epoch;
    assert_eq!(h.as_callback(PromiseResult::Failed).on_sync_surplus(U64(epoch)), U128(0));
    assert_eq!(h.c.balance, FUND - AMOUNT + 250);
}

#[test]
fn surplus_second_read_before_60s_keeps_probe_and_credits_nothing() {
    let mut h = H::new();
    assert_eq!(h.surplus_cb(FUND + 100), 0);
    let probe = h.c.surplus_probe.clone().expect("probe");
    h.advance(SURPLUS_CONFIRM_MS - 1);
    assert_eq!(h.surplus_cb(FUND + 100), 0);
    assert_eq!(h.c.surplus_probe, Some(probe), "probe kept unchanged (timer not restarted)");
    assert_eq!(h.c.balance, FUND);
    h.advance(1);
    assert_eq!(h.surplus_cb(FUND + 100), 100);
    assert_eq!(h.c.balance, FUND + 100);
    // The same refund path also waits.
    let (mut h, id) = refunded_payout(PayoutStatus::Refunded);
    let epoch = h.credit_refund(id, None);
    assert!(!h.refund_cb(id, AMOUNT, epoch, FUND));
    h.advance(SURPLUS_CONFIRM_MS - 1);
    assert!(!h.refund_cb(id, AMOUNT, epoch, FUND));
    assert!(!h.payout(id).refund_credited);
    h.advance(1);
    assert!(h.refund_cb(id, AMOUNT, epoch, FUND));
}

#[test]
fn surplus_deposit_arriving_between_reads_is_not_double_counted() {
    let mut h = H::new();
    let d = 500 * USDC;
    // Read 1: token already moved D, ft_on_transfer has not run yet.
    assert_eq!(h.surplus_cb(FUND + d), 0);
    h.fund(d); // ft_on_transfer credits D
    h.advance(SURPLUS_CONFIRM_MS);
    // Read 2: no untracked tokens any more → min(D, 0) = 0.
    assert_eq!(h.surplus_cb(FUND + d), 0);
    assert_eq!(h.c.balance, FUND + d);
    assert!(h.c.balance + h.c.in_flight <= FUND + d);
}

#[test]
fn surplus_outflow_between_reads_clears_probe() {
    let mut h = H::new();
    let id = h.submit(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(h.surplus_cb(FUND + 50), 0);
    assert!(h.c.surplus_probe.is_some());
    // A read whose epoch is stale (outflow settled while it ran) clears the probe.
    drop(h.as_owner().sync_surplus());
    let stale = h.c.outflow_epoch;
    h.settle(id, true);
    assert_eq!(h.as_callback(balance_result(FUND + 50)).on_sync_surplus(U64(stale)), U128(0));
    assert!(h.c.surplus_probe.is_none());
    // An outflow between two otherwise valid reads: the old probe does not confirm; a fresh one starts.
    assert_eq!(h.surplus_cb(FUND - AMOUNT + 50), 0);
    h.submit(&key_acc(), &Req { deposit: dep(2), ..Req::open(AMOUNT) });
    let id2 = h.last_payout_id();
    h.settle(id2, true);
    h.advance(SURPLUS_CONFIRM_MS);
    assert_eq!(h.surplus_cb(FUND - 2 * AMOUNT + 50), 0, "probe from before the outflow is not used");
    let probe = h.c.surplus_probe.clone().expect("new probe");
    assert_eq!((probe.at_ms, probe.outflow_epoch), (h.now, h.c.outflow_epoch));
    h.advance(SURPLUS_CONFIRM_MS);
    assert_eq!(h.surplus_cb(FUND - 2 * AMOUNT + 50), 50);
    assert_eq!(h.c.balance, FUND - 2 * AMOUNT + 50);
}

#[test]
fn sync_surplus_refused_when_outflow_settled_during_check() {
    let mut h = H::new();
    let id = h.submit(&key_acc(), &Req::open(AMOUNT));
    drop(h.as_owner().sync_surplus());
    let epoch = h.c.outflow_epoch;
    h.settle(id, true); // a stale FUND reading would show a fake 100 USDC surplus
    assert_eq!(h.as_callback(balance_result(FUND)).on_sync_surplus(U64(epoch)), U128(0));
    assert_eq!(h.c.balance, FUND - AMOUNT);
}

#[test]
fn force_settle_transfer_requires_stuck_age() {
    let mut h = H::new();
    let id = h.submit(&key_acc(), &Req::open(AMOUNT));
    h.advance(STUCK_TRANSFER_MS - 1);
    expect_panic(|| h.as_owner().force_settle_transfer(U64(id), false), "Transfer is not stuck yet");
    assert_eq!(h.payout(id).status, PayoutStatus::Transferring);
    h.advance(1);
    assert!(!h.as_owner().force_settle_transfer(U64(id), false));
    assert_eq!(h.payout(id).status, PayoutStatus::Failed);
    assert_eq!((h.c.balance, h.c.in_flight, h.vault_spent(), h.agent_spent(PROCUREMENT)), (FUND, 0, 0, 0));
    assert_eq!(h.agent(PROCUREMENT).failed_transfers, 1);
}

#[test]
fn force_settle_transfer_sent_and_late_callback_ignored() {
    let (mut h, sids) = H::with_payroll(1);
    let id = h.submit(&tee_acc(), &h.fixed_req(sids[0]));
    let e0 = h.c.outflow_epoch;
    h.advance(STUCK_TRANSFER_MS);
    assert!(h.as_owner().force_settle_transfer(U64(id), true));
    let p = h.payout(id);
    assert_eq!((p.status, p.funds_left), (PayoutStatus::Sent, true));
    assert_eq!((h.c.balance, h.c.in_flight, h.c.outflow_epoch), (FUND - AMOUNT, 0, e0 + 1));
    let s = h.schedule(sids[0]);
    assert_eq!((s.open_payout, s.paid_count, s.next_due_at), (None, 1, Some(U64(T0 + PERIOD))));
    assert_eq!(h.recipient(0).last_paid_at_ms, Some(U64(T0)));
    expect_panic(|| h.as_owner().force_settle_transfer(U64(id), false), "Payout is not transferring");
    expect_panic(|| h.as_owner().force_settle_transfer(U64(77), false), "Payout not found");
    // The real callback arrives late: no double settlement.
    let snapshot = h.money();
    h.settle(id, false);
    assert_eq!(h.payout(id).status, PayoutStatus::Sent);
    assert_eq!(h.money(), snapshot);
}

#[test]
fn set_storage_deposit_yocto_used_by_next_payment() {
    let mut h = H::new();
    h.as_owner().set_storage_deposit_yocto(U128(42));
    assert_eq!(h.view().get_contract_info().storage_deposit_yocto, U128(42));
    h.submit(&key_acc(), &Req::open(AMOUNT));
    assert_eq!(scheduled_calls()[0], (token(), "storage_deposit".to_string(), 42));
}

// --- ownership transfer --------------------------------------------------------------------------

#[test]
fn propose_and_accept_owner() {
    let mut h = H::new();
    let new_owner = acc("new-owner.near");
    h.as_owner().propose_owner(new_owner.clone());
    assert_eq!(h.view().get_contract_info().proposed_owner, Some(new_owner.clone()));
    assert_eq!(h.c.owner_id, owner(), "not transferred until accepted");
    expect_panic(|| h.as_(&stranger(), ONE_YOCTO).accept_owner(), "Caller is not the proposed owner");
    expect_panic(|| h.as_(&new_owner, NO_DEPOSIT).accept_owner(), "Requires attached deposit of exactly 1 yoctoNEAR");
    h.as_(&new_owner, ONE_YOCTO).accept_owner();
    assert_eq!((h.c.owner_id.clone(), h.c.proposed_owner.clone()), (new_owner.clone(), None));
    assert!(get_logs().iter().any(|l| l.contains("owner_changed")));
    expect_panic(|| h.as_owner_no_deposit().pause(), "Caller is not the owner");
    h.as_(&new_owner, NO_DEPOSIT).pause();
    assert!(h.c.paused);
    expect_panic(|| h.as_(&new_owner, ONE_YOCTO).accept_owner(), "Caller is not the proposed owner");
}

#[test]
fn agent_account_cannot_accept_ownership() {
    let (mut h, _) = H::with_payroll(1);
    for a in [key_acc(), tee_acc()] {
        h.as_owner().propose_owner(a.clone());
        expect_panic(|| h.as_(&a, ONE_YOCTO).accept_owner(), "An agent account cannot become the owner");
        assert_eq!(h.c.owner_id, owner());
    }
    // Revoked agents stay mapped and are still refused.
    h.as_owner().revoke_agent(PROCUREMENT.into());
    h.as_owner().propose_owner(key_acc());
    expect_panic(|| h.as_(&key_acc(), ONE_YOCTO).accept_owner(), "An agent account cannot become the owner");
}

#[test]
fn new_proposal_replaces_previous() {
    let mut h = H::new();
    h.as_owner().propose_owner(acc("a.near"));
    h.as_owner().propose_owner(acc("b.near"));
    expect_panic(|| h.as_(&acc("a.near"), ONE_YOCTO).accept_owner(), "Caller is not the proposed owner");
    h.as_(&acc("b.near"), ONE_YOCTO).accept_owner();
    assert_eq!(h.c.owner_id, acc("b.near"));
}

#[test]
fn accept_owner_without_proposal_panics() {
    let mut h = H::new();
    expect_panic(|| h.as_owner().accept_owner(), "Caller is not the proposed owner");
}

// --- misc ----------------------------------------------------------------------------------------

#[test]
fn fmt_amount_formats_usdc() {
    assert_eq!(fmt_amount(0), "0");
    assert_eq!(fmt_amount(1), "0.000001");
    assert_eq!(fmt_amount(1_500_000), "1.5");
    assert_eq!(fmt_amount(200 * USDC), "200");
}

#[test]
fn payment_result_json_shape() {
    let v = serde_json::to_value(PaymentResult::Submitted { payout_id: U64(7) }).unwrap();
    assert_eq!(v, serde_json::json!({ "Submitted": { "payout_id": "7" } }));
    let v =
        serde_json::to_value(PaymentResult::Rejected { reason: "AGENT_PAUSED".into(), detail: "d".into() }).unwrap();
    assert_eq!(v, serde_json::json!({ "Rejected": { "reason": "AGENT_PAUSED", "detail": "d" } }));
}

// --- review fixes: upgrade, dust, counts, log cap, approval age ----------------------------------

#[test]
fn update_contract_requires_one_yocto() {
    let mut h = H::new();
    for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
        expect_panic(
            || drop(h.as_(&owner(), deposit).update_contract()),
            "Requires attached deposit of exactly 1 yoctoNEAR",
        );
    }
    // Agents can never upgrade, with or without a deposit.
    expect_panic(|| drop(h.as_(&key_acc(), ONE_YOCTO).update_contract()), "Caller is not the owner");
    // With 1 yocto the owner passes the gate and reaches input parsing (no input in the mocked receipt).
    expect_panic(|| drop(h.as_owner().update_contract()), "Input: 8 bytes gas");
}

#[test]
fn set_policy_validates_min_payment() {
    let mut h = H::new();
    expect_panic(|| h.as_owner().set_policy(policy_min(VAULT_DAILY, 0)), "min_payment must be positive");
    expect_panic(|| h.as_owner().set_policy(policy_min(10, 11)), "min_payment must not exceed daily_limit");
    h.as_owner().set_policy(policy_min(10, 10));
    let p = h.view().get_policy();
    assert_eq!((p.daily_limit, p.min_payment), (U128(10), U128(10)));
}

#[test]
fn dust_payments_rejected_with_below_min_payment() {
    let (mut h, sids) = H::with_payroll(1);
    h.as_owner().set_policy(policy_min(VAULT_DAILY, USDC));
    let before = h.money();
    let (code, detail) = h.rejected(&key_acc(), &Req::open(USDC - 1));
    assert_eq!(code, reason::BELOW_MIN_PAYMENT);
    assert!(detail.contains("1 USDC; requested 0.999999"), "{detail}");
    assert_eq!(h.money(), before, "no payout record, no storage deposit, no counters");
    assert_eq!(h.reject_code(&key_acc(), &Req::open(1)), reason::BELOW_MIN_PAYMENT);
    // Exactly the minimum is fine.
    h.paid(&key_acc(), &Req::open(USDC));
    // Applies to Fixed recipients configured below the minimum, too.
    h.as_owner().set_policy(policy_min(VAULT_DAILY, AMOUNT + 1));
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sids[0])), reason::BELOW_MIN_PAYMENT);
    let b = h.view().get_agent_budget(PAYROLL.into()).unwrap();
    assert_eq!(b.min_payment, U128(AMOUNT + 1));
}

#[test]
fn daily_payment_count_cap_counts_failed_and_pending_and_rolls_over() {
    let mut h = H::new();
    h.edit_mandate(PROCUREMENT, |m| m.max_payments_per_day = 4);
    let k = key_acc();
    h.paid(&k, &Req::open(AMOUNT));
    let failed = h.submit(&k, &Req::open(AMOUNT));
    h.settle(failed, false); // failed transfers still count (each one cost the vault a record + storage deposit)
    h.pending(&k, &Req::open(LARGE)); // pending approvals count too
    // Rejections do not count.
    h.rejected(&k, &Req::open(PER_TX + 1));
    assert_eq!(h.view().get_agent_budget(PROCUREMENT.into()).unwrap().payments_today, 3);
    h.paid(&k, &Req::open(AMOUNT));
    let before = h.money();
    let (code, detail) = h.rejected(&k, &Req::open(AMOUNT));
    assert_eq!(code, reason::AGENT_DAILY_COUNT_EXCEEDED);
    assert!(detail.contains("4 payments per day and has made 4"), "{detail}");
    assert_eq!(h.money(), before);
    // Releasing the failed transfer's reservation did not refund the count; other agents are independent.
    h.add_key("ops", key_acc2(), open_mandate());
    h.paid(&key_acc2(), &Req::open(AMOUNT));
    let b = h.view().get_agent_budget(PROCUREMENT.into()).unwrap();
    assert_eq!((b.max_payments_per_day, b.payments_today), (4, 4));
    // Rollover resets the count.
    h.advance(DAY_MS);
    assert_eq!(h.view().get_agent_budget(PROCUREMENT.into()).unwrap().payments_today, 0);
    for _ in 0..4 {
        h.paid(&k, &Req::open(AMOUNT));
    }
    assert_eq!(h.reject_code(&k, &Req::open(AMOUNT)), reason::AGENT_DAILY_COUNT_EXCEEDED);
}

#[test]
fn approve_does_not_double_count_the_pending_payout() {
    let mut h = H::new();
    h.edit_mandate(PROCUREMENT, |m| m.max_payments_per_day = 1);
    let id = h.pending(&key_acc(), &Req::open(LARGE));
    h.approve(id); // panics today: "AGENT_DAILY_COUNT_EXCEEDED: ... may make 1 payments per day and has made 1"
    assert_eq!(h.payout(id).status, PayoutStatus::Transferring);
    assert_eq!(h.view().get_agent_budget(PROCUREMENT.into()).unwrap().payments_today, 1, "counted once");
}

#[test]
fn above_threshold_requires_deposit_deadline() {
    let mut h = H::new();
    let before = h.money();
    let (code, detail) = h.rejected(&key_acc(), &Req { expires: None, ..Req::open(LARGE) });
    assert_eq!(code, reason::INVALID_REQUEST);
    assert!(detail.contains("deposit_expires_at_ms"), "{detail}");
    assert_eq!(h.money(), before);
    assert_eq!(h.view().get_rejections(None, Some(1), None)[0].reason, reason::INVALID_REQUEST);
    // Not required at or below the threshold.
    h.paid(&key_acc(), &Req { expires: None, ..Req::open(THRESHOLD) });
    // Missing deadline is reported before the pending-approvals cap.
    h.agent_mut(PROCUREMENT).open_approvals = MAX_OPEN_APPROVALS_PER_AGENT;
    assert_eq!(h.reject_code(&key_acc(), &Req { expires: None, ..Req::open(LARGE) }), reason::INVALID_REQUEST);
    assert_eq!(h.reject_code(&key_acc(), &Req::open(LARGE)), reason::TOO_MANY_PENDING_APPROVALS);
}

#[test]
fn approve_refuses_payouts_older_than_72h() {
    let mut h = H::new();
    let far = T0 + 30 * DAY_MS;
    let old = h.pending(&key_acc(), &Req { expires: Some(far), ..Req::open(LARGE) });
    h.advance(1);
    let young = h.pending(&key_acc(), &Req { expires: Some(far), deposit: dep(2), ..Req::open(LARGE) });
    h.advance(MAX_APPROVAL_AGE_MS - 1); // old is exactly 72 h old → still allowed
    h.approve(old);
    assert_eq!(h.payout(old).status, PayoutStatus::Transferring);
    h.advance(1); // young is exactly 72 h old; push past
    h.advance(1);
    expect_panic(|| h.approve(young), "older than 72 h");
    assert_eq!(h.payout(young).status, PayoutStatus::PendingApproval);
    h.as_owner_no_deposit().reject_payout(U64(young), None);
}

#[test]
fn rejection_log_caps_50_entries_per_agent_per_day() {
    let mut h = H::new();
    h.add_key("ops", key_acc2(), open_mandate());
    h.as_owner_no_deposit().pause();
    for i in 0..MAX_LOGGED_REJECTIONS_PER_AGENT_PER_DAY + 10 {
        h.advance(1);
        // Every rejection is still returned to the agent and updates last_request_at.
        assert_eq!(h.reject_code(&key_acc(), &Req::open(u128::from(i) + 1)), reason::VAULT_PAUSED);
        assert_eq!(h.agent(PROCUREMENT).last_request_at_ms, Some(h.now));
    }
    let logged = h.view().get_rejections(None, Some(1_000), Some(PROCUREMENT.into()));
    assert_eq!(logged.len() as u32, MAX_LOGGED_REJECTIONS_PER_AGENT_PER_DAY);
    assert_eq!(logged[0].amount, U128(u128::from(MAX_LOGGED_REJECTIONS_PER_AGENT_PER_DAY)), "first 50 kept");
    assert!(!get_logs().iter().any(|l| l.contains("payment_rejected")), "no event once capped");
    // Another agent is unaffected; next day the noisy agent logs again.
    h.rejected(&key_acc2(), &Req::open(AMOUNT));
    assert_eq!(h.view().get_rejections(None, None, Some("ops".into())).len(), 1);
    h.advance(DAY_MS);
    h.rejected(&key_acc(), &Req::open(7));
    assert_eq!(h.view().get_rejections(None, Some(1), None)[0].amount, U128(7));
}

#[test]
fn rejected_request_does_not_roll_vault_day() {
    let mut h = H::new();
    h.paid(&key_acc(), &Req::open(AMOUNT));
    h.advance(DAY_MS);
    h.as_owner_no_deposit().pause();
    h.rejected(&key_acc(), &Req::open(AMOUNT));
    assert_eq!((h.c.day_index, h.c.spent_today), (T0 / DAY_MS, AMOUNT), "stored vault counters untouched");
    assert_eq!(h.vault_spent(), 0, "virtual rollover in views");
}

#[test]
fn set_storage_deposit_yocto_must_be_positive() {
    let mut h = H::new();
    expect_panic(|| h.as_owner().set_storage_deposit_yocto(U128(0)), "storage_deposit_yocto must be positive");
}

#[test]
fn ft_transfer_gas_is_30_tgas() {
    let mut h = H::new();
    h.submit(&key_acc(), &Req::open(AMOUNT));
    let gas: Vec<u64> = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, prepaid_gas, .. } if method_name == b"ft_transfer" => {
                Some(prepaid_gas.as_tgas())
            }
            _ => None,
        })
        .collect();
    assert_eq!(gas, vec![30]);
}

// =================================================================================================
// Schedules (ADR-0004)
// =================================================================================================

/// `y-m-d` of a timestamp (UTC).
fn ymd(ms: u64) -> (u64, u32, u32) {
    frequency::civil_from_days(ms / DAY_MS)
}
/// Timestamp of `y-m-d` at DEC1's time of day (09:30 UTC).
fn at(y: u64, m: u32, d: u32) -> u64 {
    frequency::days_from_civil(y, m, d) * DAY_MS + DEC1 % DAY_MS
}

fn submitted(res: PromiseOrValue<PaymentResult>) {
    match res {
        PromiseOrValue::Promise(p) => drop(p),
        PromiseOrValue::Value(v) => panic!("expected a transfer promise, got {v:?}"),
    }
}

impl H {
    fn last_payout_id(&self) -> PayoutId {
        u64::from(self.c.payouts.len() - 1)
    }
    fn due_ids(&self, now_ms: Option<u64>, agent: Option<&str>) -> Vec<(ScheduleId, bool)> {
        self.view()
            .get_due(now_ms.map(U64), agent.map(str::to_string), None, None)
            .into_iter()
            .map(|d| (d.schedule.id, d.overdue))
            .collect()
    }
}

// --- frequencies end to end ------------------------------------------------------------------------

#[test]
fn once_is_paid_once_then_ended() {
    let (mut h, sid) = H::sched_vault(DEC1 - DAY_MS, Frequency::Once, DEC1, ScheduleEnd::Never, AMOUNT);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1)));
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
    h.set_now(DEC1);
    let id = h.paid_sched(sid);
    let p = h.payout(id);
    assert_eq!((p.schedule_id, p.occurrence_at), (Some(sid), Some(U64(DEC1))));
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at, s.paid_count), (ScheduleStatus::Ended, None, 1));
    assert_eq!((s.last_paid_at, s.last_occurrence_paid), (Some(U64(DEC1)), Some(U64(DEC1))));
    h.advance(DAY_MS);
    let (code, detail) = rejection_of(h.pay_sched(sid));
    assert_eq!(code, reason::SCHEDULE_NOT_ACTIVE);
    assert!(detail.contains("Ended"), "{detail}");
    assert_eq!(h.view().get_recipient(0).unwrap().active_schedules, 0);
    assert!(h.due_ids(None, None).is_empty());
}

#[test]
fn monthly_pays_1_dec_then_not_due_until_1_jan() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::Monthly { day: 1 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.paid_sched(sid);
    let next = h.schedule(sid).next_due_at.unwrap().0;
    assert_eq!((ymd(next), next % DAY_MS), ((2027, 1, 1), DEC1 % DAY_MS));
    h.set_now(next - 1);
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
    h.set_now(next);
    let id = h.paid_sched(sid);
    assert_eq!(h.payout(id).occurrence_at, Some(U64(at(2027, 1, 1))));
    assert_eq!(ymd(h.schedule(sid).next_due_at.unwrap().0), (2027, 2, 1));
    assert_eq!(h.schedule(sid).paid_count, 2);
}

#[test]
fn weekly_pays_on_the_weekday_at_start_time() {
    // Every Monday (1); start Tue 1 Dec 09:30 → first Mon 7 Dec 09:30.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::Weekly { weekday: 1 }, DEC1, ScheduleEnd::Never, AMOUNT);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(at(2026, 12, 7))));
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
    h.set_now(at(2026, 12, 7));
    h.paid_sched(sid);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(at(2026, 12, 14))));
    h.set_now(at(2026, 12, 14) - 1);
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
    h.set_now(at(2026, 12, 14));
    h.paid_sched(sid);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(at(2026, 12, 21))));
}

#[test]
fn every_n_days_steps_from_start() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 14 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.paid_sched(sid);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 14 * DAY_MS)));
    h.set_now(DEC1 + 14 * DAY_MS - 1);
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
    h.set_now(DEC1 + 14 * DAY_MS);
    h.paid_sched(sid);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 28 * DAY_MS)));
}

#[test]
fn after_count_ends_after_n_payments() {
    let (mut h, sid) =
        H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::AfterCount { count: 2 }, AMOUNT);
    h.paid_sched(sid);
    assert_eq!(h.schedule(sid).status, ScheduleStatus::Active);
    h.set_now(DEC1 + 7 * DAY_MS);
    h.paid_sched(sid);
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at, s.paid_count), (ScheduleStatus::Ended, None, 2));
    h.set_now(DEC1 + 14 * DAY_MS);
    assert_eq!(h.sched_code(sid), reason::SCHEDULE_NOT_ACTIVE);
}

#[test]
fn end_on_date_stops_after_last_occurrence_before_it() {
    let end = ScheduleEnd::On { at: U64(DEC1 + 20 * DAY_MS) };
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, end, AMOUNT);
    for k in 0..3u64 {
        h.set_now(DEC1 + k * 7 * DAY_MS);
        h.paid_sched(sid);
    }
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at, s.paid_count), (ScheduleStatus::Ended, None, 3));
    // An end exactly on an occurrence includes it.
    let end = ScheduleEnd::On { at: U64(DEC1 + 7 * DAY_MS) };
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, end, AMOUNT);
    h.paid_sched(sid);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 7 * DAY_MS)));
}

#[test]
fn paying_late_within_grace_advances_to_next_date_not_now_plus_period() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    let late = DEC1 + 2 * DAY_MS;
    h.set_now(late);
    assert_eq!(h.due_ids(None, None), vec![(sid, false)]);
    let id = h.paid_sched(sid);
    assert_eq!(h.payout(id).occurrence_at, Some(U64(DEC1)));
    let s = h.schedule(sid);
    assert_eq!(s.next_due_at, Some(U64(DEC1 + 7 * DAY_MS)), "next date, not now + 7 days");
    assert_eq!((s.last_paid_at, s.last_occurrence_paid), (Some(U64(late)), Some(U64(DEC1))));
    // Exactly at due + grace: still not overdue (rule is now > due + grace).
    h.set_now(DEC1 + 7 * DAY_MS + GRACE);
    assert_eq!(h.due_ids(None, None), vec![(sid, false)]);
    h.paid_sched(sid);
}

// --- overdue ---------------------------------------------------------------------------------------

#[test]
fn overdue_request_needs_approval_even_below_threshold() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.set_now(DEC1 + GRACE + 1);
    assert_eq!(h.due_ids(None, None), vec![(sid, true)]);
    // Deadline required for an overdue approval too.
    let r = Req { expires: None, ..h.fixed_req(sid) };
    assert_eq!(h.reject_code(&key_acc2(), &r), reason::INVALID_REQUEST);
    let before = h.money();
    let (id, why) = h.pending_sched(sid);
    assert_eq!(why, reason::OVERDUE_NEEDS_APPROVAL);
    let p = h.payout(id);
    assert_eq!(
        (p.status, p.approval_reason.as_deref()),
        (PayoutStatus::PendingApproval, Some(reason::OVERDUE_NEEDS_APPROVAL))
    );
    assert_eq!(p.occurrence_at, Some(U64(DEC1)));
    let now = h.money();
    assert_eq!((now.balance, now.in_flight, now.vault_spent), (before.balance, 0, 0));
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.next_due_at, s.paid_count), (Some(U64(id)), Some(U64(DEC1)), 0));
    assert!(get_logs().iter().any(|l| l.contains("OVERDUE_NEEDS_APPROVAL")));
    assert_eq!(h.sched_code(sid), reason::PAYOUT_IN_PROGRESS);
    // Approve pays exactly that occurrence (no re-trigger of the overdue rule at approval time).
    h.approve(id);
    let s = h.schedule(sid);
    assert_eq!(
        (s.paid_count, s.last_occurrence_paid, s.next_due_at),
        (1, Some(U64(DEC1)), Some(U64(DEC1 + 7 * DAY_MS)))
    );
    assert_eq!(h.settle(id, true), PaymentResult::Submitted { payout_id: U64(id) });
    assert_eq!(h.c.balance, FUND - AMOUNT);
}

#[test]
fn overdue_above_threshold_reports_overdue_reason() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    h.set_now(DEC1 + GRACE + 1);
    assert_eq!(h.pending_sched(sid).1, reason::OVERDUE_NEEDS_APPROVAL);
}

#[test]
fn overdue_reject_skips_that_occurrence() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.set_now(DEC1 + GRACE + 1);
    let (id, _) = h.pending_sched(sid);
    h.as_owner().reject_payout(U64(id), None);
    let s = h.schedule(sid);
    assert_eq!((s.next_due_at, s.paid_count, s.open_payout), (Some(U64(DEC1 + 7 * DAY_MS)), 0, None));
    assert_eq!(h.c.balance, FUND);
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
}

#[test]
fn missed_occurrences_are_paid_one_by_one() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::Monthly { day: 1 }, DEC1, ScheduleEnd::Never, AMOUNT);
    // Agent offline until 2 March: Dec, Jan, Feb are overdue; 1 Mar is within grace.
    h.set_now(at(2027, 3, 2));
    for (y, m) in [(2026, 12), (2027, 1), (2027, 2)] {
        let (id, why) = h.pending_sched(sid);
        assert_eq!(why, reason::OVERDUE_NEEDS_APPROVAL, "{y}-{m}");
        assert_eq!(h.payout(id).occurrence_at, Some(U64(at(y, m, 1))));
        h.approve(id);
        h.settle(id, true);
    }
    let id = h.last_payout_id();
    submitted(h.pay_sched(sid));
    let id2 = h.last_payout_id();
    assert_eq!(id2, id + 1);
    assert_eq!(h.payout(id2).occurrence_at, Some(U64(at(2027, 3, 1))));
    h.settle(id2, true);
    let s = h.schedule(sid);
    assert_eq!((s.paid_count, s.next_due_at), (4, Some(U64(at(2027, 4, 1)))));
    assert_eq!(h.sched_code(sid), reason::NOT_DUE);
}

// --- failed transfers ------------------------------------------------------------------------------

#[test]
fn failed_transfer_restores_ended_schedule_and_recipient() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::Once, DEC1, ScheduleEnd::Never, AMOUNT);
    // Earlier on-demand-free history: recipient paid by another schedule a day before.
    let other = h.add_schedule(schedule_input(0, "fx", AMOUNT, Frequency::Once, DEC1));
    h.paid_sched(other);
    h.advance(DAY_MS);
    let before = h.schedule(sid);
    let id = h.submit(&key_acc2(), &h.fixed_req(sid));
    let s = h.schedule(sid);
    assert_eq!((s.status, s.paid_count, s.next_due_at), (ScheduleStatus::Ended, 1, None));
    assert_eq!(h.recipient(0).last_paid_at_ms, Some(U64(h.now)));
    assert_eq!(h.settle(id, false), PaymentResult::TransferFailed { payout_id: U64(id) });
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at, s.paid_count), (ScheduleStatus::Active, Some(U64(DEC1)), 0));
    assert_eq!((s.last_paid_at, s.last_occurrence_paid, s.open_payout), (None, None, None));
    assert_eq!(s.failed_attempts, 1);
    assert_eq!((s.recipient_id, s.amount, s.frequency), (before.recipient_id, before.amount, before.frequency));
    assert_eq!(h.recipient(0).last_paid_at_ms, Some(U64(DEC1)), "restored to the earlier payment");
    assert_eq!(h.agent("fx").failed_transfers, 1);
    // Retry succeeds and resets the counter.
    h.paid_sched(sid);
    let s = h.schedule(sid);
    assert_eq!((s.status, s.failed_attempts, s.paid_count), (ScheduleStatus::Ended, 0, 1));
    assert_eq!(h.agent("fx").failed_transfers, 0);
}

#[test]
fn failed_transfer_restores_after_count_end() {
    let (mut h, sid) =
        H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::AfterCount { count: 1 }, AMOUNT);
    let id = h.submit(&key_acc2(), &h.fixed_req(sid));
    assert_eq!(h.schedule(sid).status, ScheduleStatus::Ended);
    h.settle(id, false);
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at, s.paid_count), (ScheduleStatus::Active, Some(U64(DEC1)), 0));
}

// --- add / update validation -----------------------------------------------------------------------

#[test]
fn add_schedule_validation() {
    type Case = (&'static str, fn(&mut H) -> ScheduleInput, &'static str);
    // Vault: recipient 0 (base), recipient 1 (sol), recipient 2 (base, not in fx's mandate); agents procurement (Open),
    // fx (Fixed over 0, 1), allow (Allowlist over recipient 0's address), gone (revoked).
    let base = |rid: RecipientId, agent: &str| schedule_input(rid, agent, AMOUNT, every_period(), T0);
    let _ = base;
    let cases: Vec<Case> = vec![
        ("unknown recipient", |_| schedule_input(9, "fx", AMOUNT, every_period(), T0), "Recipient not found"),
        ("unknown agent", |_| schedule_input(0, "nope", AMOUNT, every_period(), T0), "Agent not found"),
        ("revoked agent", |_| schedule_input(0, "gone", AMOUNT, every_period(), T0), "Agent is revoked"),
        (
            "fixed: recipient not in mandate",
            |_| schedule_input(2, "fx", AMOUNT, every_period(), T0),
            "not in its mandate",
        ),
        (
            "allowlist: destination not listed",
            |_| schedule_input(2, "allow", AMOUNT, every_period(), T0),
            "not in its mandate",
        ),
        (
            "chain not allowed",
            |h| {
                h.edit_mandate("fx", |m| m.allowed_chains = vec![CHAIN.into()]);
                schedule_input(1, "fx", AMOUNT, every_period(), T0)
            },
            "not in its mandate",
        ),
        (
            "open: chain not allowed",
            |h| {
                h.edit_mandate(PROCUREMENT, |m| m.allowed_chains = vec![CHAIN.into()]);
                schedule_input(1, PROCUREMENT, AMOUNT, every_period(), T0)
            },
            "not in its mandate",
        ),
        (
            "amount below min_payment",
            |h| {
                h.as_owner().set_policy(policy_min(VAULT_DAILY, AMOUNT + 1));
                schedule_input(0, "fx", AMOUNT, every_period(), T0)
            },
            "below the vault's minimum payment",
        ),
        ("amount above per_tx_limit", |_| schedule_input(0, "fx", PER_TX + 1, every_period(), T0), "per-payment limit"),
        ("weekday 7", |_| schedule_input(0, "fx", AMOUNT, Frequency::Weekly { weekday: 7 }, T0), "Invalid frequency"),
        (
            "monthly day 29",
            |_| schedule_input(0, "fx", AMOUNT, Frequency::Monthly { day: 29 }, T0),
            "Invalid frequency",
        ),
        ("monthly day 0", |_| schedule_input(0, "fx", AMOUNT, Frequency::Monthly { day: 0 }, T0), "Invalid frequency"),
        ("every 0 days", |_| schedule_input(0, "fx", AMOUNT, Frequency::EveryNDays { n: 0 }, T0), "Invalid frequency"),
        (
            "every 366 days",
            |_| schedule_input(0, "fx", AMOUNT, Frequency::EveryNDays { n: 366 }, T0),
            "Invalid frequency",
        ),
        (
            "after 0",
            |_| ScheduleInput {
                end: ScheduleEnd::AfterCount { count: 0 },
                ..schedule_input(0, "fx", AMOUNT, every_period(), T0)
            },
            "Invalid end",
        ),
        (
            "ends before start",
            |_| ScheduleInput {
                end: ScheduleEnd::On { at: U64(T0 - 1) },
                ..schedule_input(0, "fx", AMOUNT, every_period(), T0)
            },
            "no payable date",
        ),
        (
            "monthly ends before first date",
            |_| ScheduleInput {
                end: ScheduleEnd::On { at: U64(at(2026, 12, 10)) },
                ..schedule_input(0, "fx", AMOUNT, Frequency::Monthly { day: 15 }, DEC1)
            },
            "no payable date",
        ),
    ];
    for (name, make, expected) in cases {
        let mut h = H::new();
        h.add_recipient(evm_addr(0x10));
        let mut sol = recipient_input("sol", SOL_ADDR.into());
        sol.destination_chain = "sol".into();
        h.as_owner().add_recipient(sol);
        h.add_recipient(evm_addr(0x20));
        h.add_key("fx", key_acc2(), fixed_mandate(vec![0, 1]));
        h.add_key("allow", acc("allow.near"), allowlist_mandate(vec![destination(CHAIN, &evm_addr(0x10))]));
        h.add_key("gone", acc("gone.near"), open_mandate());
        h.as_owner().revoke_agent("gone".into());
        let input = make(&mut h);
        expect_panic(|| h.add_schedule(input.clone()), expected);
        // (Unit tests do not roll back state on panic, so only "nothing inserted" is meaningful here; on-chain the
        // whole call reverts, incl. the id counter.)
        assert_eq!(h.c.schedules.len(), 0, "{name}: stored");
        // The same input is refused by update_schedule as well (no-payable-date inputs: see
        // `update_schedule_without_any_occurrence_is_refused`).
        if expected == "no payable date" {
            continue;
        }
        let sid = h.add_schedule(schedule_input(0, PROCUREMENT, PER_TX, every_period(), T0));
        let before = h.schedule(sid);
        expect_panic(|| h.as_owner().update_schedule(sid, input), expected);
        assert_eq!(h.schedule(sid), before, "{name}: update changed state");
    }
}

#[test]
fn add_schedule_accepts_valid_modes_and_returns_ids() {
    let mut h = H::new();
    let r0 = h.add_recipient(evm_addr(0x10));
    h.add_key("fx", key_acc2(), fixed_mandate(vec![r0]));
    h.add_key(
        "allow",
        acc("allow.near"),
        allowlist_mandate(vec![destination(CHAIN, &evm_addr(0x10).to_uppercase().replace("0X", "0x"))]),
    );
    assert_eq!(h.view().get_contract_info().next_schedule_id, 0);
    let a = h.add_schedule(schedule_input(r0, "fx", PER_TX, every_period(), T0));
    let b = h.add_schedule(schedule_input(r0, "allow", AMOUNT, every_period(), T0));
    let c = h.add_schedule(schedule_input(r0, PROCUREMENT, MIN_PAYMENT, Frequency::Monthly { day: 28 }, T0));
    assert_eq!((a, b, c), (0, 1, 2));
    assert!(get_logs().iter().any(|l| l.contains("schedule_upserted")));
    let s = h.schedule(c);
    assert_eq!((s.status, s.paid_count, s.created_at, s.failed_attempts), (ScheduleStatus::Active, 0, U64(T0), 0));
    assert_eq!((s.last_paid_at, s.open_payout), (None, None));
    let info = h.view().get_contract_info();
    assert_eq!((info.next_schedule_id, info.next_recipient_id), (3, 1));
    // add_schedule needs 1 yocto.
    expect_panic(
        || h.as_owner_no_deposit().add_schedule(schedule_input(r0, "fx", AMOUNT, every_period(), T0)),
        "1 yoctoNEAR",
    );
}

#[test]
fn add_schedule_with_once_in_the_past_has_no_payable_date() {
    let mut h = H::new();
    let r0 = h.add_recipient(evm_addr(0x10));
    h.add_key("fx", key_acc2(), fixed_mandate(vec![r0]));
    expect_panic(|| h.add_schedule(schedule_input(r0, "fx", AMOUNT, Frequency::Once, T0 - DAY_MS)), "no payable date");
}

#[test]
fn schedule_rules_are_rechecked_at_payment_time() {
    let (mut h, sids) = H::with_payroll(1);
    let sid = sids[0];
    // Mandate no longer lists the recipient (owner changed the mandate after creating the schedule).
    let other = h.add_recipient(evm_addr(0x66));
    h.edit_mandate(PAYROLL, |m| m.recipients = vec![other]);
    let (code, detail) = h.rejected(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(code, reason::RECIPIENT_NOT_ALLOWED);
    assert!(detail.contains("no longer allows"), "{detail}");
    h.edit_mandate(PAYROLL, |m| m.recipients = vec![0, other]);
    // Per-tx limit lowered below the schedule amount.
    h.edit_mandate(PAYROLL, |m| m.per_tx_limit = U128(AMOUNT - 1));
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sid)), reason::PER_TX_LIMIT_EXCEEDED);
    h.edit_mandate(PAYROLL, |m| m.per_tx_limit = U128(PER_TX));
    // Recipient moved to another chain the agent may not use.
    let mut moved = recipient_input("r0", "TXYZ".into());
    moved.destination_chain = "tron".into();
    h.as_owner().update_recipient(0, moved);
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sid)), reason::CHAIN_NOT_ALLOWED);
    // Schedule paused / resumed.
    h.as_owner().update_recipient(0, recipient_input("r0", evm_addr(0x10)));
    h.as_owner_no_deposit().pause_schedule(sid);
    expect_panic(|| h.as_owner_no_deposit().pause_schedule(sid), "Schedule is not active");
    assert_eq!(h.reject_code(&tee_acc(), &h.fixed_req(sid)), reason::SCHEDULE_NOT_ACTIVE);
    expect_panic(|| h.as_owner_no_deposit().resume_schedule(sid), "1 yoctoNEAR");
    h.as_owner().resume_schedule(sid);
    expect_panic(|| h.as_owner().resume_schedule(sid), "Schedule is not paused");
    h.paid(&tee_acc(), &h.fixed_req(sid));
}

#[test]
fn update_schedule_recomputes_next_due_after_last_paid_occurrence() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.paid_sched(sid);
    // Amount change only: next date unchanged, history kept.
    h.edit_schedule(sid, |s| s.amount = U128(AMOUNT * 2));
    let s = h.schedule(sid);
    assert_eq!((s.next_due_at, s.paid_count, s.amount), (Some(U64(DEC1 + 7 * DAY_MS)), 1, U128(AMOUNT * 2)));
    // New frequency: first new date after the paid occurrence (1 Dec) → 15 Dec.
    h.edit_schedule(sid, |s| s.frequency = Frequency::Monthly { day: 15 });
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(at(2026, 12, 15))));
    // Start moved into the future: next date from the new start.
    h.edit_schedule(sid, |s| s.start_at = U64(at(2027, 2, 1)));
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(at(2027, 2, 15))));
    // AfterCount already reached → Ended.
    h.edit_schedule(sid, |s| s.end = ScheduleEnd::AfterCount { count: 1 });
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at), (ScheduleStatus::Ended, None));
    // Failure counter reset by an update; unknown schedule.
    expect_panic(
        || h.as_owner().update_schedule(99, schedule_input(0, "fx", AMOUNT, every_period(), DEC1)),
        "Schedule not found",
    );
}

#[test]
fn update_schedule_after_late_payment_does_not_pay_twice() {
    // ADR-0004 §4 recomputes from last_paid_at + 1 (coordinator: from last_occurrence_handled). Paid 1 Dec on 3 Dec;
    // switching to Monthly{2} must not make 2 Dec payable again a day after paying.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::Monthly { day: 1 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.set_now(at(2026, 12, 3));
    h.paid_sched(sid);
    h.edit_schedule(sid, |s| s.frequency = Frequency::Monthly { day: 2 });
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(at(2027, 1, 2))));
}

#[test]
fn update_schedule_after_skip_starts_after_skipped_date() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let (id, _) = h.pending_sched(sid);
    h.as_owner().reject_payout(U64(id), Some(true));
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 7 * DAY_MS)));
    h.edit_schedule(sid, |s| s.amount = U128(AMOUNT));
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 7 * DAY_MS)), "skipped date stays handled");
}

#[test]
fn update_schedule_rejects_pending_approval_without_skipping() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let (id, _) = h.pending_sched(sid);
    assert_eq!(h.agent("fx").open_approvals, 1);
    h.edit_schedule(sid, |s| s.amount = U128(AMOUNT));
    assert_eq!(h.payout(id).status, PayoutStatus::Rejected);
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.next_due_at, s.paid_count), (None, Some(U64(DEC1)), 0));
    assert_eq!(h.agent("fx").open_approvals, 0);
    expect_panic(|| h.approve(id), "Payout is not pending approval");
    // New terms are paid directly.
    h.paid_sched(sid);
}

#[test]
fn update_schedule_on_ended_schedule_panics() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.as_owner().end_schedule(sid);
    let s = h.schedule(sid);
    assert_eq!((s.status, s.next_due_at), (ScheduleStatus::Ended, None));
    expect_panic(|| h.edit_schedule(sid, |s| s.amount = U128(AMOUNT + 1)), "Schedule is ended");
    assert_eq!(h.schedule(sid).status, ScheduleStatus::Ended);
    expect_panic(|| h.as_owner().resume_schedule(sid), "Schedule is not paused");
    expect_panic(|| h.as_owner_no_deposit().pause_schedule(sid), "Schedule is not active");
}

// --- reject skip semantics ------------------------------------------------------------------------

#[test]
fn reject_payout_skip_defaults_and_explicit_values() {
    // Default: skip the date.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let (id, _) = h.pending_sched(sid);
    h.as_owner().reject_payout(U64(id), None);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 7 * DAY_MS)));
    // Explicit false: the date stays payable.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let (id, _) = h.pending_sched(sid);
    h.as_owner_no_deposit().reject_payout(U64(id), Some(false));
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1)));
    let (id2, _) = h.pending_sched(sid);
    assert_eq!(h.payout(id2).occurrence_at, Some(U64(DEC1)));
    // Deposit deadline passed: default is not to skip.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let r = Req { expires: Some(DEC1 + 1_000), ..h.fixed_req(sid) };
    let PromiseOrValue::Value(PaymentResult::PendingApproval { payout_id, .. }) = h.pay(&key_acc2(), &r) else {
        panic!("expected pending")
    };
    h.advance(1_000);
    h.as_owner_no_deposit().reject_payout(payout_id, None);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1)), "expired quote: date stays payable");
    // Older than 72 h: default is not to skip; explicit true still skips.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let (id, _) = h.pending_sched(sid);
    h.advance(MAX_APPROVAL_AGE_MS + 1);
    h.as_owner_no_deposit().reject_payout(U64(id), None);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1)));
    let (id, _) = h.pending_sched(sid);
    h.advance(MAX_APPROVAL_AGE_MS + 1);
    h.as_owner().reject_payout(U64(id), Some(true));
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1 + 7 * DAY_MS)));
}

#[test]
fn approve_scheduled_payout_rechecks_schedule() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    let (id, _) = h.pending_sched(sid);
    // Paused meanwhile: approval fails with the reason; owner can reject.
    h.as_owner_no_deposit().pause_schedule(sid);
    expect_panic(|| h.approve(id), "SCHEDULE_NOT_ACTIVE");
    h.as_owner().resume_schedule(sid);
    // Occurrence no longer the schedule's next date (state injected): refused.
    h.schedule_mut(sid).next_due_at = Some(U64(DEC1 - 1));
    expect_panic(|| h.approve(id), "SCHEDULE_NOT_ACTIVE: Schedule 0 changed since this payment was requested");
    assert_eq!(h.payout(id).status, PayoutStatus::PendingApproval);
    h.schedule_mut(sid).next_due_at = Some(U64(DEC1));
    // Schedule slot taken by another payout (state injected): refused.
    h.schedule_mut(sid).open_payout = Some(U64(999));
    expect_panic(|| h.approve(id), "PAYOUT_IN_PROGRESS");
    h.schedule_mut(sid).open_payout = Some(U64(id));
    h.approve(id);
    assert_eq!(h.payout(id).status, PayoutStatus::Transferring);
}

// --- remove_schedule -------------------------------------------------------------------------------

#[test]
fn remove_schedule_only_ended_without_open_payout() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::Once, DEC1, ScheduleEnd::Never, AMOUNT);
    expect_panic(|| h.as_owner_no_deposit().remove_schedule(sid), "Only ended schedules can be removed");
    assert!(h.view().get_schedule(sid).is_some());
    // Paid → Ended, but the transfer is in flight: still refused; remove_recipient too.
    let id = h.submit(&key_acc2(), &h.fixed_req(sid));
    assert_eq!(h.schedule(sid).status, ScheduleStatus::Ended);
    expect_panic(|| h.as_owner_no_deposit().remove_schedule(sid), "Only ended schedules can be removed");
    expect_panic(|| h.as_owner().remove_recipient(0), "End its 1 schedules first");
    assert!(h.view().get_recipient(0).is_some());
    h.settle(id, true);
    expect_panic(|| h.as_(&key_acc2(), NO_DEPOSIT).remove_schedule(sid), "Caller is not the owner");
    h.as_owner_no_deposit().remove_schedule(sid);
    assert!(h.view().get_schedule(sid).is_none());
    expect_panic(|| h.as_owner_no_deposit().remove_schedule(sid), "Schedule not found");
    h.as_owner().remove_recipient(0);
}

#[test]
fn max_schedules_counts_current_schedules() {
    let mut h = H::new();
    let rid = h.add_recipient(evm_addr(0x10));
    for _ in 0..MAX_SCHEDULES {
        h.add_schedule(schedule_input(rid, PROCUREMENT, AMOUNT, every_period(), T0));
    }
    expect_panic(|| h.add_schedule(schedule_input(rid, PROCUREMENT, AMOUNT, every_period(), T0)), "Too many schedules");
    h.as_owner().end_schedule(0);
    h.as_owner_no_deposit().remove_schedule(0);
    let id = h.add_schedule(schedule_input(rid, PROCUREMENT, AMOUNT, every_period(), T0));
    assert_eq!(id, MAX_SCHEDULES, "ids are never reused");
}

// --- views -----------------------------------------------------------------------------------------

#[test]
fn get_schedules_filters_and_paginates() {
    let (mut h, sids) = H::with_payroll(2);
    let s2 = h.add_schedule(schedule_input(0, PROCUREMENT, AMOUNT, every_period(), T0));
    let ids = |v: Vec<Schedule>| v.into_iter().map(|s| s.id).collect::<Vec<_>>();
    assert_eq!(ids(h.view().get_schedules(None, None, None, None)), vec![sids[0], sids[1], s2]);
    assert_eq!(ids(h.view().get_schedules(None, None, Some(PAYROLL.into()), None)), sids);
    assert_eq!(ids(h.view().get_schedules(None, None, None, Some(0))), vec![sids[0], s2]);
    assert_eq!(ids(h.view().get_schedules(None, None, Some(PROCUREMENT.into()), Some(0))), vec![s2]);
    assert_eq!(ids(h.view().get_schedules(Some(1), Some(1), None, None)), vec![sids[1]]);
    assert!(h.view().get_schedules(None, None, Some("nope".into()), None).is_empty());
    assert_eq!(h.view().get_schedule(s2).map(|s| s.agent_id), Some(PROCUREMENT.to_string()));
    assert!(h.view().get_schedule(99).is_none());
    assert_eq!(h.view().get_recipient(0).unwrap().active_schedules, 2);
    assert_eq!(h.view().get_recipients(None, None).iter().map(|r| r.active_schedules).collect::<Vec<_>>(), vec![2, 1]);
    // JSON shape of a schedule (dashboard contract).
    let v = serde_json::to_value(h.view().get_schedule(s2).unwrap()).unwrap();
    assert_eq!(v["frequency"], serde_json::json!({ "EveryNDays": { "n": 30 } }));
    assert_eq!(v["end"], serde_json::json!("Never"));
    assert_eq!(v["status"], serde_json::json!("Active"));
    assert_eq!(v["amount"], serde_json::json!(AMOUNT.to_string()));
}

#[test]
fn get_due_filters_and_flags_overdue() {
    let (mut h, sids) = H::with_payroll(3);
    let mine = h.add_schedule(schedule_input(0, PROCUREMENT, AMOUNT, every_period(), T0 + DAY_MS));
    let all = vec![(sids[0], false), (sids[1], false), (sids[2], false)];
    assert_eq!(h.due_ids(None, None), all);
    assert_eq!(h.due_ids(None, Some(PAYROLL)), all);
    assert!(h.due_ids(None, Some(PROCUREMENT)).is_empty(), "not due yet");
    assert!(h.due_ids(None, Some("nope")).is_empty());
    // now_ms looks ahead; overdue flag past the grace period.
    assert_eq!(h.due_ids(Some(T0 + DAY_MS), Some(PROCUREMENT)), vec![(mine, false)]);
    assert_eq!(h.due_ids(Some(T0 + GRACE), Some(PAYROLL))[0], (sids[0], false));
    assert_eq!(h.due_ids(Some(T0 + GRACE + 1), Some(PAYROLL))[0], (sids[0], true));
    // Paginated.
    let page: Vec<ScheduleId> =
        h.view().get_due(None, None, Some(1), Some(1)).into_iter().map(|d| d.schedule.id).collect();
    assert_eq!(page, vec![sids[1]]);
    // In flight / paid / paused / failure cap are excluded.
    let id = h.submit(&tee_acc(), &h.fixed_req(sids[0]));
    h.as_owner_no_deposit().pause_schedule(sids[1]);
    h.schedule_mut(sids[2]).failed_attempts = MAX_FAILED_ATTEMPTS;
    assert!(h.due_ids(None, None).is_empty());
    h.settle(id, true);
    assert!(h.due_ids(None, None).is_empty());
    assert_eq!(h.due_ids(Some(T0 + PERIOD), Some(PAYROLL)), vec![(sids[0], false)]);
    // Agent not Active → its schedules are not listed.
    h.as_owner_no_deposit().pause_agent(PAYROLL.into());
    assert!(h.due_ids(Some(T0 + PERIOD), None).iter().all(|(s, _)| *s == mine));
    h.as_owner().resume_agent(PAYROLL.into());
    // Paused vault → nothing.
    h.as_owner_no_deposit().pause();
    assert!(h.due_ids(Some(T0 + PERIOD), None).is_empty());
}

#[test]
fn get_upcoming_window_sort_and_approval_flags() {
    let (mut h, sids) = H::with_payroll(1); // payroll: AMOUNT every 30 days from T0
    let weekly = h.add_schedule(schedule_input(0, PROCUREMENT, LARGE, Frequency::Weekly { weekday: 3 }, T0));
    let twice = h.add_schedule(ScheduleInput {
        end: ScheduleEnd::AfterCount { count: 2 },
        ..schedule_input(0, PROCUREMENT, AMOUNT, Frequency::EveryNDays { n: 1 }, T0 + 1)
    });
    let paused = h.add_schedule(schedule_input(0, PROCUREMENT, AMOUNT, Frequency::EveryNDays { n: 1 }, T0));
    h.as_owner_no_deposit().pause_schedule(paused);
    let items = h.view().get_upcoming(U64(T0), U64(T0 + 62 * DAY_MS), None, None);
    assert!(items.windows(2).all(|w| (w[0].due_at.0, w[0].schedule_id) <= (w[1].due_at.0, w[1].schedule_id)), "sorted");
    assert!(items.iter().all(|i| i.due_at.0 >= T0 && i.due_at.0 <= T0 + 62 * DAY_MS));
    assert!(items.iter().all(|i| i.schedule_id != paused), "paused excluded");
    let of = |sid: ScheduleId| items.iter().filter(|i| i.schedule_id == sid).collect::<Vec<_>>();
    let p = of(sids[0]);
    assert_eq!(p.iter().map(|i| i.due_at.0).collect::<Vec<_>>(), vec![T0, T0 + PERIOD, T0 + 2 * PERIOD]);
    assert_eq!((p[0].recipient_id, p[0].agent_id.as_str(), p[0].amount), (0, PAYROLL, U128(AMOUNT)));
    assert!(p.iter().all(|i| !i.will_need_approval));
    assert!(of(weekly).iter().all(|i| i.will_need_approval), "above threshold");
    assert_eq!(of(weekly).len(), 9);
    assert_eq!(of(twice).len(), 2, "AfterCount respected");
    // Overdue: a due date already past grace needs approval even below the threshold.
    h.advance(GRACE + 1);
    let items = h.view().get_upcoming(U64(T0), U64(T0 + DAY_MS), None, None);
    let first = items.iter().find(|i| i.schedule_id == sids[0]).unwrap();
    assert!(first.will_need_approval);
    // Pagination and window bounds.
    let all = h.view().get_upcoming(U64(T0), U64(T0 + 62 * DAY_MS), None, None);
    let page = h.view().get_upcoming(U64(T0), U64(T0 + 62 * DAY_MS), Some(2), Some(3));
    assert_eq!(
        page.iter().map(|i| (i.schedule_id, i.due_at)).collect::<Vec<_>>(),
        all[2..5].iter().map(|i| (i.schedule_id, i.due_at)).collect::<Vec<_>>()
    );
    expect_panic(|| drop(h.view().get_upcoming(U64(T0), U64(T0 + 62 * DAY_MS + 1), None, None)), "62 days");
    expect_panic(|| drop(h.view().get_upcoming(U64(T0 + 1), U64(T0), None, None)), "to_ms must be >= from_ms");
}

#[test]
fn get_upcoming_is_globally_sorted_and_limited() {
    let mut h = H::new();
    let rid = h.add_recipient(evm_addr(0x10));
    // Many daily schedules (later ids start earlier) → more than 500 items in the window.
    for i in 0..20u64 {
        h.add_schedule(schedule_input(rid, PROCUREMENT, AMOUNT, Frequency::EveryNDays { n: 1 }, T0 + (20 - i) * 1000));
    }
    let items = h.view().get_upcoming(U64(T0), U64(T0 + 62 * DAY_MS), None, None);
    assert_eq!(items.len(), MAX_UPCOMING_ITEMS);
    assert!(items.windows(2).all(|w| (w[0].due_at.0, w[0].schedule_id) <= (w[1].due_at.0, w[1].schedule_id)));
    // The earliest dates of every schedule are included (not just the first schedules' dates).
    for sid in 0..20 {
        assert!(items.iter().any(|i| i.schedule_id == sid && i.due_at.0 < T0 + DAY_MS), "schedule {sid}");
    }
    let last = items.last().unwrap().due_at.0;
    assert!(last < T0 + 26 * DAY_MS, "500 earliest items across schedules, got last {last}");
    assert_eq!(h.view().get_upcoming(U64(T0), U64(T0 + 62 * DAY_MS), None, Some(7)).len(), 7);
}

#[test]
fn set_policy_bounds_overdue_grace() {
    let mut h = H::new();
    for bad in [3_600_000 - 1, 30 * DAY_MS + 1, 0] {
        expect_panic(|| h.as_owner().set_policy(Policy { overdue_grace_ms: U64(bad), ..default_policy() }), "");
    }
    for ok in [3_600_000, 30 * DAY_MS] {
        h.as_owner().set_policy(Policy { overdue_grace_ms: U64(ok), ..default_policy() });
        assert_eq!(h.view().get_policy().overdue_grace_ms, U64(ok));
    }
    // A shorter grace makes a due payment overdue sooner.
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    h.as_owner().set_policy(Policy { overdue_grace_ms: U64(3_600_000), ..default_policy() });
    h.set_now(DEC1 + 3_600_001);
    assert_eq!(h.pending_sched(sid).1, reason::OVERDUE_NEEDS_APPROVAL);
}

#[test]
fn pending_approval_result_json_shape() {
    let v = serde_json::to_value(PaymentResult::PendingApproval {
        payout_id: U64(3),
        reason: reason::OVERDUE_NEEDS_APPROVAL.into(),
    })
    .unwrap();
    assert_eq!(v, serde_json::json!({ "PendingApproval": { "payout_id": "3", "reason": "OVERDUE_NEEDS_APPROVAL" } }));
}

#[test]
fn get_upcoming_handles_dense_old_schedules() {
    // A daily schedule started in 2000 that was never paid: next_due_at is in 2000, the window is in 2026.
    let y2000 = frequency::days_from_civil(2000, 1, 1) * DAY_MS + DEC1 % DAY_MS;
    let mut h = H::bare_at(DEC1);
    h.fund(FUND);
    let rid = h.add_recipient(evm_addr(0x10));
    h.add_key(PROCUREMENT, key_acc(), open_mandate());
    let never = h.add_schedule(schedule_input(rid, PROCUREMENT, AMOUNT, Frequency::EveryNDays { n: 1 }, y2000));
    let counted = h.add_schedule(ScheduleInput {
        end: ScheduleEnd::AfterCount { count: 100_000 },
        ..schedule_input(rid, PROCUREMENT, AMOUNT, Frequency::EveryNDays { n: 1 }, y2000)
    });
    // A new schedule never owes dates before its creation (ADR-0004 amendment): it starts at "now", not in 2000.
    assert_eq!(h.schedule(never).next_due_at, Some(U64(DEC1)));
    let items = h.view().get_upcoming(U64(DEC1), U64(DEC1 + 7 * DAY_MS), None, None);
    let dates = |sid: ScheduleId| items.iter().filter(|i| i.schedule_id == sid).map(|i| i.due_at.0).collect::<Vec<_>>();
    let want: Vec<u64> = (0..=7).map(|k| DEC1 + k * DAY_MS).collect();
    assert_eq!(dates(never), want, "Never-ending schedule jumps to the window");
    // AfterCount schedules are walked from next_due (to count the end); bounded walk: either correct dates or none,
    // but never a panic or out-of-window dates.
    let c = dates(counted);
    assert!(c.is_empty() || c == want, "{c:?}");
    assert!(items.iter().all(|i| !i.will_need_approval), "future dates below threshold");
}

#[test]
fn update_schedule_without_any_occurrence_is_refused() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, AMOUNT);
    expect_panic(|| h.edit_schedule(sid, |s| s.end = ScheduleEnd::On { at: U64(DEC1 - 1) }), "no payable date");
    assert_eq!(h.schedule(sid).status, ScheduleStatus::Active);
}

// =================================================================================================
// Security audit 2026-11-01 (docs/security/audit-2026-11-01.md): M1, M2, M3, pin_agent, L1
// =================================================================================================

#[test]
fn m2_reject_payout_needs_one_yocto_only_when_it_skips_a_scheduled_date() {
    let (mut h, sid) = H::sched_vault(DEC1, Frequency::EveryNDays { n: 7 }, DEC1, ScheduleEnd::Never, LARGE);
    // Scheduled + default skip → 1 yocto required; nothing changes on refusal.
    let (id, _) = h.pending_sched(sid);
    for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
        expect_panic(|| h.as_(&owner(), deposit).reject_payout(U64(id), None), "requires exactly 1 yoctoNEAR");
        expect_panic(|| h.as_(&owner(), deposit).reject_payout(U64(id), Some(true)), "requires exactly 1 yoctoNEAR");
    }
    assert_eq!(h.payout(id).status, PayoutStatus::PendingApproval);
    // Explicit no-skip works without a deposit (and with one).
    h.as_owner_no_deposit().reject_payout(U64(id), Some(false));
    assert_eq!((h.payout(id).status, h.schedule(sid).next_due_at), (PayoutStatus::Rejected, Some(U64(DEC1))));
    let (id, _) = h.pending_sched(sid);
    h.as_owner().reject_payout(U64(id), Some(false));
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1)));
    // Unapprovable payout (deadline passed): default resolves to no skip → no deposit needed.
    let r = Req { expires: Some(h.now + 1_000), ..h.fixed_req(sid) };
    let PromiseOrValue::Value(PaymentResult::PendingApproval { payout_id, .. }) = h.pay(&key_acc2(), &r) else {
        panic!("expected pending")
    };
    h.advance(1_000);
    h.as_owner_no_deposit().reject_payout(payout_id, None);
    assert_eq!(h.schedule(sid).next_due_at, Some(U64(DEC1)));
    // On-demand payouts have no date to skip: skip=true needs no deposit either.
    h.add_key(PROCUREMENT, key_acc(), open_mandate());
    let id = h.pending(&key_acc(), &Req { expires: Some(h.now + DAY_MS), ..Req::open(LARGE) });
    h.as_owner_no_deposit().reject_payout(U64(id), Some(true));
    assert_eq!(h.payout(id).status, PayoutStatus::Rejected);
}

#[test]
fn m2_terminal_owner_methods_need_one_yocto() {
    let (mut h, sids) = H::with_payroll(1);
    h.add_recipient(evm_addr(0x31));
    let checks: Vec<(&str, OwnerCall)> = vec![
        ("revoke_agent", Box::new(|c| c.revoke_agent(PROCUREMENT.into()))),
        ("unbind_agent", Box::new(|c| c.unbind_agent(PAYROLL.into()))),
        ("pin_agent", Box::new(|c| c.pin_agent(PAYROLL.into()))),
        ("end_schedule", Box::new(|c| c.end_schedule(0))),
        ("remove_recipient", Box::new(|c| c.remove_recipient(1))),
    ];
    for (name, call) in &checks {
        let c = h.as_owner_no_deposit();
        expect_panic(|| call(c), "Requires attached deposit of exactly 1 yoctoNEAR");
        assert_eq!(h.agent(PROCUREMENT).status, AgentStatus::Active, "{name}");
    }
    assert_eq!(h.agent(PAYROLL).account_id, Some(tee_acc()));
    assert!(!h.agent(PAYROLL).account_pinned);
    assert_eq!(h.schedule(sids[0]).status, ScheduleStatus::Active);
    assert!(h.view().get_recipient(1).is_some());
    // The kill switches stay deposit-free.
    h.as_owner_no_deposit().pause_schedule(sids[0]);
    h.as_owner_no_deposit().pause_agent(PAYROLL.into());
    h.as_owner_no_deposit().pause();
}

/// M1 setup: unpinned Open TEE slot `payroll`, A (`tee_acc`) and B (`tee_acc2`) trusted; A registered and created one
/// pending on-demand payout (to its own deposit address) and one pending scheduled payout. Returns (h, on-demand id,
/// scheduled id, schedule id).
fn m1_setup() -> (H, PayoutId, PayoutId, ScheduleId) {
    let mut h = H::new();
    let rid = h.add_recipient(evm_addr(0x10));
    h.add_tee(PAYROLL, None, open_mandate());
    h.trust_local(&tee_acc());
    h.trust_local(&tee_acc2());
    assert!(h.register(PAYROLL, &tee_acc()));
    let on_demand = h.pending(&tee_acc(), &Req { deposit: dep(0xaa), expires: Some(T0 + DAY_MS), ..Req::open(LARGE) });
    let sid = h.add_schedule(schedule_input(rid, PAYROLL, LARGE, every_period(), T0));
    let scheduled = h.pending(&tee_acc(), &h.fixed_req(sid));
    assert_eq!(h.agent(PAYROLL).open_approvals, 2);
    (h, on_demand, scheduled, sid)
}

fn assert_m1_cleared(h: &H, ids: [PayoutId; 2], sid: ScheduleId) {
    for id in ids {
        assert_eq!(h.payout(id).status, PayoutStatus::Rejected, "payout {id}");
    }
    assert_eq!(h.agent(PAYROLL).open_approvals, 0);
    assert!(h.view().get_pending_approvals().is_empty());
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.next_due_at, s.paid_count), (None, Some(U64(T0)), 0), "date stays payable");
}

#[test]
fn m1_unbind_rejects_open_approvals_of_the_old_account() {
    let (mut h, on_demand, scheduled, sid) = m1_setup();
    h.as_owner().unbind_agent(PAYROLL.into());
    assert_m1_cleared(&h, [on_demand, scheduled], sid);
    assert!(h.register(PAYROLL, &tee_acc2()));
    expect_panic(|| h.approve(on_demand), "Payout is not pending approval");
    assert_eq!((h.c.balance, h.c.in_flight), (FUND, 0));
    // B pays the schedule's date itself (fresh quote) — the date was not lost.
    let id = h.pending(&tee_acc2(), &h.fixed_req(sid));
    assert_eq!(h.payout(id).occurrence_at, Some(U64(T0)));
    assert_eq!(h.payout(id).agent_account, Some(tee_acc2()));
}

#[test]
fn m1_takeover_after_expiry_rejects_open_approvals() {
    let mut h = H::bare();
    h.fund(FUND);
    h.as_owner().update_attestation_expiration_time(U64(10 * DAY_MS));
    let rid = h.add_recipient(evm_addr(0x10));
    h.add_tee(PAYROLL, None, open_mandate());
    h.trust_local(&tee_acc());
    h.trust_local(&tee_acc2());
    assert!(h.register(PAYROLL, &tee_acc()));
    let on_demand =
        h.pending(&tee_acc(), &Req { deposit: dep(0xaa), expires: Some(T0 + 30 * DAY_MS), ..Req::open(LARGE) });
    let sid = h.add_schedule(schedule_input(rid, PAYROLL, LARGE, every_period(), T0));
    let scheduled = h.pending(&tee_acc(), &h.fixed_req(sid));
    // A's attestation expires; B takes the slot over.
    h.advance(10 * DAY_MS + 1);
    assert!(h.register(PAYROLL, &tee_acc2()));
    for id in [on_demand, scheduled] {
        assert_eq!(h.payout(id).status, PayoutStatus::Rejected);
    }
    assert_eq!(h.agent(PAYROLL).open_approvals, 0);
    let s = h.schedule(sid);
    assert_eq!((s.open_payout, s.next_due_at), (None, Some(U64(T0))));
    // Same-account refresh keeps approvals.
    let id = h.pending(&tee_acc2(), &Req { expires: Some(h.now + DAY_MS), ..Req::open(LARGE) });
    assert!(h.register(PAYROLL, &tee_acc2()));
    assert_eq!(h.payout(id).status, PayoutStatus::PendingApproval);
    h.approve(id);
    assert_eq!(h.payout(id).status, PayoutStatus::Transferring);
}

#[test]
fn m1_approve_refused_when_requester_no_longer_holds_slot() {
    let (mut h, on_demand, _, _) = m1_setup();
    // Inject: the slot's account differs from the payout's requester (any path that bypasses the rebind cleanup).
    h.payout_mut_for_test(on_demand).agent_account = Some(tee_acc2());
    let before = h.money();
    expect_panic(|| h.approve(on_demand), "no longer holds the agent slot");
    assert_eq!(h.money(), before);
    // No recorded requester at all → refused too.
    h.payout_mut_for_test(on_demand).agent_account = None;
    expect_panic(|| h.approve(on_demand), "no longer holds the agent slot");
    // Restored → approvable.
    h.payout_mut_for_test(on_demand).agent_account = Some(tee_acc());
    h.approve(on_demand);
    assert_eq!(h.payout(on_demand).status, PayoutStatus::Transferring);
}

impl H {
    fn payout_mut_for_test(&mut self, id: PayoutId) -> &mut Payout {
        self.sync_clock();
        self.c.payout_mut(id)
    }
}

#[test]
fn pin_agent_locks_slot_to_bound_account() {
    let mut h = H::new();
    h.add_tee(PAYROLL, None, open_mandate());
    h.trust_local(&tee_acc());
    h.trust_local(&tee_acc2());
    // Needs a bound account; TEE only; unknown agent.
    expect_panic(|| h.as_owner().pin_agent(PAYROLL.into()), "No account is bound to this slot yet");
    expect_panic(|| h.as_owner().pin_agent(PROCUREMENT.into()), "Only TEE agents can be pinned");
    expect_panic(|| h.as_owner().pin_agent("nope".into()), "Agent not found");
    assert!(h.register(PAYROLL, &tee_acc()));
    expect_panic(|| h.as_(&tee_acc(), ONE_YOCTO).pin_agent(PAYROLL.into()), "Caller is not the owner");
    h.as_owner().pin_agent(PAYROLL.into());
    let v = h.view().get_agent(PAYROLL.into()).unwrap();
    assert_eq!((v.account_id, v.account_pinned), (Some(tee_acc()), true));
    // Pinned: unbind refused; another account cannot register, even after the bound attestation expired.
    expect_panic(|| h.as_owner().unbind_agent(PAYROLL.into()), "Only unpinned TEE agents can be unbound");
    expect_panic(|| h.register(PAYROLL, &tee_acc2()), "pinned to another account");
    h.advance(ATTESTATION_TTL + 1);
    expect_panic(|| h.register(PAYROLL, &tee_acc2()), "pinned to another account");
    // The pinned account itself re-registers.
    assert!(h.register(PAYROLL, &tee_acc()));
    h.paid(&tee_acc(), &Req { expires: None, ..Req::open(AMOUNT) });
}

#[test]
fn unpinned_rebind_behaviour_unchanged_by_pin_feature() {
    let (mut h, _) = H::with_payroll(1);
    h.trust_local(&tee_acc2());
    assert!(!h.agent(PAYROLL).account_pinned);
    expect_panic(|| h.register(PAYROLL, &tee_acc2()), "Slot is bound to a live agent");
    h.as_owner().unbind_agent(PAYROLL.into());
    assert!(h.register(PAYROLL, &tee_acc2()));
    assert_eq!(h.agent(PAYROLL).account_id, Some(tee_acc2()));
}

#[test]
fn m3_local_mode_requires_explicit_opt_in() {
    for opt in [None, Some(false)] {
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        testing_env!(H::ctx_at(&vault(), NO_DEPOSIT, T0, Gas::from_tgas(300)).build());
        expect_panic(
            || Contract::new(owner(), token(), default_policy(), false, U64(ATTESTATION_TTL), None, opt),
            "requires_tee = false needs allow_insecure_local_mode = true",
        );
    }
    // Explicit opt-in works; TEE mode needs no flag (and ignores it).
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    testing_env!(H::ctx_at(&vault(), NO_DEPOSIT, T0, Gas::from_tgas(300)).build());
    let c = Contract::new(owner(), token(), default_policy(), false, U64(ATTESTATION_TTL), None, Some(true));
    assert!(!c.requires_tee);
    for opt in [None, Some(false), Some(true)] {
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        testing_env!(H::ctx_at(&vault(), NO_DEPOSIT, T0, Gas::from_tgas(300)).build());
        let c = Contract::new(owner(), token(), default_policy(), true, U64(ATTESTATION_TTL), None, opt);
        assert!(c.requires_tee);
    }
}

#[test]
fn l1_sync_surplus_does_not_double_count_in_flight_deposit() {
    let mut h = H::new();
    let d = 500 * USDC;
    drop(h.as_owner().sync_surplus());
    let epoch = h.c.outflow_epoch;
    // Token already moved D to the vault; ft_on_transfer has not run yet.
    let actual = FUND + d;
    h.as_callback(balance_result(actual)).on_sync_surplus(U64(epoch));
    h.fund(d);
    assert!(h.c.balance + h.c.in_flight <= actual, "balance {} > actual {actual}", h.c.balance + h.c.in_flight);
    // Confirming read 60 s later still credits nothing extra.
    h.advance(SURPLUS_CONFIRM_MS);
    assert_eq!(h.surplus_cb(actual), 0);
    assert!(h.c.balance + h.c.in_flight <= actual);
}
