// Rejection reason codes (contract/src/payment.rs, ADR-0003 §3) -> short human titles. Refusals are normal operation, not errors.
// The codes stay as the contract sends them; their human text lives in the i18n dictionaries (`reason.<CODE>`, `tee.<Reason>`).
import { t } from "@/i18n";

const REASON_CODES = ["VAULT_PAUSED", "AGENT_NOT_FOUND", "AGENT_REVOKED", "AGENT_PAUSED", "AGENT_EXPIRED", "CHAIN_NOT_ALLOWED", "RECIPIENT_NOT_ALLOWED", "AMOUNT_MISMATCH", "NOT_DUE", "PER_TX_LIMIT_EXCEEDED", "AGENT_DAILY_LIMIT_EXCEEDED", "AGENT_DAILY_COUNT_EXCEEDED", "VAULT_DAILY_LIMIT_EXCEEDED", "INSUFFICIENT_BALANCE", "BELOW_MIN_PAYMENT", "ATTESTATION_INVALID", "INVALID_DEPOSIT_ADDRESS", "PAYOUT_IN_PROGRESS", "TOO_MANY_PENDING_APPROVALS", "TOO_MANY_FAILED_TRANSFERS", "INVALID_REQUEST", "NEEDS_APPROVAL", "OVERDUE_NEEDS_APPROVAL", "SCHEDULE_NOT_ACTIVE", "SCHEDULE_NOT_FOUND"] as const;
type ReasonCode = (typeof REASON_CODES)[number];

/** "Over the agent's daily limit". Unknown codes fall back to the code itself. */
export const reasonTitle = (code: string): string => ((REASON_CODES as readonly string[]).includes(code) ? t(`reason.${code as ReasonCode}`) : code);
/** "Refused: Over the agent's daily limit". */
export const refusedTitle = (code: string): string => t("reason.refused", { title: reasonTitle(code) });

const TEE_REASONS = ["ExpiredAttestation", "InvalidMeasurements", "InvalidPpid", "NotWhitelistedForLocal", "NotRegistered"] as const;
type TeeReason = (typeof TEE_REASONS)[number];
export const teeReasonText = (r: string): string => ((TEE_REASONS as readonly string[]).includes(r) ? t(`tee.${r as TeeReason}`) : r);
