import { t } from "@/i18n";
import { shortDate, DAY_MS } from "./frequency";
import { usdcGrouped } from "@/lib/amount";
import type { UpcomingItem } from "./types";

export interface FundingMessage {
  kind: "balance" | "daily_limit";
  message: string;
  /** daily_limit only: UTC day start (ms). */
  dayStartMs?: number;
}
export interface FundingCheck {
  total: bigint;
  /** > 0 when the vault balance does not cover the listed payments. */
  shortBy: bigint;
  messages: FundingMessage[];
}

/** UI_UPDATES §5.1: upcoming sum vs balance, and each UTC day's sum vs the vault daily limit. Raw USDC strings in. */
export function checkFunding(items: UpcomingItem[], balance: string, vaultDailyLimit: string): FundingCheck {
  const total = items.reduce((a, i) => a + BigInt(i.amount), 0n);
  const bal = BigInt(balance);
  const limit = BigInt(vaultDailyLimit);
  const messages: FundingMessage[] = [];
  const shortBy = total > bal ? total - bal : 0n;
  if (shortBy > 0n) {
    messages.push({ kind: "balance", message: t("funding.balanceShort", { balance: usdcGrouped(balance, 0), short: usdcGrouped(shortBy.toString(), 0) }) });
  }
  const perDay = new Map<number, bigint>();
  for (const i of items) {
    const day = Math.floor(Number(i.due_at) / DAY_MS) * DAY_MS;
    perDay.set(day, (perDay.get(day) ?? 0n) + BigInt(i.amount));
  }
  for (const [day, sum] of [...perDay].sort((a, b) => a[0] - b[0])) {
    if (sum > limit) {
      messages.push({
        kind: "daily_limit",
        dayStartMs: day,
        message: t("funding.dailyLimit", { date: shortDate(day), amount: usdcGrouped((sum - limit).toString(), 0) }),
      });
    }
  }
  return { total, shortBy, messages };
}
