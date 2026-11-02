# ADR-0003: Agents with mandates — refinements and exact on-chain interface

## Date
2026-11-01

## Status
Accepted. Implements `AGENT_ACCESS.md`; supersedes the single-agent parts of ADR-0002 (its money-safety rules still hold).

## Context
`AGENT_ACCESS.md` turns the vault into "many agents, each with a mandate". A few points conflict with facts we verified
(ADR-0001) or with money safety (ADR-0002). This ADR records how we resolve them and fixes the JSON interface that the
worker, MCP server, SDK and dashboard code against.

## Decisions

1. **TEE agents bind to a slot at registration.** Shade Agent v2 generates the agent key inside the enclave at boot, so the
   owner cannot know a TEE agent's `account_id` in advance. The owner creates the agent (`kind = Tee`, optional pinned
   `account_id`), and the enclave calls `register_agent(agent_id, attestation)`. The attestation must verify against the
   vault-wide approved measurements + PPIDs (v2 replaces "codehash"; the spec's `approve_codehash` = `approve_measurements`).
   On success the slot is bound to the caller. The same account re-registering refreshes the attestation; a
   *different* account may bind only if the slot is unbound or the bound account's attestation is no longer valid
   (otherwise the owner must `unbind_agent` first) — so a second instance of the approved image cannot silently take
   over a live slot. If the owner pinned an `account_id`, only that account can bind (in TEE mode it must be implicit).
   Production: verify the bound account in the dashboard after first boot. Local mode (`requires_tee = false`):
   owner-whitelisted dev accounts only.
2. **Rejections do not panic.** `request_payment` returns `PaymentResult::Rejected { reason, detail }` and the transaction
   succeeds, so MCP/SDK clients get a machine-readable reason. Known agents get `last_request_at` and a ring-buffer entry
   (200 entries). Unknown callers (`AGENT_NOT_FOUND`) are not logged (no storage griefing).
3. **Extra reason codes** (beyond the spec): `ATTESTATION_INVALID` (Tee agent not registered / attestation expired / image
   revoked; after check 2), `INVALID_DEPOSIT_ADDRESS` (not a 64-hex implicit account, or the token / vault / an agent account;
   after check 3), `PAYOUT_IN_PROGRESS` (Fixed recipient already has an open payout; after check 7),
   `TOO_MANY_PENDING_APPROVALS` (agent has 5 open approvals; with check 12), `TOO_MANY_FAILED_TRANSFERS` (3 consecutive failed
   transfers for the agent after check 3, for a Fixed recipient after check 7), `INVALID_REQUEST` (bad arguments, e.g.
   memo > 140 bytes, or a payment above the approval threshold without `deposit_expires_at_ms`),
   `BELOW_MIN_PAYMENT` (`amount < policy.min_payment`, before check 8) and `AGENT_DAILY_COUNT_EXCEEDED`
   (`mandate.max_payments_per_day`, after check 9). The last two bound how much NEAR (deposit-account storage
   registration, payout records) a compromised agent can make the vault spend. Rejections are logged at most 50 times
   per agent per day and never for revoked agents (the result is still returned).
4. **Approval executes the stored deposit address**, as the spec says, but the agent may pass `deposit_expires_at_ms`
   (1Click `quote.deadline`); `approve_payout` refuses after it. Agents should request long deadlines for payments above the
   threshold, and pending payouts older than 72 h cannot be approved. `approve_payout` re-runs checks 1–11 for the payout's agent and then reserves and transfers. A failed check
   panics with the reason (owner can then `reject_payout`).
5. **Global policy** is `{ daily_limit, min_payment }` + global `paused`. Per-tx limit, approval threshold, allowlist move into mandates.
6. **Recipients stay vault-level** (CRUD as before, incl. `last_paid_at_ms`, `open_payout`, `failed_attempts`); a Fixed mandate
   references them by id. `request_payout(recipient_id, deposit_address, amount)` is kept as a wrapper that fills chain/address
   from the recipient.
7. **Transfer callback result** becomes the final result of `request_payment`: `Submitted { payout_id }` when `ft_transfer`
   succeeded, `TransferFailed { payout_id }` when it failed and the reservation was released.
8. **Key agents**: contract only checks `predecessor == agent.account_id`. The function-call key restriction is enforced by
   the NEAR runtime on the agent's account. Setup A uses a sub-account of the **owner** (`procurement.<owner>`), since the vault
   account keeps no full-access key (ADR-0002 §8).
9. Fresh deployment: state layout changes freely (nothing deployed yet), no migration. `StorageKey` order is
   append-only from the first deployment on.
10. **Chain ids are 1Click `blockchain` ids** (`base`, `arb`, `sol`, `near`, …) everywhere: mandates, recipients,
    requests. The contract compares strings exactly; SDK/MCP map aliases (`solana` → `sol`) before calling.
11. **What the destination checks prove.** The vault cannot see the 1Click quote, so Fixed/Allowlist modes check the
    destination the agent *declares*. For a TEE agent that is meaningful (its code is attested to quote honestly); for a
    key agent the hard cap is its limits (per-tx, daily amount, daily count) — a compromised key agent could quote to
    another address. The approval threshold can be split into several smaller payments; only the daily limits bind.

## Interface (JSON, as seen by RPC clients)

Amounts: `U128` decimal strings in USDC base units (6 decimals). Times: `U64` strings, ms. Ids: `AgentId` = string
`^[a-z0-9-]{1,32}$`; `RecipientId` = number (u32); `PayoutId` = `U64` string. Enums are serde externally tagged.

```text
Destination   { chain: string, address: string, label: string | null }
RecipientsMode  "Fixed" | "Allowlist" | "Open"
AgentKind       "Tee" | "Key"
AgentStatus     "Active" | "Paused" | "Revoked"
Mandate       { daily_limit, per_tx_limit, approval_threshold: U128, allowed_chains: string[],
                recipients_mode, allowlist: Destination[], recipients: RecipientId[], expires_at: U64 | null,
                max_payments_per_day: number }
AgentView     { id, name, kind, account_id: string | null, public_key: string | null, mandate, status,
                spent_today: U128, day_index: U64, created_at: U64, last_request_at: U64 | null,
                failed_transfers: number, open_approvals: number,
                tee: { measurements, ppid, valid_until_ms: U64, valid: bool, reasons: string[] } | null }
BudgetView    { agent_id, remaining_today: U128, vault_remaining_today: U128, per_tx_limit, approval_threshold,
                allowed_chains, recipients_mode, allowlist, recipients: RecipientId[], expires_at, status,
                vault_paused: bool, balance: U128, min_payment: U128, max_payments_per_day: number,
                payments_today: number }
PaymentResult { "Rejected": { reason: string, detail: string } }
            | { "PendingApproval": { payout_id: U64 } }
            | { "Submitted": { payout_id: U64 } }
            | { "TransferFailed": { payout_id: U64 } }
Payout        { id: U64, agent_id, recipient_id: number | null, chain, address, amount: U128, memo: string | null,
                status: "PendingApproval"|"Transferring"|"Sent"|"Confirmed"|"Failed"|"Refunded"|"Rejected",
                deposit_address: string | null, deposit_expires_at_ms: U64 | null, agent_account: string | null,
                tx_hash: string | null, created_at_ms, updated_at_ms, funds_left: bool, refund_credited: bool, ... }
Rejection     { agent_id, at: U64, reason, detail, chain, address, amount: U128 }
```

Agent calls:
- `request_payment({ chain, address, amount, memo?, recipient_id?, deposit_address, deposit_expires_at_ms? }) -> PaymentResult` (attach 100–150 TGas, no deposit)
- `request_payout({ recipient_id, deposit_address, amount }) -> PaymentResult` (wrapper)
- `report_payout_status({ payout_id, status: "Confirmed"|"Refunded"|"Failed", tx_hash? })` (creating agent, owner, or an attested TEE agent for Key agents' payouts — ADR-0002 amendment 2026-11-02)
- `register_agent({ agent_id, attestation })` (Tee only)

Owner calls (1 yoctoNEAR unless marked *no deposit*):
- `add_agent({ id, name, kind, account_id?, public_key?, mandate }) -> AgentView`, `update_mandate({ agent_id, mandate })`,
  `pause_agent({ agent_id })` *no deposit*, `resume_agent({ agent_id })`, `revoke_agent({ agent_id })` *no deposit*
- `set_policy({ policy: { daily_limit, min_payment } })`, `pause()` *no deposit*, `resume()`
- `approve_payout({ payout_id })` (≥ 100 TGas), `reject_payout({ payout_id })` *no deposit*
- recipients CRUD, `withdraw`, `credit_refund`, `sync_surplus`, `withdraw_near`, `force_settle_transfer`,
  `approve_measurements`, `approve_ppids`, `whitelist_agent_for_local`, … (unchanged from ADR-0002)

- `unbind_agent({ agent_id })` *no deposit*, `reset_agent_failures({ agent_id })`; `update_contract` needs 1 yocto.

Views: `get_agents({from_index?, limit?})`, `get_agent({agent_id})`, `get_agent_by_account({account_id})`,
`get_agent_budget({agent_id})`, `get_payouts({from_index?: number, limit?, agent_id?})` (with `agent_id`, `from_index` is the
position in that agent's list), `get_payouts_count()`, `get_agent_payouts_count({agent_id})`, `get_payout({payout_id})`,
`get_pending_approvals()`, `get_rejections({from_index?, limit?, agent_id?})` (newest first), `get_policy()`
→ `{ daily_limit, min_payment, paused }`, `get_balance()`, `get_recipients`, `get_recipient`, `get_due_recipients({agent_id?, now_ms?})`,
`get_contract_info()`.

## Consequences
- Contract: rewrite of `agent.rs`, `payout.rs`, `owner.rs`, `views.rs`; tests rewritten for AGENT_ACCESS §3.7.
- Worker: becomes Tee agent `payroll`; registers with `agent_id`; handles `PaymentResult`.
- New `/sdk` and `/mcp` packages; dashboard Agents UI (needs `DESIGN_AGENTS.md`).

## Amendments after the security audit (docs/security/audit-2026-11-01.md)
- Deposit rule refined: only *pausing* is deposit-free (`pause`, `pause_agent`, `pause_schedule`) plus reversible
  restrictions (`remove_measurements`, `remove_ppids`, `remove_agent_from_whitelist_for_local`, `remove_schedule`,
  `reject_payout` that keeps the date). Irreversible or slot-reopening owner actions need 1 yoctoNEAR: `revoke_agent`,
  `unbind_agent`, `end_schedule`, `remove_recipient`, `reject_payout` that skips a scheduled date. A leaked dashboard
  login (function-call) key can therefore only pause.
- `pin_agent(agent_id)` (1 yocto): pin a TEE slot to the account currently bound, after the owner verified it.
- `unbind_agent` and a takeover rebind in `register_agent` reject the slot's open approvals (dates stay payable);
  `approve_payout` refuses payouts whose `agent_account` is not the slot's current account.
- `new(..., allow_insecure_local_mode)`: `requires_tee = false` must be requested explicitly.
- Off-chain (H1/H2): the TEE worker's routing config is pinned in the measured compose; the dashboard checks the
  1Click quote behind a deposit address (`/v0/status`) before enabling Approve.
