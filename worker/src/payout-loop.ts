import { OneClickError, isTerminal } from "./oneclick.js";
import type { OneClickClient, QuoteRequest, StatusResponse } from "./oneclick.js";
import { checkRealQuote } from "./quote-check.js";
import type { PaymentResult, ReportedStatus, Vault, VaultPayout } from "./vault.js";

/** What the loop pays: a due schedule joined with its address-book recipient. */
interface Target {
  scheduleId: number;
  recipientId: number;
  label: string;
  amount: string;
  overdue: boolean;
  destination_chain: string;
  destination_asset: string;
  destination_address: string;
}

export type OneClickPort = Pick<OneClickClient, "findToken" | "quote" | "submitDeposit" | "getStatus">;

export interface LoopSettings {
  dryRun: boolean;
  vaultId: string;
  agentAccountId: string;
  slippageBps: number;
  /** Requested validity of the real quote (the check requires >= 5 min left). */
  quoteTtlMs: number;
  /** Quote validity for payments above the agent's approval threshold, so the owner has time to approve. */
  approvalQuoteTtlMs: number;
  pollTimeoutMs: number;
  pollInitialMs: number;
  pollMaxMs: number;
  /** How many recent vault payouts to scan for `Sent` ones left unreported by an earlier run. */
  reconcileWindow: number;
}

/**
 * How far back (by creation time) the worker looks for Key agents' `Sent` payouts. Approval is possible up to 72 h
 * after creation (contract MAX_APPROVAL_AGE); the rest covers a worker that was down for a while. Older ones are left
 * to the owner (dashboard) to finish.
 */
export const KEY_RECONCILE_HORIZON_MS = 14 * 24 * 60 * 60_000;

