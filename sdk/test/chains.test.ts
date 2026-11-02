import { describe, expect, it } from "vitest";
import { normalizeChain, resolveUsdc, sameAddress, validateAddress } from "../src/chains.js";
import { createTreasuryClient } from "../src/index.js";
import { checkRealQuote } from "../src/quote-check.js";
import type { QuoteRequest, QuoteResponse } from "../src/oneclick.js";
import { AGENT_ACCOUNT, budget, EVM, FakeOneClick, FakeVault, HL_ERC20_USDC, HL_HIP1_USDC, NOW, ORIGIN_ASSET, TOKENS, VAULT } from "./fakes.js";

describe("resolveUsdc on hypercore", () => {
  it("pins the hip1 asset (8 decimals) and never the erc20 one", () => {
    const t = resolveUsdc(TOKENS, "hypercore");
    expect(t.assetId).toBe(HL_HIP1_USDC);
    expect(t.decimals).toBe(8);
    expect(resolveUsdc([...TOKENS].reverse(), "hypercore").assetId).toBe(HL_HIP1_USDC);
  });

  it("ignores preferAssetId pointing at the erc20 asset", () => {
    expect(resolveUsdc(TOKENS, "hypercore", HL_ERC20_USDC).assetId).toBe(HL_HIP1_USDC);
  });

  it("fails closed when the pinned asset is not listed", () => {
    const only = TOKENS.filter((t) => t.assetId !== HL_HIP1_USDC);
    expect(() => resolveUsdc(only, "hypercore")).toThrow(/pinned USDC asset/);
  });

  it("still rejects ambiguity on other chains", () => {
    const dup = [...TOKENS, { assetId: "other", decimals: 6, blockchain: "base", symbol: "USDC" }];
    expect(() => resolveUsdc(dup, "base")).toThrow(/several USDC/);
  });
});

describe("hypercore addresses", () => {
  it("normalizes the chain and validates 0x + 40 hex", () => {
    expect(normalizeChain(" HyperCore ")).toBe("hypercore");
    expect(validateAddress("hypercore", EVM)).toBe(EVM);
    expect(() => validateAddress("hypercore", "0x123")).toThrow(/not a valid hypercore address/);
    expect(() => validateAddress("hypercore", "near-account.near")).toThrow(/not a valid hypercore address/);
  });
  it("compares addresses case-insensitively", () => {
    expect(sameAddress(EVM, EVM.toUpperCase().replace("0X", "0x"))).toBe(true);
  });
});

/** 1Click quotes hypercore amounts out in 8 decimals. */
class HlOneClick extends FakeOneClick {
  override quote(req: QuoteRequest): Promise<QuoteResponse> {
    return super.quote(req).then((r) => {
      const out = BigInt(req.amount) * 100n - 240_000n; // 6 -> 8 decimals, minus a 0.0024 fee
      return { ...r, quote: { ...r.quote, amountOut: out.toString(), minAmountOut: ((out * 99n) / 100n).toString() } };
    });
  }
}

describe("hypercore end to end through the client", () => {
  const hl = { chain: "hypercore", address: EVM, amountUsdc: "25" };
  const setup = () => {
    const vault = new FakeVault();
    vault.budgetView = budget({ allowed_chains: ["hypercore"], per_tx_limit: "25000000", remaining_today: "50000000" });
    const oneclick = new HlOneClick();
    const client = createTreasuryClient({
      vaultId: VAULT,
      network: "testnet",
      agentAccountId: AGENT_ACCOUNT,
      oneclick: { baseUrl: "http://unused", mode: "live" },
      deps: { vault, oneclick, now: () => NOW, sleep: () => Promise.resolve(), log: () => undefined },
    });
    return { client, vault, oneclick };
  };

  it("quotes with the hip1 asset and rescales 8-decimal output to USDC", async () => {
    const { client, oneclick } = setup();
    const q = await client.quotePayment(hl);
    expect(q).toMatchObject({ ok: true, estimatedFeeUsdc: "0.0024", estimatedReceiveUsdc: "24.9976" });
    expect(oneclick.quotes[0]).toMatchObject({ originAsset: ORIGIN_ASSET, destinationAsset: HL_HIP1_USDC, amount: "25000000" });
  });

  it("real quote echo check passes and the vault is called with the hip1 quote", async () => {
    const { client, vault, oneclick } = setup();
    const out = await client.requestPayment(hl);
    expect(out.status).not.toBe("rejected");
    expect(vault.calls).toHaveLength(1);
    expect(oneclick.quotes[0]).toMatchObject({ dry: false, destinationAsset: HL_HIP1_USDC, recipient: EVM, amount: "25000000" });
  });

  it("checkRealQuote flags a swapped destination asset (erc20 instead of hip1)", async () => {
    const { oneclick } = setup();
    const resp = await oneclick.quote({ dry: false, swapType: "EXACT_INPUT", originAsset: ORIGIN_ASSET, destinationAsset: HL_ERC20_USDC, amount: "25000000", recipient: EVM, recipientType: "DESTINATION_CHAIN", refundTo: VAULT, refundType: "ORIGIN_CHAIN", deadline: new Date(NOW + 30 * 60_000).toISOString() } as unknown as QuoteRequest);
    const exp = { originAsset: ORIGIN_ASSET, destinationAsset: HL_HIP1_USDC, recipient: EVM, amount: "25000000", refundTo: VAULT, nowMs: NOW };
    expect(checkRealQuote(resp, exp)).toContain("destinationAsset mismatch");
  });
});
