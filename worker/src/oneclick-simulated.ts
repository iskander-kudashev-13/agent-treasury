import { randomBytes } from "node:crypto";
import type { QuoteRequest, QuoteResponse, StatusResponse, Token } from "./oneclick.js";
import type { OneClickPort } from "./payout-loop.js";

export const SIMULATED_BANNER = "SIMULATED 1CLICK — no cross-chain transfer";
const WITHDRAW_FEE = 2400n;

/**
 * Offline stand-in for 1Click so the whole loop can be reproduced on testnet (1Click has no testnet).
 * Same shapes as the real API; the deposit address is a fresh random 64-hex implicit account per real quote.
 * Nothing leaves NEAR: the vault really transfers test tokens to that address, and nobody delivers anything cross-chain.
 * `config.ts` refuses this mode unless NEAR_NETWORK=testnet.
 */
export class SimulatedOneClient implements OneClickPort {
  constructor(
    private readonly opts: { outcome: "success" | "refunded"; log?: (m: string) => void; now?: () => number },
  ) {
    this.log(`${SIMULATED_BANNER} (outcome=${opts.outcome})`);
  }

  private log(m: string): void {
    (this.opts.log ?? console.warn)(m);
  }

  /** Origin: any `nep141:<account>` is a NEAR token (the loop passes `nep141:<treasury_token>`). Destination: `nep141:<chain>-<addr>.omft.near`. */
  findToken(assetId: string): Promise<Token | undefined> {
    const omft = /^nep141:([a-z0-9]+)-[^.]+\.omft\.near$/.exec(assetId);
    if (omft?.[1]) return Promise.resolve({ assetId, decimals: 6, blockchain: omft[1], symbol: "USDC (simulated)" });
    if (/^nep141:[a-z0-9._-]+$/.test(assetId)) {
      return Promise.resolve({ assetId, decimals: 6, blockchain: "near", symbol: "USDC (simulated)" });
    }
    return Promise.resolve(undefined);
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    const amountIn = BigInt(req.amount);
    const amountOut = amountIn > WITHDRAW_FEE ? amountIn - WITHDRAW_FEE : amountIn;
    const depositAddress = req.dry ? undefined : randomBytes(32).toString("hex");
    if (!req.dry) this.log(`${SIMULATED_BANNER}: quote for ${req.amount} -> ${req.recipient}, deposit address ${depositAddress}`);
    return Promise.resolve({
      correlationId: `simulated-${randomBytes(4).toString("hex")}`,
      timestamp: new Date((this.opts.now ?? Date.now)()).toISOString(),
      signature: "simulated",
      quoteRequest: { ...req },
      quote: {
        ...(depositAddress ? { depositAddress } : {}),
        amountIn: req.amount,
        amountOut: amountOut.toString(),
        amountOutFormatted: (Number(amountOut) / 1e6).toString(),
        minAmountOut: ((amountOut * 99n) / 100n).toString(),
        deadline: req.deadline,
        timeEstimate: 1,
        withdrawFee: WITHDRAW_FEE.toString(),
      },
    });
  }

  submitDeposit(): Promise<void> {
    return Promise.resolve(); // no-op
  }

  /** The loop only asks after the vault transfer is `Sent`, so the swap is immediately terminal. */
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
