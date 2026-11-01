import { randomBytes } from "node:crypto";
import type { QuoteRequest, QuoteResponse, StatusResponse, Token } from "./oneclick.js";

export const SIMULATED_BANNER = "SIMULATED 1CLICK - no cross-chain transfer";
const WITHDRAW_FEE = 2400n;

const tok = (assetId: string, blockchain: string, symbol: string): Token => ({ assetId, decimals: 6, blockchain, symbol });
/** Static list shaped like /v0/tokens (tron lists USDT only, like the real one). Simulated mode only. */
const SIMULATED_TOKENS: Token[] = [
  tok("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "near", "USDC"),
  tok("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "base", "USDC"),
  tok("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", "arb", "USDC"),
  tok("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "eth", "USDC"),
  tok("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "sol", "USDC"),
  tok("nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", "tron", "USDT"),
];

/**
 * Offline stand-in for 1Click so the whole flow can be reproduced on testnet (1Click has no testnet).
 * Same shapes as the real API; the deposit address is a fresh random 64-hex implicit account per real quote.
 * Nothing leaves NEAR. `createTreasuryClient` refuses this mode unless network is "testnet".
 */
export class SimulatedOneClick {
  constructor(private readonly opts: { outcome: "success" | "refunded"; log?: (m: string) => void; now?: () => number }) {
    this.log(`${SIMULATED_BANNER} (outcome=${opts.outcome})`);
  }

  private log(m: string): void {
    (this.opts.log ?? console.error)(m);
  }

  /** Origin: `nep141:<account>` is a NEAR token. Destination: `nep141:<chain>-<addr>.omft.near`. */
  getTokens(): Promise<Token[]> {
    return Promise.resolve(SIMULATED_TOKENS);
  }

  findToken(assetId: string): Promise<Token | undefined> {
    const omft = /^nep141:([a-z0-9]+)-[^.]+\.omft\.near$/.exec(assetId);
    if (omft?.[1]) return Promise.resolve({ assetId, decimals: 6, blockchain: omft[1], symbol: "USDC" });
    if (/^nep141:[a-z0-9._-]+$/.test(assetId)) return Promise.resolve({ assetId, decimals: 6, blockchain: "near", symbol: "USDC" });
    return Promise.resolve(undefined);
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    const amountIn = BigInt(req.amount);
    const amountOut = amountIn > WITHDRAW_FEE ? amountIn - WITHDRAW_FEE : amountIn;
    const depositAddress = req.dry ? undefined : randomBytes(32).toString("hex");
    if (!req.dry) this.log(`${SIMULATED_BANNER}: quote for ${req.amount} -> ${req.recipient}`);
    return Promise.resolve({
      correlationId: `simulated-${randomBytes(4).toString("hex")}`,
      timestamp: new Date((this.opts.now ?? Date.now)()).toISOString(),
      signature: "simulated",
      quoteRequest: { ...req },
      quote: {
        ...(depositAddress ? { depositAddress } : {}),
        amountIn: req.amount,
        amountOut: amountOut.toString(),
        minAmountOut: ((amountOut * 99n) / 100n).toString(),
        deadline: req.deadline,
        timeEstimate: 1,
        withdrawFee: WITHDRAW_FEE.toString(),
      },
    });
  }

  submitDeposit(): Promise<void> {
    return Promise.resolve();
  }

  getStatus(depositAddress: string): Promise<StatusResponse> {
    const tag = depositAddress.slice(0, 8);
    this.log(`${SIMULATED_BANNER}: status ${this.opts.outcome} for ${tag}`);
    return Promise.resolve(
      this.opts.outcome === "success"
        ? { status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ hash: `simulated-${tag}` }] } }
        : { status: "REFUNDED", swapDetails: { originChainTxHashes: [{ hash: `simulated-${tag}` }], refundReason: "SIMULATED_OUTCOME=refunded" } },
    );
  }
}
