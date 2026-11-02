/**
 * "Quote check" before approving a payout (security audit H2).
 *
 * The vault cannot verify `payout.deposit_address` on-chain (docs/adr/0002): a compromised agent could submit a deposit
 * address that belongs to someone else. Before the owner approves, the dashboard asks 1Click for the quote behind that
 * address (`GET /v0/status?depositAddress=...`, response `GetExecutionStatusResponse.quoteResponse`) and compares it with
 * what the vault recorded. Mirrors worker/src/quote-check.ts. Pure functions only; the fetch is injected for tests.
 */
import type { Payout } from "./types";

/** The subset of 1Click's `GetExecutionStatusResponse` this check reads. All optional: the API is external input. */
export interface OneClickStatus {
  status?: string;
  updatedAt?: string;
  quoteResponse?: {
    quoteRequest?: {
      dry?: boolean;
      swapType?: string;
      recipient?: string;
      recipientType?: string;
      refundTo?: string;
      refundType?: string;
      amount?: string;
      msg?: unknown;
      customRecipientMsg?: unknown;
    };
    quote?: { depositAddress?: string; amountIn?: string; deadline?: string };
  };
}

export type StatusFetch =
  | { kind: "ok"; data: OneClickStatus; fetchedAt: number }
  /** 404: 1Click has no quote for this deposit address. The address is not one the vault should pay. */
  | { kind: "not_found" }
  /** Network error, CORS, 401/5xx, malformed JSON. The check could not run. */
  | { kind: "unavailable"; reason: string };

