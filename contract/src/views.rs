//! Read-only methods (free RPC `view` calls). Lists are paginated with `from_index` / `limit` (default 50).

use crate::*;

#[near(serializers = [json])]
pub struct PolicyView {
    pub daily_limit: U128,
    pub min_payment: U128,
    pub overdue_grace_ms: U64,
    pub paused: bool,
}

#[near(serializers = [json])]
pub struct BalanceView {
    /// Spendable tokens (internal accounting).
    pub balance: U128,
    /// Reserved by transfers waiting for their callback.
    pub in_flight: U128,
    /// Reserved today by all agents (resets at the UTC day boundary).
    pub spent_today: U128,
    /// `policy.daily_limit - spent_today`.
    pub remaining_today: U128,
    pub day_index: U64,
}

/// What an agent may still do right now (AGENT_ACCESS §3.6). Used by the MCP server / SDK for previews.
#[near(serializers = [json])]
pub struct BudgetView {
    pub agent_id: AgentId,
    /// min(agent daily remaining, vault daily remaining) is what can actually be spent today.
    pub remaining_today: U128,
    pub vault_remaining_today: U128,
    pub per_tx_limit: U128,
    pub approval_threshold: U128,
    pub allowed_chains: Vec<String>,
    pub recipients_mode: RecipientsMode,
    pub allowlist: Vec<Destination>,
    pub recipients: Vec<RecipientId>,
    pub expires_at: Option<U64>,
    pub status: AgentStatus,
    pub vault_paused: bool,
    pub balance: U128,
    pub min_payment: U128,
    pub max_payments_per_day: u32,
    pub payments_today: u32,
}

#[near(serializers = [json])]
pub struct RecipientView {
    pub id: RecipientId,
    #[serde(flatten)]
    pub recipient: Recipient,
    /// Schedules that reference this recipient and are not ended.
    pub active_schedules: u32,
}

/// One expected scheduled payment (ADR-0004 §5).
#[near(serializers = [json])]
pub struct UpcomingItem {
    pub schedule_id: ScheduleId,
    pub recipient_id: RecipientId,
    pub agent_id: AgentId,
    pub amount: U128,
    pub due_at: U64,
    pub will_need_approval: bool,
}

/// A schedule that can be paid now.
#[near(serializers = [json])]
pub struct DueItem {
    #[serde(flatten)]
    pub schedule: Schedule,
    /// Past the grace period: `request_payment` will park it for owner approval.
    pub overdue: bool,
}

#[near(serializers = [json])]
pub struct ContractInfo {
    pub owner_id: AccountId,
    pub proposed_owner: Option<AccountId>,
    pub treasury_token: AccountId,
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: U64,
    pub storage_deposit_yocto: U128,
    /// Ids the next `add_recipient` / `add_schedule` will get (lets the dashboard batch both in one transaction).
    pub next_recipient_id: RecipientId,
    pub next_schedule_id: ScheduleId,
    pub version: String,
}

const DEFAULT_LIMIT: u32 = 50;

#[near]
impl Contract {
    pub fn get_contract_info(&self) -> ContractInfo {
        ContractInfo {
            owner_id: self.owner_id.clone(),
            proposed_owner: self.proposed_owner.clone(),
            treasury_token: self.treasury_token.clone(),
            requires_tee: self.requires_tee,
            attestation_expiration_time_ms: U64(self.attestation_expiration_time_ms),
            storage_deposit_yocto: U128(self.storage_deposit_yocto),
            next_recipient_id: self.next_recipient_id,
            next_schedule_id: self.next_schedule_id,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            daily_limit: self.policy.daily_limit,
            min_payment: self.policy.min_payment,
            overdue_grace_ms: self.policy.overdue_grace_ms,
            paused: self.paused,
        }
    }

    pub fn get_balance(&self) -> BalanceView {
        let spent = self.vault_spent_today();
        BalanceView {
            balance: U128(self.balance),
            in_flight: U128(self.in_flight),
            spent_today: U128(spent),
            remaining_today: U128(self.policy.daily_limit.0.saturating_sub(spent)),
            day_index: U64(block_timestamp_ms() / DAY_MS),
        }
    }

