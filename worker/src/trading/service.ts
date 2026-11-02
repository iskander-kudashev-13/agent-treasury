/**
 * The trading service: the long-running owner of one `HlPort`, the persisted engine state and the funding top-ups
 * (ADR-0005 sections 5, 7 and the kill switch). The engine itself (`engine/tick.ts`) is a pure function; everything with
 * side effects around it lives here.
 *
 * Guarantees:
 * - Single flight. `tick()` while a tick runs returns that tick's promise, and the timer only re-arms after a tick has
 *   finished, so two ticks never overlap (no double orders, no interleaved state writes).
 * - Rules are loaded from the store on EVERY tick with a fresh owner check (no cache): a vault whose owner changed, or a
 *   tampered file, means `no_rules` immediately.
 * - Engine state (`EngineState` incl. the sticky halt) is written after every tick (atomic rename) and read at start. A state
 *   file that exists but cannot be parsed makes the service refuse to trade (`error`), never silently drop a halt.
 * - Owner actions that arrive during a tick (kill, confirm -> clearHalt) are applied to the in-memory state at once AND
 *   replayed on the tick's result, so a slow tick cannot overwrite them.
 * - Funding runs after the tick, with the free HL spot USDC the tick just read, and only if the engine state allows it
 *   (see `Funder`).
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsdc } from "agent-treasury-sdk";
import { z } from "zod";
import { addDec } from "./hl/format.js";
import { clearHalt, haltState, initialEngineState, runTick } from "./engine/tick.js";
import type { EngineState, LogEntry, StatusPieces, VaultView } from "./engine/tick.js";
import { effectiveLimits, effectiveLimitsStatus } from "./engine/risk.js";
import type { ConfirmCtx } from "./confirm.js";
import type { Funder, FundingResult } from "./funding.js";
import type { RulesStore } from "./store.js";
import type { ApiWallet, ApiWalletManager } from "./wallet.js";
import type { ConfirmedRules, HardLimits, HlPort, TradingState, TradingStatus } from "./types.js";

export interface TradingSettings {
  vault: string;
  agentId: string;
  hlNetwork: "mainnet" | "testnet";
  /** `HL_MASTER_ADDRESS`. */
  account: string;
  hard: HardLimits;
  tickSec: number;
  deadmanSec: number;
  stateDir: string;
  /** `TRADING_START_MS`; unset = the time of the first tick (persisted). */
  startMs?: number | undefined;
}

export interface TradingServiceDeps {
  settings: TradingSettings;
  hl: HlPort;
  /** Rebuilds the HL adapter around a new API wallet after `rotate()`. Absent = the same adapter keeps being used (tests). */
  createHl?: ((w: ApiWallet) => HlPort) | undefined;
  wallet: ApiWalletManager;
  store: RulesStore;
  /** `vaultOwner` here must be uncached. */
  confirmCtx: ConfirmCtx;
  readVault: () => Promise<VaultView>;
  /** Null when top-ups are disabled. */
  funder: Funder | null;
  /** Called after a top-up was submitted so the SDK reports the terminal 1Click status to the vault. */
  watchPayment?: ((payoutId: string) => { done: Promise<{ kind: string }> }) | undefined;
  /** Vault status of a payout, used on start to resume watching a top-up that was in flight. */
  paymentStatus?: ((payoutId: string) => Promise<{ status: string }>) | undefined;
  now?: (() => number) | undefined;
}

/** Service-level failure with an HTTP status the route maps one to one. */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface KillResult {
  state: "halted";
  cancelled_orders: number;
  steps: {
    cancel_all: "ok" | "failed";
    schedule_cancel: "ok" | "failed";
    /** "failed" = the halt could not be written to disk: a restart would forget it, so the owner must act (stop the worker, revoke the API wallet). */
    state_saved: "ok" | "failed";
    /** "timeout" = the tick that was running did not finish in time; it was told to stop and cannot place orders anymore, but its last order may still be resting (cancel_all covers it). */
    tick_wait: "ok" | "timeout";
  };
}