export async function fetchOneClickStatus(
  depositAddress: string,
  baseUrl: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<StatusFetch> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  try {
    const res = await doFetch(`${baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      headers: { accept: "application/json" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "unavailable", reason: `1Click answered HTTP ${res.status}` };
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return { kind: "unavailable", reason: "1Click returned an unexpected response" };
    return { kind: "ok", data: data as OneClickStatus, fetchedAt: now() };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { kind: "unavailable", reason: e instanceof Error ? `Could not reach 1Click (${e.message})` : "Could not reach 1Click" };
  }
}

/** EVM addresses are case-insensitive (checksum casing may be normalized); everything else must match exactly. */
export function sameAddress(a: string, b: string): boolean {
  if (/^0x/i.test(a) && /^0x/i.test(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Equal u128 integer strings (leading zeros ignored). Anything that is not an integer string never matches. */
export function sameAmount(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || !/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  return BigInt(a) === BigInt(b);
}

export type CheckKey = "recipient" | "refundTo" | "amountIn" | "requestAmount" | "depositAddress" | "deadline" | "status" | "mode";
export interface CheckRow {
  key: CheckKey;
  label: string;
  /** What the vault recorded (or the rule). */
  expected: string;
  /** What 1Click reports ("—" when absent). */
  actual: string;
  ok: boolean;
}
export interface QuoteCheck {
  rows: CheckRow[];
  /** Every row passed. */
  ok: boolean;
  mismatches: CheckRow[];
}

type PayoutFields = Pick<Payout, "address" | "amount" | "deposit_address">;

/** Compare the 1Click quote behind `payout.deposit_address` with the vault's own record. `nowMs` is injected. */
export function checkQuote(payout: PayoutFields, vaultId: string, status: OneClickStatus, nowMs: number): QuoteCheck {
  const req = status.quoteResponse?.quoteRequest;
  const quote = status.quoteResponse?.quote;
  const dash = (v: unknown): string => (typeof v === "string" && v !== "" ? v : "—");
  const rows: CheckRow[] = [];
  const add = (key: CheckKey, label: string, expected: string, actual: unknown, ok: boolean) => rows.push({ key, label, expected, actual: dash(actual), ok });

  const recipient = req?.recipient;
  add("recipient", "Recipient", payout.address, recipient, typeof recipient === "string" && sameAddress(recipient, payout.address));

  const refundTo = req?.refundTo;
  add("refundTo", "Refund to", vaultId, refundTo, typeof refundTo === "string" && vaultId !== "" && refundTo === vaultId);

  add("amountIn", "Amount in", payout.amount, quote?.amountIn, sameAmount(quote?.amountIn, payout.amount));
  add("requestAmount", "Requested amount", payout.amount, req?.amount, sameAmount(req?.amount, payout.amount));

  const dep = quote?.depositAddress;
  add("depositAddress", "Deposit address", payout.deposit_address ?? "—", dep, payout.deposit_address !== null && typeof dep === "string" && dep === payout.deposit_address);

  const deadlineMs = typeof quote?.deadline === "string" ? Date.parse(quote.deadline) : Number.NaN;
  add("deadline", "Quote deadline", "in the future", quote?.deadline, Number.isFinite(deadlineMs) && deadlineMs > nowMs);

  // Nothing may have been deposited yet: any other state means this address was already used.
  add("status", "Intents status", "PENDING_DEPOSIT", status.status, status.status === "PENDING_DEPOSIT");

  // A message or a non-standard route would make a failed withdrawal non-refundable or change the destination handling.
  const clean =
    req?.dry !== true &&
    req?.swapType === "EXACT_INPUT" &&
    req.recipientType === "DESTINATION_CHAIN" &&
    req.refundType === "ORIGIN_CHAIN" &&
    req.msg === undefined &&
    req.customRecipientMsg === undefined;
  add("mode", "Quote mode", "EXACT_INPUT, destination chain, origin-chain refund, no message", clean ? "as expected" : "unexpected", clean);

  const mismatches = rows.filter((r) => !r.ok);
  return { rows, ok: mismatches.length === 0, mismatches };
}

/** What the approval UI renders and enforces. */
export type QuoteGate =
  | { phase: "no_address" }
  | { phase: "checking" }
  | { phase: "verified"; check: QuoteCheck }
  | { phase: "mismatch"; check: QuoteCheck }
  | { phase: "not_found" }
  | { phase: "unavailable"; reason: string }
  /** Testnet simulated 1Click: no real quote exists; approval needs the owner's explicit acknowledgement. */
  | { phase: "simulated" };

/**
 * Testnet-only "simulated 1Click" mode (the worker/MCP fake 1Click; their deposit addresses are random and real 1Click
 * has never seen them). On only when explicitly requested AND the network is testnet AND the vault is a `.testnet`
 * account, so a misconfigured mainnet build can never relax the quote check. Mirrors the worker/SDK rule that refuses
 * simulated 1Click on mainnet.
 */
export function isSimulatedOneClick(o: { mode: string | undefined; network: string; vaultId: string }): boolean {
  return o.mode === "simulated" && o.network === "testnet" && o.vaultId.endsWith(".testnet");
}

/**
 * Payouts settled by the simulated 1Click carry a `simulated-…` tx hash: there is nothing to track on Intents.
 * `tx_hash` is reported by the agent, so the prefix alone is untrusted: it only counts when the dashboard itself runs in
 * simulated mode (testnet). Otherwise a compromised agent on mainnet could hide the tracking links.
 */
export const isSimulatedPayout = (p: Pick<Payout, "tx_hash">, simulatedMode: boolean): boolean =>
  simulatedMode && p.tx_hash?.startsWith("simulated-") === true;

export function evaluateGate(
  payout: PayoutFields,
  vaultId: string,
  fetched: StatusFetch | undefined,
  nowMs: number,
  opts: { simulated?: boolean } = {},
): QuoteGate {
  if (!payout.deposit_address) return { phase: "no_address" };
  if (fetched === undefined) return { phase: "checking" };
  // Simulated mode replaces only "1Click doesn't know this address" / "can't reach 1Click". A quote that 1Click does
  // know is still checked normally, and a mismatch still blocks.
  if (opts.simulated === true && (fetched.kind === "not_found" || fetched.kind === "unavailable")) return { phase: "simulated" };
  if (fetched.kind === "not_found") return { phase: "not_found" };
  if (fetched.kind === "unavailable") return { phase: "unavailable", reason: fetched.reason };
  const check = checkQuote(payout, vaultId, fetched.data, nowMs);
  return check.ok ? { phase: "verified", check } : { phase: "mismatch", check };
}

/**
 * May the Approve button be enabled? Only a verified quote, or (when the status API is merely unreachable) an explicit
 * "I checked it myself" override. A mismatch, an unknown deposit address, or a missing address can never be overridden.
 */
export function canApprove(gate: QuoteGate, override: boolean): boolean {
  if (gate.phase === "verified") return true;
  return (gate.phase === "unavailable" || gate.phase === "simulated") && override;
}
