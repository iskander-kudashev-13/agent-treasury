//! Money paths: `request_payment` (the only way an agent moves money), transfer callbacks, status reports, deposits.
//!
//! NEAR specifics worth knowing when reading this file:
//! - A cross-contract call does not execute in this transaction. `Promise::new(token).function_call(..)` schedules a
//!   receipt that runs later on the token contract, then `.then(callback)` runs back here. Between those steps other
//!   transactions can call the vault, so every check happens up front and funds are **reserved before** the promise
//!   is created: a second request sees the reservation.
//! - Several `function_call`s on the same `Promise::new(receiver)` form one *batch* receipt whose actions are atomic:
//!   if `ft_transfer` fails, the preceding `storage_deposit` is rolled back and its NEAR refunded to the vault.
//! - Callbacks never panic: a panicking callback would leave the reservation stuck.
//! - Policy rejections do not panic either: they return `PaymentResult::Rejected` so agents get a machine-readable
//!   reason (ADR-0003 §2). Only malformed calls (bad JSON, too little gas) panic.

use crate::*;
use near_sdk::PromiseError;

/// What an agent asks for. Internal.
pub(crate) struct PaymentRequest<'a> {
    pub chain: &'a str,
    pub address: &'a str,
    pub amount: u128,
    pub memo: Option<&'a str>,
    pub schedule_id: Option<ScheduleId>,
    pub deposit_address: &'a str,
}

