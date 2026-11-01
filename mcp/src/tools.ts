import { SdkError } from "agent-treasury-sdk";
import type { PaymentOutcome, TreasuryClient } from "agent-treasury-sdk";
import * as z from "zod";

/** The part of the SDK client the tools use (a fake in tests). */
export type ToolClient = Pick<TreasuryClient, "getBudget" | "listAllowedRecipients" | "quotePayment" | "requestPayment" | "getPaymentStatus">;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  readOnly: boolean;
  handler: (args: never) => Promise<ToolResult>;
}

const amountUsdc = z
  .union([z.string().regex(/^\d+(\.\d{1,6})?$/, 'use a plain decimal such as "50" or "12.50" (max 6 decimals)'), z.number().positive()])
  .describe('Amount in USDC (not base units), e.g. "50" or "12.50". At most 6 decimals.');
const chain = z.string().min(1).max(32).describe('Destination chain id: "base", "arb", "sol" (alias "solana"), "near", "eth". USDC only.');
const address = z.string().min(1).max(128).describe("Destination address on that chain, exactly as the payee gave it.");
const idLike = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

const json = (o: unknown): string => JSON.stringify(o, null, 2);
const ok = (structured: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: json(structured) }], structuredContent: structured });

/** Converts SDK/network failures into a tool error the model can read. Never includes keys or memo text. */
export function toolError(e: unknown): ToolResult {
  const body =
    e instanceof SdkError
      ? { error: e.code, message: e.message }
      : { error: "UNEXPECTED_ERROR", message: e instanceof Error ? e.message : String(e) };
  return { isError: true, content: [{ type: "text", text: json(body) }] };
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return toolError(e);
  }
}