export interface LoopDeps {
  vault: Vault;
  oneclick: OneClickPort;
  settings: LoopSettings;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export type RecipientOutcome =
  | "dry_run_quoted"
  | "confirmed"
  | "refunded"
  | "failed"
  | "pending_approval"
  | "rejected"
  | "aborted"
  | "poll_timeout"
  | "error";

export interface RecipientResult {
  recipientId: number;
  scheduleId?: number;
  label: string;
  outcome: RecipientOutcome;
  message: string;
  payoutId?: string;
  depositAddress?: string;
  nearTxHash?: string;
  destinationTxHash?: string;
  steps: string[];
}

export interface RunRecord {
  id: number;
  trigger: "schedule" | "manual";
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  outcome: "running" | "ok" | "error";
  error?: string;
  reconciled: { payoutId: string; status: ReportedStatus }[];
  results: RecipientResult[];
}

const RING_SIZE = 50;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Abort extends Error {}

function statusToReport(s: StatusResponse): { status: ReportedStatus; txHash: string | undefined } | undefined {
  const dest = s.swapDetails?.destinationChainTxHashes?.[0]?.hash;
  const origin = s.swapDetails?.originChainTxHashes?.[0]?.hash;
  switch (s.status) {
    case "SUCCESS":
      return { status: "Confirmed", txHash: dest };
    case "REFUNDED":
      return { status: "Refunded", txHash: origin };
    case "FAILED":
      return { status: "Failed", txHash: origin };
    default:
      return undefined;
  }
}

/**
 * One payout run at a time (single-flight). Per due recipient:
 * validate assets -> dry quote -> real quote -> verify quote -> request_payout -> deposit/submit -> poll -> report.
 */
export class PayoutLoop {
  private readonly runs: RunRecord[] = [];
  private nextId = 1;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  nextRunAt: Date | undefined;
  private approvalThreshold = 0n;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: LoopDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => {
      console.log(m);
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  recentRuns(): RunRecord[] {
    return [...this.runs].reverse();
  }

  lastRun(): RunRecord | undefined {
    return this.runs[this.runs.length - 1];
  }

  /** Starts the periodic schedule. `canRun` lets the caller hold runs back until the agent is registered. */
  schedule(intervalMs: number, canRun: () => boolean = () => true): void {
    const tick = () => {
      this.nextRunAt = new Date(this.now() + intervalMs);
      if (canRun()) void this.run("schedule");
      this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Returns `undefined` when another run is in progress (no overlap). */
  async run(trigger: RunRecord["trigger"]): Promise<RunRecord | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const rec: RunRecord = {
      id: this.nextId++,
      trigger,
      dryRun: this.deps.settings.dryRun,
      startedAt: new Date(this.now()).toISOString(),
      outcome: "running",
      reconciled: [],
      results: [],
    };
    this.runs.push(rec);
    if (this.runs.length > RING_SIZE) this.runs.shift();
    try {
      await this.execute(rec);
      rec.outcome = "ok";
    } catch (e) {
      rec.outcome = "error";
      rec.error = errMsg(e);
      this.log(`run ${rec.id} failed: ${rec.error}`);
    } finally {
      rec.finishedAt = new Date(this.now()).toISOString();
      this.running = false;
    }
    return rec;
  }

  private async execute(rec: RunRecord): Promise<void> {
    const { vault, settings } = this.deps;
    const info = await vault.getContractInfo();
    const budget = await vault.getAgentBudget();
    if (!budget) throw new Error("agent slot not found on the vault: the owner must add_agent first");
    this.approvalThreshold = BigInt(budget.approval_threshold);
    if (budget.vault_paused || (await vault.isPaused())) {
      this.log("vault is paused: nothing to do");
      return;
    }
    if (budget.status !== "Active") {
      this.log(`agent status is ${budget.status}: nothing to do`);
      return;
    }
    // Includes payouts the owner approved after an earlier run (the vault transferred them itself): poll and report.
    if (!settings.dryRun) await this.reconcileSent(rec);

    // The contract blocks a schedule after 3 failed attempts; skip it here too instead of burning quotes.
    const due = (await vault.getDue(this.now())).filter((s) => (s.failed_attempts ?? 0) < 3);
    this.log(`run ${rec.id}: ${due.length} due schedule(s)`);
    for (const item of due) {
      const res: RecipientResult = { recipientId: item.recipient_id, scheduleId: item.id, label: `schedule ${item.id}`, outcome: "error", message: "", steps: [] };
      rec.results.push(res);
      const r: Target = { scheduleId: item.id, recipientId: item.recipient_id, label: res.label, amount: item.amount, overdue: item.overdue, destination_chain: "", destination_asset: "", destination_address: "" };
      try {
        // Address book lookup: where to pay.
        const rcpt = await vault.getRecipient(item.recipient_id);
        if (!rcpt) throw new Abort(`recipient ${item.recipient_id} of schedule ${item.id} not found`);
        r.label = res.label = rcpt.label;
        r.destination_chain = rcpt.destination_chain;
        r.destination_asset = rcpt.destination_asset;
        r.destination_address = rcpt.destination_address;
        await this.processRecipient(r, `nep141:${info.treasury_token}`, res);
      } catch (e) {
        if (e instanceof Abort) {
          res.outcome = "aborted";
        } else {
          res.outcome = "error";
        }
        res.message = errMsg(e);
        this.log(`schedule ${item.id} (${res.label}): ${res.outcome}: ${res.message}`);
      }
    }
  }

  private quoteRequest(r: Target, originAsset: string, dry: boolean): QuoteRequest {
    const { settings } = this.deps;
    // Long quotes give the owner time to approve: overdue schedules and amounts above the agent's threshold wait for approval.
    const needsApproval = r.overdue || BigInt(r.amount) > this.approvalThreshold;
    const ttl = needsApproval ? settings.approvalQuoteTtlMs : settings.quoteTtlMs;
    return {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: settings.slippageBps,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: r.destination_asset,
      amount: r.amount,
      refundTo: settings.vaultId,
      refundType: "ORIGIN_CHAIN",
      recipient: r.destination_address,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(this.now() + ttl).toISOString(),
      // No msg / customRecipientMsg on purpose: failed withdrawals must stay refundable.
    };
  }

  private async processRecipient(r: Target, originAsset: string, res: RecipientResult): Promise<void> {
    const { vault, oneclick, settings } = this.deps;
    const step = (s: string) => {
      res.steps.push(s);
      this.log(`schedule ${r.scheduleId} (${r.label}): ${s}`);
    };

    // 1. assets must come from /v0/tokens (never hand-built)
    const dest = await oneclick.findToken(r.destination_asset);
    if (!dest) throw new Abort(`destination_asset ${r.destination_asset} is not in /v0/tokens`);
    if (dest.blockchain !== r.destination_chain) {
      throw new Abort(`destination_chain ${r.destination_chain} != token blockchain ${dest.blockchain}`);
    }
    if (!(await oneclick.findToken(originAsset))) throw new Abort(`origin asset ${originAsset} is not in /v0/tokens`);
    step("assets validated");

    // 2. dry quote (sanity, creates no deposit address)
    const dry = await oneclick.quote(this.quoteRequest(r, originAsset, true));
    if (dry.quote.amountIn !== r.amount) throw new Abort(`dry quote amountIn ${dry.quote.amountIn} != amount`);
    step(`dry quote ok: amountOut ${dry.quote.amountOut} (min ${dry.quote.minAmountOut})`);
    if (settings.dryRun) {
      res.outcome = "dry_run_quoted";
      res.message = `DRY_RUN: would pay ${r.amount} -> ${dry.quote.amountOutFormatted ?? dry.quote.amountOut}`;
      return;
    }

    // 3. real quote + defense in depth
    const real = await oneclick.quote(this.quoteRequest(r, originAsset, false));
    const problems = checkRealQuote(real, {
      originAsset,
      destinationAsset: r.destination_asset,
      recipient: r.destination_address,
      amount: r.amount,
      refundTo: settings.vaultId,
      nowMs: this.now(),
    });
    if (problems.length > 0) throw new Abort(`quote rejected, request_payout NOT called: ${problems.join("; ")}`);
    const depositAddress = real.quote.depositAddress;
    if (depositAddress === undefined) throw new Abort("no depositAddress"); // narrowing; checkRealQuote already covers it
    res.depositAddress = depositAddress;
    step(`real quote verified, deposit address ${depositAddress}`);

    // 4. request_payout (never retried blindly)
    const before = await vault.getSchedule(r.scheduleId);
    if (before?.status !== "Active") throw new Abort("schedule vanished or is not Active before request_payout");
    const deadlineMs = Date.parse(real.quote.deadline ?? "");
    let txHash: string | undefined;
    let result: PaymentResult | undefined;
    let callError: unknown;
    try {
      ({ txHash, result } = await vault.requestPayment({
        scheduleId: r.scheduleId,
        depositAddress,
        depositExpiresAtMs: deadlineMs,
      }));
    } catch (e) {
      callError = e; // ambiguous: the tx may have executed; resolved by re-reading state below
      step(`request_payout call did not return cleanly (${errMsg(e)}); re-reading vault state`);
    }
    res.nearTxHash = txHash;

    if (result && "Rejected" in result) {
      res.outcome = "rejected";
      res.message = `${result.Rejected.reason}: ${result.Rejected.detail}`;
      step(`vault rejected the payment, not retried: ${res.message}`);
      return;
    }
    if (result && "PendingApproval" in result) {
      res.payoutId = result.PendingApproval.payout_id;
      res.outcome = "pending_approval";
      res.message = `payout ${res.payoutId} needs owner approval (${result.PendingApproval.reason ?? "unknown reason"}); once approved the vault transfers it and a later run reports it`;
      step(res.message);
      return;
    }
    if (result && "TransferFailed" in result) {
      res.payoutId = result.TransferFailed.payout_id;
      res.outcome = "failed";
      res.message = "ft_transfer to the deposit address failed; vault released the reservation";
      step(res.message);
      return;
    }

    // Submitted, or the result is unknown: identify the payout from vault state and verify it is ours.
    const after = await vault.getSchedule(r.scheduleId);
    const lookupId = result ? result.Submitted.payout_id : (after?.open_payout ?? undefined);
    let payout: VaultPayout | null = lookupId !== undefined ? await vault.getPayout(lookupId) : null;
    if (!result && payout?.status === "PendingApproval" && payout.id !== before.open_payout) {
      res.payoutId = payout.id;
      res.outcome = "pending_approval";
      res.message = `payout ${payout.id} needs owner approval (${payout.approval_reason ?? "unknown reason"}); skipped`;
      step(res.message);
      return;
    }
    if (!payout || payout.deposit_address !== depositAddress) {
      // Funds did not move toward our address as far as the vault state shows.
      if (callError !== undefined) throw new Abort(`request_payout failed: ${errMsg(callError)}`);
      throw new Abort("request_payout returned but the vault shows no payout to our deposit address");
    }
    res.payoutId = payout.id;
    for (let i = 0; i < 5 && payout?.status === "Transferring"; i++) {
      await this.sleep(2000);
      payout = await vault.getPayout(res.payoutId);
    }
    if (payout?.status === "Failed") {
      res.outcome = "failed";
      res.message = "ft_transfer to the deposit address failed; vault released the reservation";
      step(res.message);
      return;
    }
    if (payout?.status !== "Sent") {
      throw new Abort(`payout ${res.payoutId} is ${payout?.status ?? "missing"}, expected Sent`);
    }
    step(`payout ${res.payoutId} Sent`);

    // 5. tell 1Click (optional speed-up; failure is not fatal)
    if (txHash !== undefined) {
      try {
        await oneclick.submitDeposit({ txHash, depositAddress, nearSenderAccount: settings.agentAccountId });
        step("deposit/submit ok");
      } catch (e) {
        step(`deposit/submit failed (non-fatal): ${errMsg(e)}`);
      }
    }

    // 6. poll until terminal, then report
    const final = await this.pollTerminal(depositAddress, step);
    if (!final) {
      res.outcome = "poll_timeout";
      res.message = "no terminal 1Click status yet; payout stays Sent and is reconciled on the next run";
      step(res.message);
      return;
    }
    const report = statusToReport(final);
    if (!report) throw new Abort(`unexpected terminal status ${final.status}`);
    res.destinationTxHash = final.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    const mine = await this.report(res.payoutId, report.status, report.txHash);
    step(mine ? `reported ${report.status}` : "already reported by someone else (the vault keeps their status)");
    res.outcome = report.status === "Confirmed" ? "confirmed" : report.status === "Refunded" ? "refunded" : "failed";
    res.message = `1Click ${final.status}`;
  }

  /** Bounded polling with exponential backoff. Transient 1Click errors are tolerated until the deadline. */
  private async pollTerminal(depositAddress: string, step: (s: string) => void): Promise<StatusResponse | undefined> {
    const { oneclick, settings } = this.deps;
    const deadline = this.now() + settings.pollTimeoutMs;
    let delay = settings.pollInitialMs;
    for (;;) {
      try {
        const s = await oneclick.getStatus(depositAddress);
        if (isTerminal(s.status)) return s;
        step(`1Click status ${s.status}`);
      } catch (e) {
        step(`status poll error (retrying): ${errMsg(e)}`);
      }
      if (this.now() + delay > deadline) return undefined;
      await this.sleep(delay);
      delay = Math.min(delay * 2, settings.pollMaxMs);
    }
  }

  /**
   * report_payout_status is idempotent on the contract, so a bounded retry is safe. Returns false when someone else
   * already wrote a terminal status (the vault's status may differ from ours, so callers must not record ours).
   */
  private async report(payoutId: string, status: ReportedStatus, txHash: string | undefined): Promise<boolean> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.deps.vault.reportPayoutStatus({ payoutId, status, txHash });
        return true;
      } catch (e) {
        // Someone else (the Key agent's MCP, the owner) already reported a terminal status first: nothing to retry.
        if (/not in Sent state/.test(errMsg(e))) {
          this.log(`payout ${payoutId} already reported by someone else`);
          return false;
        }
        // Not allowed (e.g. our attestation expired): retrying will not help.
        if (/Only the agent that created the payout/.test(errMsg(e))) throw e;
        last = e;
        await this.sleep(1000 * (i + 1));
      }
    }
    throw new Error(`report_payout_status failed after retries: ${errMsg(last)}`);
  }