pub(crate) type Rejected = (&'static str, String);

/// Outcome of a successful evaluation.
pub(crate) struct Approved {
    /// `Some(reason)` if the payment must wait for the owner.
    pub needs_approval: Option<&'static str>,
    pub recipient_id: Option<RecipientId>,
    pub occurrence_at: Option<u64>,
}

#[near]
impl Contract {
    /// The way an agent moves money (AGENT_ACCESS §3.4, ADR-0003, ADR-0004 §3).
    ///
    /// - On demand: `schedule_id = null`; `chain`/`address`/`amount` chosen by the agent within its mandate.
    /// - Scheduled: `schedule_id` of a schedule assigned to the caller's agent; `chain`/`address`/`amount` must equal it.
    ///
    /// `deposit_address` is the 1Click ORIGIN_CHAIN deposit account (64-hex implicit account) from a fresh
    /// `POST /v0/quote` (`dry: false`) whose recipient is `address` on `chain`. `deposit_expires_at_ms` is that quote's
    /// deadline (required if the payment needs approval). Attach 100–150 TGas, no deposit.
    ///
    /// Returns `Rejected{reason,detail}` (transaction still succeeds), `PendingApproval{payout_id,reason}`, or — after
    /// the transfer callback — `Submitted{payout_id}` / `TransferFailed{payout_id}`.
    #[allow(clippy::too_many_arguments)]
    pub fn request_payment(
        &mut self,
        chain: String,
        address: String,
        amount: U128,
        memo: Option<String>,
        schedule_id: Option<ScheduleId>,
        deposit_address: String,
        deposit_expires_at_ms: Option<U64>,
    ) -> PromiseOrValue<PaymentResult> {
        require!(env::prepaid_gas() >= MIN_GAS_PAYMENT, "Attach at least 100 TGas");
        let caller = env::predecessor_account_id();
        let now = block_timestamp_ms();
        // No `roll_day()` here: evaluation uses virtual rollover, so rejections change no counters.

        let agent_id = self.agent_by_account.get(&caller).cloned();
        let req = PaymentRequest {
            chain: &chain,
            address: &address,
            amount: amount.0,
            memo: memo.as_deref(),
            schedule_id,
            deposit_address: &deposit_address,
        };
        let agent = agent_id.as_ref().and_then(|id| self.agents.get(id));
        let ok = match self.evaluate_payment(agent, &req, None) {
            Ok(ok) => ok,
            Err((code, detail)) => {
                return PromiseOrValue::Value(self.reject(agent_id.as_ref(), &req, code, detail, now));
            }
        };
        // evaluate_payment returned Ok, so the agent exists.
        let agent_id = agent_id.unwrap_or_else(|| env::panic_str("unreachable"));
        let open_approvals = {
            let a = self.agent_mut(&agent_id);
            a.last_request_at_ms = Some(now);
            a.open_approvals
        };
        let deposit =
            deposit_address.parse::<AccountId>().unwrap_or_else(|_| env::panic_str("unreachable: deposit validated"));

        if let Some(approval_reason) = ok.needs_approval {
            if deposit_expires_at_ms.is_none() {
                let detail =
                    "Payments that need owner approval must include deposit_expires_at_ms (the 1Click quote deadline)."
                        .to_string();
                return PromiseOrValue::Value(self.reject(Some(&agent_id), &req, reason::INVALID_REQUEST, detail, now));
            }
            if open_approvals >= MAX_OPEN_APPROVALS_PER_AGENT {
                let detail = format!(
                    "Agent '{agent_id}' already has {open_approvals} payments waiting for owner approval (max {MAX_OPEN_APPROVALS_PER_AGENT})."
                );
                return PromiseOrValue::Value(self.reject(
                    Some(&agent_id),
                    &req,
                    reason::TOO_MANY_PENDING_APPROVALS,
                    detail,
                    now,
                ));
            }
            let id = self.push_payout(&agent_id, &caller, &req, &ok, deposit, deposit_expires_at_ms, now);
            {
                let p = self.payout_mut(id);
                p.approval_reason = Some(approval_reason.to_string());
            }
            self.approvals.insert(id);
            self.agent_mut(&agent_id).open_approvals += 1;
            if let Some(sid) = schedule_id {
                if let Some(s) = self.schedules.get_mut(&sid) {
                    s.open_payout = Some(U64(id));
                }
            }
            Event::PayoutPendingApproval { payout_id: U64(id), agent_id: &agent_id, amount, reason: approval_reason }
                .emit();
            return PromiseOrValue::Value(PaymentResult::PendingApproval {
                payout_id: U64(id),
                reason: approval_reason.to_string(),
            });
        }

        let id = self.push_payout(&agent_id, &caller, &req, &ok, deposit, deposit_expires_at_ms, now);
        PromiseOrValue::Promise(self.reserve_and_transfer(id))
    }

    /// Scheduled-payment wrapper for the payroll worker: fills chain/address/amount from the schedule.
    pub fn request_payout(
        &mut self,
        schedule_id: ScheduleId,
        deposit_address: String,
        deposit_expires_at_ms: Option<U64>,
    ) -> PromiseOrValue<PaymentResult> {
        let (chain, address, amount) = self
            .schedules
            .get(&schedule_id)
            .and_then(|s| self.recipients.get(&s.recipient_id).map(|r| (r, s.amount)))
            .map(|(r, amount)| (r.destination_chain.clone(), r.destination_address.clone(), amount))
            // Unknown schedule: still evaluated, so the agent gets SCHEDULE_NOT_FOUND (after the agent checks).
            .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string(), U128(1)));
        self.request_payment(chain, address, amount, None, Some(schedule_id), deposit_address, deposit_expires_at_ms)
    }

    /// Callback of the payment transfer. Its return value is the final result of `request_payment`.
    #[private]
    pub fn on_transfer_result(&mut self, payout_id: U64) -> PaymentResult {
        // Only an explicit failure is a failure: `TooLong` means the call succeeded with a large return value.
        let success = !matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed));
        self.settle_transfer(payout_id, success);
        // Report the payout's actual state (it may have been settled manually before this late callback).
        let sent = self.payout_ref(payout_id.0).is_some_and(|p| p.funds_left);
        if sent { PaymentResult::Submitted { payout_id } } else { PaymentResult::TransferFailed { payout_id } }
    }

    #[private]
    pub fn on_withdraw_result(&mut self, amount: U128, receiver_id: AccountId) -> bool {
        let success = !matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed));
        self.in_flight = self.in_flight.saturating_sub(amount.0);
        if success {
            self.outflow_epoch = self.outflow_epoch.wrapping_add(1);
        } else {
            self.balance = self.balance.saturating_add(amount.0);
        }
        Event::Withdraw { receiver_id: &receiver_id, amount, success }.emit();
        success
    }

    /// Callback of `credit_refund`. Credits only tokens confirmed as untracked by two balance reads >= 60 s apart
    /// (see `confirm_surplus`), so a deposit still on its way to `ft_on_transfer` is never counted twice.
    #[private]
    pub fn on_refund_balance(&mut self, payout_id: U64, amount: U128, outflow_epoch: U64) -> bool {
        let Some(actual) = read_u128_result() else {
            log!("credit_refund: could not read token balance");
            return false;
        };
        let Some(idx) = u32::try_from(payout_id.0).ok() else { return false };
        let Some(p) = self.payouts.get(idx) else { return false };
        if p.refund_credited || !p.funds_left || amount.0 > p.amount.0 {
            return false;
        }
        let Some(verified) = self.confirm_surplus(actual, outflow_epoch.0) else {
            return false;
        };
        if verified < amount.0 {
            log!("credit_refund: refund not received yet (untracked tokens {verified} < {})", amount.0);
            self.surplus_probe = None;
            return false;
        }
        if let Some(p) = self.payouts.get_mut(idx) {
            p.refund_credited = true;
            p.updated_at_ms = U64(block_timestamp_ms());
        }
        self.surplus_probe = None;
        self.balance = self.balance.saturating_add(amount.0);
        Event::RefundCredited { payout_id, amount }.emit();
        true
    }

    /// Callback of `sync_surplus`: credit tokens the vault holds beyond `balance + in_flight`, confirmed by two reads.
    #[private]
    pub fn on_sync_surplus(&mut self, outflow_epoch: U64) -> U128 {
        let Some(actual) = read_u128_result() else {
            log!("sync_surplus: could not read token balance");
            return U128(0);
        };
        let Some(verified) = self.confirm_surplus(actual, outflow_epoch.0) else {
            return U128(0);
        };
        self.surplus_probe = None;
        if verified > 0 {
            self.balance = self.balance.saturating_add(verified);
            Event::SurplusCredited { amount: U128(verified) }.emit();
        }
        U128(verified)
    }

    /// The agent that created a payout (its current account) or the owner reports the final 1Click status.
    /// Annotation only: it never moves money. `Sent` → `Confirmed` | `Refunded` | `Failed`; same status again = no-op.
    pub fn report_payout_status(&mut self, payout_id: U64, status: PayoutStatus, tx_hash: Option<String>) {
        let caller = env::predecessor_account_id();
        let creator =
            self.payout_ref(payout_id.0).unwrap_or_else(|| env::panic_str("Payout not found")).agent_id.clone();
        let is_creator = self
            .agents
            .get(&creator)
            .is_some_and(|a| a.status != AgentStatus::Revoked && a.account_id.as_ref() == Some(&caller));
        require!(caller == self.owner_id || is_creator, "Only the agent that created the payout or the owner");
        require!(
            matches!(status, PayoutStatus::Confirmed | PayoutStatus::Refunded | PayoutStatus::Failed),
            "Status must be Confirmed, Refunded or Failed"
        );
        if let Some(h) = &tx_hash {
            require!(h.len() <= MAX_TX_HASH_LEN, "tx_hash too long");
        }
        let now = U64(block_timestamp_ms());
        let p = self.payout_mut(payout_id.0);
        if p.status == status {
            return;
        }
        require!(p.status == PayoutStatus::Sent, "Payout is not in Sent state");
        p.status = status;
        if tx_hash.is_some() {
            p.tx_hash = tx_hash.clone();
        }
        p.updated_at_ms = now;
        Event::PayoutStatusReported { payout_id, status, tx_hash: tx_hash.as_deref() }.emit();
    }

    /// NEP-141 receiver: fund the treasury with `ft_transfer_call(receiver_id = vault, msg = "")`.
    /// Only the treasury token is accepted (anything else panics → the token contract refunds the sender).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        require!(env::predecessor_account_id() == self.treasury_token, "Only the treasury token is accepted");
        self.balance = self.balance.checked_add(amount.0).unwrap_or_else(|| env::panic_str("Overflow"));
        Event::Deposit { sender_id: &sender_id, amount }.emit();
        PromiseOrValue::Value(U128(0))
    }
}