    pub fn get_agent_budget(&self, agent_id: AgentId) -> Option<BudgetView> {
        let a = self.agents.get(&agent_id)?;
        let vault_remaining = self.policy.daily_limit.0.saturating_sub(self.vault_spent_today());
        let agent_remaining = a.mandate.daily_limit.0.saturating_sub(a.spent_today());
        Some(BudgetView {
            agent_id,
            remaining_today: U128(agent_remaining.min(vault_remaining)),
            vault_remaining_today: U128(vault_remaining),
            per_tx_limit: a.mandate.per_tx_limit,
            approval_threshold: a.mandate.approval_threshold,
            allowed_chains: a.mandate.allowed_chains.clone(),
            recipients_mode: a.mandate.recipients_mode,
            allowlist: a.mandate.allowlist.clone(),
            recipients: a.mandate.recipients.clone(),
            expires_at: a.mandate.expires_at,
            status: a.status,
            vault_paused: self.paused,
            balance: U128(self.balance),
            min_payment: self.policy.min_payment,
            max_payments_per_day: a.mandate.max_payments_per_day,
            payments_today: a.payments_today(),
        })
    }

    pub fn get_recipient(&self, recipient_id: RecipientId) -> Option<RecipientView> {
        self.recipients.get(&recipient_id).map(|r| self.recipient_view(recipient_id, r))
    }

    pub fn get_recipients(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<RecipientView> {
        self.recipients
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(DEFAULT_LIMIT) as usize)
            .map(|(id, r)| self.recipient_view(*id, r))
            .collect()
    }

    pub fn get_schedule(&self, schedule_id: ScheduleId) -> Option<Schedule> {
        self.schedules.get(&schedule_id).cloned()
    }

