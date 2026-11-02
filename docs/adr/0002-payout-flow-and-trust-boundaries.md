# ADR-0002: Payout flow, approvals and what the agent is trusted with

## Date
2026-11-01

## Status
Accepted (v1). Revisit item "deposit address binding" for v2.

## Context
1Click ORIGIN_CHAIN deposits for NEAR USDC (`nep141:17208628…a1`) return a fresh 64-hex implicit account as `depositAddress`
that does not exist yet and is not registered on the USDC contract (storage bound 0.00125 NEAR). The quote is produced off-chain,
so the contract cannot see which recipient a deposit address will pay. 1Click has no testnet.

## Decisions
1. **Transfer = one batch receipt to the token contract**: `storage_deposit(account_id=deposit, registration_only=true)` + `ft_transfer(1 yocto)`.
   Actions in one receipt are atomic: if `ft_transfer` fails, the storage deposit is reverted and refunded.
   Callback `on_transfer_result` (`#[private]`, never panics) releases the reservation on failure.
2. **Reserve before transfer**: `balance`, `spent_today`, `last_paid_at`, `in_flight` are updated before the promise is created;
   a recipient with an in-flight payout cannot be requested again.
3. **Large payouts**: `amount > approval_threshold` creates a `PendingApproval` payout with **no deposit address** and no reservation.
   The owner approves → status `Approved`; the agent's next `request_payout` for that recipient (with a fresh quote) executes it.
   Reason: 1Click deposit addresses expire; approving a stale address could lose funds. Reject = skip this period.
4. **Agent status reports never move money**. `report_payout_status` only annotates (`Confirmed` / `Refunded` / `Failed`, tx hash).
   Refunds land back on the vault as plain `ft_transfer`, which the vault cannot observe. The owner credits them with
   `credit_refund(payout_id, amount?)` (partial refunds allowed) or `sync_surplus()` (any untracked tokens). Both read
   `ft_balance_of` and credit only if `actual >= balance + in_flight + amount`, and both refuse if an outflow settled
   between the read and the callback (`outflow_epoch` guard). A lying agent cannot inflate the balance.
5. **Owner never locked out**: `withdraw` ignores pause and agent state; `sync_surplus` recovers stray tokens; `withdraw_near` recovers NEAR not locked for storage; `force_settle_transfer` settles a payout whose callback never ran (after 1 h). Sensitive owner methods require 1 yoctoNEAR
   (full-access key / wallet confirmation); `pause()` deliberately does not, so the kill switch also works from a function-call key.
6. **Deposit address must be a 64-hex implicit account** (the shape 1Click returns) and cannot be the token contract, the vault, the caller, or a registered agent.
7. **Failure loop bound**: 3 consecutive failed transfers block a recipient until the owner resets it (each attempt stores a payout entry paid by the vault).
8. **Upgrades**: owner-gated `update_contract` → `migrate`. After deployment the vault account's own full-access key should be deleted, so code can only change through the owner path. Ownership moves in two steps (`propose_owner` / `accept_owner`).

## Trust boundary (documented in README)
A compromised or buggy agent can at most: send **the configured amount** for **a due recipient**, **once per period**, within
`per_tx_limit` and `daily_limit`, while not paused — to a deposit address of its choosing. The worker also chooses the quote's `refundTo` (it must be the vault); a compromised worker could set its own address there, which matters only if 1Click refunds. It cannot change amounts, recipients,
limits, approve its own large payouts, withdraw, or register other agents. In TEE mode the agent code is pinned by approved
measurements, so the developer cannot swap it for code that picks a different deposit address.

## Open for v2
Bind the deposit address to the recipient on-chain by verifying the 1Click quote `signature` (`env::ed25519_verify`) and checking
`quoteRequest.recipient` / `destinationAsset` against the recipient record — needs 1Click's signing key and payload format.

## Amendment (audit L1, 2026-11-01): two-phase balance confirmation
`credit_refund` and `sync_surplus` read `ft_balance_of`, but with NEP-141 `ft_transfer_call` the token contract credits the
vault one receipt *before* `ft_on_transfer` runs here, so a single read can include a deposit that is about to be credited
again. Both methods are now two-phase: the first call records a probe of untracked tokens; a second call at least 60 s
later credits `min(first, second)` (for a refund: the refund amount only if the confirmed untracked amount covers it).
An outflow settling between the reads clears the probe. The dashboard guides the owner through the two steps.

## Amendment (2026-11-02): status reporting for Key agents' payouts

Found in the testnet e2e run: a Key agent (MCP server inside a chat client) gets `pending_approval` and returns at
once. When the owner approves later, the vault transfers to the deposit address and the payout is `Sent`, but nobody
polls 1Click or calls `report_payout_status`: the payout stays `Sent` until the agent happens to ask for its status.

Decision: `report_payout_status` may also be called by an **attested TEE agent** (kind `Tee`, `Active`, registration
valid now: attestation not expired, measurements and PPID approved, local-mode whitelist when TEE is not required),
**only for payouts created by Key agents**. TEE agents still report only their own payouts. Owner and creator rights
are unchanged. The worker's reconcile step (each run) scans the newest `reconcileWindow` vault payouts for `Sent`
payouts of Key agents and reports the terminal status it reads from 1Click itself.

Why this is safe: the report is an annotation and never moves money. The worker's code is attested, and it uses the
same 1Click status check as for its own payouts. A false report can only mislabel a payout, but a false `Confirmed`
is final: `credit_refund` needs `Refunded`/`Failed`, and status only moves from `Sent`. Recovery for refunded tokens
behind a wrong `Confirmed` is `sync_surplus` (owner credits the vault's untracked token surplus, not linked to the
payout). The same was already true for creator reports; the owner can always check the Intents explorer.

Scan: payout ids are creation order, while a Key payout becomes `Sent` when approved (up to 72 h later,
`MAX_APPROVAL_AGE_MS`). The worker pages `get_payouts` backwards until a page is entirely older than 14 days
(`KEY_RECONCILE_HORIZON_MS`, max 20 pages of 100) and looks up `get_agent` only for agents seen there. Older `Sent`
payouts are left to the owner. On testnet with simulated 1Click the worker reports `SUCCESS` for any address; do not
share a simulated-mode worker with a testnet vault used for real-mode tests. Rejected alternatives:
MCP keeps polling (the process is usually gone), owner reports by hand (kills autonomy), a separate reporter role in
the policy (extra state and UI for the same trust level).
