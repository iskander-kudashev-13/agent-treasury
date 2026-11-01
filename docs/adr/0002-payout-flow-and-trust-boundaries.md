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
