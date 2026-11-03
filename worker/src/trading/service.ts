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
import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsdc } from "agent-treasury-sdk";
import { z } from "zod";
import { addDec } from "./hl/format.js";
import { BotRegistry, RegistryError, botKind, openRegistry } from "./bots.js";
import { AgentGate, OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, hlErrorText, plainText, rejected, responseMessage } from "./agent.js";
import type { RemainingToday } from "./agent.js";
import type { BotsFile } from "./bots.js";
import { clearHalt, haltAll, haltBot, initialEngineState, runTick } from "./engine/tick.js";
import { positionOf } from "./engine/fills.js";
import type { BotInput, BotView, EngineState, LogEntry, StatusPieces, TickInput, TickResult, VaultView } from "./engine/tick.js";
import { type EngineStateV1, initialEngineStateV1, migrateV1 } from "./engine/migrate.js";
import { emptyBotState } from "./engine/state.js";
import { type Fx, MIN_NOTIONAL, effectiveLimits, effectiveLimitsStatus, fx, fxMin, fxMul, fxStr } from "./engine/risk.js";
import { DAY_MS, utcDayIndex } from "./engine/pnl.js";
import type { ConfirmCtx } from "./confirm.js";
import type { Funder, FundingResult } from "./funding.js";
import { HistoryStore, RANGE_MS } from "./history.js";
import type { HistoryPoint, Range } from "./history.js";
import { FillsJournal } from "./journal.js";
import type { BotFill, JournalFill } from "./journal.js";
import { type BotMetrics, applyFill, computeMetrics, type CostBook } from "./metrics.js";
import type { RulesStore } from "./store.js";
import type { ApiWallet, ApiWalletManager } from "./wallet.js";
import { ACCOUNT_SCOPE } from "./history.js";
import { DEFAULT_BOT_ID } from "./types.js";
import { HALT_REASONS } from "./types.js";
import type {
  AgentIntent,
  AgentOrderResponse,
  AgentState,
  Bot,
  BotDetail,
  BotState,
  BotSummary,
  ConfirmedRules,
  HaltReason,
  HardLimits,
  HlFill,
  HlPort,
  HlSpotPair,
  TradingState,
  TradingStatus,
} from "./types.js";

/** ADR-0007 section 8 (`TRADING_AGENT_*`). */
export interface AgentTradingSettings {
  enabled: boolean;
  maxOrdersPerDay: number;
  minOrderIntervalSec: number;
  tokenTtlHours: number;
}
export const AGENT_TRADING_OFF: AgentTradingSettings = { enabled: false, maxOrdersPerDay: 10, minOrderIntervalSec: 10, tokenTtlHours: 72 };

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
  /** `TRADING_MAX_BOTS`: bots that are not archived (default 3, 1..5). */
  maxBots?: number | undefined;
  /** ADR-0007. Absent = agent-driven trading off. */
  agent?: AgentTradingSettings | undefined;
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
    readonly status: 400 | 401 | 404 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Result of `archive`. `warning` is set when the archive went through on weaker evidence than usual. */