const engineStateSchema = z.looseObject({
  version: z.literal(1),
  halt: z.nullable(z.looseObject({ reason: z.string(), atMs: z.number(), detail: z.string() })),
  orderCounter: z.number().int().nonnegative(),
  firedAt: z.record(z.string(), z.number()),
  orders: z.record(z.string(), z.looseObject({ ruleId: z.string(), expiresAtMs: z.number().nullable() })),
  recent: z.array(z.looseObject({})),
});

/** HL needs scheduleCancel at least 5 s in the future; "now" for the kill switch is the earliest allowed moment plus margin. */
export const KILL_SCHEDULE_CANCEL_MS = 6_000;
const LOG_TAIL_BYTES = 512 * 1024;
const MAX_REASON_CHARS = 200;
/** How long a kill waits for the tick that is running before it cancels (the tick can no longer place or reschedule). */
export const KILL_WAIT_TICK_MS = 10_000;
const MAX_PUBLIC_TEXT = 200;

/** Public `/status` text: no URLs or query strings (RPC / HL endpoints can carry keys), bounded length. */
export function publicText(s: string | null): string | null {
  if (s === null) return null;
  return s
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\?[A-Za-z0-9_.~%-]+=\S*/g, "")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, MAX_PUBLIC_TEXT);
}

const budgetRaw = z.looseObject({
  status: z.enum(["Active", "Paused", "Revoked"]),
  vault_paused: z.boolean(),
  remaining_today: z.string().regex(/^\d+$/),
  per_tx_limit: z.string().regex(/^\d+$/),
  payments_today: z.number().int(),
  max_payments_per_day: z.number().int(),
  expires_at: z.string().regex(/^\d+$/).nullable(),
});