impl Contract {
    /// Checks in the documented order (AGENT_ACCESS §3.4 + ADR-0003 §3 + ADR-0004 §3); first failure wins. Pure: no
    /// state change. `existing` = the payout being approved (its own open slot does not count as "in progress", it is
    /// not counted twice against the daily count, and an overdue approval does not re-trigger approval).
    pub(crate) fn evaluate_payment(
        &self,
        agent: Option<&Agent>,
        req: &PaymentRequest,
        existing: Option<PayoutId>,
    ) -> Result<Approved, Rejected> {
        let now = block_timestamp_ms();
        let amount = req.amount;
        // 1
        if self.paused {
            return Err((reason::VAULT_PAUSED, "The vault is paused by its owner; no payments are possible.".into()));
        }
        // 2
        let Some(a) = agent else {
            return Err((reason::AGENT_NOT_FOUND, "The calling account is not an agent of this vault.".into()));
        };
        match a.status {
            AgentStatus::Revoked => {
                return Err((reason::AGENT_REVOKED, format!("Agent '{}' has been revoked by the owner.", a.id)));
            }
            AgentStatus::Paused => {
                return Err((reason::AGENT_PAUSED, format!("Agent '{}' is paused by the owner.", a.id)));
            }
            AgentStatus::Active => {}
        }
        let tee_reasons = self.agent_tee_reasons(a);
        if !tee_reasons.is_empty() {
            return Err((
                reason::ATTESTATION_INVALID,
                format!("TEE agent '{}' has no valid attestation ({:?}); it must re-register.", a.id, tee_reasons),
            ));
        }
        // 3
        if let Some(exp) = a.mandate.expires_at {
            if now > exp.0 {
                return Err((reason::AGENT_EXPIRED, format!("The mandate of agent '{}' expired.", a.id)));
            }
        }
        if a.failed_transfers >= MAX_FAILED_ATTEMPTS {
            return Err((
                reason::TOO_MANY_FAILED_TRANSFERS,
                format!(
                    "Agent '{}' had {} failed transfers in a row; the owner must reset it.",
                    a.id, a.failed_transfers
                ),
            ));
        }
        if amount == 0
            || req.chain.is_empty()
            || req.chain.len() > MAX_CHAIN_LEN
            || req.address.is_empty()
            || req.address.len() > MAX_ADDRESS_LEN
            || req.memo.is_some_and(|m| m.len() > MAX_MEMO_LEN)
        {
            return Err((
                reason::INVALID_REQUEST,
                "Amount must be positive; chain ≤ 16 chars, address ≤ 128 chars, memo ≤ 140 bytes.".into(),
            ));
        }
        if !self.is_valid_deposit_address(req.deposit_address) {
            return Err((
                reason::INVALID_DEPOSIT_ADDRESS,
                "deposit_address must be the 64-hex NEAR deposit account from a fresh 1Click quote.".into(),
            ));
        }
        // Scheduled requests: an unknown schedule or a removed recipient is reported as such (not as a chain error).
        if let Some(sid) = req.schedule_id {
            let Some(s) = self.schedules.get(&sid) else {
                return Err((reason::SCHEDULE_NOT_FOUND, format!("Schedule {sid} does not exist.")));
            };
            if !self.recipients.contains_key(&s.recipient_id) {
                return Err((
                    reason::RECIPIENT_NOT_ALLOWED,
                    format!("The recipient of schedule {sid} was removed from the address book."),
                ));
            }
        }
        // 4
        if !a.mandate.allowed_chains.iter().any(|c| c == req.chain) {
            return Err((
                reason::CHAIN_NOT_ALLOWED,
                format!("Agent '{}' may pay on {:?}; '{}' is not allowed.", a.id, a.mandate.allowed_chains, req.chain),
            ));
        }
        // 5–7
        let mut out = Approved { needs_approval: None, recipient_id: None, occurrence_at: None };
        match req.schedule_id {
            Some(sid) => {
                let Some(s) = self.schedules.get(&sid) else {
                    return Err((reason::SCHEDULE_NOT_FOUND, format!("Schedule {sid} does not exist.")));
                };
                if s.status != ScheduleStatus::Active {
                    return Err((
                        reason::SCHEDULE_NOT_ACTIVE,
                        format!("Schedule {sid} is {:?}; it cannot be paid.", s.status),
                    ));
                }
                let r = self.recipients.get(&s.recipient_id);
                let matches = s.agent_id == a.id
                    && r.is_some_and(|r| {
                        r.destination_chain == req.chain && same_address(&r.destination_address, req.address)
                    });
                if !matches {
                    return Err((
                        reason::RECIPIENT_NOT_ALLOWED,
                        format!("Schedule {sid} is not assigned to agent '{}' or its destination differs.", a.id),
                    ));
                }
                let r = r.unwrap_or_else(|| env::panic_str("unreachable"));
                if !self.mandate_allows_recipient(&a.mandate, s.recipient_id, r) {
                    return Err((
                        reason::RECIPIENT_NOT_ALLOWED,
                        format!("The mandate of agent '{}' no longer allows recipient '{}'.", a.id, r.label),
                    ));
                }
                // 6
                if amount != s.amount.0 {
                    return Err((
                        reason::AMOUNT_MISMATCH,
                        format!(
                            "Schedule {sid} pays exactly {} USDC; requested {}.",
                            fmt_amount(s.amount.0),
                            fmt_amount(amount)
                        ),
                    ));
                }
                // 7
                let Some(due) = s.next_due_at else {
                    return Err((reason::SCHEDULE_NOT_ACTIVE, format!("Schedule {sid} has nothing left to pay.")));
                };
                if now < due.0 {
                    return Err((
                        reason::NOT_DUE,
                        format!("Schedule {sid} is not due yet (next payment at {} ms).", due.0),
                    ));
                }
                if s.failed_attempts >= MAX_FAILED_ATTEMPTS {
                    return Err((
                        reason::TOO_MANY_FAILED_TRANSFERS,
                        format!(
                            "Payments of schedule {sid} failed {} times in a row; the owner must reset it.",
                            s.failed_attempts
                        ),
                    ));
                }
                if let Some(open) = s.open_payout {
                    if Some(open.0) != existing {
                        return Err((
                            reason::PAYOUT_IN_PROGRESS,
                            format!("A payment of schedule {sid} is already pending or in flight (payout {}).", open.0),
                        ));
                    }
                }
                if let Some(pid) = existing {
                    // Approving: the pending payout must still be this schedule's open payout for this very date.
                    let same_date = self.payout_ref(pid).and_then(|p| p.occurrence_at) == Some(due);
                    if s.open_payout != Some(U64(pid)) || !same_date {
                        return Err((
                            reason::SCHEDULE_NOT_ACTIVE,
                            format!("Schedule {sid} changed since this payment was requested; reject it."),
                        ));
                    }
                }
                out.recipient_id = Some(s.recipient_id);
                out.occurrence_at = Some(due.0);
                if existing.is_none() && now > due.0.saturating_add(self.policy.overdue_grace_ms.0) {
                    out.needs_approval = Some(reason::OVERDUE_NEEDS_APPROVAL);
                }
            }
            None => match a.mandate.recipients_mode {
                RecipientsMode::Fixed => {
                    return Err((
                        reason::RECIPIENT_NOT_ALLOWED,
                        format!("Agent '{}' has a Fixed mandate: it only pays its scheduled payments.", a.id),
                    ));
                }
                RecipientsMode::Allowlist => {
                    let ok = a
                        .mandate
                        .allowlist
                        .iter()
                        .any(|d| d.chain == req.chain && same_address(&d.address, req.address));
                    if !ok {
                        return Err((
                            reason::RECIPIENT_NOT_ALLOWED,
                            format!("{} on {} is not in the allowlist of agent '{}'.", req.address, req.chain, a.id),
                        ));
                    }
                }
                RecipientsMode::Open => {}
            },
        }
        if amount < self.policy.min_payment.0 {
            return Err((
                reason::BELOW_MIN_PAYMENT,
                format!(
                    "The smallest payment this vault allows is {} USDC; requested {}.",
                    fmt_amount(self.policy.min_payment.0),
                    fmt_amount(amount)
                ),
            ));
        }
        // 8
        if amount > a.mandate.per_tx_limit.0 {
            return Err((
                reason::PER_TX_LIMIT_EXCEEDED,
                format!(
                    "Per-payment limit for agent '{}' is {} USDC; requested {}.",
                    a.id,
                    fmt_amount(a.mandate.per_tx_limit.0),
                    fmt_amount(amount)
                ),
            ));
        }
        // 9
        let agent_spent = a.spent_today();
        if agent_spent.saturating_add(amount) > a.mandate.daily_limit.0 {
            return Err((
                reason::AGENT_DAILY_LIMIT_EXCEEDED,
                format!(
                    "Daily limit for agent '{}' is {} USDC; {} already spent today; requested {}.",
                    a.id,
                    fmt_amount(a.mandate.daily_limit.0),
                    fmt_amount(agent_spent),
                    fmt_amount(amount)
                ),
            ));
        }
        // The payout being approved was already counted when it became pending.
        let count = a.payments_today();
        if existing.is_none() && count >= a.mandate.max_payments_per_day {
            return Err((
                reason::AGENT_DAILY_COUNT_EXCEEDED,
                format!(
                    "Agent '{}' may make {} payments per day and has made {} today.",
                    a.id, a.mandate.max_payments_per_day, count
                ),
            ));
        }
        // 10
        let vault_spent = self.vault_spent_today();
        if vault_spent.saturating_add(amount) > self.policy.daily_limit.0 {
            return Err((
                reason::VAULT_DAILY_LIMIT_EXCEEDED,
                format!(
                    "The vault-wide daily limit is {} USDC; {} already spent today by all agents; requested {}.",
                    fmt_amount(self.policy.daily_limit.0),
                    fmt_amount(vault_spent),
                    fmt_amount(amount)
                ),
            ));
        }
        // 11
        if amount > self.balance {
            return Err((
                reason::INSUFFICIENT_BALANCE,
                format!(
                    "The vault holds {} USDC available; requested {}.",
                    fmt_amount(self.balance),
                    fmt_amount(amount)
                ),
            ));
        }
        // 12 (decision only; the caller enforces deposit deadline / pending cap)
        if existing.is_none() && out.needs_approval.is_none() && amount > a.mandate.approval_threshold.0 {
            out.needs_approval = Some(reason::ABOVE_THRESHOLD);
        }
        Ok(out)
    }

