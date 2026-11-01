/**
 * M0 deliverable: prints one `dry: true` 1Click quote, NEAR USDC -> Base USDC, 1 USDC, placeholder recipient.
 * Read-only mainnet API call: no funds, no signing, no deposit address is created.
 *   pnpm dry-quote
 */
import { OneClickClient } from "../src/oneclick.js";

const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
// Placeholder addresses (not controlled by anyone we know; a dry quote never sends anything).
const PLACEHOLDER_RECIPIENT = "0x1111111111111111111111111111111111111111";
const PLACEHOLDER_REFUND = "0".repeat(64);

const client = new OneClickClient({
  baseUrl: process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com",
  apiKey: process.env.ONECLICK_API_KEY || undefined,
  timeoutMs: 15_000,
});

for (const id of [NEAR_USDC, BASE_USDC]) {
  const t = await client.findToken(id);
  if (!t) throw new Error(`${id} is not listed by /v0/tokens`);
  console.log(`token ok: ${t.symbol} on ${t.blockchain}, ${t.decimals} decimals`);
}

const resp = await client.quote({
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: NEAR_USDC,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: BASE_USDC,
  amount: "1000000",
  refundTo: PLACEHOLDER_REFUND,
  refundType: "ORIGIN_CHAIN",
  recipient: PLACEHOLDER_RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
});
console.log(JSON.stringify(resp, null, 2));