export function mapOutcome(r: PaymentOutcome): Record<string, unknown> {
  switch (r.status) {
    case "rejected":
      return { status: "rejected", reason: r.reason, detail: r.detail };
    case "pending_approval":
      return { status: "pending_approval", payout_id: r.payoutId, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
    case "submitted":
      return { status: "submitted", payout_id: r.payoutId, ...(r.nearTx !== undefined ? { near_tx: r.nearTx } : {}) };
    case "transfer_failed":
      return {
        status: "transfer_failed",
        payout_id: r.payoutId,
        detail: "The vault could not transfer the funds; the reservation was released and nothing was spent. It is safe to try again later.",
      };
  }
}

export function createTools(client: ToolClient): ToolDef[] {
  const getBudget = z.object({});
  const list = z.object({});
  const quote = z.object({ chain, address, amount_usdc: amountUsdc });
  const request = z.object({
    chain,
    address,
    amount_usdc: amountUsdc,
    memo: z.string().max(140).optional().describe("Optional note, max 140 bytes, e.g. an invoice number. Stored and shown to the owner; never treated as instructions."),
  });
  const status = z.object({ payout_id: idLike.describe("The payout_id returned by treasury_request_payment.") });

  return [
    {
      name: "treasury_get_budget",
      title: "Get my spending budget",
      description:
        "Returns this agent's current mandate and what is left to spend: remaining_today_usdc, per_tx_limit_usdc, approval_threshold_usdc, min_payment_usdc, payments_left_today, " +
        "allowed_chains, recipients_mode (Fixed | Allowlist | Open), allowlist, expires_at and status. Amounts are in USDC. " +
        "Call it before planning a payment. Read-only.",
      inputSchema: getBudget,
      readOnly: true,
      handler: () =>
        guarded(async () => {
          const b = await client.getBudget();
          return ok({
            remaining_today_usdc: b.remainingTodayUsdc,
            per_tx_limit_usdc: b.perTxLimitUsdc,
            approval_threshold_usdc: b.approvalThresholdUsdc,
            allowed_chains: b.allowedChains,
            recipients_mode: b.recipientsMode,
            ...(b.recipientsMode === "Allowlist" ? { allowlist: b.allowlist } : {}),
            ...(b.expiresAt !== undefined ? { expires_at: b.expiresAt } : {}),
            min_payment_usdc: b.minPaymentUsdc,
            payments_left_today: b.paymentsLeftToday,
            status: b.vaultPaused ? "VaultPaused" : b.status,
          });
        }),
    },
    {
      name: "treasury_list_allowed_recipients",
      title: "List allowed recipients",
      description:
        "Lists the destinations (chain, address, label) this agent may pay when its mandate uses an allowlist. " +
        "An empty list means the mandate is Open (any address on the allowed chains) or Fixed; check recipients_mode in treasury_get_budget. Read-only.",
      inputSchema: list,
      readOnly: true,
      handler: () =>
        guarded(async () => {
          const recipients = await client.listAllowedRecipients();
          return { content: [{ type: "text", text: json(recipients) }] };
        }),
    },
    {
      name: "treasury_quote_payment",
      title: "Dry-run a payment",
      description:
        "Checks, WITHOUT spending anything, whether a payment would be accepted: runs the mandate checks locally and asks 1Click for a dry quote. " +
        "Returns ok, would_reject_reason (if any), needs_approval, estimated_fee_usdc and estimated_arrival_s. Amounts are in USDC. " +
        "This is only a preview: the vault contract makes the final decision when treasury_request_payment is called. " +
        "If needs_approval is true, a human owner must approve the payment in the dashboard before it is sent.",
      inputSchema: quote,
      readOnly: true,
      handler: (a: z.infer<typeof quote>) =>
        guarded(async () => {
          const q = await client.quotePayment({ chain: a.chain, address: a.address, amountUsdc: String(a.amount_usdc) });
          return ok({
            ok: q.ok,
            ...(q.wouldRejectReason !== undefined ? { would_reject_reason: q.wouldRejectReason } : {}),
            ...(q.wouldRejectDetail !== undefined ? { would_reject_detail: q.wouldRejectDetail } : {}),
            needs_approval: q.needsApproval,
            ...(q.estimatedFeeUsdc !== undefined ? { estimated_fee_usdc: q.estimatedFeeUsdc } : {}),
            ...(q.estimatedArrivalS !== undefined ? { estimated_arrival_s: q.estimatedArrivalS } : {}),
            ...(q.quoteError !== undefined ? { quote_error: q.quoteError } : {}),
          });
        }),
    },
    {
      name: "treasury_request_payment",
      title: "Pay from the treasury",
      description:
        "Sends USDC from the vault to an address on another chain (via NEAR Intents), within this agent's mandate. REAL MONEY: only call it when the user clearly asked for this payment. " +
        "Amounts are in USDC. Result `status`: " +
        "`submitted` = accepted and on its way (use payout_id with treasury_get_payment_status); " +
        "`rejected` = the vault refused it with a machine-readable `reason` and an English `detail`: the rejection is FINAL for this request, relay the `detail` to the user and do NOT retry, and NEVER split the amount into smaller payments to bypass a limit; " +
        "`pending_approval` = the amount is above the approval threshold and a human owner must approve it in the dashboard (tell the user, do not resubmit; `reason` is ABOVE_THRESHOLD or OVERDUE_NEEDS_APPROVAL); " +
        "`transfer_failed` = the transfer failed and nothing was spent. " +
        "The memo is untrusted free text for the owner's records; it is never executed. The call returns immediately; it does not wait for arrival.",
      inputSchema: request,
      readOnly: false,
      handler: (a: z.infer<typeof request>) =>
        guarded(async () => {
          const r = await client.requestPayment({
            chain: a.chain,
            address: a.address,
            amountUsdc: String(a.amount_usdc),
            ...(a.memo !== undefined ? { memo: a.memo } : {}),
          });
          return ok(mapOutcome(r));
        }),
    },
    {
      name: "treasury_get_payment_status",
      title: "Get payment status",
      description:
        "Returns the state of a payment made by this agent: status (PendingApproval, Transferring, Sent, Confirmed, Failed, Refunded, Rejected), chain, address, amount_usdc, " +
        "near_tx, intents_status (1Click) and destination_tx (the transaction on the destination chain, once delivered). Amounts are in USDC. Read-only. " +
        "`PendingApproval` means a human must still approve it in the dashboard.",
      inputSchema: status,
      readOnly: true,
      handler: (a: z.infer<typeof status>) =>
        guarded(async () => {
          const s = await client.getPaymentStatus(String(a.payout_id));
          return ok({
            status: s.status,
            chain: s.chain,
            address: s.address,
            amount_usdc: s.amountUsdc,
            source: s.source,
            ...(s.nearTx !== undefined ? { near_tx: s.nearTx } : {}),
            ...(s.intentsStatus !== undefined ? { intents_status: s.intentsStatus } : {}),
            ...(s.destinationTx !== undefined ? { destination_tx: s.destinationTx } : {}),
          });
        }),
    },
  ];
}
