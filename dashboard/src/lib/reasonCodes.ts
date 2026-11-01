// Rejection reason codes (contract/src/payment.rs, ADR-0003 §3) -> short human titles. Refusals are normal operation, not errors.
const TITLES: Record<string, string> = {
  VAULT_PAUSED: "The vault is paused",
  AGENT_NOT_FOUND: "Unknown agent",
  AGENT_REVOKED: "The agent is revoked",
  AGENT_PAUSED: "The agent is paused",
  AGENT_EXPIRED: "The agent's mandate has expired",
  CHAIN_NOT_ALLOWED: "Chain not in the mandate",
  RECIPIENT_NOT_ALLOWED: "Recipient not in the mandate",
  AMOUNT_MISMATCH: "Amount differs from the schedule",
  NOT_DUE: "Not due yet",
  PER_TX_LIMIT_EXCEEDED: "Over the per payment limit",
  AGENT_DAILY_LIMIT_EXCEEDED: "Over the agent's daily limit",
  AGENT_DAILY_COUNT_EXCEEDED: "Too many payments today",
  VAULT_DAILY_LIMIT_EXCEEDED: "Over the vault's daily limit",
  INSUFFICIENT_BALANCE: "Not enough balance in the vault",
  BELOW_MIN_PAYMENT: "Below the minimum payment",
  ATTESTATION_INVALID: "Enclave attestation is not valid",
  INVALID_DEPOSIT_ADDRESS: "Invalid deposit address",
  PAYOUT_IN_PROGRESS: "A payment to this recipient is already in progress",
  TOO_MANY_PENDING_APPROVALS: "Too many payments waiting for approval",
  TOO_MANY_FAILED_TRANSFERS: "Paused after repeated failed transfers",
  INVALID_REQUEST: "Invalid request",
  NEEDS_APPROVAL: "Waiting for your approval",
  OVERDUE_NEEDS_APPROVAL: "Overdue, waiting for your approval",
  SCHEDULE_NOT_ACTIVE: "Schedule is not active",
  SCHEDULE_NOT_FOUND: "Schedule not found",
};

/** "Refused: Over the agent's daily limit". Unknown codes fall back to the code itself. */
export const reasonTitle = (code: string): string => TITLES[code] ?? code;
export const refusedTitle = (code: string): string => `Refused: ${reasonTitle(code)}`;

const TEE_REASONS: Record<string, string> = {
  ExpiredAttestation: "Attestation expired. The enclave must register again.",
  InvalidMeasurements: "The enclave image is no longer approved (measurements removed on Policy).",
  InvalidPpid: "The hardware (PPID) is no longer approved on Policy.",
  NotWhitelistedForLocal: "Account is not whitelisted for local mode.",
  NotRegistered: "No attestation yet.",
};
export const teeReasonText = (r: string): string => TEE_REASONS[r] ?? r;