    /// Deposit address must look like a 1Click NEAR deposit account and must not be a party we know.
    pub(crate) fn is_valid_deposit_address(&self, s: &str) -> bool {
        if !is_implicit_account(s) {
            return false;
        }
        let Ok(acc) = s.parse::<AccountId>() else { return false };
        acc != self.treasury_token
            && acc != env::current_account_id()
            && acc != self.owner_id
            && !self.agent_by_account.contains_key(&acc)
    }

    /// Log a rejection (known, non-revoked agents; capped per agent per day) and build the result.
    fn reject(
        &mut self,
        agent_id: Option<&AgentId>,
        req: &PaymentRequest,
        code: &'static str,
        detail: String,
        now: u64,
    ) -> PaymentResult {
        let log_it = match agent_id.and_then(|id| self.agents.get_mut(id)) {
            Some(a) => {
                a.last_request_at_ms = Some(now);
                a.roll_day();
                // Revoked agents and noisy agents do not get to rewrite the shared audit log.
                let ok = a.status != AgentStatus::Revoked
                    && a.rejections_logged_today < MAX_LOGGED_REJECTIONS_PER_AGENT_PER_DAY;
                if ok {
                    a.rejections_logged_today += 1;
                }
                ok
            }
            None => false,
        };
        if let (Some(id), true) = (agent_id, log_it) {
            let entry = Rejection {
                agent_id: id.clone(),
                at: U64(now),
                reason: code.to_string(),
                detail: detail.clone(),
                chain: truncate(req.chain, MAX_CHAIN_LEN),
                address: truncate(req.address, MAX_ADDRESS_LEN),
                amount: U128(req.amount),
            };
            if self.rejections.len() < REJECTIONS_CAP {
                self.rejections.push(entry);
            } else {
                let head = self.rejections_head;
                self.rejections.set(head, entry);
                self.rejections_head = (head + 1) % REJECTIONS_CAP;
            }
            Event::PaymentRejected { agent_id: id, reason: code }.emit();
        }
        PaymentResult::Rejected { reason: code.to_string(), detail }
    }

