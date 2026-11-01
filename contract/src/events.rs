//! NEP-297 structured events (`EVENT_JSON:` logs). Indexers and the dashboard read these.

use crate::*;

const EVENT_STANDARD: &str = "agent-treasury";
const EVENT_STANDARD_VERSION: &str = "1.0.0";

/// Maximum number of advisory IDs surfaced in an event (log size is bounded).
pub const MAX_ADVISORY_IDS: usize = 8;

pub fn summarize_advisory_ids(advisory_ids: &[String]) -> (Vec<String>, u16) {
    let total = u16::try_from(advisory_ids.len()).unwrap_or(u16::MAX);
    (advisory_ids.iter().take(MAX_ADVISORY_IDS).cloned().collect(), total)
}

#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
#[must_use = "Don't forget to `.emit()` this event"]
pub enum Event<'a> {
    AgentAdded {
        agent_id: &'a str,
        kind: AgentKind,
        account_id: Option<&'a AccountId>,
    },
    AgentRegistered {
        agent_id: &'a str,
        account_id: &'a AccountId,
        measurements: &'a FullMeasurementsHex,
        ppid: &'a Ppid,
        advisory_ids_truncated: Vec<String>,
        number_of_advisory_ids: u16,
        valid_until_ms: U64,
    },
    MandateUpdated {
        agent_id: &'a str,
    },
    AgentStatusChanged {
        agent_id: &'a str,
        status: AgentStatus,
    },
    Deposit {
        sender_id: &'a AccountId,
        amount: U128,
    },
    Withdraw {
        receiver_id: &'a AccountId,
        amount: U128,
        success: bool,
    },
    PolicyUpdated {
        policy: &'a Policy,
    },
    Paused {
        by: &'a AccountId,
    },
    Resumed {
        by: &'a AccountId,
    },
    RecipientUpserted {
        recipient_id: RecipientId,
        recipient: &'a Recipient,
    },
    RecipientRemoved {
        recipient_id: RecipientId,
    },
    PaymentRejected {
        agent_id: &'a str,
        reason: &'a str,
    },
    PayoutPendingApproval {
        payout_id: U64,
        agent_id: &'a str,
        amount: U128,
        reason: &'a str,
    },
    ScheduleUpserted {
        schedule_id: ScheduleId,
        schedule: &'a Schedule,
    },
    ScheduleStatusChanged {
        schedule_id: ScheduleId,
        status: ScheduleStatus,
    },
    PayoutApproved {
        payout_id: U64,
    },
    PayoutRejected {
        payout_id: U64,
    },
    PayoutTransferring {
        payout_id: U64,
        agent_id: &'a str,
        amount: U128,
        deposit_address: &'a AccountId,
    },
    PayoutSent {
        payout_id: U64,
    },
    PayoutTransferFailed {
        payout_id: U64,
    },
    PayoutStatusReported {
        payout_id: U64,
        status: PayoutStatus,
        tx_hash: Option<&'a str>,
    },
    RefundCredited {
        payout_id: U64,
        amount: U128,
    },
    SurplusCredited {
        amount: U128,
    },
    OwnerProposed {
        proposed_owner: &'a AccountId,
    },
    OwnerChanged {
        old_owner: &'a AccountId,
        new_owner: &'a AccountId,
    },
}

impl Event<'_> {
    pub fn emit(&self) {
        let data = serde_json::json!(self);
        let event_json = serde_json::json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_STANDARD_VERSION,
            "event": data["event"],
            "data": [data["data"]]
        })
        .to_string();
        log!("EVENT_JSON:{}", event_json);
    }
}
