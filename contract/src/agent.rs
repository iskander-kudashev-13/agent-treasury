//! Agents: creation and mandates (owner), TEE registration (Shade Agent v2), status, views.
//!
//! TEE parts adapted from NearDeFi/shade-agent-template @816b75b `agent-contract/src/{lib,owner,views}.rs` and
//! `internal/{attestation,helpers}.rs` (Apache-2.0). Changes: an agent is a slot created by the owner with a mandate;
//! the enclave binds its attested account to the slot (`register_agent(agent_id, attestation)`, ADR-0003 §1);
//! an invalid TEE agent is rejected with `ATTESTATION_INVALID` instead of being removed; chain signatures removed.
//!
//! Trust model: in TEE mode (`requires_tee = true`) a TEE agent registers by presenting an Intel TDX quote (dstack)
//! whose `report_data` is its own implicit account id. The quote proves the key was generated inside an enclave
//! running exactly an approved docker image (pinned by the approved measurements). Nobody, including the developer,
//! has that key. Local mode skips attestation and is for development only.
//! Key agents are plain accounts; the owner gives them a function-call key that can only call this vault.

use crate::*;

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRemovalReason {
    ExpiredAttestation,
    InvalidMeasurements,
    InvalidPpid,
    NotWhitelistedForLocal,
    NotRegistered,
}

#[near(serializers = [json])]
pub struct TeeView {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: U64,
    pub valid: bool,
    pub reasons: Vec<AgentRemovalReason>,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub id: AgentId,
    pub name: String,
    pub kind: AgentKind,
    pub account_id: Option<AccountId>,
    pub account_pinned: bool,
    pub public_key: Option<PublicKey>,
    pub mandate: Mandate,
    pub status: AgentStatus,
    /// Spent in the current UTC day (virtual rollover).
    pub spent_today: U128,
    pub day_index: U64,
    pub created_at: U64,
    pub last_request_at: Option<U64>,
    pub failed_transfers: u32,
    pub open_approvals: u32,
    pub tee: Option<TeeView>,
}

#[near]
impl Contract {
    // --- owner: agent lifecycle ------------------------------------------------------------------

    /// Create an agent with its mandate.
    /// - `Key`: `account_id` required (the account holding the function-call key), `public_key` optional (recorded).
    /// - `Tee`: `account_id` optional; if given, only that account can register into the slot (pinned).
    #[payable]
    pub fn add_agent(
        &mut self,
        id: AgentId,
        name: String,
        kind: AgentKind,
        account_id: Option<AccountId>,
        public_key: Option<PublicKey>,
        mandate: Mandate,
    ) -> AgentView {
        self.require_owner_one_yocto();
        require!(is_valid_agent_id(&id), "Agent id must match ^[a-z0-9-]{1,32}$");
        require!(!self.agents.contains_key(&id), "Agent id already exists");
        require!(!name.is_empty() && name.len() <= MAX_LABEL_LEN, "Invalid name");
        self.validate_mandate(&mandate);
        if kind == AgentKind::Key {
            require!(account_id.is_some(), "Key agents need account_id");
        }
        if kind == AgentKind::Tee && self.requires_tee {
            if let Some(acc) = &account_id {
                require!(is_implicit_account(acc.as_str()), "A pinned TEE account must be an implicit account");
            }
        }
        if let Some(acc) = &account_id {
            self.require_bindable_account(acc);
            self.agent_by_account.insert(acc.clone(), id.clone());
        }
        let now = block_timestamp_ms();
        let agent = Agent {
            id: id.clone(),
            name,
            kind,
            account_pinned: kind == AgentKind::Tee && account_id.is_some(),
            account_id,
            public_key,
            mandate,
            status: AgentStatus::Active,
            spent_today: 0,
            payments_today: 0,
            rejections_logged_today: 0,
            day_index: now / DAY_MS,
            created_at_ms: now,
            last_request_at_ms: None,
            failed_transfers: 0,
            open_approvals: 0,
            tee: None,
        };
        let view = self.agent_view(&agent);
        Event::AgentAdded { agent_id: &id, kind, account_id: agent.account_id.as_ref() }.emit();
        self.agents.insert(id, agent);
        view
    }

