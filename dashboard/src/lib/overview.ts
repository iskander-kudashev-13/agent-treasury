import type { Payout } from "./types";

const DAY = 86_400_000;
/** Statuses where the money has left the vault balance (or is on its way). */
const OUT = new Set(["Transferring", "Sent", "Confirmed"]);

/** USDC paid out per UTC day for the last `days` days, oldest first (last item = today). `raw` units are summed as bigint. */
export function dailyPaidOut(payouts: readonly Payout[], days: number, nowMs: number): { values: number[]; total: bigint } {
  const today = Math.floor(nowMs / DAY);
  const sums = Array.from({ length: days }, () => 0n);
  let total = 0n;
  for (const p of payouts) {
    if (!OUT.has(p.status)) continue;
    const idx = days - 1 - (today - Math.floor(Number(p.created_at_ms) / DAY));
    if (idx < 0 || idx >= days) continue;
    sums[idx] = (sums[idx] ?? 0n) + BigInt(p.amount);
    total += BigInt(p.amount);
  }
  return { values: sums.map((v) => Number(v) / 1e6), total };
}

/** Payouts created today (UTC day), any status. */
export const paymentsToday = (payouts: readonly Payout[], nowMs: number): number => {
  const today = Math.floor(nowMs / DAY);
  return payouts.filter((p) => Math.floor(Number(p.created_at_ms) / DAY) === today).length;
};