    pub fn get_schedules(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
        agent_id: Option<AgentId>,
        recipient_id: Option<RecipientId>,
    ) -> Vec<Schedule> {
        self.schedules
            .values()
            .filter(|s| agent_id.as_ref().is_none_or(|a| &s.agent_id == a))
            .filter(|s| recipient_id.is_none_or(|r| s.recipient_id == r))
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(DEFAULT_LIMIT) as usize)
            .cloned()
            .collect()
    }

    /// Schedules that can be paid now (or at `now_ms`), optionally of one agent: vault not paused, schedule Active,
    /// agent Active, due date reached, no open payout, below the failure cap. Does not check mandates or limits
    /// (`request_payment` does).
    pub fn get_due(
        &self,
        now_ms: Option<U64>,
        agent_id: Option<AgentId>,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<DueItem> {
        if self.paused {
            return Vec::new();
        }
        let now = now_ms.map(|v| v.0).unwrap_or_else(block_timestamp_ms);
        let grace = self.policy.overdue_grace_ms.0;
        self.schedules
            .values()
            .filter(|s| agent_id.as_ref().is_none_or(|a| &s.agent_id == a))
            .filter(|s| s.status == ScheduleStatus::Active && s.open_payout.is_none())
            .filter(|s| s.failed_attempts < MAX_FAILED_ATTEMPTS)
            .filter(|s| self.agents.get(&s.agent_id).is_some_and(|a| a.status == AgentStatus::Active))
            .filter_map(|s| {
                let due = s.next_due_at?.0;
                (due <= now).then(|| DueItem { schedule: s.clone(), overdue: now > due.saturating_add(grace) })
            })
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(DEFAULT_LIMIT) as usize)
            .collect()
    }

    /// Expected scheduled payments with due dates in `[from_ms, to_ms]` (window ≤ 62 days), sorted by date across all
    /// schedules (k-way merge, so paging is exact). `will_need_approval`: above the agent's approval threshold, or
    /// already past the grace period. At most 500 items per call.
    pub fn get_upcoming(
        &self,
        from_ms: U64,
        to_ms: U64,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<UpcomingItem> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        require!(to_ms.0 >= from_ms.0, "to_ms must be >= from_ms");
        require!(to_ms.0 - from_ms.0 <= MAX_UPCOMING_WINDOW_MS, "Window is limited to 62 days");
        let now = block_timestamp_ms();
        let grace = self.policy.overdue_grace_ms.0;
        let skip = from_index.unwrap_or(0) as usize;
        let take = (limit.unwrap_or(MAX_UPCOMING_ITEMS as u32) as usize).min(MAX_UPCOMING_ITEMS);

        // Heap of per-schedule cursors: (due_at, schedule_id, paid_count_at_due, emitted_for_schedule).
        let mut heap: BinaryHeap<Reverse<(u64, ScheduleId, u32, usize)>> = BinaryHeap::new();
        for s in self.schedules.values().filter(|s| s.status == ScheduleStatus::Active) {
            if let Some((due, paid)) = frequency::cursor_from(
                s.frequency,
                s.start_at.0,
                s.end,
                s.next_due_at.map(|d| d.0),
                s.paid_count,
                from_ms.0,
            ) {
                if due <= to_ms.0 {
                    heap.push(Reverse((due, s.id, paid, 0)));
                }
            }
        }
        let mut out = Vec::new();
        let mut seen = 0usize;
        while let Some(Reverse((due, sid, paid, emitted))) = heap.pop() {
            let Some(s) = self.schedules.get(&sid) else { continue };
            if seen >= skip {
                let threshold = self.agents.get(&s.agent_id).map(|a| a.mandate.approval_threshold.0).unwrap_or(0);
                out.push(UpcomingItem {
                    schedule_id: sid,
                    recipient_id: s.recipient_id,
                    agent_id: s.agent_id.clone(),
                    amount: s.amount,
                    due_at: U64(due),
                    will_need_approval: s.amount.0 > threshold || now > due.saturating_add(grace),
                });
                if out.len() >= take {
                    break;
                }
            }
            seen += 1;
            let next_paid = paid.saturating_add(1);
            if emitted + 1 < MAX_UPCOMING_PER_SCHEDULE {
                if let Some(n) = frequency::next_after(s.frequency, s.start_at.0, due) {
                    if n <= to_ms.0 && s.end.allows(n, next_paid) {
                        heap.push(Reverse((n, sid, next_paid, emitted + 1)));
                    }
                }
            }
        }
        out
    }

    pub fn get_payout(&self, payout_id: U64) -> Option<Payout> {
        self.payout_ref(payout_id.0).cloned()
    }

    /// Payouts in id order. Without `agent_id`: `from_index` is a payout id. With `agent_id`: `from_index` is the
    /// position in that agent's own payout list (index-backed, no full scan).
    pub fn get_payouts(&self, from_index: Option<u32>, limit: Option<u32>, agent_id: Option<AgentId>) -> Vec<Payout> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        match agent_id {
            None => {
                let end = from.saturating_add(limit).min(self.payouts.len());
                (from..end).filter_map(|i| self.payouts.get(i).cloned()).collect()
            }
            Some(id) => {
                let Some(list) = self.agent_payouts.get(&id) else { return Vec::new() };
                let end = from.saturating_add(limit).min(list.len());
                (from..end).filter_map(|i| list.get(i)).filter_map(|pid| self.payout_ref(*pid).cloned()).collect()
            }
        }
    }

    /// Number of payouts of one agent (for paging `get_payouts` with `agent_id`).
    pub fn get_agent_payouts_count(&self, agent_id: AgentId) -> u32 {
        self.agent_payouts.get(&agent_id).map(|l| l.len()).unwrap_or(0)
    }

    pub fn get_payouts_count(&self) -> U64 {
        U64(self.payouts.len() as u64)
    }

    pub fn get_pending_approvals(&self) -> Vec<Payout> {
        self.approvals.iter().filter_map(|id| self.payout_ref(*id).cloned()).collect()
    }

    /// Rejection log, newest first (last 200), optionally only one agent.
    pub fn get_rejections(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
        agent_id: Option<AgentId>,
    ) -> Vec<Rejection> {
        let n = self.rejections.len();
        if n == 0 {
            return Vec::new();
        }
        // Newest entry sits just before `rejections_head` (which is 0 until the buffer is full).
        (0..n)
            .map(|i| (self.rejections_head + n - 1 - i) % n)
            .filter_map(|idx| self.rejections.get(idx))
            .filter(|r| agent_id.as_ref().is_none_or(|id| &r.agent_id == id))
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(DEFAULT_LIMIT) as usize)
            .cloned()
            .collect()
    }
}

impl Contract {
    fn recipient_view(&self, id: RecipientId, r: &Recipient) -> RecipientView {
        let active_schedules =
            self.schedules.values().filter(|s| s.recipient_id == id && s.status != ScheduleStatus::Ended).count()
                as u32;
        RecipientView { id, recipient: r.clone(), active_schedules }
    }
}
