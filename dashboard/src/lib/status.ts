import { t } from "@/i18n";
import type { PayoutStatus } from "./types";

export type Tone = "gray" | "yellow" | "blue" | "green" | "red" | "orange";

export interface StatusInfo {
  label: string;
  tone: Tone;
  /** No further transitions expected from the agent. */
  terminal: boolean;
  hint: string;
}

const MAP: Record<PayoutStatus, { tone: Tone; terminal: boolean }> = {
  PendingApproval: { tone: "yellow", terminal: false },
  Rejected: { tone: "gray", terminal: true },
  Transferring: { tone: "blue", terminal: false },
  Sent: { tone: "blue", terminal: false },
  Confirmed: { tone: "green", terminal: true },
  Failed: { tone: "red", terminal: true },
  Refunded: { tone: "orange", terminal: true },
};

/** Label and hint are looked up at call time in the current language. */
export function payoutStatusInfo(status: string): StatusInfo {
  const m = (MAP as Record<string, { tone: Tone; terminal: boolean } | undefined>)[status];
  if (!m) return { label: status, tone: "gray", terminal: false, hint: t("statusHint.unknown") };
  const s = status as PayoutStatus;
  return { ...m, label: t(`status.${s}`), hint: t(`statusHint.${s}`) };
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
