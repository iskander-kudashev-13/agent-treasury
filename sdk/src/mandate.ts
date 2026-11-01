import { normalizeChain, sameAddress } from "./chains.js";
import { formatUsdc, parseU128 } from "./units.js";
import type { BudgetView } from "./vault.js";

export interface MandatePreview {
  /** First failing check in the AGENT_ACCESS section 3.4 order, if any. */
  wouldReject?: { reason: string; detail: string };
  /** amount > approval_threshold (only meaningful when nothing rejects). */
  needsApproval: boolean;
}

/**
 * Client-side PREVIEW of the contract's `request_payment` checks (AGENT_ACCESS 3.4 order, first failure wins).
 * Not authoritative: the contract re-checks everything. Checks that need data a plain
 * agent does not have (Fixed-mandate recipient/amount/due, attestation, open-payout, failed-transfer counters) are not previewed.
 */
export function previewMandate(budget: BudgetView, req: { chain: string; address: string; amount: bigint; nowMs: number }): MandatePreview {
  const rejectWith = (reason: string, detail: string): MandatePreview => ({ wouldReject: { reason, detail }, needsApproval: false });
  const name = budget.agent_id;
  const usdc = (v: bigint) => `${formatUsdc(v)} USDC`;

  // 1. global pause
  if (budget.vault_paused) return rejectWith("VAULT_PAUSED", "The vault is paused by its owner; no agent can pay right now.");
  // 2. agent status
  if (budget.status === "Revoked") return rejectWith("AGENT_REVOKED", `Agent '${name}' has been revoked and can never pay again.`);
  if (budget.status === "Paused") return rejectWith("AGENT_PAUSED", `Agent '${name}' is paused by the vault owner.`);
  // 3. expiry
  if (budget.expires_at !== null && req.nowMs > Number(budget.expires_at)) {
    return rejectWith("AGENT_EXPIRED", `The mandate of agent '${name}' expired at ${new Date(Number(budget.expires_at)).toISOString()}.`);
  }
  // 4. chain (compare after alias normalization so "solana" in a mandate matches 1Click's "sol")
  const allowedChains = budget.allowed_chains.map(normalizeChain);
  if (!allowedChains.includes(req.chain)) {
    return rejectWith("CHAIN_NOT_ALLOWED", `Chain '${req.chain}' is not allowed for agent '${name}'. Allowed: ${budget.allowed_chains.join(", ") || "none"}.`);
  }
  // 5. recipient
  if (budget.recipients_mode === "Fixed") {
    return rejectWith(
      "RECIPIENT_NOT_ALLOWED",
      `Fixed agents only pay their scheduled payments; agent '${name}' cannot make on-demand payments.`,
    );
  }
  if (budget.recipients_mode === "Allowlist") {
    const hit = budget.allowlist.some((d) => normalizeChain(d.chain) === req.chain && sameAddress(d.address, req.address));
    if (!hit) return rejectWith("RECIPIENT_NOT_ALLOWED", `Address ${req.address} on '${req.chain}' is not in the allowlist of agent '${name}'.`);
  }
  // 6-7. AMOUNT_MISMATCH / NOT_DUE: Fixed only (handled above)
  // BELOW_MIN_PAYMENT (ADR-0003 decision 3): before the per-tx check
  const minPayment = parseU128(budget.min_payment);
  if (req.amount < minPayment) return rejectWith("BELOW_MIN_PAYMENT", `The minimum payment is ${usdc(minPayment)}; requested ${usdc(req.amount)}.`);
  // 8. per-tx limit
  const perTx = parseU128(budget.per_tx_limit);
  if (req.amount > perTx) return rejectWith("PER_TX_LIMIT_EXCEEDED", `Per-transaction limit for agent '${name}' is ${usdc(perTx)}; requested ${usdc(req.amount)}.`);
  // 9. agent daily limit (remaining_today is already rolled over by the view)
  const remaining = parseU128(budget.remaining_today);
  if (req.amount > remaining) {
    return rejectWith("AGENT_DAILY_LIMIT_EXCEEDED", `Agent '${name}' has ${usdc(remaining)} left of its daily limit today; requested ${usdc(req.amount)}.`);
  }
  // 9b. agent daily payment count
  if (budget.payments_today >= budget.max_payments_per_day) {
    return rejectWith("AGENT_DAILY_COUNT_EXCEEDED", `Agent '${name}' already made ${budget.payments_today} of its ${budget.max_payments_per_day} allowed payments today.`);
  }
  // 10. vault daily limit
  const vaultRemaining = parseU128(budget.vault_remaining_today);
  if (req.amount > vaultRemaining) {
    return rejectWith("VAULT_DAILY_LIMIT_EXCEEDED", `The vault has ${usdc(vaultRemaining)} left of its global daily limit today; requested ${usdc(req.amount)}.`);
  }
  // 11. balance
  const balance = parseU128(budget.balance);
  if (req.amount > balance) return rejectWith("INSUFFICIENT_BALANCE", `The vault balance is ${usdc(balance)}; requested ${usdc(req.amount)}.`);
  // 12. approval threshold (strictly above)
  return { needsApproval: req.amount > parseU128(budget.approval_threshold) };
}
