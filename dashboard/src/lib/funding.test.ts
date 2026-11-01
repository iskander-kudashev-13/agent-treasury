import { describe, expect, it } from "vitest";
import { checkFunding } from "./funding";
import type { UpcomingItem } from "./types";

const U = (n: number) => String(n * 1_000_000);
const DEC1 = 1_796_117_400_000;
const item = (amount: number, due: number): UpcomingItem => ({ schedule_id: 0, recipient_id: 0, agent_id: "payroll", amount: U(amount), due_at: String(due), will_need_approval: false });

describe("checkFunding", () => {
  it("is quiet when funded and under the daily limit", () => {
    const r = checkFunding([item(1500, DEC1), item(40, DEC1 + 2 * 86_400_000)], U(5000), U(5000));
    expect(r.messages).toEqual([]);
    expect(r.total).toBe(BigInt(U(1540)));
  });
  it("warns when balance is short", () => {
    const r = checkFunding([item(1500, DEC1), item(2000, DEC1 + 86_400_000), item(800, DEC1 + 2 * 86_400_000)], U(3100), U(9999));
    expect(r.shortBy).toBe(BigInt(U(1200)));
    expect(r.messages[0]?.message).toBe("Vault balance 3,100 USDC — short by 1,200 for these.");
  });
  it("warns per day against the vault daily limit", () => {
    const r = checkFunding([item(1500, DEC1), item(2000, DEC1 + 3_600_000)], U(10000), U(3000));
    expect(r.messages).toEqual([{ kind: "daily_limit", dayStartMs: 1_796_083_200_000, message: "1 Dec exceeds the vault's daily limit; 500 will move to the next day." }]);
  });
});
