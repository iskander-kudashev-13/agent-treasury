/**
 * Vault -> Hyperliquid top-ups (ADR-0005 section 2). THIS MODULE MOVES MONEY (through the SDK's `requestPayment`,
 * which the vault mandate bounds). It is deliberately dumb and conservative:
 *
 * - Size and trigger come from env config (`TRADING_TOPUP_USDC`, `TRADING_TOPUP_FLOOR_USDC`), never from rules or AI.
 * - Destination is ONLY the configured HL master address on chain `hypercore`. Before every request the vault budget is
 *   read and the mandate must hold exactly one allowlist entry, that one, otherwise nothing is sent.
 * - At most one top-up in flight. The marker is persisted BEFORE the signed call (`attempt`) and upgraded to the
 *   payout id afterwards, so a crash or an ambiguous submission cannot lead to a duplicate. It clears only when the
 *   payout reaches a terminal status (or after a long safety timeout).
 * - One call per invocation, exact configured amount, never split, never retried in a loop. After a rejection or
 *   failure a persisted back-off (default 1 h) applies, also across restarts.
 * - Results of the SDK are honoured as they are: rejected / pending_approval / submitted / transfer_failed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Budget, PaymentOutcome, PaymentRequest, PaymentStatus } from "agent-treasury-sdk";
import type { TradingState } from "./types.js";

export const FUNDING_CHAIN = "hypercore";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MICRO = 1_000_000n;
const HOUR = 3_600_000;

/** The slice of the SDK TreasuryClient that funding uses (fakeable in tests). */
export interface FundingClient {
  getBudget(): Promise<Budget>;
  requestPayment(req: PaymentRequest): Promise<PaymentOutcome>;
  getPaymentStatus(payoutId: string): Promise<PaymentStatus>;
  /**
   * This agent's most recent vault payouts (newest last), read from the vault view `get_payouts` filtered by `agent_id`.
   * Used to find out whether an `attempt` of unknown outcome actually reached the vault. Throws when the vault cannot be read.
   */
  listRecentPayouts(): Promise<VaultPayoutLite[]>;
}

/** The fields of a vault payout that funding reconciliation needs. */
export interface VaultPayoutLite {
  id: string;
  chain: string;
  address: string;
  /** Vault clock (block time) of creation, ms. */
  createdAtMs: number;
  status: string;
}

/** Vault clock vs worker clock tolerance when matching a payout to an attempt. */
const CLOCK_SLACK_MS = 120_000;
/** SDK errors raised strictly BEFORE anything is signed. Every other code (VAULT_ERROR, AMBIGUOUS_SUBMISSION, CONFIG, ...) may have moved money. */
const PRE_SIGNING_CODES: ReadonlySet<string> = new Set(["INVALID_INPUT", "ONECLICK_ERROR", "QUOTE_CHECK_FAILED", "UNSUPPORTED_ASSET", "NO_SIGNING_KEY"]);

export interface FundingConfig {
  enabled: boolean;
  /** `HL_MASTER_ADDRESS`. */
  masterAddress: string;
  /** `TRADING_TOPUP_USDC`, decimal string, >= 2 (1Click minimum). */
  topupUsdc: string;
  /** `TRADING_TOPUP_FLOOR_USDC`. */
  floorUsdc: string;
  stateDir: string;
  /** Pause after a rejected / failed request. Default 1 h. */
  retryAfterMs?: number;
  /** An `attempt` marker with unknown outcome blocks this long. Default 2 h. */
  ambiguousBlockMs?: number;
  /** After a Confirmed top-up wait for the HL balance to show it. Default 10 min. */
  settleMs?: number;
  /** Safety valve for a payout stuck non-terminal. Default 80 h (pending approvals expire after 72 h). */
  maxInFlightMs?: number;
  now?: () => number;
}

