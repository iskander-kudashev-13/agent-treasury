import { describe, expect, it } from "vitest";
import { filterActivity, mergeActivity } from "./AgentActivity";
import type { Payout, Rejection } from "@/lib/types";

const payout = (id: string, status: Payout["status"], at: number): Payout =>
  ({ id, agent_id: "a", agent_account: null, schedule_id: null, occurrence_at: null, approval_reason: null, recipient_id: null, chain: "base", address: "0x", amount: "1", memo: null, status, deposit_address: null, deposit_expires_at_ms: null, tx_hash: null, created_at_ms: String(at), updated_at_ms: String(at) }) as Payout;
const rej = (at: number): Rejection => ({ agent_id: "a", at: String(at), reason: "AGENT_DAILY_LIMIT_EXCEEDED", detail: "d", chain: "base", address: "0x", amount: "1" });

describe("activity", () => {
  const items = mergeActivity([payout("1", "Confirmed", 100), payout("2", "PendingApproval", 300), payout("3", "Rejected", 50)], [rej(200)]);
  it("merges newest first", () => {
    expect(items.map((i) => i.at)).toEqual([300, 200, 100, 50]);
  });
  it("filters", () => {
    expect(filterActivity(items, "all")).toHaveLength(4);
    expect(filterActivity(items, "paid").map((i) => i.at)).toEqual([100]);
    expect(filterActivity(items, "pending").map((i) => i.at)).toEqual([300]);
    expect(filterActivity(items, "rejected").map((i) => i.at)).toEqual([200, 50]);
  });
});
