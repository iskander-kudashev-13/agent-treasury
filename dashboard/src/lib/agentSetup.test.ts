import { describe, expect, it } from "vitest";
import { ALLOWANCE_YOCTO, envSnippet, isImplicitAccount, isNearAccountId, mcpConfig, nearToYocto, planDeleteAgentKey, planKeyAgentCreate, planKeyAgentExisting, planTeeSlot, slugify, validateAccountPrefix, validateAgentId, validateFund } from "./agentSetup";
import { buildCall } from "./calls";
import { generateAgentKey, isEd25519PublicKey } from "./keygen";
import type { Mandate } from "./types";

const mandate: Mandate = { daily_limit: "1", per_tx_limit: "1", approval_threshold: "0", allowed_chains: ["base"], recipients_mode: "Open", allowlist: [], recipients: [], expires_at: null, max_payments_per_day: 5 };

describe("names", () => {
  it("slugify", () => {
    expect(slugify("Procurement Bot!")).toBe("procurement-bot");
    expect(slugify("  --A__b--  ")).toBe("a-b");
    expect(slugify("x".repeat(40)).length).toBe(32);
    expect(slugify("Ünï")).toBe("n");
  });
  it("agent id", () => {
    expect(validateAgentId("payroll")).toBeNull();
    expect(validateAgentId("Payroll")).toBeTruthy();
    expect(validateAgentId("")).toBeTruthy();
    expect(validateAgentId("a", ["a"])).toMatch(/exists/);
  });
  it("account prefix and ids", () => {
    expect(validateAccountPrefix("procurement", "alice.near")).toBeNull();
    expect(validateAccountPrefix("a.b", "alice.near")).toBeTruthy();
    expect(validateAccountPrefix("x".repeat(32), "o".repeat(40) + ".near")).toMatch(/64/);
    expect(isNearAccountId("proc.alice.testnet")).toBe(true);
    expect(isNearAccountId("Bad")).toBe(false);
    expect(isImplicitAccount("a".repeat(64))).toBe(true);
    expect(isImplicitAccount("a".repeat(63))).toBe(false);
  });
});

describe("amounts", () => {
  it("nearToYocto", () => {
    expect(nearToYocto("0.25")).toBe(ALLOWANCE_YOCTO);
    expect(nearToYocto("1")).toBe("1000000000000000000000000");
    expect(() => nearToYocto("x")).toThrow();
    expect(validateFund("0.35")).toBeNull();
    expect(validateFund("0.01")).toMatch(/0.05/);
    expect(validateFund("abc")).toBeTruthy();
  });
});

describe("plans", () => {
  const base = { id: "procurement", name: " Procurement ", mandate };
  it("setup A: create account + function-call key, then add_agent with 1 yocto", () => {
    const txs = planKeyAgentCreate({ ...base, owner: "alice.near", vault: "vault.alice.near", prefix: "procurement", publicKey: "ed25519:PK", fundNear: "0.35" });
    expect(txs).toHaveLength(2);
    expect(txs[0]!.receiverId).toBe("procurement.alice.near");
    expect(txs[0]!.actions).toEqual([
      { type: "CreateAccount" },
      { type: "Transfer", yocto: "350000000000000000000000" },
      { type: "AddKeyFunctionCall", publicKey: "ed25519:PK", receiverId: "vault.alice.near", methodNames: ["request_payment", "report_payout_status"], allowanceYocto: ALLOWANCE_YOCTO },
    ]);
    const call = txs[1]!.actions[0]!;
    expect(txs[1]!.receiverId).toBe("vault.alice.near");
    expect(call).toMatchObject({ type: "FunctionCall", method: "add_agent", deposit: "1" });
    expect((call as { args: Record<string, unknown> }).args).toEqual({ id: "procurement", name: "Procurement", kind: "Key", account_id: "procurement.alice.near", public_key: "ed25519:PK", mandate });
  });
  it("never adds a full-access key unless one is given", () => {
    const withFa = planKeyAgentCreate({ ...base, owner: "a.near", vault: "v.a.near", prefix: "p", publicKey: "ed25519:PK", fundNear: "0.1", ownerFullAccessKey: "ed25519:FA" });
    expect(withFa[0]!.actions.at(-1)).toEqual({ type: "AddKeyFullAccess", publicKey: "ed25519:FA" });
    const without = planKeyAgentCreate({ ...base, owner: "a.near", vault: "v.a.near", prefix: "p", publicKey: "ed25519:PK", fundNear: "0.1" });
    expect(without[0]!.actions.some((a) => a.type === "AddKeyFullAccess")).toBe(false);
  });
  it("setup B only calls add_agent", () => {
    const txs = planKeyAgentExisting({ ...base, vault: "v.near", accountId: "bot.near", publicKey: null });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.actions[0]).toMatchObject({ method: "add_agent", args: { kind: "Key", account_id: "bot.near", public_key: null } });
  });
  it("TEE slot has no key and an optional pinned account", () => {
    const slot = planTeeSlot({ ...base, vault: "v.near", pinnedAccount: null });
    expect(slot[0]!.actions[0]).toMatchObject({ args: { kind: "Tee", account_id: null, public_key: null } });
    const pinned = planTeeSlot({ ...base, vault: "v.near", pinnedAccount: "a".repeat(64) });
    expect(pinned[0]!.actions[0]).toMatchObject({ args: { account_id: "a".repeat(64) } });
  });
  it("delete key", () => {
    expect(planDeleteAgentKey("bot.alice.near", "ed25519:PK")).toMatchObject({ receiverId: "bot.alice.near", actions: [{ type: "DeleteKey", publicKey: "ed25519:PK" }] });
  });
});

describe("snippets and keys", () => {
  const c = { vault: "v.near", network: "mainnet", account: "p.a.near", privateKey: "ed25519:SECRET" };
  it("env", () => {
    expect(envSnippet(c)).toBe("TREASURY_VAULT=v.near\nTREASURY_NETWORK=mainnet\nTREASURY_AGENT_ACCOUNT=p.a.near\nTREASURY_AGENT_PRIVATE_KEY=ed25519:SECRET\n");
  });
  it("mcp config keeps the secret out when asked", () => {
    expect(mcpConfig(c, "env")).not.toContain("SECRET");
    expect(JSON.parse(mcpConfig(c, c.privateKey)).mcpServers["agent-treasury"].env.TREASURY_AGENT_PRIVATE_KEY).toBe("ed25519:SECRET");
  });
  it("generates a fresh ed25519 pair", () => {
    const a = generateAgentKey();
    const b = generateAgentKey();
    expect(isEd25519PublicKey(a.publicKey)).toBe(true);
    expect(a.secretKey.startsWith("ed25519:")).toBe(true);
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

describe("agent call table", () => {
  it("1 yocto for restoring/irreversible calls, none for pause", () => {
    for (const m of ["add_agent", "update_mandate", "resume_agent", "revoke_agent", "unbind_agent", "pin_agent"] as const) expect(buildCall(m).deposit).toBe("1");
    expect(buildCall("pause_agent").deposit).toBe("0");
  });
});
