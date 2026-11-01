import type { PayoutStatus } from "./types";

export type Tone = "gray" | "yellow" | "blue" | "green" | "red" | "orange";

export interface StatusInfo {
  label: string;
  tone: Tone;
  /** No further transitions expected from the agent. */
  terminal: boolean;
  hint: string;
}

const MAP: Record<PayoutStatus, StatusInfo> = {
  PendingApproval: { label: "Needs approval", tone: "yellow", terminal: false, hint: "Above approval threshold; waiting for the owner" },
  Rejected: { label: "Rejected", tone: "gray", terminal: true, hint: "Owner rejected; this period is skipped" },
  Transferring: { label: "Transferring", tone: "blue", terminal: false, hint: "Transfer to the deposit address in flight" },
  Sent: { label: "Sent", tone: "blue", terminal: false, hint: "Funds at the Intents deposit address" },
  Confirmed: { label: "Confirmed", tone: "green", terminal: true, hint: "Delivered on the destination chain" },
  Failed: { label: "Failed", tone: "red", terminal: true, hint: "Transfer or swap failed" },
  Refunded: { label: "Refunded", tone: "orange", terminal: true, hint: "Refunded to the vault; owner credits it with credit_refund" },
};

export function payoutStatusInfo(status: string): StatusInfo {
  return (MAP as Record<string, StatusInfo | undefined>)[status] ?? { label: status, tone: "gray", terminal: false, hint: "Unknown status" };
}

/** Only a Refunded payout can be credited back by the owner. */
export const canCreditRefund = (p: { status: string; funds_left?: boolean; refund_credited?: boolean }): boolean =>
  (p.status === "Refunded" || (p.status === "Failed" && p.funds_left === true)) && p.refund_credited !== true;

export const STUCK_TRANSFER_MS = 3_600_000;
/** Transferring for more than 1h: owner may force-settle. */
export const isStuckTransfer = (p: { status: string; updated_at_ms: string }, nowMs: number): boolean =>
  p.status === "Transferring" && nowMs - Number(p.updated_at_ms) > STUCK_TRANSFER_MS;

export const MAX_FAILED_ATTEMPTS = 3;
export const isBlockedRecipient = (failedAttempts: number | undefined): boolean => (failedAttempts ?? 0) >= MAX_FAILED_ATTEMPTS;


/** Tee agent slot not pinned to an account: owner may need to unbind a stale binding. */
export const canUnbind = (a: { kind: string; account_id: string | null }): boolean => a.kind === "Tee" && a.account_id !== null;

/** Deposit address deadline passed (approve_payout would be refused). */
export const isDepositExpired = (expiresMs: string | null, nowMs: number): boolean => expiresMs !== null && Number(expiresMs) < nowMs;

/** Map a status `Tone` to a kit `Accent` (for `<Pill accent>`): green→ok, yellow/orange→warn, red→danger, blue→info, gray→neutral. */
export const toneAccent = (t: Tone): "ok" | "warn" | "danger" | "info" | "neutral" =>
  ({ green: "ok", yellow: "warn", orange: "warn", red: "danger", blue: "info", gray: "neutral" } as const)[t];
