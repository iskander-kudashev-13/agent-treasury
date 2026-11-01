import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { SdkError } from "agent-treasury-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { FakeClient } from "./fake-client.js";

const NAMES = ["treasury_get_budget", "treasury_list_allowed_recipients", "treasury_quote_payment", "treasury_request_payment", "treasury_get_payment_status"];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function connect(fake = new FakeClient()) {
  const server = buildServer(fake);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    return { r, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { client, fake, call };
}

describe("tool registration", () => {
  it("exposes exactly the five public tools with the required guidance", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    const req = tools.find((t) => t.name === "treasury_request_payment");
    const d = req?.description ?? "";
    expect(d).toMatch(/USDC/);
    expect(d).toMatch(/FINAL/);
    expect(d).toMatch(/relay the `detail`/);
    expect(d).toMatch(/pending_approval/);
    expect(d).toMatch(/human owner must approve it in the dashboard/);
    expect(d).toMatch(/NEVER split/);
    expect(d).toMatch(/untrusted/);
    for (const t of tools.filter((x) => x.name !== "treasury_list_allowed_recipients")) expect(t.description).toMatch(/USDC/);
  });

  it("declares input schemas and read-only hints", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const req = tools.find((t) => t.name === "treasury_request_payment");
    expect(Object.keys((req?.inputSchema.properties ?? {}) as object).sort()).toEqual(["address", "amount_usdc", "chain", "memo"]);
    expect(req?.inputSchema.required).toEqual(["chain", "address", "amount_usdc"]);
    expect(req?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "treasury_get_budget")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("handlers", () => {
  it("get_budget maps to the spec shape", async () => {
    const { call, fake } = await connect();
    expect((await call("treasury_get_budget")).json).toEqual({
      remaining_today_usdc: "200",
      per_tx_limit_usdc: "100",
      approval_threshold_usdc: "100",
      min_payment_usdc: "1",
      payments_left_today: 8,
      allowed_chains: ["base", "sol"],
      recipients_mode: "Open",
      status: "Active",
    });
    fake.budget = { ...fake.budget, recipientsMode: "Allowlist", allowlist: fake.destinations, expiresAt: "2027-01-01T00:00:00.000Z", vaultPaused: true };
    expect((await call("treasury_get_budget")).json).toMatchObject({ allowlist: fake.destinations, expires_at: "2027-01-01T00:00:00.000Z", status: "VaultPaused" });
  });

  it("list_allowed_recipients returns the Destination[] array", async () => {
    const { call, fake } = await connect();
    expect((await call("treasury_list_allowed_recipients")).text).toBe(JSON.stringify(fake.destinations, null, 2));
  });

  it("quote_payment passes USDC strings through and snake_cases the result", async () => {
    const { call, fake } = await connect();
    const { json } = await call("treasury_quote_payment", { chain: "base", address: "0xabc", amount_usdc: "50" });
    expect(json).toEqual({ ok: true, needs_approval: false, estimated_fee_usdc: "0.0024", estimated_arrival_s: 12 });
    expect(fake.calls.at(-1)).toEqual({ method: "quotePayment", args: { chain: "base", address: "0xabc", amountUsdc: "50" } });
    fake.quote = { ok: false, wouldRejectReason: "PER_TX_LIMIT_EXCEEDED", wouldRejectDetail: "too big", needsApproval: false };
    expect((await call("treasury_quote_payment", { chain: "base", address: "0xabc", amount_usdc: "5000" })).json).toMatchObject({
      ok: false,
      would_reject_reason: "PER_TX_LIMIT_EXCEEDED",
    });
  });

  it("request_payment: each outcome", async () => {
    const { call, fake } = await connect();
    const args = { chain: "base", address: "0xabc", amount_usdc: "50", memo: "invoice 42" };
    expect((await call("treasury_request_payment", args)).json).toEqual({ status: "submitted", payout_id: "7", near_tx: "TX1" });
    expect(fake.calls.at(-1)?.args).toEqual({ chain: "base", address: "0xabc", amountUsdc: "50", memo: "invoice 42" });

    fake.outcome = { status: "rejected", reason: "AGENT_DAILY_LIMIT_EXCEEDED", detail: "Daily limit is 200 USDC." };
    const rej = await call("treasury_request_payment", args);
    expect(rej.json).toEqual({ status: "rejected", reason: "AGENT_DAILY_LIMIT_EXCEEDED", detail: "Daily limit is 200 USDC." });
    expect(rej.r.isError).toBeFalsy(); // a rejection is a valid business result, not a tool failure

    fake.outcome = { status: "pending_approval", payoutId: "9", depositExpiresAt: "x", reason: "ABOVE_THRESHOLD" };
    expect((await call("treasury_request_payment", args)).json).toEqual({ status: "pending_approval", payout_id: "9", reason: "ABOVE_THRESHOLD" });

    fake.outcome = { status: "transfer_failed", payoutId: "3" };
    expect((await call("treasury_request_payment", args)).json).toMatchObject({ status: "transfer_failed", payout_id: "3" });
  });

  it("accepts a numeric amount and converts it to a decimal string", async () => {
    const { call, fake } = await connect();
    await call("treasury_request_payment", { chain: "base", address: "0xabc", amount_usdc: 12.5 });
    expect(fake.calls.at(-1)?.args).toMatchObject({ amountUsdc: "12.5" });
  });

  it("rejects invalid input before reaching the client", async () => {
    const { call, fake } = await connect();
    for (const bad of [
      { chain: "base", address: "0xabc", amount_usdc: "1.2345678" },
      { chain: "base", address: "0xabc", amount_usdc: "-5" },
      { chain: "base", address: "0xabc", amount_usdc: "5", memo: "x".repeat(141) },
      { chain: "base", amount_usdc: "5" },
    ]) {
      const failed = await call("treasury_request_payment", bad).then(
        ({ r }) => r.isError === true,
        () => true,
      );
      expect(failed).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("get_payment_status never echoes the untrusted memo", async () => {
    const { call, fake } = await connect();
    const { text, json } = await call("treasury_get_payment_status", { payout_id: "7" });
    expect(json).toEqual({ status: "Confirmed", chain: "base", address: "0xabc", amount_usdc: "50", source: "on_demand", near_tx: "TX1", intents_status: "SUCCESS", destination_tx: "0xdest" });
    expect(text).not.toMatch(/IGNORE/);
    expect(fake.calls.at(-1)).toEqual({ method: "getPaymentStatus", args: "7" });
    await call("treasury_get_payment_status", { payout_id: 7 });
    expect(fake.calls.at(-1)?.args).toBe("7");
  });

  it("turns SDK errors into readable tool errors", async () => {
    const { call, fake } = await connect();
    fake.error = new SdkError("UNSUPPORTED_ASSET", "USDC is not available on \"tron\" (only USDT is listed there)");
    const { r, json } = await call("treasury_request_payment", { chain: "tron", address: "T123", amount_usdc: "5" });
    expect(r.isError).toBe(true);
    expect(json).toMatchObject({ error: "UNSUPPORTED_ASSET" });
    fake.error = new Error("boom");
    expect((await call("treasury_get_budget")).json).toMatchObject({ error: "UNEXPECTED_ERROR", message: "boom" });
  });
});
