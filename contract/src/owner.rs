//! Owner-only methods: vault policy, kill switch, recipients (address book), schedules, approvals, funds, admin.
//!
//! Methods that widen what agents can do or move money require exactly 1 yoctoNEAR (full-access key / wallet
//! confirmation). Methods that only *restrict* (`pause`, `pause_agent`, `revoke_agent`, `reject_payout`,
//! `pause_schedule`, `end_schedule`, `remove_*`) do not, so they also work from a limited function-call key.
//! Agent lifecycle and TEE trust anchors live in `agent.rs`.

use crate::payment::{PaymentRequest, first_payable};
use crate::*;

#[near]
impl Contract {
    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.require_owner_one_yocto();
        require!(policy.min_payment.0 > 0, "min_payment must be positive");
        require!(policy.min_payment.0 <= policy.daily_limit.0, "min_payment must not exceed daily_limit");
        require!(
            (MIN_OVERDUE_GRACE_MS..=MAX_OVERDUE_GRACE_MS).contains(&policy.overdue_grace_ms.0),
            "overdue_grace_ms must be between 1 hour and 30 days"
        );
        self.policy = policy;
        Event::PolicyUpdated { policy: &self.policy }.emit();
    }

    /// Global kill switch: stops every agent immediately. Deliberately no deposit requirement.
    pub fn pause(&mut self) {
        self.require_owner();
        self.paused = true;
        Event::Paused { by: &env::predecessor_account_id() }.emit();
    }

    #[payable]
    pub fn resume(&mut self) {
        self.require_owner_one_yocto();
        self.paused = false;
        Event::Resumed { by: &env::predecessor_account_id() }.emit();
    }

    // --- recipients (address book) --------------------------------------------------------------

    #[payable]
    pub fn add_recipient(&mut self, recipient: RecipientInput) -> RecipientId {
        self.require_owner_one_yocto();
        validate_recipient(&recipient);
        let id = self.next_recipient_id;
        self.next_recipient_id = id.checked_add(1).unwrap_or_else(|| env::panic_str("Too many recipients"));
        let r = Recipient {
            label: recipient.label,
            destination_chain: recipient.destination_chain,
            destination_asset: recipient.destination_asset,
            destination_address: recipient.destination_address,
            created_at_ms: U64(block_timestamp_ms()),
            last_paid_at_ms: None,
        };
        Event::RecipientUpserted { recipient_id: id, recipient: &r }.emit();
        self.recipients.insert(id, r);
        id
    }

    /// Changing a recipient's destination rejects pending approvals of its schedules (they were quoted to the old
    /// address) and is refused while one of its payments is in flight.
    #[payable]
    pub fn update_recipient(&mut self, recipient_id: RecipientId, recipient: RecipientInput) {
        self.require_owner_one_yocto();
        validate_recipient(&recipient);
        require!(self.recipients.contains_key(&recipient_id), "Recipient not found");
        let ids: Vec<ScheduleId> =
            self.schedules.iter().filter(|(_, s)| s.recipient_id == recipient_id).map(|(id, _)| *id).collect();
        for sid in ids {
            self.cancel_schedule_approval(sid);
        }
        let r = self.recipients.get_mut(&recipient_id).unwrap_or_else(|| env::panic_str("Recipient not found"));
        r.label = recipient.label;
        r.destination_chain = recipient.destination_chain;
        r.destination_asset = recipient.destination_asset;
        r.destination_address = recipient.destination_address;
        let r = r.clone();
        Event::RecipientUpserted { recipient_id, recipient: &r }.emit();
    }

    /// Refused while schedules that are not `Ended` (or whose last payment is still open) reference the recipient.
    #[payable]
    pub fn remove_recipient(&mut self, recipient_id: RecipientId) {
        self.require_owner_one_yocto();
        let live = self
            .schedules
            .values()
            .filter(|s| {
                s.recipient_id == recipient_id && (s.status != ScheduleStatus::Ended || s.open_payout.is_some())
            })
            .count();
        require!(live == 0, format!("End its {live} schedules first"));
        require!(self.recipients.remove(&recipient_id).is_some(), "Recipient not found");
        Event::RecipientRemoved { recipient_id }.emit();
    }

    // --- schedules ---------------------------------------------------------------------------------

    /// Create a scheduled payment (ADR-0004). The agent's mandate must allow it (recipient, chain, amount).
    #[payable]
    pub fn add_schedule(&mut self, schedule: ScheduleInput) -> ScheduleId {
        self.require_owner_one_yocto();
        require!(self.schedules.len() < MAX_SCHEDULES, "Too many schedules");
        self.validate_schedule(&schedule);
        let id = self.next_schedule_id;
        self.next_schedule_id = id.checked_add(1).unwrap_or_else(|| env::panic_str("Too many schedules"));
        let mut s = Schedule {
            id,
            recipient_id: schedule.recipient_id,
            amount: schedule.amount,
            frequency: schedule.frequency,
            start_at: schedule.start_at,
            end: schedule.end,
            agent_id: schedule.agent_id,
            status: ScheduleStatus::Active,
            last_paid_at: None,
            last_occurrence_paid: None,
            last_occurrence_handled: None,
            paid_count: 0,
            created_at: U64(block_timestamp_ms()),
            next_due_at: None,
            open_payout: None,
            failed_attempts: 0,
        };
        // A new schedule never owes dates before it was created: count from max(start_at, now).
        s.next_due_at = first_payable(&s, s.start_at.0.max(block_timestamp_ms()));
        require!(s.next_due_at.is_some(), "Schedule has no payable date");
        Event::ScheduleUpserted { schedule_id: id, schedule: &s }.emit();
        self.schedules.insert(id, s);
        id
    }

    /// Replace a schedule's terms. Paid history is kept; the next date is recomputed after the last paid date.
    /// A pending approval is rejected (it was for the old terms); refused while a transfer is in flight.
    #[payable]
    pub fn update_schedule(&mut self, schedule_id: ScheduleId, schedule: ScheduleInput) {
        self.require_owner_one_yocto();
        self.validate_schedule(&schedule);
        self.cancel_schedule_approval(schedule_id);
        let s = self.schedules.get_mut(&schedule_id).unwrap_or_else(|| env::panic_str("Schedule not found"));
        require!(s.status != ScheduleStatus::Ended, "Schedule is ended");
        s.recipient_id = schedule.recipient_id;
        s.amount = schedule.amount;
        s.frequency = schedule.frequency;
        s.start_at = schedule.start_at;
        s.end = schedule.end;
        s.agent_id = schedule.agent_id;
        s.failed_attempts = 0;
        // Dates already paid or skipped stay handled; recompute after the last handled one.
        // New terms continue after everything already handled: the last paid/skipped date and the time of the last
        // payment (so a late payment followed by a date change cannot pay twice within days).
        let after = |t: Option<U64>| t.map(|v| v.0.saturating_add(1)).unwrap_or(0);
        let from = s.start_at.0.max(after(s.last_occurrence_handled)).max(after(s.last_paid_at));
        s.next_due_at = first_payable(s, from);
        if s.next_due_at.is_none() {
            // Nothing left: fine if something was already paid (terms now say "done"), refused for an unpaid schedule.
            require!(s.paid_count > 0, "Schedule has no payable date");
            s.status = ScheduleStatus::Ended;
        }
        let s = s.clone();
        Event::ScheduleUpserted { schedule_id, schedule: &s }.emit();
    }

    /// Restricting → no deposit. A pending approval stays but can only be approved after `resume_schedule`.
    /// Dates missed while paused remain payable after resume (overdue ones need approval).
    pub fn pause_schedule(&mut self, schedule_id: ScheduleId) {
        self.require_owner();
        let s = self.schedules.get_mut(&schedule_id).unwrap_or_else(|| env::panic_str("Schedule not found"));
        require!(s.status == ScheduleStatus::Active, "Schedule is not active");
        s.status = ScheduleStatus::Paused;
        Event::ScheduleStatusChanged { schedule_id, status: ScheduleStatus::Paused }.emit();
    }

    #[payable]
    pub fn resume_schedule(&mut self, schedule_id: ScheduleId) {
        self.require_owner_one_yocto();
        let s = self.schedules.get_mut(&schedule_id).unwrap_or_else(|| env::panic_str("Schedule not found"));
        require!(s.status == ScheduleStatus::Paused, "Schedule is not paused");
        s.status = ScheduleStatus::Active;
        Event::ScheduleStatusChanged { schedule_id, status: ScheduleStatus::Active }.emit();
    }

    /// Terminal for future dates. Rejects a pending approval; refused while a transfer is in flight. 1 yoctoNEAR because
    /// it is irreversible (use `pause_schedule` from a limited key).
    #[payable]
    pub fn end_schedule(&mut self, schedule_id: ScheduleId) {
        self.require_owner_one_yocto();
        self.cancel_schedule_approval(schedule_id);
        let s = self.schedules.get_mut(&schedule_id).unwrap_or_else(|| env::panic_str("Schedule not found"));
        s.status = ScheduleStatus::Ended;
        s.next_due_at = None;
        Event::ScheduleStatusChanged { schedule_id, status: ScheduleStatus::Ended }.emit();
    }

    /// Delete an `Ended` schedule without an open payout (frees storage and the schedule cap). History stays in
    /// payouts (`schedule_id` keeps pointing at the removed id).
    pub fn remove_schedule(&mut self, schedule_id: ScheduleId) {
        self.require_owner();
        let s = self.schedules.get(&schedule_id).unwrap_or_else(|| env::panic_str("Schedule not found"));
        require!(s.status == ScheduleStatus::Ended && s.open_payout.is_none(), "Only ended schedules can be removed");
        self.schedules.remove(&schedule_id);
        Event::ScheduleStatusChanged { schedule_id, status: ScheduleStatus::Ended }.emit();
    }

    /// Clear a schedule's failed-transfer counter (after investigating the failures).
    #[payable]
    pub fn reset_schedule_failures(&mut self, schedule_id: ScheduleId) {
        self.require_owner_one_yocto();
        let s = self.schedules.get_mut(&schedule_id).unwrap_or_else(|| env::panic_str("Schedule not found"));
        s.failed_attempts = 0;
    }

    // --- approvals -------------------------------------------------------------------------------

    /// Approve a payment that waits for the owner (above threshold or overdue). Re-runs the checks for its agent now
    /// (pause, mandate, schedule, limits, balance); if any fails this call panics with the reason (reject it instead).
    /// Then reserves and transfers to the deposit address the agent supplied. Refuses after the agent-declared deposit
    /// deadline and for payouts older than 72 h. Attach ≥ 100 TGas.
    #[payable]
    pub fn approve_payout(&mut self, payout_id: U64) -> Promise {
        self.require_owner_one_yocto();
        require!(env::prepaid_gas() >= MIN_GAS_PAYMENT, "Attach at least 100 TGas");
        let p = self.payout_ref(payout_id.0).unwrap_or_else(|| env::panic_str("Payout not found")).clone();
        require!(p.status == PayoutStatus::PendingApproval, "Payout is not pending approval");
        require!(
            block_timestamp_ms() <= p.created_at_ms.0.saturating_add(MAX_APPROVAL_AGE_MS),
            "This payout is older than 72 h; reject it and let the agent request again"
        );
        if let Some(exp) = p.deposit_expires_at_ms {
            require!(
                block_timestamp_ms() < exp.0,
                "The 1Click deposit address of this payout expired; reject it and let the agent request again"
            );
        }
        // The payout must have been created by the account that currently holds the agent slot (ADR-0003 §1).
        let current_account = self.agents.get(&p.agent_id).and_then(|a| a.account_id.clone());
        require!(
            p.agent_account.is_some() && p.agent_account == current_account,
            "This payout was requested by an account that no longer holds the agent slot; reject it"
        );
        self.roll_day();
        let deposit = p.deposit_address.as_ref().map(|d| d.to_string()).unwrap_or_default();
        let req = PaymentRequest {
            chain: &p.chain,
            address: &p.address,
            amount: p.amount.0,
            memo: p.memo.as_deref(),
            schedule_id: p.schedule_id,
            deposit_address: &deposit,
        };
        if let Err((code, detail)) = self.evaluate_payment(self.agents.get(&p.agent_id), &req, Some(payout_id.0)) {
            env::panic_str(&format!("{code}: {detail}"));
        }
        self.approvals.remove(&payout_id.0);
        if let Some(a) = self.agents.get_mut(&p.agent_id) {
            a.open_approvals = a.open_approvals.saturating_sub(1);
        }
        Event::PayoutApproved { payout_id }.emit();
        self.reserve_and_transfer(payout_id.0)
    }

    /// Reject a pending payment. For a scheduled payment, `skip` decides whether its due date counts as handled
    /// (schedule moves on) or stays payable (agent can request it again with a fresh quote). Default: skip, except when
    /// the payout can no longer be approved (deposit deadline passed or older than 72 h) — then the date stays payable,
    /// so a slow approval never silently drops a salary.
    /// Skipping a scheduled date drops a payment for good, so it needs 1 yoctoNEAR; a reject that keeps the date
    /// payable (or of an on-demand payment) needs no deposit.
    #[payable]
    pub fn reject_payout(&mut self, payout_id: U64, skip: Option<bool>) {
        self.require_owner();
        let p = self.payout_ref(payout_id.0).unwrap_or_else(|| env::panic_str("Payout not found"));
        let now = block_timestamp_ms();
        let unapprovable = p.deposit_expires_at_ms.is_some_and(|e| now >= e.0)
            || now > p.created_at_ms.0.saturating_add(MAX_APPROVAL_AGE_MS);
        let skip = skip.unwrap_or(!unapprovable) && p.schedule_id.is_some();
        if skip {
            require!(env::attached_deposit() == ONE_YOCTO, "Skipping a scheduled date requires exactly 1 yoctoNEAR");
        }
        self.reject_pending(payout_id.0, skip);
    }

    // --- funds -----------------------------------------------------------------------------------

    /// Owner withdrawal. Always allowed: not blocked by pause, agents, or open payouts (only by available balance).
    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        self.require_owner_one_yocto();
        require!(amount.0 > 0, "Amount must be positive");
        require!(amount.0 <= self.balance, "Insufficient vault balance");
        require!(env::prepaid_gas() >= MIN_GAS_WITHDRAW, "Attach at least 60 TGas");
        let receiver_id = receiver_id.unwrap_or_else(|| self.owner_id.clone());

        self.balance -= amount.0;
        self.in_flight = self.in_flight.checked_add(amount.0).unwrap_or_else(|| env::panic_str("Overflow"));

        Promise::new(self.treasury_token.clone())
            .function_call(
                "ft_transfer".to_string(),
                serde_json::to_vec(&serde_json::json!({
                    "receiver_id": receiver_id,
                    "amount": amount,
                    "memo": "agent-treasury withdraw",
                }))
                .unwrap_or_default(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw_result(amount, receiver_id),
            )
    }

    /// Credit tokens refunded by 1Click (they arrive as a plain `ft_transfer`) back to the spendable balance. Only for
    /// payouts whose funds left and that ended `Refunded` / `Failed`. `amount` (default: payout amount) may be smaller
    /// for partial refunds. Checked against the real token balance with an outflow-epoch guard.
    #[payable]
    pub fn credit_refund(&mut self, payout_id: U64, amount: Option<U128>) -> Promise {
        self.require_owner_one_yocto();
        let p = self.payout_ref(payout_id.0).unwrap_or_else(|| env::panic_str("Payout not found"));
        require!(p.funds_left, "Funds of this payout never left the vault");
        require!(!p.refund_credited, "Refund already credited");
        require!(matches!(p.status, PayoutStatus::Refunded | PayoutStatus::Failed), "Payout is not refunded or failed");
        let amount = amount.unwrap_or(p.amount);
        require!(amount.0 > 0 && amount.0 <= p.amount.0, "Refund amount must be in (0, payout amount]");
        self.ft_balance_of_self().then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_refund_balance(
                payout_id,
                amount,
                U64(self.outflow_epoch),
            ),
        )
    }

    /// Credit any tokens the vault holds beyond `balance + in_flight` (plain `ft_transfer` deposits, unmatched refunds).
    #[payable]
    pub fn sync_surplus(&mut self) -> Promise {
        self.require_owner_one_yocto();
        self.ft_balance_of_self().then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_sync_surplus(U64(self.outflow_epoch)),
        )
    }

    /// Withdraw NEAR not locked for storage (e.g. leftover from funding storage deposits).
    #[payable]
    pub fn withdraw_near(&mut self, amount: U128) -> Promise {
        self.require_owner_one_yocto();
        let storage_cost = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let available = env::account_balance().saturating_sub(storage_cost);
        require!(amount.0 > 0 && amount.0 <= available.as_yoctonear(), "Amount exceeds NEAR not locked for storage");
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Escape hatch if a transfer callback never ran. Only for payouts stuck in `Transferring` for over an hour. The
    /// owner checks the token transfer on an explorer: `sent = true` → `Sent`, `false` → release (`Failed`).
    #[payable]
    pub fn force_settle_transfer(&mut self, payout_id: U64, sent: bool) -> bool {
        self.require_owner_one_yocto();
        let p = self.payout_ref(payout_id.0).unwrap_or_else(|| env::panic_str("Payout not found"));
        require!(p.status == PayoutStatus::Transferring, "Payout is not transferring");
        require!(
            block_timestamp_ms() >= p.updated_at_ms.0.saturating_add(STUCK_TRANSFER_MS),
            "Transfer is not stuck yet"
        );
        self.settle_transfer(payout_id, sent)
    }

    #[payable]
    pub fn set_storage_deposit_yocto(&mut self, storage_deposit_yocto: U128) {
        self.require_owner_one_yocto();
        require!(storage_deposit_yocto.0 > 0, "storage_deposit_yocto must be positive");
        self.storage_deposit_yocto = storage_deposit_yocto.0;
    }

    // --- ownership & upgrades -------------------------------------------------------------------

    #[payable]
    pub fn propose_owner(&mut self, proposed_owner: AccountId) {
        self.require_owner_one_yocto();
        Event::OwnerProposed { proposed_owner: &proposed_owner }.emit();
        self.proposed_owner = Some(proposed_owner);
    }

    #[payable]
    pub fn accept_owner(&mut self) {
        require!(env::attached_deposit() == ONE_YOCTO, "Requires attached deposit of exactly 1 yoctoNEAR");
        let caller = env::predecessor_account_id();
        require!(self.proposed_owner.as_ref() == Some(&caller), "Caller is not the proposed owner");
        require!(!self.agent_by_account.contains_key(&caller), "An agent account cannot become the owner");
        let old = std::mem::replace(&mut self.owner_id, caller);
        self.proposed_owner = None;
        Event::OwnerChanged { old_owner: &old, new_owner: &self.owner_id }.emit();
    }

    /// Owner-gated code upgrade. Raw input: `[gas for migrate: u64 LE, 8 bytes] ++ [wasm]`. Deploys and calls
    /// `migrate`. With this the vault account itself needs no full-access key: delete it after deployment.
    /// Requires 1 yoctoNEAR: a function-call (e.g. dashboard login) key must never be able to replace the code.
    #[payable]
    pub fn update_contract(&mut self) -> Promise {
        self.require_owner_one_yocto();
        let input = env::input().unwrap_or_else(|| env::panic_str("No input"));
        require!(input.len() > 8, "Input: 8 bytes gas (u64 LE) followed by wasm");
        let mut gas_bytes = [0u8; 8];
        gas_bytes.copy_from_slice(&input[..8]);
        let gas_tgas = u64::from_le_bytes(gas_bytes);
        Promise::new(env::current_account_id())
            .deploy_contract(input[8..].to_vec())
            .function_call("migrate".to_string(), Vec::new(), NearToken::from_near(0), Gas::from_tgas(gas_tgas))
            .as_return()
    }
}