    /// Replace an agent's mandate. Spending counters are kept (changing limits does not reset today's spend).
    #[payable]
    pub fn update_mandate(&mut self, agent_id: AgentId, mandate: Mandate) {
        self.require_owner_one_yocto();
        self.validate_mandate(&mandate);
        let a = self.agent_mut(&agent_id);
        require!(a.status != AgentStatus::Revoked, "Agent is revoked");
        a.mandate = mandate;
        Event::MandateUpdated { agent_id: &agent_id }.emit();
    }

    /// Stop one agent immediately. Restricting → no deposit needed (works from a function-call key).
    pub fn pause_agent(&mut self, agent_id: AgentId) {
        self.require_owner();
        let a = self.agent_mut(&agent_id);
        require!(a.status != AgentStatus::Revoked, "Agent is revoked");
        a.status = AgentStatus::Paused;
        Event::AgentStatusChanged { agent_id: &agent_id, status: AgentStatus::Paused }.emit();
    }

    #[payable]
    pub fn resume_agent(&mut self, agent_id: AgentId) {
        self.require_owner_one_yocto();
        let a = self.agent_mut(&agent_id);
        require!(a.status != AgentStatus::Revoked, "Agent is revoked; create a new agent instead");
        a.status = AgentStatus::Active;
        Event::AgentStatusChanged { agent_id: &agent_id, status: AgentStatus::Active }.emit();
    }

    /// Terminal. Also rejects the agent's open approvals. The account stays mapped so later calls get `AGENT_REVOKED`.
    /// For key agents, also delete the function-call key from the agent account (separate transaction).
    /// 1 yoctoNEAR: irreversible, so a leaked dashboard login key must not be able to do it (use `pause_agent`).
    #[payable]
    pub fn revoke_agent(&mut self, agent_id: AgentId) {
        self.require_owner_one_yocto();
        let a = self.agent_mut(&agent_id);
        require!(a.status != AgentStatus::Revoked, "Agent already revoked");
        a.status = AgentStatus::Revoked;
        self.reject_agent_approvals(&agent_id);
        Event::AgentStatusChanged { agent_id: &agent_id, status: AgentStatus::Revoked }.emit();
    }