    #[allow(clippy::too_many_arguments)]
    fn push_payout(
        &mut self,
        agent_id: &AgentId,
        caller: &AccountId,
        req: &PaymentRequest,
        ok: &Approved,
        deposit: AccountId,
        deposit_expires_at_ms: Option<U64>,
        now: u64,
    ) -> PayoutId {
        let id = self.payouts.len() as PayoutId;
        {
            let a = self.agent_mut(agent_id);
            a.roll_day();
            a.payments_today = a.payments_today.saturating_add(1);
        }
        if !self.agent_payouts.contains_key(agent_id) {
            let prefix = StorageKey::AgentPayouts { agent_hash: env::sha256(agent_id.as_bytes()) };
            self.agent_payouts.insert(agent_id.clone(), Vector::new(prefix));
        }
        if let Some(list) = self.agent_payouts.get_mut(agent_id) {
            list.push(id);
        }
        self.payouts.push(Payout {
            id: U64(id),
            agent_id: agent_id.clone(),
            agent_account: Some(caller.clone()),
            schedule_id: req.schedule_id,
            recipient_id: ok.recipient_id,
            occurrence_at: ok.occurrence_at.map(U64),
            chain: req.chain.to_string(),
            address: req.address.to_string(),
            amount: U128(req.amount),
            memo: req.memo.map(str::to_string),
            status: PayoutStatus::PendingApproval,
            approval_reason: None,
            deposit_address: Some(deposit),
            deposit_expires_at_ms,
            tx_hash: None,
            created_at_ms: U64(now),
            updated_at_ms: U64(now),
            reserved_day: None,
            prev_schedule: None,
            prev_recipient_last_paid_at_ms: None,
            funds_left: false,
            refund_credited: false,
        });
        id
    }