export type FundingResult =
  | { action: "skipped"; reason: SkipReason; detail?: string }
  | { action: "submitted"; payoutId: string }
  | { action: "pending_approval"; payoutId: string }
  | { action: "rejected"; reason: string; detail: string }
  | { action: "transfer_failed"; payoutId: string }
  | { action: "ambiguous"; detail: string }
  | { action: "error"; detail: string };

export type SkipReason =
  | "disabled"
  | "bad_config"
  | "state_blocks"
  | "bad_balance"
  | "above_floor"
  | "in_flight"
  | "backoff"
  | "settling"
  | "budget_unreadable"
  | "mandate_mismatch"
  | "agent_not_active"
  | "budget_insufficient"
  | "equity_sufficient"
  | "not_credited";

interface Persisted {
  inflight: { kind: "attempt" | "payout"; payoutId?: string; atMs: number; amountUsdc: string } | null;
  lastFailureAtMs: number | null;
  lastFailureReason: string | null;
  lastConfirmedAtMs: number | null;
  /** Request time of the last top-up; after Confirmed + settle the HL ledger must show an inflow since then. */
  creditCheckSinceMs: number | null;
  /** Set when a Confirmed top-up never showed up in the HL balance. Blocks until the owner checks (`clearInFlight`). */
  notCredited: string | null;
}

const EMPTY: Persisted = { inflight: null, lastFailureAtMs: null, lastFailureReason: null, lastConfirmedAtMs: null, creditCheckSinceMs: null, notCredited: null };
const TERMINAL_OK = new Set(["Confirmed"]);
const TERMINAL_BAD = new Set(["Failed", "Refunded", "Rejected"]);
/** Funding may run in these engine states only. Everything else (halted, stopped_today, paused_onchain, error, ...) blocks. */
const ALLOWED_STATES: ReadonlySet<TradingState> = new Set(["running", "no_rules", "awaiting_api_wallet"]);

export interface FundingInput {
  state: TradingState;
  /** Free spot USDC on the HL master account. */
  freeUsdc: string;
  /** Total HL equity and the hard position cap: no top-up while equity already covers cap + floor. Optional. */
  equityUsdc?: string | undefined;
  maxPositionUsdc?: string | undefined;
  /** Sum of USDC that flowed INTO the HL account since `sinceMs` (ledger deposits / transfers in). Throws when HL cannot be read. */
  inflowSince?: ((sinceMs: number) => Promise<string>) | undefined;
}

/** Decimal string -> micro-USDC, truncating extra decimals. Returns null for anything that is not a plain non-negative decimal. */
export function toMicroLenient(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1] ?? "0") * MICRO + BigInt((m[2] ?? "").slice(0, 6).padEnd(6, "0"));
}

/** Throws when the funding parameters are not safe. Call at startup; `Funder` also re-checks per call. */
export function checkFundingConfig(c: Pick<FundingConfig, "masterAddress" | "topupUsdc" | "floorUsdc">): string | null {
  if (!EVM_ADDRESS.test(c.masterAddress)) return "HL_MASTER_ADDRESS must be 0x + 40 hex";
  const top = toMicroLenient(c.topupUsdc);
  const floor = toMicroLenient(c.floorUsdc);
  if (top === null || floor === null) return "TRADING_TOPUP_USDC / TRADING_TOPUP_FLOOR_USDC must be decimal numbers";
  if (top < 2n * MICRO) return "TRADING_TOPUP_USDC must be at least 2 (1Click minimum)";
  if (floor <= 0n) return "TRADING_TOPUP_FLOOR_USDC must be greater than 0";
  return null;
}

export class Funder {
  private busy = false;
  private readonly now: () => number;
  private readonly file: string;

  constructor(
    private readonly client: FundingClient,
    private readonly cfg: FundingConfig,
  ) {
    this.now = cfg.now ?? Date.now;
    this.file = join(cfg.stateDir, "funding.json");
  }

