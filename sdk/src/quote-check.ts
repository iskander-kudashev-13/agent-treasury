import { sameAddress } from "./chains.js";
import type { QuoteResponse } from "./oneclick.js";

export const MIN_QUOTE_VALIDITY_MS = 5 * 60_000;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

export interface ExpectedQuote {
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  amount: string;
  refundTo: string;
  nowMs: number;
}

/**
 * Defense in depth before any signature: the vault cannot verify what a deposit address pays (docs/adr/0002),
 * so we check that the real quote says exactly what the caller asked for. Empty list = safe to call `request_payment`.
 */
export function checkRealQuote(resp: QuoteResponse, exp: ExpectedQuote): string[] {
  const problems: string[] = [];
  const req = resp.quoteRequest;
  const q = resp.quote;

  if (req.dry) problems.push("quote is a dry quote");
  if (req.swapType !== "EXACT_INPUT") problems.push(`swapType ${req.swapType} != EXACT_INPUT`);
  if (req.originAsset !== exp.originAsset) problems.push("originAsset mismatch");
  if (req.destinationAsset !== exp.destinationAsset) problems.push("destinationAsset mismatch");
  if (!sameAddress(req.recipient, exp.recipient)) problems.push("recipient mismatch");
  if (req.recipientType !== "DESTINATION_CHAIN") problems.push("recipientType is not DESTINATION_CHAIN");
  if (req.refundTo !== exp.refundTo) problems.push("refundTo is not the vault");
  if (req.refundType !== "ORIGIN_CHAIN") problems.push("refundType is not ORIGIN_CHAIN");
  if (req.amount !== exp.amount) problems.push("quoteRequest.amount mismatch");
  // msg / customRecipientMsg would make failed withdrawals non-refundable.
  if (req.msg !== undefined || req.customRecipientMsg !== undefined) problems.push("quoteRequest carries a msg");
  if (q.amountIn !== exp.amount) problems.push(`amountIn ${q.amountIn} != ${exp.amount}`);
  if (!/^[1-9]\d*$/.test(q.minAmountOut)) problems.push("minAmountOut is not a positive integer");

  if (q.depositAddress === undefined || !IMPLICIT_ACCOUNT.test(q.depositAddress)) {
    problems.push("depositAddress is not a 64-hex implicit account");
  }
  const deadline = q.deadline === undefined ? Number.NaN : Date.parse(q.deadline);
  if (Number.isNaN(deadline)) problems.push("quote.deadline missing or invalid");
  else if (deadline < exp.nowMs + MIN_QUOTE_VALIDITY_MS) problems.push("quote.deadline is less than 5 min away");
  return problems;
}
