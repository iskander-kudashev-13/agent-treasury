import { describe, expect, it } from "vitest";
import { canApprove, checkQuote, evaluateGate, fetchOneClickStatus, sameAddress, sameAmount, type OneClickStatus } from "./oneclickStatus";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const DEP = "a".repeat(64);
const payout = { address: "0xAbC0000000000000000000000000000000000001", amount: "1200000000", deposit_address: DEP };

function status(over: Partial<{ recipient: string; refundTo: string; amountIn: string; amount: string; deposit: string; deadline: string; st: string; msg: unknown; dry: boolean }> = {}): OneClickStatus {
  return {
    status: over.st ?? "PENDING_DEPOSIT",
    quoteResponse: {
      quoteRequest: {
        dry: over.dry ?? false,
        swapType: "EXACT_INPUT",
        recipient: over.recipient ?? payout.address,
        recipientType: "DESTINATION_CHAIN",
        refundTo: over.refundTo ?? "vault.testnet",
        refundType: "ORIGIN_CHAIN",
        amount: over.amount ?? payout.amount,
        ...(over.msg !== undefined ? { msg: over.msg } : {}),
      },
      quote: { depositAddress: over.deposit ?? DEP, amountIn: over.amountIn ?? payout.amount, deadline: over.deadline ?? "2026-11-01T13:00:00Z" },
    },
  };
}
const check = (s: OneClickStatus) => checkQuote(payout, "vault.testnet", s, NOW);
const failed = (s: OneClickStatus) => check(s).mismatches.map((m) => m.key);

describe("sameAddress / sameAmount", () => {
  it("EVM is case-insensitive, others exact", () => {
    expect(sameAddress("0xABC", "0xabc")).toBe(true);
    expect(sameAddress("So1anaAddr", "so1anaaddr")).toBe(false);
    expect(sameAddress("0xabc", "abc")).toBe(false);
  });
  it("amounts are integer strings compared as numbers", () => {
    expect(sameAmount("0100", "100")).toBe(true);
    expect(sameAmount("100", "101")).toBe(false);
    expect(sameAmount("1.0", "1")).toBe(false);
    expect(sameAmount(undefined, "1")).toBe(false);
  });
});

describe("checkQuote", () => {
  it("passes when the quote matches the vault record (EVM case differs)", () => {
    const c = check(status({ recipient: payout.address.toLowerCase() }));
    expect(c.ok).toBe(true);
    expect(c.mismatches).toEqual([]);
  });
  it("flags a different recipient", () => {
    expect(failed(status({ recipient: "0x0000000000000000000000000000000000000bad" }))).toEqual(["recipient"]);
  });
  it("flags a refundTo that is not the vault", () => {
    expect(failed(status({ refundTo: "attacker.near" }))).toEqual(["refundTo"]);
  });
  it("flags a different amount in either field", () => {
    expect(failed(status({ amountIn: "1199999999" }))).toEqual(["amountIn"]);
    expect(failed(status({ amount: "1" }))).toEqual(["requestAmount"]);
  });
  it("flags a passed or missing deadline", () => {
    expect(failed(status({ deadline: "2026-11-01T11:59:59Z" }))).toEqual(["deadline"]);
    expect(failed(status({ deadline: "soon" }))).toEqual(["deadline"]);
  });
  it("flags a quote for another deposit address and a used address", () => {
    expect(failed(status({ deposit: "b".repeat(64) }))).toEqual(["depositAddress"]);
    expect(failed(status({ st: "SUCCESS" }))).toEqual(["status"]);
  });
  it("flags dry quotes and attached messages", () => {
    expect(failed(status({ dry: true }))).toEqual(["mode"]);
    expect(failed(status({ msg: "x" }))).toEqual(["mode"]);
  });
  it("a response without a quote fails every comparison", () => {
    const c = check({ status: "PENDING_DEPOSIT" });
    expect(c.ok).toBe(false);
    expect(c.mismatches.map((m) => m.key)).toEqual(expect.arrayContaining(["recipient", "refundTo", "amountIn", "deadline"]));
    expect(c.rows.find((r) => r.key === "recipient")?.actual).toBe("—");
  });
});

describe("evaluateGate / canApprove", () => {
  const ok = { kind: "ok", data: status(), fetchedAt: NOW } as const;
  it("verified quote enables approve without override", () => {
    const g = evaluateGate(payout, "vault.testnet", ok, NOW);
    expect(g.phase).toBe("verified");
    expect(canApprove(g, false)).toBe(true);
  });
  it("mismatch can never be overridden", () => {
    const g = evaluateGate(payout, "vault.testnet", { kind: "ok", data: status({ recipient: "0xbad" }), fetchedAt: NOW }, NOW);
    expect(g.phase).toBe("mismatch");
    expect(canApprove(g, true)).toBe(false);
  });
  it("unavailable status needs the explicit override; unknown address and missing address never pass", () => {
    const u = evaluateGate(payout, "vault.testnet", { kind: "unavailable", reason: "x" }, NOW);
    expect(canApprove(u, false)).toBe(false);
    expect(canApprove(u, true)).toBe(true);
    expect(canApprove(evaluateGate(payout, "vault.testnet", { kind: "not_found" }, NOW), true)).toBe(false);
    expect(canApprove(evaluateGate({ ...payout, deposit_address: null }, "vault.testnet", ok, NOW), true)).toBe(false);
  });
  it("is checking until the fetch settles, and not approvable", () => {
    const g = evaluateGate(payout, "vault.testnet", undefined, NOW);
    expect(g.phase).toBe("checking");
    expect(canApprove(g, true)).toBe(false);
  });
  it("a deadline that passes later flips the gate at re-evaluation time", () => {
    expect(evaluateGate(payout, "vault.testnet", ok, NOW + 2 * 3_600_000).phase).toBe("mismatch");
  });
});

describe("fetchOneClickStatus", () => {
  const mk = (res: Partial<Response> | Error): typeof fetch =>
    (async () => {
      if (res instanceof Error) throw res;
      return res as Response;
    }) as unknown as typeof fetch;
  it("maps 200, 404, 5xx and network errors", async () => {
    const base = "https://x";
    expect(await fetchOneClickStatus("d", base, { fetchImpl: mk({ status: 200, ok: true, json: async () => status() }), now: () => 5 })).toMatchObject({ kind: "ok", fetchedAt: 5 });
    expect(await fetchOneClickStatus("d", base, { fetchImpl: mk({ status: 404, ok: false }) })).toEqual({ kind: "not_found" });
    expect(await fetchOneClickStatus("d", base, { fetchImpl: mk({ status: 503, ok: false }) })).toMatchObject({ kind: "unavailable" });
    expect(await fetchOneClickStatus("d", base, { fetchImpl: mk(new TypeError("Failed to fetch")) })).toMatchObject({ kind: "unavailable" });
    expect(await fetchOneClickStatus("d", base, { fetchImpl: mk({ status: 200, ok: true, json: async () => null }) })).toMatchObject({ kind: "unavailable" });
  });
  it("builds the documented URL", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return { status: 404, ok: false } as Response;
    }) as unknown as typeof fetch;
    await fetchOneClickStatus("dep addr", "https://1click.chaindefuser.com", { fetchImpl: f });
    expect(url).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=dep%20addr");
  });
});