impl Contract {
    fn ft_balance_of_self(&self) -> Promise {
        Promise::new(self.treasury_token.clone()).function_call(
            "ft_balance_of".to_string(),
            serde_json::to_vec(&serde_json::json!({ "account_id": env::current_account_id() })).unwrap_or_default(),
            NearToken::from_near(0),
            GAS_FT_BALANCE_OF,
        )
    }

    /// Rejects the schedule's pending approval (without skipping the date), if any. Panics if a transfer is in flight.
    fn cancel_schedule_approval(&mut self, schedule_id: ScheduleId) {
        let Some(open) = self.schedules.get(&schedule_id).and_then(|s| s.open_payout) else {
            return;
        };
        let status = self.payout_ref(open.0).map(|p| p.status);
        require!(status != Some(PayoutStatus::Transferring), "A transfer for this schedule is in flight");
        if status == Some(PayoutStatus::PendingApproval) {
            self.reject_pending(open.0, false);
        } else if let Some(s) = self.schedules.get_mut(&schedule_id) {
            s.open_payout = None;
        }
    }

    /// ADR-0004 §4. Shared by add/update; the same rules are re-checked at payment time.
    pub(crate) fn validate_schedule(&self, s: &ScheduleInput) {
        require!(s.frequency.is_valid(), "Invalid frequency");
        require!(s.end.is_valid(), "Invalid end");
        let r = self.recipients.get(&s.recipient_id).unwrap_or_else(|| env::panic_str("Recipient not found"));
        let a = self.agents.get(&s.agent_id).unwrap_or_else(|| env::panic_str("Agent not found"));
        require!(a.status != AgentStatus::Revoked, "Agent is revoked");
        require!(
            self.mandate_allows_recipient(&a.mandate, s.recipient_id, r),
            format!("{} can't pay this recipient (not in its mandate)", a.id)
        );
        require!(s.amount.0 >= self.policy.min_payment.0, "Amount is below the vault's minimum payment");
        require!(
            s.amount.0 <= a.mandate.per_tx_limit.0,
            format!("Amount exceeds {}'s per-payment limit ({})", a.id, fmt_amount(a.mandate.per_tx_limit.0))
        );
    }
}

fn validate_recipient(r: &RecipientInput) {
    require!(!r.label.is_empty() && r.label.len() <= MAX_LABEL_LEN, "Invalid label");
    require!(
        !r.destination_chain.is_empty() && r.destination_chain.len() <= MAX_CHAIN_LEN,
        "Invalid destination_chain"
    );
    require!(
        !r.destination_asset.is_empty() && r.destination_asset.len() <= MAX_ASSET_LEN,
        "Invalid destination_asset"
    );
    require!(
        !r.destination_address.is_empty() && r.destination_address.len() <= MAX_ADDRESS_LEN,
        "Invalid destination_address"
    );
}
