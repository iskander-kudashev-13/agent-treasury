/**
 * `credit_refund` and `sync_surplus` are two-phase (docs/adr/0002, audit L1): the first call only records a balance probe,
 * the owner repeats the SAME call at least 60 s later and the contract credits the smaller of the two reads.
 */
export const TWO_PHASE_WAIT_MS = 60_000;
/** Safety margin for block-time skew between the wallet clock and the chain. */
export const TWO_PHASE_MARGIN_MS = 3_000;

/** Whole seconds until the confirm call may be sent (0 = now). */
export function secondsLeft(startedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((startedAtMs + TWO_PHASE_WAIT_MS + TWO_PHASE_MARGIN_MS - nowMs) / 1000));
}

export type TwoPhaseState =
  | { phase: "idle" }
  | { phase: "waiting"; startedAt: number }
  | { phase: "verifying" }
  | { phase: "done" }
  /** The second call ran but nothing was credited. */
  | { phase: "not_credited" };

export const credited = (kind: "refund" | "surplus", before: { refundCredited?: boolean; balance?: string }, after: { refundCredited?: boolean; balance?: string }): boolean =>
  kind === "refund" ? after.refundCredited === true && before.refundCredited !== true : BigInt(after.balance ?? "0") > BigInt(before.balance ?? "0");
