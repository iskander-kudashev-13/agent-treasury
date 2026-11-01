import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMandate, planRevoke, planSetup, printPlan, validateSubAccountName } from "../scripts/key-agent-plan.js";

const mandate = loadMandate(join(import.meta.dirname, "../examples/mandate.procurement.json"));

describe("key agent setup plan", () => {
  const plan = planSetup({ network: "testnet", owner: "owner.testnet", vault: "vault.owner.testnet", name: "procurement", agentId: "procurement", displayName: "Procurement", mandate, fundNear: "0.35" });

  it("creates the sub-account, adds a restricted key, then add_agent with 1 yocto", () => {
    expect(plan.map((t) => [t.signer, t.receiver])).toEqual([
      ["owner.testnet", "procurement.owner.testnet"],
      ["procurement.owner.testnet", "procurement.owner.testnet"],
      ["owner.testnet", "vault.owner.testnet"],
    ]);
    expect(plan[1]?.details).toMatchObject({
      receiver_id: "vault.owner.testnet",
      method_names: ["request_payment", "report_payout_status"],
      allowance_near: "0.25",
    });
    expect(plan[2]?.details).toMatchObject({ method: "add_agent", deposit: "1 yoctoNEAR", args: { kind: "Key", account_id: "procurement.owner.testnet", mandate } });
  });

  it("contains no private key material", () => {
    const lines: string[] = [];
    printPlan("t", plan, (s) => lines.push(s));
    expect(lines.join("\n")).not.toMatch(/private/i);
  });

  it("revoke plan: revoke_agent then delete_key", () => {
    const r = planRevoke({ network: "testnet", owner: "owner.testnet", vault: "v.testnet", agentId: "procurement", account: "procurement.owner.testnet", publicKey: "ed25519:abc" });
    expect(r[0]?.details).toMatchObject({ method: "revoke_agent", deposit: "1 yoctoNEAR" });
    expect(r[1]?.description).toMatch(/delete access key ed25519:abc/);
  });
});

describe("mandate file validation", () => {
  const write = (o: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "mandate-")), "m.json");
    writeFileSync(p, JSON.stringify(o));
    return p;
  };
  const ok = { daily_limit: "10", per_tx_limit: "5", approval_threshold: "5", max_payments_per_day: 5, allowed_chains: ["base"], recipients_mode: "Open" };

  it("accepts a minimal Open mandate and fills defaults", () => {
    expect(loadMandate(write(ok))).toMatchObject({ allowlist: [], recipients: [], expires_at: null });
  });
  it.each([
    ["float amounts", { ...ok, daily_limit: "1.5" }],
    ["per-tx above daily", { ...ok, per_tx_limit: "11" }],
    ["Fixed mode", { ...ok, recipients_mode: "Fixed" }],
    ["empty Allowlist", { ...ok, recipients_mode: "Allowlist" }],
    ["zero max_payments_per_day", { ...ok, max_payments_per_day: 0 }],
    ["unknown field", { ...ok, extra: 1 }],
  ])("rejects %s", (_n, m) => {
    expect(() => loadMandate(write(m))).toThrow();
  });
  it("validates sub-account names", () => {
    expect(() => {
      validateSubAccountName("procurement");
    }).not.toThrow();
    expect(() => {
      validateSubAccountName("Bad.Name");
    }).toThrow();
  });
});