    /// Detach the account bound to an unpinned TEE slot (e.g. to move the agent to a new enclave). The slot keeps its
    /// mandate and history; the next valid attestation binds it again, so this re-opens the slot: 1 yoctoNEAR.
    /// Payments the old account left waiting for approval are rejected (their date stays payable).
    #[payable]
    pub fn unbind_agent(&mut self, agent_id: AgentId) {
        self.require_owner_one_yocto();
        let (pinned, kind, acc) = {
            let a = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("Agent not found"));
            (a.account_pinned, a.kind, a.account_id.clone())
        };
        require!(kind == AgentKind::Tee && !pinned, "Only unpinned TEE agents can be unbound");
        if let Some(acc) = acc {
            self.agent_by_account.remove(&acc);
        }
        self.reject_agent_approvals(&agent_id);
        let a = self.agent_mut(&agent_id);
        a.account_id = None;
        a.tee = None;
        Event::AgentStatusChanged { agent_id: &agent_id, status: a.status }.emit();
    }

    /// Pin a TEE slot to the account currently bound to it (after the owner checked it is the enclave they deployed):
    /// from now on only that account can register into the slot.
    #[payable]
    pub fn pin_agent(&mut self, agent_id: AgentId) {
        self.require_owner_one_yocto();
        let a = self.agent_mut(&agent_id);
        require!(a.kind == AgentKind::Tee, "Only TEE agents can be pinned");
        require!(a.account_id.is_some(), "No account is bound to this slot yet");
        a.account_pinned = true;
        Event::AgentStatusChanged { agent_id: &agent_id, status: a.status }.emit();
    }

    /// Clear an agent's failed-transfer counter (after investigating the failures).
    #[payable]
    pub fn reset_agent_failures(&mut self, agent_id: AgentId) {
        self.require_owner_one_yocto();
        self.agent_mut(&agent_id).failed_transfers = 0;
    }

    // --- TEE registration ------------------------------------------------------------------------

    /// Called by the enclave. Binds the caller's attested account to the TEE agent slot `agent_id`.
    /// - Same account again: refreshes the attestation.
    /// - Unbound slot (or bound account's attestation no longer valid): binds the caller. The owner should check in the
    ///   dashboard that the bound account is the enclave they deployed, or pin it (`add_agent` with `account_id`).
    /// - Slot bound to a different account that is still valid: refused, so a second instance of the approved image
    ///   cannot silently take over a live slot. The owner can `unbind_agent` first.
    pub fn register_agent(&mut self, agent_id: AgentId, attestation: DstackAttestation) -> bool {
        let caller = env::predecessor_account_id();
        let (kind, status, pinned, current, current_valid) = {
            let a = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("Agent not found"));
            let valid = a.account_id.is_some() && a.tee.is_some() && self.agent_tee_reasons(a).is_empty();
            (a.kind, a.status, a.account_pinned, a.account_id.clone(), valid)
        };
        require!(kind == AgentKind::Tee, "Only TEE agents register with an attestation");
        require!(status != AgentStatus::Revoked, "Agent is revoked");
        require!(
            caller != self.owner_id && caller != env::current_account_id() && caller != self.treasury_token,
            "Agent account cannot be the owner, the vault or the token"
        );
        if pinned {
            require!(current.as_ref() == Some(&caller), "This agent slot is pinned to another account");
        } else if let Some(cur) = &current {
            require!(
                cur == &caller || !current_valid,
                "Slot is bound to a live agent; the owner must unbind_agent first"
            );
        }
        if let Some(other) = self.agent_by_account.get(&caller) {
            require!(other == &agent_id, "Account is already bound to another agent");
        }

        let (measurements, ppid, advisory_ids) = self.verify_attestation(attestation);
        let valid_until_ms = block_timestamp_ms()
            .checked_add(self.attestation_expiration_time_ms)
            .unwrap_or_else(|| env::panic_str("Expiration overflow"));
        let (advisory_ids_truncated, number_of_advisory_ids) = events::summarize_advisory_ids(&advisory_ids);
        Event::AgentRegistered {
            agent_id: &agent_id,
            account_id: &caller,
            measurements: &measurements,
            ppid: &ppid,
            advisory_ids_truncated,
            number_of_advisory_ids,
            valid_until_ms: U64(valid_until_ms),
        }
        .emit();

        if let Some(old) = &current {
            if old != &caller {
                self.agent_by_account.remove(old);
                // A new account took over the slot: what the old one left for approval must not be approved now.
                self.reject_agent_approvals(&agent_id);
            }
        }
        self.agent_by_account.insert(caller.clone(), agent_id.clone());
        let a = self.agent_mut(&agent_id);
        a.account_id = Some(caller);
        a.tee = Some(TeeRegistration { measurements, ppid, valid_until_ms });
        true
    }

    // --- owner: TEE trust anchors ----------------------------------------------------------------

    /// Approve a docker image / TEE configuration (v2 replacement of "approve_codehash"). Widens trust → 1 yoctoNEAR.
    #[payable]
    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner_one_yocto();
        self.approved_measurements.insert(measurements);
    }

    /// Revoke measurements: agents running that image are rejected (`ATTESTATION_INVALID`) immediately.
    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        require!(self.approved_measurements.remove(&measurements), "Measurements not in approved list");
    }

    #[payable]
    pub fn approve_ppids(&mut self, ppids: Vec<Ppid>) {
        self.require_owner_one_yocto();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    pub fn remove_ppids(&mut self, ppids: Vec<Ppid>) {
        self.require_owner();
        for id in ppids {
            require!(self.approved_ppids.remove(&id), "PPID not in approved list");
        }
    }

    #[payable]
    pub fn update_attestation_expiration_time(&mut self, attestation_expiration_time_ms: U64) {
        self.require_owner_one_yocto();
        self.attestation_expiration_time_ms = attestation_expiration_time_ms.into();
    }

    /// Local (non-TEE) mode only: allow a dev account to register into a TEE slot without attestation.
    #[payable]
    pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
        require!(!self.requires_tee, "Whitelisting agents is not supported for TEE");
        self.require_owner_one_yocto();
        self.whitelisted_agents_for_local.insert(account_id);
    }

    pub fn remove_agent_from_whitelist_for_local(&mut self, account_id: AccountId) {
        require!(!self.requires_tee, "Removing agents from the whitelist is not supported for TEE");
        self.require_owner();
        require!(self.whitelisted_agents_for_local.remove(&account_id), "Agent not in whitelist for local");
    }

    // --- views -----------------------------------------------------------------------------------

    pub fn get_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AgentView> {
        self.agents
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .map(|a| self.agent_view(a))
            .collect()
    }

    pub fn get_agent(&self, agent_id: AgentId) -> Option<AgentView> {
        self.agents.get(&agent_id).map(|a| self.agent_view(a))
    }

    pub fn get_agent_by_account(&self, account_id: AccountId) -> Option<AgentView> {
        self.agent_by_account.get(&account_id).and_then(|id| self.agents.get(id)).map(|a| self.agent_view(a))
    }

    pub fn get_approved_measurements(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<FullMeasurementsHex> {
        let from = from_index.unwrap_or(0) as usize;
        self.approved_measurements.iter().skip(from).take(limit.unwrap_or(50) as usize).cloned().collect()
    }

    pub fn get_approved_ppids(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Ppid> {
        let from = from_index.unwrap_or(0) as usize;
        self.approved_ppids.iter().skip(from).take(limit.unwrap_or(50) as usize).cloned().collect()
    }

    pub fn get_whitelisted_agents_for_local(&self) -> Vec<AccountId> {
        self.whitelisted_agents_for_local.iter().cloned().collect()
    }
}

impl Contract {
    /// Reject every pending approval of an agent without skipping scheduled dates.
    pub(crate) fn reject_agent_approvals(&mut self, agent_id: &AgentId) {
        let open: Vec<PayoutId> = self
            .approvals
            .iter()
            .copied()
            .filter(|id| self.payout_ref(*id).is_some_and(|p| &p.agent_id == agent_id))
            .collect();
        for id in open {
            self.reject_pending(id, false);
        }
    }

    pub(crate) fn agent_view(&self, a: &Agent) -> AgentView {
        AgentView {
            id: a.id.clone(),
            name: a.name.clone(),
            kind: a.kind,
            account_id: a.account_id.clone(),
            account_pinned: a.account_pinned,
            public_key: a.public_key.clone(),
            mandate: a.mandate.clone(),
            status: a.status,
            spent_today: U128(a.spent_today()),
            day_index: U64(block_timestamp_ms() / DAY_MS),
            created_at: U64(a.created_at_ms),
            last_request_at: a.last_request_at_ms.map(U64),
            failed_transfers: a.failed_transfers,
            open_approvals: a.open_approvals,
            tee: a.tee.as_ref().map(|t| {
                let reasons = a.account_id.as_ref().map(|acc| self.tee_invalid_reasons(acc, t)).unwrap_or_default();
                TeeView {
                    measurements: t.measurements.clone(),
                    ppid: t.ppid.clone(),
                    valid_until_ms: U64(t.valid_until_ms),
                    valid: reasons.is_empty(),
                    reasons,
                }
            }),
        }
    }

    /// Reasons a TEE agent may not pay right now (empty = valid). Key agents always return empty.
    pub(crate) fn agent_tee_reasons(&self, a: &Agent) -> Vec<AgentRemovalReason> {
        if a.kind != AgentKind::Tee {
            return Vec::new();
        }
        match (&a.account_id, &a.tee) {
            (Some(acc), Some(t)) => self.tee_invalid_reasons(acc, t),
            _ => vec![AgentRemovalReason::NotRegistered],
        }
    }

    pub(crate) fn tee_invalid_reasons(&self, account_id: &AccountId, t: &TeeRegistration) -> Vec<AgentRemovalReason> {
        let mut reasons = Vec::new();
        if t.valid_until_ms < block_timestamp_ms() {
            reasons.push(AgentRemovalReason::ExpiredAttestation);
        }
        if !self.approved_measurements.contains(&t.measurements) {
            reasons.push(AgentRemovalReason::InvalidMeasurements);
        }
        if !self.approved_ppids.contains(&t.ppid) {
            reasons.push(AgentRemovalReason::InvalidPpid);
        }
        if !self.requires_tee && !self.whitelisted_agents_for_local.contains(account_id) {
            reasons.push(AgentRemovalReason::NotWhitelistedForLocal);
        }
        reasons
    }

    fn require_bindable_account(&self, acc: &AccountId) {
        require!(!self.agent_by_account.contains_key(acc), "Account is already bound to an agent");
        require!(
            acc != &self.owner_id && acc != &env::current_account_id() && acc != &self.treasury_token,
            "Agent account cannot be the owner, the vault or the token"
        );
    }

    pub(crate) fn validate_mandate(&self, m: &Mandate) {
        require!(m.per_tx_limit.0 <= m.daily_limit.0, "per_tx_limit must not exceed daily_limit");
        require!(m.max_payments_per_day >= 1, "max_payments_per_day must be at least 1");
        require!(
            !m.allowed_chains.is_empty() && m.allowed_chains.len() <= MAX_CHAINS_PER_MANDATE,
            "allowed_chains must have 1..=16 entries"
        );
        for c in &m.allowed_chains {
            require!(!c.is_empty() && c.len() <= MAX_CHAIN_LEN, "Invalid chain id");
        }
        require!(m.allowlist.len() <= MAX_ALLOWLIST_PER_MANDATE, "allowlist too long");
        for d in &m.allowlist {
            require!(!d.chain.is_empty() && d.chain.len() <= MAX_CHAIN_LEN, "Invalid allowlist chain");
            require!(!d.address.is_empty() && d.address.len() <= MAX_ADDRESS_LEN, "Invalid allowlist address");
            require!(d.label.as_ref().is_none_or(|l| l.len() <= MAX_LABEL_LEN), "Allowlist label too long");
        }
        require!(m.recipients.len() <= MAX_RECIPIENTS_PER_MANDATE, "Too many recipients");
        for r in &m.recipients {
            require!(self.recipients.contains_key(r), "Mandate references an unknown recipient");
        }
        match m.recipients_mode {
            RecipientsMode::Fixed => require!(!m.recipients.is_empty(), "Fixed mandate needs recipients"),
            RecipientsMode::Allowlist => require!(!m.allowlist.is_empty(), "Allowlist mandate needs an allowlist"),
            RecipientsMode::Open => {}
        }
    }

    pub(crate) fn verify_attestation(
        &self,
        attestation: DstackAttestation,
    ) -> (FullMeasurementsHex, Ppid, Vec<String>) {
        if self.requires_tee {
            let predecessor = env::predecessor_account_id();
            require!(is_implicit_account(predecessor.as_str()), "Account ID must be implicit account");

            // report_data = 32 bytes of the agent's ed25519 public key (its implicit account id), zero-padded to 64.
            let account_id_bytes =
                hex::decode(predecessor.as_str()).unwrap_or_else(|_| env::panic_str("Failed to decode account ID"));
            let mut report_data_bytes = [0u8; 64];
            report_data_bytes[..32].copy_from_slice(&account_id_bytes);
            let expected_report_data = ReportData::from(report_data_bytes);

            let expected_measurements: Vec<FullMeasurements> =
                self.approved_measurements.iter().cloned().map(Into::into).collect();
            let approved_ppids: Vec<Ppid> = self.approved_ppids.iter().cloned().collect();

            match attestation.verify(
                expected_report_data,
                block_timestamp_ms() / 1000,
                &expected_measurements,
                &approved_ppids,
            ) {
                Ok(AcceptedDstackAttestation { measurements, ppid, advisory_ids }) => {
                    (measurements.into(), ppid, advisory_ids)
                }
                Err(e) => env::panic_str(&format!("Attestation verification failed: {e}")),
            }
        } else {
            require!(
                self.whitelisted_agents_for_local.contains(&env::predecessor_account_id()),
                "Agent needs to be whitelisted for local mode"
            );
            let default_measurements = create_mock_full_measurements_hex();
            require!(
                self.approved_measurements.contains(&default_measurements),
                "Default measurements must be approved for local mode"
            );
            require!(self.approved_ppids.contains(&Ppid::default()), "Default PPID must be approved for local mode");
            (default_measurements, Ppid::default(), Vec::new())
        }
    }
}