    /// Reserve (vault + agent daily counters, balance, schedule occurrence) and create the transfer promise.
    /// Callers must have run `evaluate_payment` in the same receipt.
    pub(crate) fn reserve_and_transfer(&mut self, payout_id: PayoutId) -> Promise {
        let now = block_timestamp_ms();
        self.roll_day();
        let day = self.day_index;
        let (agent_id, amount, schedule_id, recipient_id, deposit) = {
            let p = self.payout_ref(payout_id).unwrap_or_else(|| env::panic_str("Payout not found"));
            (
                p.agent_id.clone(),
                p.amount.0,
                p.schedule_id,
                p.recipient_id,
                p.deposit_address.clone().unwrap_or_else(|| env::panic_str("No deposit address")),
            )
        };
        self.balance = self.balance.checked_sub(amount).unwrap_or_else(|| env::panic_str("Insufficient balance"));
        self.in_flight = self.in_flight.checked_add(amount).unwrap_or_else(|| env::panic_str("Overflow"));
        self.spent_today = self.spent_today.checked_add(amount).unwrap_or_else(|| env::panic_str("Overflow"));
        {
            let a = self.agent_mut(&agent_id);
            a.roll_day();
            a.spent_today = a.spent_today.checked_add(amount).unwrap_or_else(|| env::panic_str("Overflow"));
        }
        let prev_schedule = schedule_id.and_then(|sid| self.schedules.get_mut(&sid)).map(|s| {
            let snap = ScheduleSnapshot {
                next_due_at: s.next_due_at,
                last_paid_at: s.last_paid_at,
                last_occurrence_paid: s.last_occurrence_paid,
                last_occurrence_handled: s.last_occurrence_handled,
                paid_count: s.paid_count,
                status: s.status,
            };
            // Pay the occurrence `next_due_at`, then move to the next one (or end).
            let occ = s.next_due_at.map(|d| d.0).unwrap_or(now);
            s.paid_count = s.paid_count.saturating_add(1);
            s.last_paid_at = Some(U64(now));
            s.last_occurrence_paid = Some(U64(occ));
            s.last_occurrence_handled = Some(U64(occ));
            s.next_due_at = next_payable(s, occ);
            if s.next_due_at.is_none() {
                s.status = ScheduleStatus::Ended;
            }
            s.open_payout = Some(U64(payout_id));
            snap
        });
        let prev_recipient_last_paid = recipient_id.and_then(|rid| self.recipients.get_mut(&rid)).map(|r| {
            let prev = r.last_paid_at_ms;
            r.last_paid_at_ms = Some(U64(now));
            prev
        });
        {
            let p = self.payout_mut(payout_id);
            p.status = PayoutStatus::Transferring;
            p.reserved_day = Some(U64(day));
            p.prev_schedule = prev_schedule;
            p.prev_recipient_last_paid_at_ms = prev_recipient_last_paid.flatten();
            p.updated_at_ms = U64(now);
        }
        Event::PayoutTransferring {
            payout_id: U64(payout_id),
            agent_id: &agent_id,
            amount: U128(amount),
            deposit_address: &deposit,
        }
        .emit();

        Promise::new(self.treasury_token.clone())
            // The 1Click deposit account is fresh and not registered on the token contract; NEP-141 `ft_transfer` to an
            // unregistered account panics. `registration_only: true` refunds the deposit if it is already registered.
            .function_call(
                "storage_deposit".to_string(),
                serde_json::to_vec(&serde_json::json!({ "account_id": deposit, "registration_only": true }))
                    .unwrap_or_default(),
                NearToken::from_yoctonear(self.storage_deposit_yocto),
                GAS_STORAGE_DEPOSIT,
            )
            // 1 yoctoNEAR is required by NEP-141. No `msg` / ft_transfer_call: 1Click watches for a plain transfer.
            .function_call(
                "ft_transfer".to_string(),
                serde_json::to_vec(&serde_json::json!({
                    "receiver_id": deposit,
                    "amount": U128(amount),
                    "memo": format!("agent-treasury payout {payout_id}"),
                }))
                .unwrap_or_default(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_transfer_result(U64(payout_id)))
    }

    /// Shared by the transfer callback and the owner's `force_settle_transfer`. Never panics.
    pub(crate) fn settle_transfer(&mut self, payout_id: U64, success: bool) -> bool {
        let now = block_timestamp_ms();
        let today = now / DAY_MS;
        let Some(idx) = u32::try_from(payout_id.0).ok() else { return false };
        let Some(p) = self.payouts.get_mut(idx) else { return false };
        if p.status != PayoutStatus::Transferring {
            log!("settle_transfer: payout {} not transferring, ignored", payout_id.0);
            return false;
        }
        let amount = p.amount.0;
        let schedule_id = p.schedule_id;
        let recipient_id = p.recipient_id;
        let agent_id = p.agent_id.clone();
        let reserved_day = p.reserved_day.map(|d| d.0);
        let prev_schedule = p.prev_schedule.clone();
        let prev_recipient_last_paid = p.prev_recipient_last_paid_at_ms;
        p.updated_at_ms = U64(now);
        if success {
            p.status = PayoutStatus::Sent;
            p.funds_left = true;
        } else {
            p.status = PayoutStatus::Failed;
        }

        self.in_flight = self.in_flight.saturating_sub(amount);
        if success {
            self.outflow_epoch = self.outflow_epoch.wrapping_add(1);
        } else {
            self.balance = self.balance.saturating_add(amount);
            if reserved_day == Some(self.day_index) && self.day_index == today {
                self.spent_today = self.spent_today.saturating_sub(amount);
            }
        }
        if let Some(a) = self.agents.get_mut(&agent_id) {
            if success {
                a.failed_transfers = 0;
            } else {
                a.failed_transfers = a.failed_transfers.saturating_add(1);
                if reserved_day == Some(a.day_index) && a.day_index == today {
                    a.spent_today = a.spent_today.saturating_sub(amount);
                }
            }
        }
        // Nested `if` instead of a let-chain: the wasm is built with rustc 1.86 (nearcore VM limit).
        if let Some(sid) = schedule_id {
            if let Some(s) = self.schedules.get_mut(&sid) {
                if s.open_payout == Some(payout_id) {
                    s.open_payout = None;
                    if success {
                        s.failed_attempts = 0;
                    } else {
                        if let Some(prev) = &prev_schedule {
                            s.next_due_at = prev.next_due_at;
                            s.last_paid_at = prev.last_paid_at;
                            s.last_occurrence_paid = prev.last_occurrence_paid;
                            s.last_occurrence_handled = prev.last_occurrence_handled;
                            s.paid_count = prev.paid_count;
                            // Only undo an automatic end; keep an owner's pause/end made meanwhile.
                            if s.status == ScheduleStatus::Ended && prev.status == ScheduleStatus::Active {
                                s.status = ScheduleStatus::Active;
                            }
                        }
                        s.failed_attempts = s.failed_attempts.saturating_add(1);
                    }
                }
            }
        }
        if !success {
            if let Some(rid) = recipient_id {
                if let Some(r) = self.recipients.get_mut(&rid) {
                    r.last_paid_at_ms = prev_recipient_last_paid;
                }
            }
        }
        if success {
            Event::PayoutSent { payout_id }.emit();
        } else {
            Event::PayoutTransferFailed { payout_id }.emit();
        }
        success
    }

    /// Reject a `PendingApproval` payout (owner reject, agent revoke, schedule change). `skip_occurrence`: a scheduled
    /// payment's due date counts as handled (the schedule moves on to its next date without paying this one).
    pub(crate) fn reject_pending(&mut self, payout_id: PayoutId, skip_occurrence: bool) {
        let now = block_timestamp_ms();
        let (agent_id, schedule_id) = {
            let p = self.payout_mut(payout_id);
            require!(p.status == PayoutStatus::PendingApproval, "Payout is not pending approval");
            p.status = PayoutStatus::Rejected;
            p.updated_at_ms = U64(now);
            (p.agent_id.clone(), p.schedule_id)
        };
        self.approvals.remove(&payout_id);
        if let Some(a) = self.agents.get_mut(&agent_id) {
            a.open_approvals = a.open_approvals.saturating_sub(1);
        }
        if let Some(sid) = schedule_id {
            if let Some(s) = self.schedules.get_mut(&sid) {
                if s.open_payout == Some(U64(payout_id)) {
                    s.open_payout = None;
                    if skip_occurrence {
                        if let Some(due) = s.next_due_at {
                            s.last_occurrence_handled = Some(due);
                            s.next_due_at = next_payable(s, due.0);
                            if s.next_due_at.is_none() {
                                s.status = ScheduleStatus::Ended;
                            }
                        }
                        let snap = s.clone();
                        Event::ScheduleUpserted { schedule_id: sid, schedule: &snap }.emit();
                    }
                }
            }
        }
        Event::PayoutRejected { payout_id: U64(payout_id) }.emit();
    }

    /// Mandate rule for a schedule's recipient (ADR-0004 §4): chain allowed, and Fixed → listed recipient,
    /// Allowlist → destination listed, Open → nothing more.
    pub(crate) fn mandate_allows_recipient(&self, m: &Mandate, recipient_id: RecipientId, r: &Recipient) -> bool {
        if !m.allowed_chains.iter().any(|c| c == &r.destination_chain) {
            return false;
        }
        match m.recipients_mode {
            RecipientsMode::Fixed => m.recipients.contains(&recipient_id),
            RecipientsMode::Allowlist => m
                .allowlist
                .iter()
                .any(|d| d.chain == r.destination_chain && same_address(&d.address, &r.destination_address)),
            RecipientsMode::Open => true,
        }
    }
}

/// Next payable occurrence strictly after `after`, honoring the end rule (with the current `paid_count`).
pub(crate) fn next_payable(s: &Schedule, after: u64) -> Option<U64> {
    frequency::next_after(s.frequency, s.start_at.0, after).filter(|occ| s.end.allows(*occ, s.paid_count)).map(U64)
}

/// First payable occurrence at or after `t`.
pub(crate) fn first_payable(s: &Schedule, t: u64) -> Option<U64> {
    frequency::first_at_or_after(s.frequency, s.start_at.0, t).filter(|occ| s.end.allows(*occ, s.paid_count)).map(U64)
}

impl Contract {
    /// Two-phase check of untracked tokens (`actual - balance - in_flight`). NEP-141 `ft_transfer_call` credits the vault
    /// on the token contract one receipt before `ft_on_transfer` runs here, so a single read can see a deposit that is
    /// about to be credited again. The first call only records a probe; a second call >= 60 s later (by then any such
    /// deposit has reached `ft_on_transfer` and is part of `balance`) confirms `min(first, second)`. Any outflow settling
    /// in between invalidates the probe (stale read). Returns `Some(confirmed)` on the confirming call, else `None`.
    pub(crate) fn confirm_surplus(&mut self, actual: u128, outflow_epoch: u64) -> Option<u128> {
        let now = block_timestamp_ms();
        let surplus = actual.saturating_sub(self.balance.saturating_add(self.in_flight));
        if outflow_epoch != self.outflow_epoch {
            log!("balance check: an outflow settled during the read, call again");
            self.surplus_probe = None;
            return None;
        }
        match self.surplus_probe.take() {
            Some(probe)
                if probe.outflow_epoch == outflow_epoch && now >= probe.at_ms.saturating_add(SURPLUS_CONFIRM_MS) =>
            {
                Some(probe.surplus.0.min(surplus))
            }
            Some(probe) if now < probe.at_ms.saturating_add(SURPLUS_CONFIRM_MS) => {
                self.surplus_probe = Some(probe);
                log!("balance check: probe recorded, call again after 60 s to confirm");
                None
            }
            _ => {
                self.surplus_probe = Some(SurplusProbe { surplus: U128(surplus), at_ms: now, outflow_epoch });
                log!("balance check: probe recorded ({surplus} untracked), call again after 60 s to confirm");
                None
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Reads a JSON `U128` (e.g. `ft_balance_of`) from the first promise result.
fn read_u128_result() -> Option<u128> {
    env::promise_result_checked(0, 128).ok().and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok()).map(|v| v.0)
}