  /**
   * Pick up `Sent` payouts whose terminal status was never reported: this agent's own (earlier poll timeout, crash)
   * and Key agents' payouts approved by the owner after the agent's process went away. The vault lets an attested
   * TEE agent report the latter (ADR-0002 "Status reporting"); the status always comes from 1Click itself.
   */
  private async reconcileSent(rec: RunRecord): Promise<void> {
    const { vault, oneclick, settings } = this.deps;
    const own = await vault.getRecentPayouts(settings.reconcileWindow);
    let keyAgents: VaultPayout[] = [];
    try {
      keyAgents = await vault.getSentKeyAgentPayouts({ sinceMs: this.now() - KEY_RECONCILE_HORIZON_MS, pageSize: 100, maxPages: 20 });
    } catch (e) {
      this.log(`reconcile: could not list Key agents' payouts: ${errMsg(e)}`);
    }
    const seen = new Set<string>();
    for (const p of [...own, ...keyAgents]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.status !== "Sent" || p.deposit_address === null) continue;
      try {
        const s = await oneclick.getStatus(p.deposit_address);
        const report = isTerminal(s.status) ? statusToReport(s) : undefined;
        if (!report) continue;
        if (!(await this.report(p.id, report.status, report.txHash))) continue;
        rec.reconciled.push({ payoutId: p.id, status: report.status });
        this.log(`reconciled payout ${p.id}: ${report.status}`);
      } catch (e) {
        // Unknown deposit address (404) or transient error: leave it for the next run.
        this.log(`reconcile payout ${p.id} skipped: ${e instanceof OneClickError ? e.message : errMsg(e)}`);
      }
    }
  }
}