export interface ArchiveResult {
  bot: BotSummary;
  cancelled_orders: number;
  warning?: string;
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

/** Result of `POST /trading/bots/:id/kill`: only this bot stops, the account and the other bots continue. */
export interface BotKillResult {
  bot_id: string;
  state: "halted";
  cancelled_orders: number;
  steps: { cancel: "ok" | "failed"; state_saved: "ok" | "failed" };
}

const looseDec = z.string();
const aggMapSchema = z.record(z.string(), z.looseObject({ cash: looseDec, dq: looseDec, fees: looseDec, lastPx: looseDec }));
const haltSchema = z.nullable(z.looseObject({ reason: z.string(), atMs: z.number(), detail: z.string() }));

/** `version: 1` (single bot): converted by `migrateV1`. Fields added over time are optional (defaults come from `initialEngineStateV1`). */
const engineStateSchemaV1 = z.looseObject({
  version: z.literal(1),
  halt: haltSchema,
  orderCounter: z.number().int().nonnegative(),
  firedAt: z.record(z.string(), z.number()),
  orders: z.record(z.string(), z.looseObject({ ruleId: z.string(), expiresAtMs: z.number().nullable() })),
  recent: z.array(z.looseObject({})),
  botPrefixes: z.array(z.string().regex(/^0x[0-9a-f]{16}$/)).optional(),
  botOids: z.array(z.number().int().nonnegative()).optional(),
  prefixesDropped: z.number().int().nonnegative().optional(),
  filledOrdersToday: z.number().int().nonnegative().optional(),
  filledOidsToday: z.array(z.number().int().nonnegative()).optional(),
  deadManGatedAtMs: z.nullable(z.number()).optional(),
  stopReason: z.nullable(z.enum(["DAILY_LOSS_STOP", "EQUITY_DROP"])).optional(),
  fills: z
    .nullable(
      z.looseObject({
        cursorMs: z.number(),
        seen: z.array(z.looseObject({ k: z.string(), t: z.number() })),
        totalComplete: z.boolean(),
        completeFromMs: z.number().optional(),
        botOidsToday: z.array(z.number().int().nonnegative()).optional(),
        basis: z.record(z.string(), z.record(z.string(), z.looseObject({ size: z.string(), cost: z.string() }))).optional(),
        todayFromMs: z.nullable(z.number()),
        total: aggMapSchema,
        today: aggMapSchema,
        botFillsToday: z.number().int().nonnegative(),
        foreignFills: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const intNN = z.number().int().nonnegative();
const decStr = z.string().regex(/^-?\d+(\.\d+)?$/);
/** Fields below are optional (older v2 files lack some) but, when present, must have the right type: a mismatch is fatal. */
const daySchema = z.nullable(
  z.looseObject({
    dayIndex: intNN,
    startEquity: decStr,
    snapshotAtMs: z.number(),
    startBackstop: decStr.optional(),
    balanceAtMs: z.number().optional(),
    startPositions: z.record(z.string(), z.looseObject({ size: decStr, mid: decStr })).optional(),
  }),
);
const startPositionsSchema = z.record(z.string(), z.looseObject({ size: decStr, mid: decStr }));

const botStateSchema = z.looseObject({
  firedAt: z.record(z.string(), z.number()),
  orders: z.record(z.string(), z.looseObject({ ruleId: z.string(), expiresAtMs: z.number().nullable() })),
  halt: haltSchema,
  ordersToday: intNN.optional(),
  filledOrdersToday: intNN.optional(),
  filledOidsToday: z.array(intNN).optional(),
  stoppedDayIndex: z.nullable(intNN).optional(),
  stopReason: z.nullable(z.literal("DAILY_LOSS_STOP")).optional(),
  startPositions: startPositionsSchema.optional(),
  agg: z.looseObject({
    total: aggMapSchema,
    today: aggMapSchema,
    totalComplete: z.boolean(),
    botFillsToday: z.number().int().nonnegative(),
    botOidsToday: z.array(z.number().int().nonnegative()),
    basis: z.record(z.string(), z.record(z.string(), z.looseObject({ size: z.string(), cost: z.string() }))),
  }),
});

/** `version: 2`. */
const engineStateSchemaV2 = z.looseObject({
  version: z.literal(2),
  account: z.looseObject({
    halt: haltSchema,
    day: daySchema.optional(),
    ordersToday: intNN.optional(),
    stoppedDayIndex: z.nullable(intNN).optional(),
    stopReason: z.nullable(z.enum(["ACCOUNT_LOSS_STOP", "EQUITY_DROP"])).optional(),
    orderCounter: z.number().int().nonnegative(),
    recent: z.array(z.looseObject({})),
    fillCursor: z
      .nullable(
        z.looseObject({
          cursorMs: z.number(),
          seen: z.array(z.looseObject({ k: z.string(), t: z.number() })),
          completeFromMs: z.number(),
          todayFromMs: z.nullable(z.number()),
          foreignFills: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  }),
  oidBot: z.record(z.string(), z.string()),
  bots: z.record(z.string(), botStateSchema),
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
export function vaultViewFromBudget(raw: unknown, agentId = "hl-trader"): VaultView {
  // `get_agent_budget` returns null for an unknown agent: say so plainly instead of a schema error.
  if (raw === null) throw new Error(`agent '${agentId}' not found in the vault: create it on the Trading page (Setup)`);
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

/** A log entry as the API returns it: `bot_id` is always present (null = account-level). */
export type LoggedEntry = Omit<LogEntry, "bot_id"> & { bot_id: string | null };

/** Per-bot facts of the last tick the HTTP layer needs. */
interface LastTick {
  pieces: StatusPieces;
  tradingState: TradingState;
  bots: Record<string, BotView>;
  /** Verified envelope per bot id (null = none / refused). */
  rules: Map<string, ConfirmedRules | null>;
  /** Bot ids whose stored active envelope was refused. */
  refused: Set<string>;
}

const HOUR_MS = 3_600_000;
const SPARK_POINTS = 24;
/** Archiving is refused while the bot holds at least this much (the HL minimum order, so it could still sell it). */
const ARCHIVE_MAX_POSITION: Fx = MIN_NOTIONAL;
const PAIRS_CACHE_MS = 300_000;

export class TradingService {
  private hl: HlPort;
  private readonly now: () => number;
  private readonly stateFile: string;
  private readonly logFile: string;
  private readonly metaFile: string;
  private state: EngineState;
  /** Set when a state file exists but is unusable: the service then refuses to trade. */
  private fatal: string | null = null;
  private inflight: Promise<void> | null = null;
  /** ADR-0007: what holds the single-flight slot. A scheduled tick never just joins an agent tick (it runs its own after it). */
  private inflightKind: "tick" | "agent" | null = null;
  /** ADR-0007: per agent bot, one request in flight, the order interval, and the idempotency cache (memory only). */
  readonly agentGate: AgentGate;
  /** ADR-0007: last authenticated agent request per bot (memory only: no bots.json write per request). */
  private readonly agentLastUsed = new Map<string, number>();
  /** Owner mutations that arrived while a tick was running (replayed on its result). */
  private pendingOps: ((s: EngineState) => EngineState)[] | null = null;
  private last: LastTick | null = null;
  private extraWarnings = new Map<string, string>();
  private lastFundingKey = "";
  private startMs: number | undefined;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Bumped by every kill. A tick remembers the value it started with and stops trading when it changes. */
  private killEpoch = 0;
  /** Per-bot counterpart of `killEpoch` (kill of one bot, archive). */
  private readonly botEpoch = new Map<string, number>();
  /** The last state write failed. While true the service refuses to trade (a halt or counter could be lost). */
  private persistFailed = false;
  /** Bumped whenever `last.bots` comes from a completed engine tick (archive needs a view newer than its own cancel). */
  private viewSeq = 0;
  /** Bot registry (`bots.json`): the permanent prefix map and each bot's active hash. */
  readonly registry: BotRegistry;
  private readonly history: HistoryStore;
  private readonly journal: FillsJournal;
  private readonly books = new Map<string, CostBook>();
  private pairsCache: { at: number; pairs: HlSpotPair[] } | null = null;

  constructor(private readonly d: TradingServiceDeps) {
    this.hl = d.hl;
    this.now = d.now ?? Date.now;
    const dir = d.settings.stateDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.stateFile = join(dir, "engine-state.json");
    this.logFile = join(dir, "log.jsonl");
    this.metaFile = join(dir, "meta.json");
    this.startMs = d.settings.startMs ?? this.loadStartMs();
    this.history = new HistoryStore(dir, this.now);
    this.agentGate = new AgentGate(this.agentSettings.minOrderIntervalSec * 1000, this.now);
    this.journal = new FillsJournal(dir);
    // State first (pure parse; a v1 file also yields the cloid prefixes the old engine remembered), then the registry
    // (which migrates `active.json`), then the converted state is written. Each step is idempotent, see bots.ts / migrate.ts.
    const loaded = this.readStateFile();
    if (this.fatal !== null) this.preserveCorrupt("engine-state.json");
    let registry: BotRegistry;
    const emptyFile: BotsFile = { version: 1, bots: [], legacy_v1: null };
    try {
      // An unreadable engine state must not trigger the registry migration: it would record only the prefixes it can see and
      // lose the older ones for good. The service is fatal anyway; the migration runs once the operator fixed the state file.
      if (this.fatal !== null && !existsSync(join(dir, "bots.json"))) registry = new BotRegistry(dir, emptyFile, this.fatal);
      else registry = openRegistry(dir, { legacyPrefixes: loaded.prefixes, startMs: this.startMs });
    } catch (e) {
      this.fatal = `bots.json / active.json is unusable (${errMsg(e)})`;
      this.preserveCorrupt(existsSync(join(dir, "bots.json")) ? "bots.json" : "active.json");
      registry = new BotRegistry(dir, emptyFile, this.fatal);
    }
    this.registry = registry;
    this.state = loaded.state;
    // A v1 state always yields a `default` bot block; if the registry has no such bot (it never had rules) and the block is
    // pristine, it is not state worth keeping (and would otherwise look like a bot that bots.json lost).
    if (loaded.migratedFromV1 && this.fatal === null && registry.get(DEFAULT_BOT_ID) === undefined) {
      const d = this.state.bots[DEFAULT_BOT_ID];
      if (d !== undefined && Object.keys(d.agg.total).length === 0 && Object.keys(d.orders).length === 0) {
        const rest = Object.fromEntries(Object.entries(this.state.bots).filter(([id]) => id !== DEFAULT_BOT_ID));
        this.state = { ...this.state, bots: rest, oidBot: Object.fromEntries(Object.entries(this.state.oidBot).filter(([, b]) => b !== DEFAULT_BOT_ID)) };
      }
    }
    // Bot ids are permanent. If bots.json lost a bot that the engine state still knows (deleted, restored from an old backup),
    // trading on would let a new strategy reuse the id and inherit the old position and fills: refuse to start.
    registry.reserveStateIds(() => this.stateBotIds());
    if (this.fatal === null) {
      const missing = this.missingFromRegistry();
      if (missing.length > 0) {
        this.fatal = `bots.json does not list bot(s) ${missing.slice(0, 5).join(", ")} that engine-state.json still knows; restore bots.json from a backup (bot ids are never reused)`;
      }
    }
    if (loaded.migratedFromV1 && this.fatal === null) this.finishMigration();
    if (this.fatal === null) this.applyHaltMarker();
    if (this.fatal === null) {
      try {
        this.history.enforceRetention(ACCOUNT_SCOPE);
        for (const b of registry.list()) this.history.enforceRetention(b.id);
      } catch {
        /* retention is housekeeping; the next compaction retries */
      }
    }
  }

  /** False while HL refuses the dead-man switch for volume: limit orders get a warning when proposed or confirmed. */
  deadManAvailable(): boolean {
    return this.state.account.deadManGatedAtMs == null;
  }

  /** Kill state that concerns one bot (kill-all epoch + the bot's own epoch). A rules challenge is bound to it (audit MM2). */
  killStamp(botId: string): string {
    return `${this.killEpoch}:${this.botEpoch.get(botId) ?? 0}`;
  }

  /** Why owner writes (confirm, rename, archive) are refused right now, or null. Set when a state file is unusable. */
  writeBlockedReason(): string | null {
    return this.fatal;
  }

  private assertWritable(): void {
    if (this.fatal !== null) throw new ServiceError(409, "STATE_CORRUPT", `The trading state is unusable, so no changes are accepted: ${this.fatal}`);
  }

  /** Every bot id the engine state refers to. */
  private stateBotIds(): string[] {
    return [...new Set([...Object.keys(this.state.bots), ...Object.values(this.state.oidBot)])];
  }

  private missingFromRegistry(): string[] {
    const known = new Set(this.registry.list().map((b) => b.id));
    return this.stateBotIds().filter((id) => !known.has(id));
  }

  /**
   * Keeps a copy of an unreadable state / registry file as `<name>.corrupt.<ts>.json` (once per distinct content) so nothing an
   * operator or a later write could replace is lost. Best effort.
   */
  private preserveCorrupt(file: string): void {
    try {
      const dir = this.d.settings.stateDir;
      const src = join(dir, file);
      if (!existsSync(src)) return;
      const bytes = readFileSync(src);
      const stem = file.replace(/\.json$/, "");
      for (const f of readdirSync(dir)) if (f.startsWith(`${stem}.corrupt.`) && readFileSync(join(dir, f)).equals(bytes)) return;
      writeFileSync(join(dir, `${stem}.corrupt.${this.now()}.json`), bytes, { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  // The halt marker: when engine-state.json cannot be trusted the kill switch must not overwrite it, but it must still be
  // remembered. The halt goes to `halt-marker.json` and is applied (then deleted) by the first start that can read the state.
  private get markerFile(): string {
    return join(this.d.settings.stateDir, "halt-marker.json");
  }

  private readMarker(): { bot_id: string | null; reason: HaltReason; atMs: number; detail: string }[] | "unreadable" {
    if (!existsSync(this.markerFile)) return [];
    try {
      const j: unknown = JSON.parse(readFileSync(this.markerFile, "utf8"));
      const p = z.object({ version: z.literal(1), halts: z.array(z.object({ bot_id: z.nullable(z.string()), reason: z.enum(HALT_REASONS), atMs: z.number(), detail: z.string() })) }).parse(j);
      return p.halts;
    } catch {
      return "unreadable";
    }
  }

  private writeHaltMarker(botId: string | null, atMs: number, reason: HaltReason, detail: string): boolean {
    try {
      const prev = this.readMarker();
      const halts = prev === "unreadable" ? [] : prev;
      if (prev === "unreadable") this.preserveCorrupt("halt-marker.json");
      writeAtomic(this.markerFile, JSON.stringify({ version: 1, halts: [...halts, { bot_id: botId, reason, atMs, detail }] }));
      return true;
    } catch {
      return false;
    }
  }

  private applyHaltMarker(): void {
    const m = this.readMarker();
    if (m === "unreadable") {
      this.fatal = "halt-marker.json is unreadable (a kill was recorded there while the engine state was unusable); fix or delete it after checking what was killed";
      this.preserveCorrupt("halt-marker.json");
      return;
    }
    if (m.length === 0) return;
    for (const h of m) {
      this.state = h.bot_id === null ? haltAll(this.state, h.atMs, h.reason, h.detail, this.registry.live().map((b) => b.id)) : haltBot(this.state, h.bot_id, h.atMs, h.reason, h.detail);
    }
    this.appendLog([{ at_ms: this.now(), kind: "state", detail: `halt marker applied (${m.length} halt(s) recorded while the engine state was unusable)` }]);
    if (this.persistState()) {
      try {
        unlinkSync(this.markerFile);
      } catch {
        /* applying it again is harmless (a halt is sticky) */
      }
    }
  }

  /** The current HL adapter (changes after `rotate`). Read-only uses only (pair metadata for validation). */
  hlPort(): HlPort {
    return this.hl;
  }

  get maxBots(): number {
    return this.d.settings.maxBots ?? 3;
  }

  get agentSettings(): AgentTradingSettings {
    return this.d.settings.agent ?? AGENT_TRADING_OFF;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------------------------------------------------

  /** Parses engine-state.json (v1 or v2). A v1 file is converted in memory here; `finishMigration` writes it. */
  private readStateFile(): { state: EngineState; prefixes: string[]; migratedFromV1: boolean } {
    if (!existsSync(this.stateFile)) return { state: initialEngineState(), prefixes: [], migratedFromV1: false };
    try {
      const raw: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
      if (version === 1) {
        const p = engineStateSchemaV1.safeParse(raw);
        if (!p.success) throw new Error(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        const m = migrateV1({ ...initialEngineStateV1(), ...(p.data as unknown as EngineStateV1) });
        return { state: m.state, prefixes: m.prefixes, migratedFromV1: true };
      }
      const p = engineStateSchemaV2.safeParse(raw);
      if (!p.success) throw new Error(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const d = p.data as unknown as EngineState;
      const base = initialEngineState();
      return {
        state: {
          ...base,
          ...d,
          account: { ...base.account, ...d.account },
          bots: Object.fromEntries(Object.entries(d.bots).map(([id, b]) => [id, { ...emptyBotState(), ...b }])),
        },
        prefixes: [],
        migratedFromV1: false,
      };
    } catch (e) {
      this.fatal = `engine-state.json is unreadable (${errMsg(e)}); fix or delete it after checking that no halt was recorded (and revoke every agent token first)`;
      return { state: initialEngineState(), prefixes: [], migratedFromV1: false };
    }
  }

  /** Keeps the v1 file as `engine-state.v1.json` (never overwritten), then writes the converted state. */
  private finishMigration(): void {
    try {
      const backup = join(this.d.settings.stateDir, "engine-state.v1.json");
      if (!existsSync(backup)) copyFileSync(this.stateFile, backup);
      writeAtomic(this.stateFile, JSON.stringify(this.state));
      this.appendLog([{ at_ms: this.now(), kind: "state", detail: "engine state migrated to version 2 (single bot became bot 'default'); the old file is kept as engine-state.v1.json" }]);
    } catch (e) {
      this.fatal = `could not write the migrated engine state (${errMsg(e)}); the v1 file is untouched, fix the directory and restart`;
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
    // Never write over a state file that could not be read: its content (a halt, a counter) may be recoverable by the operator.
    if (this.fatal !== null) return false;
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

  /**
   * Newest first, at most `limit` entries (reads only the tail of the file). `botId` keeps one bot's entries. Entries written
   * before bots existed have no `bot_id`: orders and skips were the single bot's (`default`), the rest is account-level.
   */
  readLog(limit: number, botId?: string): LoggedEntry[] {
    if (!existsSync(this.logFile)) return [];
    const fd = openSync(this.logFile, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      if (size > len) lines.shift(); // first line is cut
      const out: LoggedEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const e = JSON.parse(line) as LogEntry;
          if (typeof e.at_ms !== "number" || typeof e.kind !== "string" || typeof e.detail !== "string") continue;
          const owner = e.bot_id ?? (e.kind === "order" || e.kind === "skip" ? DEFAULT_BOT_ID : null);
          if (botId !== undefined && owner !== botId) continue;
          out.push({ ...e, bot_id: owner });
        } catch {
          /* skip a damaged line */
        }
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }

  /** Order attempts of a bot since `fromMs`, from the log tail (a bound, not an audit: the tail is 512 KB). */
  private countOrders(botId: string, fromMs: number): number {
    let n = 0;
    for (const e of this.readLog(10_000, botId)) {
      if (e.at_ms < fromMs) break;
      if (e.kind === "order") n++;
    }
    return n;
  }

  /** Applies an owner mutation now and replays it on the result of a tick that is running. */
  private mutate(fn: (s: EngineState) => EngineState): boolean {
    this.state = fn(this.state);
    this.pendingOps?.push(fn);
    return this.persistState(); // false while fatal: memory only, the caller records halts in the marker file
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------------------------------------------------

  /** Runs one tick unless one is running (then returns that one). Never throws. */
  tick(): Promise<void> {
    if (this.inflight) {
      // ADR-0007: an agent tick runs only that agent's order; DSL bots must not be starved, so run a full tick after it.
      if (this.inflightKind !== "agent") return this.inflight;
      return this.inflight.then(() => this.tick());
    }
    const p = this.runOnce()
      .then(() => undefined)
      .finally(() => {
        this.inflight = null;
        this.inflightKind = null;
      });
    this.inflight = p;
    this.inflightKind = "tick";
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

  /**
   * One engine tick. `agent` (ADR-0007) makes it an agent tick: the same reads, gates and write-ahead, but in step 7 only that
   * intent is tried. Returns the tick result, or null when the tick did not run (an error status was set instead).
   */
  private async runOnce(agent?: TickInput["agent"], probe?: { reached: boolean }): Promise<TickResult | null> {
    const now = this.now();
    const s = this.d.settings;
    const epoch = this.killEpoch;
    const botEpochs = new Map(this.registry.list().map((b) => [b.id, this.botEpoch.get(b.id) ?? 0]));
    this.pendingOps = [];
    try {
      if (this.fatal !== null) {
        this.setErrorStatus(now, "STATE_CORRUPT", this.fatal);
        return null;
      }
      // A state file that cannot be written means a halt, a counter or a cooldown could be forgotten: do not trade.
      if (this.persistFailed && !this.persistState()) {
        this.setErrorStatus(now, "STATE_WRITE_FAILED", "engine state cannot be written; not trading until it can");
        return null;
      }
      const missing = this.missingFromRegistry();
      if (missing.length > 0) {
        this.setErrorStatus(now, "REGISTRY_MISSING_BOT", `engine state refers to bot(s) ${missing.slice(0, 5).join(", ")} that the registry does not list`);
        return null;
      }
      if (this.startMs === undefined) {
        this.startMs = now;
        try {
          writeAtomic(this.metaFile, JSON.stringify({ startMs: now }));
        } catch {
          /* non-fatal: the baseline is recomputed from the next start */
        }
      }
      // Every bot's active rule set is loaded and fully re-verified on EVERY tick (owner still the owner, signature, hash,
      // limits, the envelope belongs to this bot). A refused bot has no rules; the others are not affected.
      const botsIn: BotInput[] = [];
      const rules = new Map<string, ConfirmedRules | null>();
      const refused = new Set<string>();
      const legacy = this.registry.legacyV1();
      for (const b of this.registry.list()) {
        let envelope: ConfirmedRules | null = null;
        if (b.archived_at_ms === null && b.active_hash !== null) {
          const loaded = await this.d.store
            .loadBot(b, this.d.confirmCtx, { legacyV1Hash: legacy?.bot_id === b.id ? legacy.hash : null })
            .catch((e: unknown) => ({ status: "refused" as const, code: "LOAD_ERROR", reason: errMsg(e) }));
          if (loaded.status === "ok") {
            envelope = loaded.confirmed;
            this.extraWarnings.delete(`rules:${b.id}`);
          } else if (loaded.status === "refused") {
            refused.add(b.id);
            this.extraWarnings.set(`rules:${b.id}`, `bot ${b.id}: the stored active rules were refused: ${loaded.code}: ${loaded.reason}`);
          }
        } else this.extraWarnings.delete(`rules:${b.id}`);
        rules.set(b.id, envelope);
        botsIn.push({
          id: b.id,
          createdAtMs: b.created_at_ms,
          archived: b.archived_at_ms !== null,
          prefixes: b.hashes.map((h) => h.prefix),
          rules: envelope ? { rules: envelope.rules, hash: envelope.hash, confirmedAtMs: envelope.confirmed_at_ms } : null,
          refused: refused.has(b.id),
        });
      }

      let apiAddress: string;
      try {
        apiAddress = this.d.wallet.address();
      } catch (e) {
        this.setErrorStatus(now, "API_WALLET_UNAVAILABLE", errMsg(e));
        return null;
      }

      const result = await runTick(
        {
          hl: this.hl,
          vault: this.d.readVault,
          config: { account: s.account, apiWalletAddress: apiAddress, hard: s.hard, tickSec: s.tickSec, deadmanSec: s.deadmanSec, fundedSinceMs: this.startMs },
          // A kill that arrived after this tick started (or a KILLED halt that is still in force) stops every order and
          // every dead-man refresh of this tick; a kill of one bot (or its archive) stops that bot's orders only.
          vaultTopups: () => this.d.funder?.confirmedTopups() ?? [],
          // Stamps the day snapshot's balance read (outflow window of the equity backstop).
          clock: this.now,
          shouldStop: (botId) => {
            if (this.killEpoch !== epoch || this.state.account.halt?.reason === "KILLED") return true;
            if (botId === undefined) return false;
            return (this.botEpoch.get(botId) ?? 0) !== (botEpochs.get(botId) ?? 0) || this.state.bots[botId]?.halt?.reason === "KILLED";
          },
          // Write-ahead: order counter / cooldown / daily count reach the disk before the order can reach HL.
          beforeOrder: (st, attributed) => {
            // Journal first: this tick's fills are already inside `st` (cursor moved past them). If we crashed after writing the
            // state but before the journal, those rows would be lost for good; the journal de-duplicates the later replay.
            this.recordFills(attributed);
            try {
              const merged = (this.pendingOps ?? []).reduce((acc, fn) => fn(acc), st);
              writeAtomic(this.stateFile, JSON.stringify(merged));
            } catch (e) {
              this.persistFailed = true;
              this.extraWarnings.set("persist", `engine state could not be saved: ${errMsg(e)}`);
              throw e;
            }
            if (probe !== undefined) probe.reached = true; // the order call comes next (agent ticks: review M1)
          },
        },
        { nowMs: now, bots: botsIn, state: this.state, ...(agent !== undefined ? { agent } : {}) },
      );
      let next = result.state;
      for (const op of this.pendingOps) next = op(next);
      // Journal and history first, state second: a crash in between replays the fills, which the journal de-duplicates.
      this.record(now, result);
      this.state = next;
      this.persistState();
      this.appendLog(result.entries);
      this.viewSeq += 1;

      const tradingState: TradingState = next.account.halt !== null ? "halted" : result.tradingState;
      this.last = { pieces: result.status, tradingState, bots: result.bots, rules, refused };

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
      return result;
    } catch (e) {
      this.setErrorStatus(now, "SERVICE_ERROR", errMsg(e));
      return null;
    } finally {
      this.pendingOps = null;
    }
  }

  /** Cost book of a bot, rebuilt from its journal the first time it is needed. */
  private bookOf(botId: string): CostBook {
    let b = this.books.get(botId);
    if (b === undefined) {
      b = new Map();
      for (const f of this.journal.readAll(botId)) applyFill(b, f);
      this.books.set(botId, b);
    }
    return b;
  }

  /**
   * Writes the fills journal (realized P&L and position after each fill, by average cost) and folds the per-bot and account
   * samples into the history buckets. Failures are warnings: charts and tables must never stop trading.
   */
  private record(now: number, r: Awaited<ReturnType<typeof runTick>>): void {
    this.recordFills(r.attributed);
    try {
      for (const v of Object.values(r.bots)) {
        if (!v.priced || v.state === "archived") continue;
        this.history.record({ botId: v.id, atMs: now, pnl: v.pnlTotal, positionUsdc: v.positionUsdc, today: v.pnlToday, pos: v.pos, px: v.px });
      }
      if (r.accountSample) this.history.record({ botId: ACCOUNT_SCOPE, atMs: now, pnl: r.accountSample.pnl, positionUsdc: r.accountSample.positionUsdc, equity: r.accountSample.equity, today: r.accountSample.today, px: r.accountSample.px });
    } catch (e) {
      this.extraWarnings.set("history", `history / fills journal not writable: ${errMsg(e)}`);
    }
  }

  /** Appends fills to the journal (idempotent: a fill already journaled is skipped). Failure is a warning, never a stop. */
  private recordFills(attributed: readonly Awaited<ReturnType<typeof runTick>>["attributed"][number][]): void {
    try {
      for (const a of attributed) {
        const f: HlFill = a.fill;
        const jf: JournalFill = {
          tid: f.tid ?? null,
          oid: f.oid,
          cloid: f.cloid,
          rule_id: a.ruleId,
          time_ms: f.timeMs,
          pair: f.pair,
          side: f.side,
          px: f.price,
          sz: f.size,
          fee_usdc: f.feeUsdc,
          fee_token: f.feeToken ?? "USDC",
          fee_amount: f.feeAmount ?? f.feeUsdc,
          realized_usdc: null,
          pos_after: "0",
          ...(typeof a.note === "string" ? { note: a.note } : {}),
        };
        if (this.journal.has(a.botId, jf)) continue;
        const applied = applyFill(this.bookOf(a.botId), jf);
        jf.realized_usdc = applied.realized === null ? null : fxStr(applied.realized);
        jf.pos_after = fxStr(applied.posAfter > 0n ? applied.posAfter : 0n, 8);
        this.journal.append(a.botId, [jf]);
      }
      this.extraWarnings.delete("history");
    } catch (e) {
      this.extraWarnings.set("history", `history / fills journal not writable: ${errMsg(e)}`);
    }
  }

  private setErrorStatus(now: number, reason: string, detail: string): void {
    const base = this.last?.pieces ?? this.emptyPieces();
    this.last = {
      pieces: { ...base, state: "error", state_reason: reason, state_detail: detail.slice(0, 600), last_tick_ms: now, next_tick_ms: now + this.d.settings.tickSec * 1000 },
      tradingState: "error",
      bots: this.last?.bots ?? {},
      rules: this.last?.rules ?? new Map<string, ConfirmedRules | null>(),
      refused: this.last?.refused ?? new Set(),
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
      state_repeats: 0,
      other_approved_agents: [],
      balances: { usdc_free: "0", usdc_total: "0", equity_usdc: "0", positions: [] },
      pnl: {
        today_usdc: "0",
        total_usdc: "0",
        net_funded_usdc: "0",
        day_start_equity_usdc: "0",
        funded_by_vault_usdc: "0",
        external_inflow_usdc: "0",
        external_outflow_usdc: "0",
        fees_usdc: "0",
        untracked_delta_usdc: "0",
      },
      limits: {
        effective: effectiveLimitsStatus(eff, this.d.settings.hard.priceBandBps),
        effective_bot_id: null,
        today: { orders: 0, loss_usdc: "0" },
        position_usdc: "0",
        vault: { status: "Paused", remaining_today_usdc: "0", per_tx_limit_usdc: "0", payments_today: 0, max_payments_per_day: 0, expires_at_ms: null },
      },
      open_orders: [],
      dead_man: { cancel_at_ms: this.state.account.deadManAtMs, available: true, reason: null },
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

  /** State of a bot for the status list: the last tick's view, else what the registry alone can say. */
  private botState(b: Bot): { state: BotState; reason: string | null } {
    const v = this.last?.bots[b.id];
    if (b.archived_at_ms !== null) return { state: "archived", reason: null };
    // A halt that arrived after the last tick (kill, perp alarm) is visible at once.
    const h = this.state.bots[b.id]?.halt ?? this.state.account.halt;
    if (h != null && b.active_hash !== null) return { state: "halted", reason: h.reason };
    if (v !== undefined) return { state: v.state, reason: v.reason };
    if (b.active_hash === null) return { state: "draft", reason: null };
    return { state: "blocked", reason: this.last?.pieces.state_reason ?? "NO_TICK_YET" };
  }

  /** Full `TradingStatus` (public: everything in it is also visible on HL and NEAR). */
  status(): TradingStatus {
    const s = this.d.settings;
    const pieces = this.last?.pieces ?? this.emptyPieces();
    let state: TradingState = this.last?.tradingState ?? pieces.state;
    let reason = pieces.state_reason;
    let detail = pieces.state_detail;
    // A kill (or a perp alarm) that arrived after the last tick is visible at once.
    if (this.state.account.halt !== null && state !== "halted") {
      state = "halted";
      reason = this.state.account.halt.reason;
      detail = this.state.account.halt.detail;
    }
    if (this.fatal !== null && this.last === null) {
      state = "error";
      reason = "STATE_CORRUPT";
      detail = this.fatal;
    }
    const def = this.last?.rules.get(DEFAULT_BOT_ID) ?? null;
    const refusedAny = [...(this.last?.refused ?? [])].length > 0;
    if (state === "no_rules" && refusedAny) {
      reason = "RULES_REFUSED";
      detail = [...this.extraWarnings.entries()].find(([k]) => k.startsWith("rules:"))?.[1] ?? detail;
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
      dead_man: { ...pieces.dead_man, cancel_at_ms: this.state.account.deadManAtMs },
      active_rules: def ? { hash: def.hash, name: def.rules.name, confirmed_at_ms: def.confirmed_at_ms, confirmed_by: def.account_id } : null,
      bots: this.registry.live().map((b) => ({ id: b.id, name: b.name, state: this.botState(b).state })),
      max_bots: this.maxBots,
      warnings: [...pieces.warnings, ...this.extraWarnings.values()].map((w) => publicText(w) ?? ""),
      agent_trading: {
        enabled: this.agentSettings.enabled,
        max_orders_per_day: this.agentSettings.maxOrdersPerDay,
        min_order_interval_sec: this.agentSettings.minOrderIntervalSec,
        token_ttl_hours: this.agentSettings.tokenTtlHours,
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Bots (read side, ADR-0006 section 8)
  // -------------------------------------------------------------------------------------------------------------------

  /** 24 hourly closes of the total P&L, oldest first (from the 15-minute tier), carrying the last value over empty hours. */
  private spark(botId: string): string[] {
    const pts = this.history.read(botId, "1d").points;
    const now = this.now();
    const hourEnd = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
    const out: string[] = [];
    let i = 0;
    let lastVal: string | null = null;
    const first = pts[0];
    if (first === undefined) return out;
    for (let h = SPARK_POINTS - 1; h >= 0; h--) {
      const end = hourEnd - h * HOUR_MS;
      while (i < pts.length && (pts[i] as HistoryPoint).t < end) lastVal = (pts[i++] as HistoryPoint).pnl;
      if (lastVal !== null) out.push(lastVal);
    }
    return out;
  }

  /** Public view of a bot: id, name, state, pair. With `full` (owner session) also P&L, position and the sparkline. */
  botSummary(b: Bot, full: boolean): BotSummary {
    const st = this.botState(b);
    const rules = this.last?.rules.get(b.id) ?? null;
    const v = this.last?.bots[b.id];
    const base: BotSummary = {
      id: b.id,
      name: b.name,
      kind: botKind(b),
      state: st.state,
      state_reason: st.reason,
      pairs: rules?.rules.pairs ?? [],
      created_at_ms: b.created_at_ms,
      archived_at_ms: b.archived_at_ms,
    };
    if (!full) return base;
    return {
      ...base,
      pnl_today_usdc: v?.pnlToday ?? "0",
      pnl_total_usdc: v?.pnlTotal ?? "0",
      position_usdc: v?.positionUsdc ?? "0",
      spark: this.spark(b.id),
      last_fill_ms: this.journal.lastFillMs(b.id),
    };
  }

  botsList(full: boolean): BotSummary[] {
    return this.registry.list().map((b) => this.botSummary(b, full));
  }

  private botOrThrow(id: string): Bot {
    const b = this.registry.get(id);
    if (b === undefined) throw new ServiceError(404, "BOT_NOT_FOUND", "No such bot");
    return b;
  }

  private async pairsMeta(): Promise<HlSpotPair[]> {
    const t = this.now();
    if (this.pairsCache !== null && t - this.pairsCache.at < PAIRS_CACHE_MS) return this.pairsCache.pairs;
    try {
      const pairs = await this.hl.getSpotPairs();
      this.pairsCache = { at: t, pairs };
      return pairs;
    } catch {
      return this.pairsCache?.pairs ?? [];
    }
  }

  async botDetail(id: string): Promise<BotDetail> {
    const b = this.botOrThrow(id);
    const rules = this.last?.rules.get(id) ?? null;
    const v = this.last?.bots[id];
    const meta = await this.pairsMeta();
    const pairNames = rules?.rules.pairs ?? [];
    const kind = botKind(b);
    const tok = b.agent ?? null;
    return {
      bot: this.botSummary(b, true),
      kind,
      agent:
        kind === "agent"
          ? {
              connected: tok !== null && tok.expires_at_ms > this.now(),
              token_id: tok?.token_id ?? null,
              issued_at_ms: tok?.issued_at_ms ?? null,
              expires_at_ms: tok?.expires_at_ms ?? null,
              last_used_ms: tok === null ? null : (this.agentLastUsed.get(id) ?? null),
            }
          : null,
      rules,
      rules_history: this.rulesHistory(id),
      limits: {
        bot: rules?.rules.limits ?? null,
        account: effectiveLimitsStatus(effectiveLimits(null, this.d.settings.hard), this.d.settings.hard.priceBandBps),
      },
      today: { orders: this.state.bots[id]?.ordersToday ?? 0, loss_usdc: v?.lossToday ?? "0" },
      positions: (v?.positions ?? []).map((p) => ({ pair: p.pair, size: p.size, avg_cost: p.avgCost, mid: p.mid, value_usdc: p.value })),
      pairs: pairNames.flatMap((name) => {
        const m = meta.find((p) => p.name === name);
        return m === undefined ? [] : [{ name, coin: m.assetId - 10_000 === 0 ? name : `@${m.assetId - 10_000}`, sz_decimals: m.szDecimals }];
      }),
      open_orders: v?.openOrders ?? [],
      hl_network: this.d.settings.hlNetwork,
    };
  }

  /** Fresh, fully verified active rule set of a bot (null = none or refused). */
  async loadRules(id: string): Promise<ConfirmedRules | null> {
    const b = this.registry.get(id);
    if (b === undefined) return null;
    const legacy = this.registry.legacyV1();
    const r = await this.d.store.loadBot(b, this.d.confirmCtx, { legacyV1Hash: legacy?.bot_id === b.id ? legacy.hash : null });
    return r.status === "ok" ? r.confirmed : null;
  }

  /** Stored rule sets of a bot, oldest first (informational). */
  rulesHistory(id: string): ReturnType<RulesStore["history"]> {
    const b = this.registry.get(id);
    if (b === undefined) return [];
    const mine = new Set(b.hashes.flatMap((h) => (h.hash === null ? [] : [h.hash])));
    // Rule sets from before bots existed have no owner on record; they were the first bot's.
    return this.d.store.history((hash) => mine.has(hash) || (id === DEFAULT_BOT_ID && this.registry.hashOwner(hash) === undefined));
  }

  botHistory(id: string, range: Range): { range: Range; bucket_ms: number; points: Omit<HistoryPoint, "pos" | "equity">[] } {
    const b = this.botOrThrow(id);
    const r = this.history.read(id, range, { createdAtMs: b.created_at_ms });
    return {
      range,
      bucket_ms: r.bucket_ms,
      points: r.points.map((p) => ({ t: p.t, pnl: p.pnl, lo: p.lo, hi: p.hi, today: p.today, val: p.val, px: p.px })),
    };
  }

  botFills(id: string, q: { cursor?: string | null; limit?: number; fromMs?: number }): { fills: BotFill[]; next_cursor: string | null } {
    this.botOrThrow(id);
    return this.journal.page(id, q);
  }

  botMetrics(id: string, range: Range): BotMetrics {
    const b = this.botOrThrow(id);
    const now = this.now();
    const win = RANGE_MS[range];
    const fromMs = win !== null ? now - win : Math.max(0, b.created_at_ms);
    const pts = this.history.read(id, range, { createdAtMs: b.created_at_ms }).points;
    return computeMetrics({ range, nowMs: now, createdAtMs: b.created_at_ms, fills: this.journal.readAll(id), points: pts, orders: this.countOrders(id, fromMs) });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Owner actions
  // -------------------------------------------------------------------------------------------------------------------

  isPerpHalted(): boolean {
    return this.state.account.halt?.reason === "PERP_POSITION_DETECTED";
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

  /**
   * A rule set was confirmed for `botId` and stored: lift that bot's halt and the account halt (other bots stay halted until each
   * is confirmed), start the baseline if needed, and run a tick so `state` is real.
   */
  async activated(env: ConfirmedRules, botId: string = env.bot_id ?? DEFAULT_BOT_ID): Promise<TradingState> {
    if (this.startMs === undefined) {
      this.startMs = env.confirmed_at_ms;
      try {
        writeAtomic(this.metaFile, JSON.stringify({ startMs: this.startMs }));
      } catch {
        /* non-fatal */
      }
    }
    const had = this.state.account.halt !== null || this.state.bots[botId]?.halt != null;
    this.mutate((st) => clearHalt(st, botId));
    this.appendLog([{ at_ms: this.now(), kind: "state", bot_id: botId, detail: `rules ${env.hash.slice(0, 16)} confirmed by ${env.account_id}${had ? "; halt cleared" : ""}` }]);
    await this.tickFresh();
    return this.status().state;
  }

  /** Waits (bounded) for the tick in flight; after it ends nothing else can create an order. */
  private async waitTick(): Promise<"ok" | "timeout"> {
    const running = this.inflight;
    if (!running) return "ok";
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, KILL_WAIT_TICK_MS);
    });
    const r = await Promise.race([running.then(() => "ok" as const, () => "ok" as const), timeout]);
    if (timer) clearTimeout(timer);
    return r;
  }

  /** Cancels the open spot orders that `pick` selects. `failed` also covers orders whose pair cannot be resolved. */
  private async cancelWhere(pick: (cloid: string | null) => boolean): Promise<{ cancelled: number; ok: boolean }> {
    try {
      const [orders, pairs] = await Promise.all([this.hl.getOpenOrders(this.d.settings.account), this.hl.getSpotPairs()]);
      const byName = new Map(pairs.map((p) => [p.name, p.assetId]));
      const targets: { assetId: number; oid: number }[] = [];
      let unresolved = 0;
      for (const o of orders.filter((x) => x.market === "spot" && pick(x.cloid))) {
        const id = byName.get(o.pair);
        if (id === undefined || id < 10_000) unresolved += 1;
        else targets.push({ assetId: id, oid: o.oid });
      }
      if (targets.length > 0) await this.hl.cancelOrders(targets);
      return { cancelled: targets.length, ok: unresolved === 0 };
    } catch {
      return { cancelled: 0, ok: false };
    }
  }

  /** True for a cloid that carries one of the bot's prefixes. */
  private ownsCloid(botId: string): (cloid: string | null) => boolean {
    return (cloid) => {
      const b = this.registry.get(botId);
      if (b === undefined || cloid === null || cloid.length < 18) return false;
      const p = cloid.slice(0, 18).toLowerCase();
      return b.hashes.some((h) => h.prefix === p);
    };
  }

  /**
   * Kill switch (kill all). Halts the account and every bot for good (until a new signed rule set for each bot), cancels every
   * spot order and sets the dead-man switch to fire within seconds. Both HL steps are attempted whatever the other one does.
   */
  async kill(reason?: string): Promise<KillResult> {
    const at = this.now();
    const why = reason ? reason.replace(/\p{Cc}/gu, " ").slice(0, MAX_REASON_CHARS) : "";
    // Synchronous, before the first await: from here on a running tick cannot place an order or move the dead-man switch.
    this.killEpoch += 1;
    const killDetail = why ? `kill switch: ${why}` : "kill switch";
    this.mutate((st) => haltAll(st, at, "KILLED", killDetail, this.registry.live().map((b) => b.id)));
    // State file unusable: it is not touched; the halt goes to the marker file and is applied by the next start that can read it.
    const markerOk = this.fatal !== null ? this.writeHaltMarker(null, at, "KILLED", killDetail) : false;
    this.appendLog([{ at_ms: at, kind: "state", detail: `KILL SWITCH${why ? `: ${why}` : ""}` }]);
    // Owner decision "Stop = full cut-off" (audit AM1): every stopped agent bot loses its token, so the cut-off does not depend on
    // engine-state.json surviving. Best effort: the halt above already happened whatever this does.
    this.revokeOnStop(this.registry.live().map((b) => b.id));

    // Wait (bounded) for the tick that is running: after it ends nothing else can create an order, so the cancel below
    // sees every order and our scheduleCancel is the last one.
    const tickWait = await this.waitTick();

    const c = await this.cancelWhere(() => true);
    const cancelAll: "ok" | "failed" = c.ok ? "ok" : "failed";
    let sched: "ok" | "failed" = "ok";
    const fireAt = this.now() + KILL_SCHEDULE_CANCEL_MS;
    try {
      await this.hl.scheduleCancel(fireAt);
      this.mutate((st) => ({ ...st, account: { ...st.account, deadManAtMs: fireAt } }));
    } catch {
      sched = "failed";
    }
    const saved = this.fatal !== null ? markerOk : this.persistState(); // final write: also retries a halt that could not be saved at the start
    // ML2: the state write failed for another reason (disk full ...): the halt must still survive a restart.
    if (!saved && !markerOk) this.writeHaltMarker(null, at, "KILLED", killDetail);
    this.appendLog([
      { at_ms: this.now(), kind: "cancel", detail: `kill: cancel_all ${cancelAll} (${c.cancelled} order(s)), schedule_cancel ${sched}, state_saved ${saved ? "ok" : "failed"}, tick_wait ${tickWait}` },
    ]);
    return {
      state: "halted",
      cancelled_orders: c.cancelled,
      steps: { cancel_all: cancelAll, schedule_cancel: sched, state_saved: saved ? "ok" : "failed", tick_wait: tickWait },
    };
  }

  /**
   * Kills ONE bot (ADR-0006): it halts for good (until a new signed rule set for it), its resting orders are cancelled (only
   * orders with its cloid prefixes), the other bots and the dead-man switch are untouched.
   */
  async killBot(id: string, reason?: string): Promise<BotKillResult> {
    const b = this.botOrThrow(id);
    const at = this.now();
    const why = reason ? reason.replace(/\p{Cc}/gu, " ").slice(0, MAX_REASON_CHARS) : "";
    this.botEpoch.set(id, (this.botEpoch.get(id) ?? 0) + 1);
    const killDetail = why ? `kill switch: ${why}` : "kill switch";
    this.mutate((st) => haltBot(st, id, at, "KILLED", killDetail));
    const markerOk = this.fatal !== null ? this.writeHaltMarker(id, at, "KILLED", killDetail) : false;
    this.appendLog([{ at_ms: at, kind: "state", bot_id: id, detail: `KILL SWITCH (bot ${id})${why ? `: ${why}` : ""}` }]);
    this.revokeOnStop([id]); // audit AM1: Stop also kills the agent token (best effort, after the halt)
    await this.waitTick();
    const c = await this.cancelWhere(this.ownsCloid(b.id));
    const saved = this.fatal !== null ? markerOk : this.persistState();
    if (!saved && !markerOk) this.writeHaltMarker(id, at, "KILLED", killDetail);
    this.appendLog([{ at_ms: this.now(), kind: "cancel", bot_id: id, detail: `kill bot ${id}: cancel ${c.ok ? "ok" : "failed"} (${c.cancelled} order(s)), state_saved ${saved ? "ok" : "failed"}` }]);
    return { bot_id: id, state: "halted", cancelled_orders: c.cancelled, steps: { cancel: c.ok ? "ok" : "failed", state_saved: saved ? "ok" : "failed" } };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Agent-driven trading (ADR-0007)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Stop = full cut-off (owner decision, audit AM1): revokes the agent token of each listed agent bot that has one. Synchronous
   * (bots.json commit), so an order that authenticated before the Stop and still waits for the slot fails its token re-check.
   * Errors are logged, never thrown: the halt must not depend on the bots.json write.
   */
  private revokeOnStop(ids: readonly string[]): void {
    for (const id of ids) {
      const b = this.registry.get(id);
      if (b === undefined || botKind(b) !== "agent" || b.agent == null) continue;
      try {
        if (this.registry.revokeAgentToken(id)) {
          this.agentLastUsed.delete(id);
          this.appendLog([{ at_ms: this.now(), kind: "state", bot_id: id, detail: "agent token revoked by the Stop" }]);
        }
      } catch (e) {
        this.appendLog([{ at_ms: this.now(), kind: "state", bot_id: id, detail: `agent token revoke on Stop FAILED (the bot is halted; revoke it by hand): ${publicText(errMsg(e)) ?? ""}` }]);
      }
    }
  }

  /**
   * Audit AL3 / review M2: the token that authenticated the request must still be the bot's current, unexpired token. Checked
   * before the wait for the single-flight slot and again right after it (a revoke, Stop or re-sign may have happened meanwhile).
   */
  private assertAgentToken(botId: string, tokenId: string): void {
    const rec = this.registry.get(botId)?.agent ?? null;
    if (rec === null || rec.token_id !== tokenId) throw new ServiceError(401, "AGENT_UNAUTHORIZED", "Missing or invalid agent token");
    if (this.now() >= rec.expires_at_ms) throw new ServiceError(401, "AGENT_TOKEN_EXPIRED", "The agent token has expired; ask the owner for a new one");
  }

  /** Remembers the last authenticated agent request (memory only). */
  noteAgentUse(botId: string): void {
    this.agentLastUsed.set(botId, this.now());
  }

  /** Revokes the agent token of an agent bot (owner, toward safety). The bot keeps its mandate; the agent gets 401 from now on. */
  revokeAgentToken(id: string): { bot_id: string; revoked: boolean } {
    let revoked: boolean;
    try {
      revoked = this.registry.revokeAgentToken(id);
    } catch (e) {
      if (e instanceof RegistryError) throw new ServiceError(e.status === 404 ? 404 : 409, e.code, e.message);
      throw e;
    }
    this.agentLastUsed.delete(id);
    if (revoked) this.appendLog([{ at_ms: this.now(), kind: "state", bot_id: id, detail: "agent token revoked by the owner" }]);
    return { bot_id: id, revoked };
  }

  /** Orders and loss this agent bot may still use today: min(bot, account). */
  agentRemaining(botId: string): RemainingToday {
    const hard = this.d.settings.hard;
    const env = this.last?.rules.get(botId) ?? null;
    const lim = effectiveLimits(env?.rules ?? null, hard);
    const acctLim = effectiveLimits(null, hard);
    const sb = this.state.bots[botId];
    const today = this.state.account.day?.dayIndex === utcDayIndex(this.now());
    const botOrders = today ? (sb?.ordersToday ?? 0) : 0;
    const acctOrders = today ? this.state.account.ordersToday : 0;
    const orders = Math.max(0, Math.min(lim.maxOrdersPerDay - botOrders, acctLim.maxOrdersPerDay - acctOrders));
    const botLoss = fx(this.last?.bots[botId]?.lossToday ?? "0");
    const acctLoss = fx(this.last?.pieces.limits.today.loss_usdc ?? "0");
    const left = fxMin(lim.dailyLossStop - botLoss, acctLim.dailyLossStop - acctLoss);
    return { orders, loss_usdc: fxStr(left > 0n ? left : 0n) };
  }

  /** Step 5 of `POST /trading/agent/order`: refusals that need no tick. Null = go on. */
  private agentPrecheck(botId: string): { code: string; message: string } | null {
    const b = this.registry.get(botId);
    if (b === undefined || b.archived_at_ms !== null || b.active_hash === null) return { code: "BOT_NOT_ACTIVE", message: "This bot has no active mandate" };
    if (botKind(b) !== "agent") return { code: "NOT_AGENT_BOT", message: "This bot is not run by an AI agent" };
    const acctHalt = this.state.account.halt;
    if (acctHalt !== null)
      return acctHalt.reason === "KILLED"
        ? { code: "KILLED", message: "The owner stopped all trading; nothing is traded until the owner signs the limits again" }
        : { code: acctHalt.reason, message: `Trading is halted (${acctHalt.reason}); the owner must act` };
    const h = this.state.bots[botId]?.halt ?? null;
    if (h !== null) return { code: "BOT_HALTED", message: "The owner stopped this bot; it trades again only after the owner signs its limits again (a new agent token)" };
    return null;
  }

  private logAgentRefusal(botId: string, code: string, message: string, note: string | null): void {
    this.appendLog([{ at_ms: this.now(), kind: "skip", rule_id: "agent", bot_id: botId, detail: `${code}: ${responseMessage(message)}`, source: "agent", code, ...(note !== null ? { note } : {}) }]);
  }

  /**
   * One agent order (ADR-0007 sections 4-5): cheap pre-check, then ONE engine tick that carries the intent, in the single-flight
   * slot (it waits for a running tick first). The engine decides; this only maps its outcome to the frozen response.
   */
  async agentOrder(botId: string, tokenId: string, intent: AgentIntent, note: string | null): Promise<AgentOrderResponse> {
    this.assertAgentToken(botId, tokenId);
    const pre = this.agentPrecheck(botId);
    if (pre !== null) {
      this.logAgentRefusal(botId, pre.code, pre.message, note);
      return rejected(pre.code, pre.message, this.agentRemaining(botId));
    }
    while (this.inflight) await this.inflight;
    // Re-checked after the wait, synchronously before the slot is claimed (throws 401: nothing ran, nothing is cached).
    this.assertAgentToken(botId, tokenId);
    // Claimed synchronously after the last check: no other tick can start in between.
    const probe = { reached: false };
    const run = this.runOnce({ botId, intent, note }, probe);
    const slot = run.then(
      () => undefined,
      () => undefined,
    );
    this.inflight = slot;
    this.inflightKind = "agent";
    let r: TickResult | null;
    try {
      r = await run;
    } finally {
      if (this.inflight === slot) {
        this.inflight = null;
        this.inflightKind = null;
      }
    }
    const remaining = this.agentRemaining(botId);
    // Review M1: the write-ahead succeeded, so the order call was about to run or ran, but no clean outcome came back (a throw
    // after it in the tick or in the service). Final, and the agent must read the state first.
    if (probe.reached && (r === null || r.agent === undefined || !r.agent.placed)) {
      this.logAgentRefusal(botId, OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, note);
      return rejected(OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, remaining);
    }
    if (r === null || r.agent === undefined) {
      // The tick ended before step 7 (or did not run): the account state says why. No order was placed.
      const pieces = r?.status ?? this.last?.pieces;
      const state = r?.tradingState ?? this.last?.tradingState ?? "error";
      const code = pieces?.state_reason ?? `STATE_${state.toUpperCase()}`;
      const detail = pieces?.state_detail ?? null;
      const message = `No order: trading is ${state} (${code})${detail ? `: ${publicText(detail) ?? ""}` : ""}`;
      this.logAgentRefusal(botId, code, message, note);
      return rejected(code, message, remaining);
    }
    const out = r.agent;
    if (!out.placed) return rejected(out.code, out.reason, remaining);
    const order = { pair: intent.pair, side: intent.side, price_limit: fxStr(out.price, 8), size: fxStr(out.size, 8), notional_usdc: fxStr(out.notional), cloid: out.cloid };
    const base = { order, remaining_today: remaining, replayed: false, request_id: out.cloid };
    const res = out.result;
    if (out.outcomeUnknown === true) return rejected(OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, remaining, order, out.cloid);
    switch (res.status) {
      case "rejected":
        return { ...rejected("HL_REJECTED", `Hyperliquid refused the order: ${hlErrorText(res.error)}`, remaining, order, out.cloid) };
      case "unfilled":
        return { status: "unfilled", code: null, message: "No liquidity inside the price band; nothing traded (it counts toward today's orders)", final: false, retry_after_s: null, fill: null, ...base };
      case "resting":
        // Cannot happen for IOC; reported without a fill (the engine's dead-man / stale-order cancels cover a resting order).
        return { status: "unfilled", code: null, message: "The order is resting on the book (unexpected for an immediate-or-cancel order); nothing was filled yet", final: false, retry_after_s: null, fill: null, ...base };
      case "filled": {
        const partial = fx(res.filledSize) < out.size;
        return {
          status: partial ? "partially_filled" : "filled",
          code: null,
          message: responseMessage(`${partial ? "Partially filled" : "Filled"}: ${intent.side} ${res.filledSize} at ${res.avgPx} (${intent.pair})`),
          final: false,
          retry_after_s: null,
          fill: { filled_size: res.filledSize, avg_price: res.avgPx },
          ...base,
        };
      }
    }
  }

  /** `GET /trading/agent/state` (ADR-0007 section 9): built from the last tick, the engine state and the journal. No HL write. */
  async agentState(botId: string, tokenId: string): Promise<AgentState> {
    const b = this.botOrThrow(botId);
    const hard = this.d.settings.hard;
    const st = this.status();
    const bst = this.botState(b);
    const env = this.last?.rules.get(botId) ?? (await this.loadRules(botId).catch(() => null));
    const lim = effectiveLimits(env?.rules ?? null, hard);
    const acctLim = effectiveLimits(null, hard);
    const v = this.last?.bots[botId];
    const sb = this.state.bots[botId];
    const remaining = this.agentRemaining(botId);
    const now = this.now();
    const today = this.state.account.day?.dayIndex === utcDayIndex(now);
    const botLoss = fx(v?.lossToday ?? "0");
    const openOrders = v?.openOrders ?? [];
    const openSellOf = (pair: string): Fx => openOrders.filter((o) => o.side === "sell" && o.pair === pair).reduce((a, o) => a + fx(o.size), 0n);
    const sumBuys = (rows: { side: string; price: string; size: string }[]): Fx => rows.filter((o) => o.side === "buy").reduce((a, o) => a + fxMul(fx(o.price), fx(o.size)), 0n);
    const complete = sb?.agg.totalComplete ?? true;
    const positions = (v?.positions ?? []).map((p) => {
      const sellable = complete ? fx(p.size) - openSellOf(p.pair) : null;
      return { pair: p.pair, size: p.size, sellable_size: sellable === null ? null : fxStr(sellable > 0n ? sellable : 0n, 8), avg_cost: p.avgCost, mid: p.mid, value_usdc: p.value };
    });
    const botLeft = lim.maxPosition - fx(v?.positionUsdc ?? "0") - sumBuys(openOrders);
    const acctLeft = acctLim.maxPosition - fx(st.limits.position_usdc) - sumBuys(st.open_orders);
    const posLeft = fxMin(botLeft, acctLeft);
    const meta = await this.pairsMeta();
    const pairs = env?.rules.pairs ?? [];
    const recentOrders = this.readLog(200, botId)
      .filter((e) => e.source === "agent" && (e.kind === "order" || e.kind === "skip"))
      .slice(0, 10)
      .map((e) => ({ at_ms: e.at_ms, status: e.kind === "order" ? ("placed" as const) : ("rejected" as const), code: e.code ?? null }));
    return {
      // Audit AL5: the owner-session rename is a text channel to the agent; it gets the same plain-text treatment as a note.
      bot: { id: b.id, name: plainText(b.name, 60) ?? b.id, state: bst.state, state_reason: bst.reason },
      can_trade: bst.state === "running" && st.state === "running",
      account: { state: st.state, state_reason: st.state_reason },
      mandate: {
        hash: env?.hash ?? b.active_hash ?? "",
        pairs,
        limits: env?.rules.limits ?? { max_position_usdc: fxStr(lim.maxPosition), max_order_usdc: fxStr(lim.maxOrder), daily_loss_stop_usdc: fxStr(lim.dailyLossStop), max_orders_per_day: lim.maxOrdersPerDay },
        effective: effectiveLimitsStatus(lim, hard.priceBandBps),
        order_type: "ioc",
      },
      today: {
        orders_used: today ? (sb?.ordersToday ?? 0) : 0,
        orders_left: remaining.orders,
        loss_usdc: fxStr(botLoss > 0n ? botLoss : 0n),
        loss_left_usdc: remaining.loss_usdc,
        resets_at_ms: (utcDayIndex(now) + 1) * DAY_MS,
      },
      balances: { usdc_free: st.balances.usdc_free },
      positions,
      position_left_usdc: fxStr(posLeft > 0n ? posLeft : 0n),
      pnl: { today_usdc: v?.pnlToday ?? "0", total_usdc: v?.pnlTotal ?? "0" },
      markets: pairs.map((pair) => {
        const m = meta.find((x) => x.name === pair);
        const mid = v?.px[pair] ?? null;
        return { pair, mid, sz_decimals: m?.szDecimals ?? 0, min_order_usdc: "10" as const };
      }),
      // Numbers only: notes never go back to the agent (a leaked token must not plant text for the legitimate agent).
      recent_fills: this.journal.page(botId, { limit: 10 }).fills.map((f) => ({ time_ms: f.time_ms, side: f.side, price: f.price, size: f.size, fee_usdc: f.fee_usdc, realized_usdc: f.realized_usdc })),
      recent_orders: recentOrders,
      as_of_ms: st.last_tick_ms,
      next_order_allowed_at_ms: this.agentGate.nextAllowedAtMs(botId, tokenId),
    };
  }

  rename(id: string, name: string): BotSummary {
    this.assertWritable();
    this.botOrThrow(id);
    try {
      return this.botSummary(this.registry.rename(id, name), true);
    } catch (e) {
      if (e instanceof RegistryError) throw new ServiceError(e.status === 404 ? 404 : 400, e.code, e.message);
      throw e;
    }
  }

  /**
   * Position guard of `archive`: refuses (409) while the bot holds at least 10 USDC of coins (the HL minimum order). It needs
   * evidence: a priced view and a mid for every pair with a positive size, otherwise the position is UNKNOWN and the archive is
   * refused (a bot cannot slip through just because prices were missing). A bot whose fill history is incomplete cannot derive
   * its position at all; that case is archivable but reported in `warning`.
   */
  private assertArchivable(id: string): void {
    const sb = this.state.bots[id];
    if (sb === undefined || !sb.agg.totalComplete) return;
    const held = Object.entries(positionOf(sb.agg.total)).filter(([, q]) => q > 0n);
    if (held.length === 0) return;
    const v = this.last?.bots[id];
    const unknown = (): ServiceError => new ServiceError(409, "POSITION_UNKNOWN", "The bot's position value is not known (no priced tick yet, or a coin it holds has no current price); try again after the next tick");
    if (v === undefined || !v.priced) throw unknown();
    for (const [pair] of held) {
      const p = v.positions.find((x) => x.pair === pair);
      if (p === undefined || fx(p.mid) <= 0n) throw unknown();
    }
    if (fx(v.positionUsdc) >= ARCHIVE_MAX_POSITION)
      throw new ServiceError(409, "BOT_HOLDS_POSITION", `This bot still holds about ${v.positionUsdc} USDC of coins. Sell its position first (at least ${fxStr(ARCHIVE_MAX_POSITION)} USDC is needed to archive).`);
  }

  /**
   * Archives a bot: cancels its orders and drops its rule set. Order of events (no window in which the bot can trade):
   *  1. position guard on what is known now (refusal changes nothing);
   *  2. the bot is HALTED (persisted) and its epoch bumped, so neither the running tick nor any later one can place an order;
   *  3. wait for the running tick, cancel the bot's orders, run one fresh tick (fills of cancelled/partly filled orders are
   *     folded in) and check the position AGAIN on that fresh view;
   *  4. only then the registry marks it archived. A refusal in 3-4 leaves the bot HALTED (never back to trading).
   */
  async archive(id: string): Promise<ArchiveResult> {
    this.assertWritable();
    const b = this.botOrThrow(id);
    if (b.archived_at_ms !== null) return { bot: this.botSummary(b, true), cancelled_orders: 0 };
    this.assertArchivable(id);

    const at = this.now();
    const prevHalt = this.state.bots[id]?.halt ?? null;
    this.botEpoch.set(id, (this.botEpoch.get(id) ?? 0) + 1);
    const restore = (): void => {
      this.mutate((st) => {
        const cur = st.bots[id];
        return cur?.halt?.reason === "KILLED" && cur.halt.atMs === at ? { ...st, bots: { ...st.bots, [id]: { ...cur, halt: prevHalt } } } : st;
      });
    };
    if (!this.mutate((st) => haltBot(st, id, at, "KILLED", "archiving"))) {
      restore();
      throw new ServiceError(409, "STATE_WRITE_FAILED", "The engine state cannot be written, so the bot cannot be stopped safely; nothing was changed");
    }
    try {
      if ((await this.waitTick()) === "timeout") throw new ServiceError(409, "TICK_BUSY", "A trading tick is still running; try again in a minute (the bot was not archived)");
      const c = await this.cancelWhere(this.ownsCloid(id));
      // Any bot that ever had a rule set may have a fill the engine has not folded in yet (an order placed by the tick we just
      // waited for, or a partial fill of a cancelled one): one fresh tick, and the position is checked on ITS view.
      if (b.hashes.length > 0) {
        const seq = this.viewSeq;
        await this.tickFresh();
        if (this.viewSeq === seq) throw new ServiceError(409, "POSITION_UNKNOWN", "The bot's fills could not be refreshed (the tick failed); try again after the next tick");
      }
      this.assertArchivable(id);
      let bot: Bot;
      try {
        bot = this.registry.archive(id, this.now());
      } catch (e) {
        if (e instanceof RegistryError) throw new ServiceError(e.status === 404 ? 404 : 400, e.code, e.message);
        throw e;
      }
      this.appendLog([{ at_ms: this.now(), kind: "state", bot_id: id, detail: `bot ${id} archived (${c.cancelled} order(s) cancelled${c.ok ? "" : ", cancel incomplete"})` }]);
      const warnings: string[] = [];
      if (this.state.bots[id]?.agg.totalComplete === false) warnings.push("the bot's fill history is incomplete, so its position could not be verified; check Hyperliquid for coins it may still hold");
      if (!c.ok) warnings.push("some of its orders could not be cancelled; check open orders on Hyperliquid");
      return { bot: this.botSummary(bot, true), cancelled_orders: c.cancelled, ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}) };
    } catch (e) {
      // ML1: a refused archive must not put the bot back into trading. It stays halted (KILLED, persisted) until the owner signs
      // its rules again; only the detail changes so the dashboard says why.
      this.mutate((st) => haltBot(st, id, at, "KILLED", "archive was refused; the bot stays stopped until you sign its rules again"));
      throw e;
    }
  }

  /** New API wallet (the old key is deleted). Orders of the old key are cancelled first, best effort. */
  async rotateApiWallet(): Promise<string> {
    this.assertWritable(); // ML8: no rotation while the state is unusable
    // Serialized with the tick: wait for a running one, then hold the single-flight slot while the key is swapped, so no
    // tick sees the old adapter with the new key (or the reverse).
    while (this.inflight) await this.inflight;
    const op = this.rotateExclusive();
    const slot = op.then(
      () => undefined,
      () => undefined,
    );
    this.inflight = slot;
    this.inflightKind = "tick";
    let address: string;
    try {
      address = await op;
    } finally {
      await slot;
      if (this.inflight === slot) {
        this.inflight = null;
        this.inflightKind = null;
      }
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
    this.mutate((st) => ({ ...st, account: { ...st.account, deadManAtMs: null } }));
    this.appendLog([{ at_ms: this.now(), kind: "state", detail: `API wallet rotated; new address ${address}` }]);
    return address;
  }
}