  private load(): Persisted {
    if (!existsSync(this.file)) return { ...EMPTY };
    // A corrupt file must not unlock a duplicate payment: surface it as an exception, caller reports `error`.
    const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
    return {
      inflight: j.inflight ?? null,
      lastFailureAtMs: j.lastFailureAtMs ?? null,
      lastFailureReason: j.lastFailureReason ?? null,
      lastConfirmedAtMs: j.lastConfirmedAtMs ?? null,
      creditCheckSinceMs: j.creditCheckSinceMs ?? null,
      notCredited: j.notCredited ?? null,
    };
  }

  private save(p: Persisted): void {
    mkdirSync(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Read-only view for the status endpoint. */
  inFlight(): Persisted["inflight"] {
    try {
      return this.load().inflight;
    } catch {
      return { kind: "attempt", atMs: 0, amountUsdc: this.cfg.topupUsdc };
    }
  }

  /** Operator escape hatch for an `attempt` whose outcome was checked by hand. Not reachable from rules or AI. */
  clearInFlight(): void {
    const p = this.load();
    this.save({ ...p, inflight: null, creditCheckSinceMs: null, notCredited: null });
  }

  /**
   * One decision, at most one `requestPayment`. `freeUsdc` is the master account's free spot USDC.
   * Never throws; failures come back as `error` and leave the persisted state consistent.
   */
  async maybeTopUp(input: FundingInput): Promise<FundingResult> {
    if (this.busy) return { action: "skipped", reason: "in_flight", detail: "a top-up call is already running" };
    this.busy = true;
    try {
      return await this.run(input);
    } catch (e) {
      return { action: "error", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      this.busy = false;
    }
  }

  /** The vault payout (if any) that the attempt made at `atMs` created; throws when the vault cannot be read. */
  private async findAttemptPayout(atMs: number): Promise<VaultPayoutLite | null> {
    const list = await this.client.listRecentPayouts();
    const hit = list.find(
      (x) => x.createdAtMs >= atMs - CLOCK_SLACK_MS && x.chain.toLowerCase() === FUNDING_CHAIN && x.address.toLowerCase() === this.cfg.masterAddress.toLowerCase(),
    );
    return hit ?? null;
  }

  private async run(input: FundingInput): Promise<FundingResult> {
    const c = this.cfg;
    const skip = (reason: SkipReason, detail?: string): FundingResult => (detail === undefined ? { action: "skipped", reason } : { action: "skipped", reason, detail });
    if (!c.enabled) return skip("disabled");
    const bad = checkFundingConfig(c);
    if (bad) return skip("bad_config", bad);
    if (!ALLOWED_STATES.has(input.state)) return skip("state_blocks", input.state);
    const free = toMicroLenient(input.freeUsdc);
    if (free === null) return skip("bad_balance", input.freeUsdc);
    const amount = toMicroLenient(c.topupUsdc) as bigint;
    const floor = toMicroLenient(c.floorUsdc) as bigint;
    const t = this.now();
    let p = this.load();

    // 0. A Confirmed top-up must show up in the HL balance once the settle window has passed. Checked before the floor
    //    test: otherwise a credited-and-spent balance would look like "never credited". If it did not, stop and warn.
    if (p.notCredited !== null) return skip("not_credited", p.notCredited);
    if (p.creditCheckSinceMs !== null && p.lastConfirmedAtMs !== null && t - p.lastConfirmedAtMs >= (c.settleMs ?? 10 * 60_000) && input.inflowSince) {
      // The ledger, not the free balance: the engine may have spent the credited USDC already. Only "no inflow at all"
      // blocks (1Click fees and slippage make the exact amount unpredictable). A failed lookup is retried next time.
      let inflow: bigint | null;
      try {
        inflow = toMicroLenient(await input.inflowSince(p.creditCheckSinceMs - CLOCK_SLACK_MS));
      } catch {
        inflow = null;
      }
      if (inflow !== null && inflow > 0n) {
        p = { ...p, creditCheckSinceMs: null };
        this.save(p);
      } else if (inflow !== null) {
        const why = `the top-up confirmed at ${p.lastConfirmedAtMs} shows no inflow in the HL ledger; check the HL account, then clear the marker`;
        p = { ...p, notCredited: why };
        this.save(p);
        return skip("not_credited", why);
      }
    }

    // 1. A previous top-up still in flight blocks everything.
    if (p.inflight) {
      const inf = p.inflight;
      const age = t - inf.atMs;
      if (inf.kind === "attempt") {
        // The outcome of the signed call is unknown (timeout, crash between the call and the save). Ask the vault whether
        // a payout of ours appeared; if so the money is already on its way and the marker becomes that payout.
        let found: VaultPayoutLite | null | "unknown";
        try {
          found = await this.findAttemptPayout(inf.atMs);
        } catch {
          found = "unknown";
        }
        if (found !== "unknown" && found !== null) {
          p = { ...p, inflight: { kind: "payout", payoutId: found.id, atMs: inf.atMs, amountUsdc: inf.amountUsdc } };
          this.save(p);
          return skip("in_flight", `adopted payout ${found.id} of a previous request with an unknown outcome`);
        }
        if (age < (c.ambiguousBlockMs ?? 2 * HOUR)) return skip("in_flight", "previous request has an unknown outcome");
        if (found === "unknown") return skip("in_flight", "previous request has an unknown outcome and the vault payout list is unreadable");
        p = { ...p, inflight: null }; // the vault confirms: nothing was created
        this.save(p);
      } else {
        // kind "payout" (a record without payoutId is corrupt: stay blocked until the safety valve)
        let st: string | null;
        try {
          st = inf.payoutId === undefined ? null : (await this.client.getPaymentStatus(inf.payoutId)).status;
        } catch {
          st = null; // cannot tell: stay blocked, unless the safety valve fires below
        }
        if (st !== null && TERMINAL_OK.has(st)) {
          p = { ...p, inflight: null, lastConfirmedAtMs: t, creditCheckSinceMs: p.creditCheckSinceMs };
          this.save(p);
        } else if (st !== null && TERMINAL_BAD.has(st)) {
          p = { ...p, inflight: null, lastFailureAtMs: t, lastFailureReason: `payout ${inf.payoutId} ended as ${st}`, creditCheckSinceMs: null };
          this.save(p);
        } else if (age >= (c.maxInFlightMs ?? 80 * HOUR)) {
          p = { ...p, inflight: null, lastFailureAtMs: t, lastFailureReason: `payout ${inf.payoutId} still ${st ?? "unknown"} after the safety timeout`, creditCheckSinceMs: null };
          this.save(p);
        } else {
          return skip("in_flight", `payout ${inf.payoutId} is ${st ?? "unreadable"}`);
        }
      }
    }
    // 1b. Only now the balance decides: an in-flight top-up is resolved first, whatever the balance is.
    if (free >= floor) return skip("above_floor");
    if (input.equityUsdc !== undefined && input.maxPositionUsdc !== undefined) {
      const eq = toMicroLenient(input.equityUsdc);
      const cap = toMicroLenient(input.maxPositionUsdc);
      if (eq !== null && cap !== null && eq >= cap + floor) return skip("equity_sufficient", `equity ${input.equityUsdc} already covers the position cap plus the floor`);
    }

    if (p.lastConfirmedAtMs !== null && t - p.lastConfirmedAtMs < (c.settleMs ?? 10 * 60_000)) return skip("settling");
    if (p.lastFailureAtMs !== null && t - p.lastFailureAtMs < (c.retryAfterMs ?? HOUR)) return skip("backoff", p.lastFailureReason ?? undefined);

    // 2. Mandate must be exactly what ADR-0005 says. Read fresh, every time.
    let b: Budget;
    try {
      b = await this.client.getBudget();
    } catch (e) {
      return skip("budget_unreadable", e instanceof Error ? e.message : String(e));
    }
    const entry = b.allowlist[0];
    if (
      b.recipientsMode !== "Allowlist" ||
      b.allowlist.length !== 1 ||
      !entry ||
      entry.chain.toLowerCase() !== FUNDING_CHAIN ||
      entry.address.toLowerCase() !== c.masterAddress.toLowerCase()
    )
      return skip("mandate_mismatch", "the allowlist must hold exactly one entry: hypercore + HL_MASTER_ADDRESS");
    if (b.allowedChains.length > 0 && !(b.allowedChains.length === 1 && b.allowedChains[0]?.toLowerCase() === FUNDING_CHAIN))
      return skip("mandate_mismatch", "allowed_chains must be exactly [hypercore]");
    if (b.status !== "Active" || b.vaultPaused) return skip("agent_not_active", b.vaultPaused ? "vault paused" : b.status);
    if (b.expiresAt !== undefined && Date.parse(b.expiresAt) <= t) return skip("agent_not_active", "mandate expired");

    const le = (name: string, v: string): bigint => toMicroLenient(v) ?? (() => { throw new Error(`budget.${name} is not a number: ${v}`); })();
    if (
      b.paymentsLeftToday < 1 ||
      amount > le("perTxLimitUsdc", b.perTxLimitUsdc) ||
      amount > le("remainingTodayUsdc", b.remainingTodayUsdc) ||
      amount > le("vaultRemainingTodayUsdc", b.vaultRemainingTodayUsdc) ||
      amount > le("vaultBalanceUsdc", b.vaultBalanceUsdc) ||
      amount < le("minPaymentUsdc", b.minPaymentUsdc)
    )
      return skip("budget_insufficient");

    // 3. Mark the attempt BEFORE the signed call; a crash after this line leaves a blocking marker, never a duplicate.
    this.save({ ...p, inflight: { kind: "attempt", atMs: t, amountUsdc: c.topupUsdc }, creditCheckSinceMs: t });
    p = { ...p, creditCheckSinceMs: t };
    let out: PaymentOutcome;
    try {
      out = await this.client.requestPayment({ chain: FUNDING_CHAIN, address: c.masterAddress, amountUsdc: c.topupUsdc, memo: "hl-trader top-up" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
      if (!PRE_SIGNING_CODES.has(code)) {
        // AMBIGUOUS_SUBMISSION, VAULT_ERROR (a signed call whose result was not read), CONFIG, untyped errors: the
        // transaction may have executed. Keep the `attempt` marker; the next call reconciles it against the vault.
        return { action: "ambiguous", detail: `${code}: ${msg}` };
      }
      // Only these codes are raised before anything is signed: no money moved, the marker can go.
      this.save({ ...p, inflight: null, lastFailureAtMs: t, lastFailureReason: `${code}: ${msg}`, creditCheckSinceMs: null });
      return { action: "error", detail: `${code}: ${msg}` };
    }

    switch (out.status) {
      case "submitted":
      case "pending_approval": {
        this.save({ ...p, inflight: { kind: "payout", payoutId: out.payoutId, atMs: t, amountUsdc: c.topupUsdc } });
        return { action: out.status, payoutId: out.payoutId };
      }
      case "rejected":
        this.save({ ...p, inflight: null, lastFailureAtMs: t, lastFailureReason: `${out.reason}: ${out.detail}`, creditCheckSinceMs: null });
        return { action: "rejected", reason: out.reason, detail: out.detail };
      case "transfer_failed":
        this.save({ ...p, inflight: null, lastFailureAtMs: t, lastFailureReason: `transfer_failed ${out.payoutId}`, creditCheckSinceMs: null });
        return { action: "transfer_failed", payoutId: out.payoutId };
      default: {
        // Unknown outcome shape: treat as ambiguous and keep the marker.
        return { action: "ambiguous", detail: "unrecognised payment outcome" };
      }
    }
  }
}
