import { describe, expect, it } from "vitest";
import { ASSISTANT_METHODS, NO_DEPOSIT_METHODS, ONE_YOCTO_METHODS, MAX_ACTIONS_PER_TX, buildCall, chunkCalls, describeCall, isAssistantMethod, toTxAction } from "./calls";
import { explorerAddressUrl } from "./config";

describe("buildCall", () => {
  it("attaches exactly 1 yocto to the sensitive methods", () => {
    for (const m of ONE_YOCTO_METHODS) expect(buildCall(m).deposit).toBe("1");
  });
  it("attaches nothing to the no-deposit methods", () => {
    for (const m of NO_DEPOSIT_METHODS) expect(buildCall(m, { skip: false }).deposit).toBe("0");
  });
  it("uses 60 TGas for withdraw, 100 for credit_refund/sync_surplus/approve_payout and 30 TGas otherwise", () => {
    expect(buildCall("withdraw").gas).toBe("60000000000000");
    expect(buildCall("credit_refund").gas).toBe("100000000000000");
    expect(buildCall("sync_surplus").gas).toBe("100000000000000");
    expect(buildCall("approve_payout")).toMatchObject({ deposit: "1", gas: "100000000000000" });
    for (const m of ["withdraw_near", "force_settle_transfer", "set_storage_deposit_yocto", "propose_owner", "accept_owner"] as const) {
      expect(buildCall(m)).toMatchObject({ deposit: "1", gas: "30000000000000" });
    }
    expect(buildCall("set_policy").gas).toBe("30000000000000");
    expect(buildCall("pause").gas).toBe("30000000000000");
  });
});

describe("schedule methods", () => {
  it("add/update/resume/reset need 1 yocto; pause/end need none", () => {
    for (const m of ["add_schedule", "update_schedule", "resume_schedule", "reset_schedule_failures"] as const) expect(buildCall(m)).toMatchObject({ deposit: "1", gas: "30000000000000" });
    expect(buildCall("pause_schedule").deposit).toBe("0");
    expect(buildCall("end_schedule").deposit).toBe("1");
    expect(buildCall("remove_recipient").deposit).toBe("1");
    expect((ONE_YOCTO_METHODS as readonly string[]).includes("reset_recipient_period")).toBe(false);
  });
});

describe("agent methods", () => {
  it("pause/revoke/unbind need no deposit, resume needs 1 yocto", () => {
    for (const m of ["pause_agent", "pause"] as const) expect(buildCall(m).deposit).toBe("0");
    for (const m of ["revoke_agent", "unbind_agent", "pin_agent", "resume_agent", "reset_agent_failures", "resume"] as const) expect(buildCall(m).deposit).toBe("1");
  });
  it("allowlist methods are gone", () => {
    expect((ONE_YOCTO_METHODS as readonly string[]).includes("allowlist_add")).toBe(false);
    expect((NO_DEPOSIT_METHODS as readonly string[]).includes("allowlist_remove")).toBe(false);
  });
});

describe("explorer", () => {
  it("builds address links", () => {
    expect(explorerAddressUrl("abc", "https://testnet.nearblocks.io")).toBe("https://testnet.nearblocks.io/address/abc");
  });
});

describe("payout rejection and trust anchors", () => {
  it("reject_payout needs 1 yocto only when it skips a scheduled date", () => {
    expect(buildCall("reject_payout", { payout_id: "1", skip: true }).deposit).toBe("1");
    expect(buildCall("reject_payout", { payout_id: "1", skip: false }).deposit).toBe("0");
    expect(buildCall("reject_payout", { payout_id: "1" }).deposit).toBe("1"); // contract default skips scheduled dates
    expect(buildCall("remove_schedule", { schedule_id: 1 }).deposit).toBe("0");
  });
  it("removing a local whitelist entry is deposit-free", () => {
    expect(buildCall("remove_agent_from_whitelist_for_local", { account_id: "a.testnet" }).deposit).toBe("0");
  });
});

describe("planned calls", () => {
  it("toTxAction uses the table", () => {
    expect(toTxAction({ method: "end_schedule", args: { schedule_id: 1 } })).toMatchObject({ type: "FunctionCall", deposit: "1", gas: "30000000000000" });
    expect(toTxAction({ method: "remove_schedule", args: { schedule_id: 1 } })).toMatchObject({ deposit: "0" });
    expect(toTxAction({ method: "pin_agent", args: { agent_id: "a" } })).toMatchObject({ deposit: "1" });
  });
  it("assistant may only propose the known methods", () => {
    expect(isAssistantMethod("add_schedule")).toBe(true);
    expect(isAssistantMethod("withdraw")).toBe(false);
    expect(isAssistantMethod("toString")).toBe(false);
    expect(ASSISTANT_METHODS).not.toContain("withdraw");
  });
  it("chunks keeping order", () => {
    const xs = Array.from({ length: MAX_ACTIONS_PER_TX * 2 + 1 }, (_, i) => i);
    const ch = chunkCalls(xs);
    expect(ch).toHaveLength(3);
    expect(ch.flat()).toEqual(xs);
  });
  it("describes calls in plain language", () => {
    expect(describeCall({ method: "pause", args: {} })).toMatch(/Pause the whole vault/);
    expect(describeCall({ method: "pause_agent", args: { agent_id: "payroll" } }, { agent: () => "Payroll" })).toBe("Pause Payroll");
  });
});