/** `get_agent_budget` (raw contract JSON, ADR-0003) -> the engine's `VaultView`. Throws on an unexpected shape (fail closed). */
export function vaultViewFromBudget(raw: unknown): VaultView {
  const b = budgetRaw.parse(raw);
  return {
    vaultPaused: b.vault_paused,
    status: b.status,
    remainingTodayUsdc: formatUsdc(BigInt(b.remaining_today)),
    perTxLimitUsdc: formatUsdc(BigInt(b.per_tx_limit)),
    paymentsToday: b.payments_today,
    maxPaymentsPerDay: b.max_payments_per_day,
    expiresAtMs: b.expires_at === null ? null : Number(b.expires_at),
  };
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TradingService {
  private hl: HlPort;
  private readonly now: () => number;
  private readonly stateFile: string;
  private readonly logFile: string;
  private readonly metaFile: string;
  private state: EngineState;
  /** Set when the state file exists but is unusable: the service then refuses to trade. */
  private fatal: string | null = null;
  private inflight: Promise<void> | null = null;
  /** Owner mutations that arrived while a tick was running (replayed on its result). */
  private pendingOps: ((s: EngineState) => EngineState)[] | null = null;
  private last: { pieces: StatusPieces; tradingState: TradingState; rules: ConfirmedRules | null } | null = null;
  private extraWarnings = new Map<string, string>();
  private lastFundingKey = "";
  private startMs: number | undefined;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Bumped by every kill. A tick remembers the value it started with and stops trading when it changes. */
  private killEpoch = 0;
  /** The last state write failed. While true the service refuses to trade (a halt or counter could be lost). */
  private persistFailed = false;

  constructor(private readonly d: TradingServiceDeps) {
    this.hl = d.hl;
    this.now = d.now ?? Date.now;
    const dir = d.settings.stateDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.stateFile = join(dir, "engine-state.json");
    this.logFile = join(dir, "log.jsonl");
    this.metaFile = join(dir, "meta.json");
    this.state = this.loadState();
    this.startMs = d.settings.startMs ?? this.loadStartMs();
  }

  /** The current HL adapter (changes after `rotate`). Read-only uses only (pair metadata for validation). */
  hlPort(): HlPort {
    return this.hl;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------------------------------------------------

  private loadState(): EngineState {
    if (!existsSync(this.stateFile)) return initialEngineState();
    try {
      const parsed = engineStateSchema.safeParse(JSON.parse(readFileSync(this.stateFile, "utf8")));
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return { ...initialEngineState(), ...(parsed.data as unknown as EngineState) };
    } catch (e) {
      this.fatal = `engine-state.json is unreadable (${errMsg(e)}); fix or delete it after checking that no halt was recorded`;
      return initialEngineState();
    }
  }

  private loadStartMs(): number | undefined {
    try {
      if (!existsSync(this.metaFile)) return undefined;
      const j = JSON.parse(readFileSync(this.metaFile, "utf8")) as { startMs?: unknown };
      return typeof j.startMs === "number" && Number.isFinite(j.startMs) ? j.startMs : undefined;
    } catch {
      return undefined;
    }
  }

  private persistState(): boolean {
    try {
      writeAtomic(this.stateFile, JSON.stringify(this.state));
      this.extraWarnings.delete("persist");
      this.persistFailed = false;
      return true;
    } catch (e) {
      this.extraWarnings.set("persist", `engine state could not be saved: ${errMsg(e)}`);
      this.persistFailed = true;
      return false;
    }
  }

  private appendLog(entries: readonly LogEntry[]): void {
    if (entries.length === 0) return;
    try {
      appendFileSync(this.logFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    } catch (e) {
      this.extraWarnings.set("log", `log.jsonl is not writable: ${errMsg(e)}`);
    }
  }

  /** Newest first, at most `limit` entries (reads only the tail of the file). */
  readLog(limit: number): LogEntry[] {
    if (!existsSync(this.logFile)) return [];
    const fd = openSync(this.logFile, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      if (size > len) lines.shift(); // first line is cut
      const out: LogEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const e = JSON.parse(line) as LogEntry;
          if (typeof e.at_ms === "number" && typeof e.kind === "string" && typeof e.detail === "string") out.push(e);
        } catch {
          /* skip a damaged line */
        }
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }

  /** Applies an owner mutation now and replays it on the result of a tick that is running. */
  private mutate(fn: (s: EngineState) => EngineState): boolean {
    this.state = fn(this.state);
    this.pendingOps?.push(fn);
    return this.persistState();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------------------------------------------------

  /** Runs one tick unless one is running (then returns that one). Never throws. */
  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.runOnce().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  /** A tick that started AFTER this call (waits for a running one first). Used after an owner action. */
  async tickFresh(): Promise<void> {
    if (this.inflight) await this.inflight;
    await this.tick();
  }

  isTicking(): boolean {
    return this.inflight !== null;
  }

  private async runOnce(): Promise<void> {
    const now = this.now();
    const s = this.d.settings;
    const epoch = this.killEpoch;
    this.pendingOps = [];
    try {
      if (this.fatal !== null) {
        this.setErrorStatus(now, "STATE_CORRUPT", this.fatal);
        return;
      }
      // A state file that cannot be written means a halt, a counter or a cooldown could be forgotten: do not trade.
      if (this.persistFailed && !this.persistState()) {
        this.setErrorStatus(now, "STATE_WRITE_FAILED", "engine state cannot be written; not trading until it can");
        return;
      }
      if (this.startMs === undefined) {
        this.startMs = now;
        try {
          writeAtomic(this.metaFile, JSON.stringify({ startMs: now }));
        } catch {
          /* non-fatal: the baseline is recomputed from the next start */
        }
      }
      const loaded = await this.d.store.loadActive(this.d.confirmCtx).catch((e: unknown) => ({ status: "refused" as const, code: "LOAD_ERROR", reason: errMsg(e) }));
      let rules: { rules: ConfirmedRules["rules"]; hash: string; confirmedAtMs: number } | null = null;
      let confirmed: ConfirmedRules | null = null;
      if (loaded.status === "ok") {
        confirmed = loaded.confirmed;
        rules = { rules: confirmed.rules, hash: confirmed.hash, confirmedAtMs: confirmed.confirmed_at_ms };
        this.extraWarnings.delete("rules");
      } else if (loaded.status === "refused") {
        this.extraWarnings.set("rules", `the stored active rules were refused: ${loaded.code}: ${loaded.reason}`);
      } else {
        this.extraWarnings.delete("rules");
      }

      let apiAddress: string;
      try {
        apiAddress = this.d.wallet.address();
      } catch (e) {
        this.setErrorStatus(now, "API_WALLET_UNAVAILABLE", errMsg(e));
        return;
      }

      const result = await runTick(
        {
          hl: this.hl,
          vault: this.d.readVault,
          config: { account: s.account, apiWalletAddress: apiAddress, hard: s.hard, tickSec: s.tickSec, deadmanSec: s.deadmanSec, fundedSinceMs: this.startMs },
          // A kill that arrived after this tick started (or a KILLED halt that is still in force) stops every order and
          // every dead-man refresh of this tick.
          shouldStop: () => this.killEpoch !== epoch || this.state.halt?.reason === "KILLED",
          // Write-ahead: order counter / cooldown / daily count reach the disk before the order can reach HL.
          beforeOrder: (st) => {
            try {
              const merged = (this.pendingOps ?? []).reduce((acc, fn) => fn(acc), st);
              writeAtomic(this.stateFile, JSON.stringify(merged));
            } catch (e) {
              this.persistFailed = true;
              this.extraWarnings.set("persist", `engine state could not be saved: ${errMsg(e)}`);
              throw e;
            }
          },
        },
        { nowMs: now, rules, state: this.state },
      );
      let next = result.state;
      for (const op of this.pendingOps) next = op(next);
      this.state = next;
      this.persistState();
      this.appendLog(result.entries);

      const tradingState: TradingState = next.halt !== null ? "halted" : result.tradingState;
      this.last = { pieces: result.status, tradingState, rules: confirmed };

      // Funding runs on what this tick just read. The Funder itself refuses in every state except running / no_rules /
      // awaiting_api_wallet and when the mandate differs from ADR-0005.
      if (this.d.funder) {
        const fr = await this.d.funder.maybeTopUp({
          state: tradingState,
          freeUsdc: result.status.balances.usdc_free,
          equityUsdc: result.status.balances.equity_usdc,
          maxPositionUsdc: s.hard.maxPositionUsdc,
          inflowSince: async (since) => {
            const rows = await this.hl.getLedger(s.account, since);
            return rows.filter((r) => r.kind === "deposit" || r.kind === "transfer_in").reduce((a, r) => addDec(a, r.usdc), "0");
          },
        });
        this.noteFunding(fr, now);
      }
    } catch (e) {
      this.setErrorStatus(now, "SERVICE_ERROR", errMsg(e));
    } finally {
      this.pendingOps = null;
    }
  }

  private setErrorStatus(now: number, reason: string, detail: string): void {
    const base = this.last?.pieces ?? this.emptyPieces();
    this.last = {
      pieces: { ...base, state: "error", state_reason: reason, state_detail: detail.slice(0, 600), last_tick_ms: now, next_tick_ms: now + this.d.settings.tickSec * 1000 },
      tradingState: "error",
      rules: this.last?.rules ?? null,
    };
    this.appendLog([{ at_ms: now, kind: "state", detail: `error: ${reason} (${detail.slice(0, 200)})` }]);
  }

  private noteFunding(fr: FundingResult, at: number): void {
    const bad = fr.action === "rejected" || fr.action === "error" || fr.action === "ambiguous" || fr.action === "transfer_failed";
    const key = JSON.stringify(fr);
    if (fr.action === "skipped") {
      this.extraWarnings.delete("topup");
      // Skips are the normal case (above floor, in flight...). Log only the ones that need the owner's attention, once.
      const notable = fr.reason === "not_credited" || fr.reason === "mandate_mismatch" || fr.reason === "agent_not_active" || fr.reason === "budget_insufficient" || fr.reason === "bad_config" || fr.reason === "backoff";
      if (notable && key !== this.lastFundingKey) this.appendLog([{ at_ms: at, kind: "topup", detail: `skipped: ${fr.reason}${fr.detail ? ` (${fr.detail.slice(0, 200)})` : ""}` }]);
      if (fr.reason === "mandate_mismatch" || fr.reason === "not_credited") this.extraWarnings.set("topup", `top-ups are blocked: ${fr.detail ?? fr.reason}`.slice(0, 300));
      this.lastFundingKey = notable ? key : "";
      return;
    }
    this.lastFundingKey = "";
    const detail =
      fr.action === "submitted" || fr.action === "pending_approval"
        ? `${fr.action}: payout ${fr.payoutId}`
        : fr.action === "transfer_failed"
          ? `transfer_failed: payout ${fr.payoutId}`
          : fr.action === "rejected"
            ? `rejected: ${fr.reason}: ${fr.detail}`
            : `${fr.action}: ${fr.detail}`;
    this.appendLog([{ at_ms: at, kind: "topup", detail: detail.slice(0, 300) }]);
    if (bad) this.extraWarnings.set("topup", `last top-up: ${detail}`.slice(0, 300));
    else this.extraWarnings.delete("topup");
    if (fr.action === "submitted" && this.d.watchPayment) this.watch(fr.payoutId);
  }

  private watch(payoutId: string): void {
    try {
      void this.d.watchPayment?.(payoutId).done.then(
        (o) => {
          this.appendLog([{ at_ms: this.now(), kind: "topup", detail: `payout ${payoutId} watch ended: ${o.kind}` }]);
        },
        (e: unknown) => {
          this.appendLog([{ at_ms: this.now(), kind: "topup", detail: `payout ${payoutId} watch failed: ${errMsg(e).slice(0, 200)}` }]);
        },
      );
    } catch (e) {
      this.appendLog([{ at_ms: this.now(), kind: "topup", detail: `could not watch payout ${payoutId}: ${errMsg(e).slice(0, 200)}` }]);
    }
  }

  /** On start: a top-up that was submitted before a restart needs its terminal status reported again. */
  private async resumeWatches(): Promise<void> {
    const inf = this.d.funder?.inFlight();
    if (!inf || inf.kind !== "payout" || inf.payoutId === undefined || !this.d.paymentStatus) return;
    try {
      const st = await this.d.paymentStatus(inf.payoutId);
      if (st.status === "Sent" || st.status === "Transferring") this.watch(inf.payoutId);
    } catch {
      /* the next funding check reads the status again */
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.resumeWatches();
    const loop = (): void => {
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(loop, this.d.settings.tickSec * 1000);
      });
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------------------------------------------------

  private emptyPieces(): StatusPieces {
    const eff = effectiveLimits(null, this.d.settings.hard);
    return {
      state: "not_configured",
      state_reason: "NO_TICK_YET",
      state_detail: "the worker has not completed a trading tick yet",
      api_wallet: { address: this.safeAddress(), approved: false, name: null, valid_until_ms: null },
      other_approved_agents: [],
      balances: { usdc_free: "0", usdc_total: "0", equity_usdc: "0", positions: [] },
      pnl: { today_usdc: "0", total_usdc: "0", net_funded_usdc: "0", day_start_equity_usdc: "0" },
      limits: {
        effective: effectiveLimitsStatus(eff, this.d.settings.hard.priceBandBps),
        today: { orders: 0, loss_usdc: "0" },
        position_usdc: "0",
        vault: { status: "Paused", remaining_today_usdc: "0", per_tx_limit_usdc: "0", payments_today: 0, max_payments_per_day: 0, expires_at_ms: null },
      },
      open_orders: [],
      dead_man: { cancel_at_ms: this.state.deadManAtMs },
      perp_check: { ok: true, at_ms: 0 },
      last_tick_ms: null,
      next_tick_ms: null,
      warnings: [],
    };
  }

  private safeAddress(): string {
    try {
      return this.d.wallet.address();
    } catch {
      return "";
    }
  }

  /** Full `TradingStatus` (public: everything in it is also visible on HL and NEAR). */
  status(): TradingStatus {
    const s = this.d.settings;
    const pieces = this.last?.pieces ?? this.emptyPieces();
    let state: TradingState = this.last?.tradingState ?? pieces.state;
    let reason = pieces.state_reason;
    let detail = pieces.state_detail;
    // A kill (or a perp alarm) that arrived after the last tick is visible at once.
    if (this.state.halt !== null && state !== "halted") {
      state = "halted";
      reason = this.state.halt.reason;
      detail = this.state.halt.detail;
    }
    if (this.fatal !== null && this.last === null) {
      state = "error";
      reason = "STATE_CORRUPT";
      detail = this.fatal;
    }
    const rules = this.last?.rules ?? null;
    const refused = this.extraWarnings.get("rules");
    if (state === "no_rules" && refused) {
      reason = "RULES_REFUSED";
      detail = refused;
    }
    return {
      enabled: true,
      ...pieces,
      state,
      state_reason: reason,
      state_detail: publicText(detail),
      hl_network: s.hlNetwork,
      hl_account: s.account,
      vault: s.vault,
      agent_id: s.agentId,
      api_wallet: { ...pieces.api_wallet, address: this.safeAddress() || pieces.api_wallet.address },
      dead_man: { cancel_at_ms: this.state.deadManAtMs },
      active_rules: rules ? { hash: rules.hash, name: rules.rules.name, confirmed_at_ms: rules.confirmed_at_ms, confirmed_by: rules.account_id } : null,
      warnings: [...pieces.warnings, ...this.extraWarnings.values()].map((w) => publicText(w) ?? ""),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Owner actions
  // -------------------------------------------------------------------------------------------------------------------

  isPerpHalted(): boolean {
    return this.state.halt?.reason === "PERP_POSITION_DETECTED";
  }

  /**
   * Called BEFORE a confirmation is accepted. After a perp alarm a new rule set is refused while a perp is still open
   * (the bot never closes it; the owner does). Fails closed when HL cannot be read.
   */
  async assertMayActivate(): Promise<void> {
    if (!this.isPerpHalted()) return;
    let perp;
    try {
      perp = await this.hl.getPerpState(this.d.settings.account);
    } catch {
      throw new ServiceError(502, "HL_UNAVAILABLE", "Could not read the Hyperliquid perp state to check the perp alarm");
    }
    const still = perp.positions.length > 0 || perp.openPerpOrders > 0 || Number(perp.accountValueUsdc) > 1;
    if (still) {
      throw new ServiceError(
        409,
        "PERP_STILL_OPEN",
        "The bot is halted because a perp position or order was detected and it is still open. Close it on app.hyperliquid.xyz (and revoke or rotate the API wallet), then sign the rules again.",
      );
    }
  }

  /** A new rule set was confirmed and stored: lift the halt, start the baseline if needed, and run a tick so `state` is real. */
  async activated(env: ConfirmedRules): Promise<TradingState> {
    if (this.startMs === undefined) {
      this.startMs = env.confirmed_at_ms;
      try {
        writeAtomic(this.metaFile, JSON.stringify({ startMs: this.startMs }));
      } catch {
        /* non-fatal */
      }
    }
    const had = this.state.halt !== null;
    this.mutate(clearHalt);
    this.appendLog([{ at_ms: this.now(), kind: "state", detail: `rules ${env.hash.slice(0, 16)} confirmed by ${env.account_id}${had ? "; halt cleared" : ""}` }]);
    await this.tickFresh();
    return this.status().state;
  }

  /**
   * Kill switch. Halts for good (until a new signed rule set), cancels every spot order and sets the dead-man switch to
   * fire within seconds. Both HL steps are attempted whatever the other one does.
   */
  async kill(reason?: string): Promise<KillResult> {
    const s = this.d.settings;
    const at = this.now();
    const why = reason ? reason.replace(/\p{Cc}/gu, " ").slice(0, MAX_REASON_CHARS) : "";
    // Synchronous, before the first await: from here on a running tick cannot place an order or move the dead-man switch.
    this.killEpoch += 1;
    this.mutate((st) => haltState(st, at, "KILLED", why ? `kill switch: ${why}` : "kill switch"));
    this.appendLog([{ at_ms: at, kind: "state", detail: `KILL SWITCH${why ? `: ${why}` : ""}` }]);

    // Wait (bounded) for the tick that is running: after it ends nothing else can create an order, so the cancel below
    // sees every order and our scheduleCancel is the last one.
    let tickWait: "ok" | "timeout" = "ok";
    const running = this.inflight;
    if (running) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, KILL_WAIT_TICK_MS);
      });
      const r = await Promise.race([running.then(() => "ok" as const, () => "ok" as const), timeout]);
      if (timer) clearTimeout(timer);
      tickWait = r;
    }

    let cancelled = 0;
    let cancelAll: "ok" | "failed" = "ok";
    try {
      const [orders, pairs] = await Promise.all([this.hl.getOpenOrders(s.account), this.hl.getSpotPairs()]);
      const byName = new Map(pairs.map((p) => [p.name, p.assetId]));
      const spot = orders.filter((o) => o.market === "spot");
      const targets: { assetId: number; oid: number }[] = [];
      let unresolved = 0;
      for (const o of spot) {
        const id = byName.get(o.pair);
        if (id === undefined || id < 10_000) unresolved += 1;
        else targets.push({ assetId: id, oid: o.oid });
      }
      if (targets.length > 0) await this.hl.cancelOrders(targets);
      cancelled = targets.length;
      if (unresolved > 0) cancelAll = "failed";
    } catch {
      cancelAll = "failed";
    }
    let sched: "ok" | "failed" = "ok";
    const fireAt = this.now() + KILL_SCHEDULE_CANCEL_MS;
    try {
      await this.hl.scheduleCancel(fireAt);
      this.mutate((st) => ({ ...st, deadManAtMs: fireAt }));
    } catch {
      sched = "failed";
    }
    const saved = this.persistState(); // final write: also retries a halt that could not be saved at the start
    this.appendLog([
      { at_ms: this.now(), kind: "cancel", detail: `kill: cancel_all ${cancelAll} (${cancelled} order(s)), schedule_cancel ${sched}, state_saved ${saved ? "ok" : "failed"}, tick_wait ${tickWait}` },
    ]);
    return {
      state: "halted",
      cancelled_orders: cancelled,
      steps: { cancel_all: cancelAll, schedule_cancel: sched, state_saved: saved ? "ok" : "failed", tick_wait: tickWait },
    };
  }

  /** New API wallet (the old key is deleted). Orders of the old key are cancelled first, best effort. */
  async rotateApiWallet(): Promise<string> {
    // Serialized with the tick: wait for a running one, then hold the single-flight slot while the key is swapped, so no
    // tick sees the old adapter with the new key (or the reverse).
    while (this.inflight) await this.inflight;
    const op = this.rotateExclusive();
    const slot = op.then(
      () => undefined,
      () => undefined,
    );
    this.inflight = slot;
    let address: string;
    try {
      address = await op;
    } finally {
      await slot;
      if (this.inflight === slot) this.inflight = null;
    }
    await this.tickFresh();
    return address;
  }

  private async rotateExclusive(): Promise<string> {
    const s = this.d.settings;
    try {
      const [orders, pairs] = await Promise.all([this.hl.getOpenOrders(s.account), this.hl.getSpotPairs()]);
      const byName = new Map(pairs.map((p) => [p.name, p.assetId]));
      const targets = orders.flatMap((o) => (o.market === "spot" && byName.has(o.pair) ? [{ assetId: byName.get(o.pair) as number, oid: o.oid }] : []));
      if (targets.length > 0) await this.hl.cancelOrders(targets);
    } catch {
      /* the dead-man switch and the old key's revocation cover this */
    }
    let address: string;
    try {
      address = this.d.wallet.rotate();
    } catch (e) {
      throw new ServiceError(400, "ROTATE_REFUSED", errMsg(e));
    }
    if (this.d.createHl) this.hl = this.d.createHl(this.d.wallet.load());
    this.mutate((st) => ({ ...st, deadManAtMs: null }));
    this.appendLog([{ at_ms: this.now(), kind: "state", detail: `API wallet rotated; new address ${address}` }]);
    return address;
  }
}
