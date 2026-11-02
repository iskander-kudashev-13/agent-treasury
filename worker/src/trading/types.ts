/**
 * Shared types of the Hyperliquid spot trading module (docs/adr/0005-hyperliquid-trading-agent.md).
 * Types only: no runtime code except the const tuples that the zod schema and the status route reuse.
 */

/** Human decimal string, ^\d+(\.\d{1,6})?$ (USDC amounts and prices). */
export type Dec = string;
/** Signed human decimal string, ^-?\d+(\.\d{1,2})?$ (percent). */
export type SDec = string;

export const WINDOWS = ["1h", "4h", "1d"] as const;
export const EVERIES = ["1h", "4h", "1d", "1w"] as const;
export const TTLS = ["15m", "1h", "4h", "1d"] as const;
export const COOLDOWNS = ["15m", "1h", "4h", "1d", "1w"] as const;
export type Window = (typeof WINDOWS)[number];
export type Every = (typeof EVERIES)[number];
export type Ttl = (typeof TTLS)[number];
export type Cooldown = (typeof COOLDOWNS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// Rules DSL v1 (ADR-0005 "Rules DSL v1")
// ---------------------------------------------------------------------------------------------------------------------

export type Trigger =
  | { type: "price_change"; window: Window; op: "lte" | "gte"; pct: SDec }
  | { type: "price"; op: "lte" | "gte"; usdc: Dec }
  | { type: "interval"; every: Every }
  | { type: "position_pnl"; op: "lte" | "gte"; pct: SDec };

export type OrderSpec = { type: "ioc" } | { type: "limit"; offset_pct: Dec; ttl: Ttl };

export interface Action {
  side: "buy" | "sell";
  size: { usdc: Dec } | { position_pct: Dec };
  order: OrderSpec;
}

export interface Rule {
  id: string;
  pair: string;
  when: Trigger;
  action: Action;
  /** Required unless `when.type == "interval"` (then the effective cooldown is `every`). */
  cooldown?: Cooldown;
}

export interface RuleLimits {
  max_position_usdc: Dec;
  max_order_usdc: Dec;
  daily_loss_stop_usdc: Dec;
  max_orders_per_day: number;
}

export interface RuleSetV1 {
  version: 1;
  name: string;
  pairs: string[];
  limits: RuleLimits;
  rules: Rule[];
}

/** Hard limits from env (`TRADING_*`). A rule set may be tighter, never looser. */
export interface HardLimits {
  maxPositionUsdc: Dec;
  maxOrderUsdc: Dec;
  dailyLossUsdc: Dec;
  maxOrdersPerDay: number;
  /** `TRADING_ALLOWED_PAIRS`. */
  allowedPairs: readonly string[];
  /** `TRADING_MIN_PAIR_VOLUME_USDC`. */
  minPairVolumeUsdc: Dec;
  /** `TRADING_PRICE_BAND_BPS`. */
  priceBandBps: number;
}

/** What `spotMeta` / `spotMetaAndAssetCtxs` say about one spot pair, keyed by display name ("HYPE/USDC"). */
export interface PairInfo {
  name: string;
  /** 10000 + spotIndex for spot. Anything below 10000 is a perp and is refused everywhere. */
  assetId: number;
  szDecimals: number;
  /** 24 h notional volume in USDC. */
  volume24hUsdc: Dec;
  /** Current mid when known (optional; used only for advisory warnings). */
  mid?: Dec;
}
export type PairInfoMap = Readonly<Record<string, PairInfo | undefined>>;

export interface ValidationIssue {
  /** Stable machine code, also used by `docs/trading-rules-vectors.json`. */
  code: string;
  /** Dotted path into the rule set ("rules.0.action.size"), "" for the root. */
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------------------------------

export const TRADING_STATES = [
  "not_configured",
  "awaiting_api_wallet",
  "no_rules",
  "running",
  "paused_onchain",
  "stopped_today",
  "halted",
  "error",
] as const;
export type TradingState = (typeof TRADING_STATES)[number];

// ---------------------------------------------------------------------------------------------------------------------
// Bots (ADR-0006)
// ---------------------------------------------------------------------------------------------------------------------

/** Bot id: lower-case, unique, never reused (also not after archive). The migrated first bot is `default`. */
export const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
export const DEFAULT_BOT_ID = "default";
export const MAX_BOTS_HARD = 5;
export const MAX_RULE_SETS_PER_BOT = 64;
export const BOT_NAME_MAX = 60;

export interface BotHashEntry {
  /** `0x` + 16 hex: the cloid prefix. Permanent: fills carrying it belong to this bot for ever. */
  prefix: string;
  /** Rule-set hash; null only for a prefix recovered from a pre-multi-bot engine state. */
  hash: string | null;
  activated_at_ms: number;
}

export interface Bot {
  id: string;
  /** 1..60 chars, display only, owner can rename (not signed). */
  name: string;
  created_at_ms: number;
  archived_at_ms: number | null;
  /** Confirmed rule set in force; null = draft or archived. */
  active_hash: string | null;
  hashes: BotHashEntry[];
}

export const BOT_STATES = ["draft", "running", "stopped_today", "halted", "archived", "blocked"] as const;
export type BotState = (typeof BOT_STATES)[number];

/** `GET /trading/bots` item. The public list only carries id, name, state and pair; the rest needs the owner session. */
export interface BotSummary {
  id: string;
  name: string;
  state: BotState;
  state_reason: string | null;
  pairs: string[];
  pnl_today_usdc?: SDec;
  pnl_total_usdc?: SDec;
  position_usdc?: Dec;
  /** 24 hourly pnl_total closes, oldest first. */
  spark?: SDec[];
  created_at_ms: number;
  archived_at_ms: number | null;
  last_fill_ms?: number | null;
}

export interface BotDetail {
  bot: BotSummary;
  rules: ConfirmedRules | null;
  rules_history: { hash: string; name: string; confirmed_at_ms: number; superseded_at_ms: number | null }[];
  limits: { bot: RuleLimits | null; account: RuleLimits & { price_band_bps: number } };
  today: { orders: number; loss_usdc: Dec };
  positions: { pair: string; size: Dec; avg_cost: Dec | null; mid: Dec; value_usdc: Dec }[];
  /** `coin` is the HL coin name ("@107") the dashboard passes to `candleSnapshot`. */
  pairs: { name: string; coin: string; sz_decimals: number }[];
  open_orders: TradingStatus["open_orders"];
  hl_network: "mainnet" | "testnet";
}

/** Why the engine is `halted` (goes into `state_reason`). */
export const HALT_REASONS = ["PERP_POSITION_DETECTED", "KILLED"] as const;
export type HaltReason = (typeof HALT_REASONS)[number];

/** Vault agent status as returned by `get_agent_budget` (ADR-0003). */
export type AgentStatus = "Active" | "Paused" | "Revoked" | "Expired";

// ---------------------------------------------------------------------------------------------------------------------
// Hyperliquid port (what the engine needs; implemented by hl/nktkas.ts and hl/fake.ts)
// All amounts are human decimal strings, all times are ms. Pairs use display names ("HYPE/USDC"); the adapter maps
// "@107"-style coin names, so the engine never sees them.
// ---------------------------------------------------------------------------------------------------------------------

export interface HlSpotPair extends PairInfo {
  base: string;
  /** Mid price, null when the book is empty. */
  midUsdc: Dec | null;
}

export interface HlMids {
  /** Mid per pair display name. */
  mids: Readonly<Record<string, Dec | undefined>>;
  /** When the adapter fetched this snapshot (the engine rejects it when older than 2 ticks). */
  atMs: number;
  /** Optional per-pair age: when this pair's mid was last known to be current. Absent = `atMs` for every pair. */
  pairAtMs?: Readonly<Record<string, number | undefined>>;
}

export interface HlBook {
  bid: Dec | null;
  ask: Dec | null;
  atMs: number;
}

export interface HlCandle {
  openTimeMs: number;
  closeTimeMs: number;
  open: Dec;
  close: Dec;
}

export interface HlSpotBalance {
  /** Token name ("USDC", "HYPE"). */
  coin: string;
  total: Dec;
  /** Locked in open orders. */
  hold: Dec;
}

export interface HlPerpState {
  /** Perp positions with non-zero size. */
  positions: { coin: string; size: SDec }[];
  openPerpOrders: number;
  accountValueUsdc: Dec;
}

export interface HlOpenOrder {
  oid: number;
  /** 0x + 32 hex (16 bytes), null for orders placed by hand. */
  cloid: string | null;
  market: "spot" | "perp";
  /** Display name for spot, coin name for perp. */
  pair: string;
  side: "buy" | "sell";
  price: Dec;
  size: Dec;
  placedAtMs: number;
}

export interface HlFill {
  oid: number;
  /** HL trade id; unique per fill. Absent in older fixtures (then `fillKey` falls back to oid/time/side/price/size). */
  tid?: number;
  cloid: string | null;
  pair: string;
  side: "buy" | "sell";
  price: Dec;
  size: Dec;
  /** Fee in USDC (or base token for buys; the adapter converts to USDC). */
  feeUsdc: Dec;
  /**
   * Raw HL fee fields (ADR-0006 section 3): the token the fee was charged in ("USDC", or the base token on a spot buy) and the
   * amount in that token. A buy that pays its fee in the base token receives `size - feeAmount`, which a per-bot position needs.
   * Absent (older fixtures) = the fee was charged in USDC and equals `feeUsdc`.
   */
  feeToken?: string;
  feeAmount?: Dec;
  timeMs: number;
}

/** Non-funding ledger movement, for `net_inflow` in the loss stop. Field mapping is an open [verify] item in the ADR. */
export interface HlLedgerEntry {
  timeMs: number;
  /**
   * `class_in` / `class_out` = accountClassTransfer perp->spot / spot->perp inside the account. They are not external flows
   * (netFunded ignores them) but they move the spot USDC the equity backstop watches, so the backstop counts them.
   */
  kind: "deposit" | "withdraw" | "transfer_in" | "transfer_out" | "class_in" | "class_out";
  usdc: Dec;
}

export interface HlApprovedAgent {
  address: string;
  name: string | null;
  validUntilMs: number | null;
}

export interface HlPlaceOrder {
  assetId: number;
  isBuy: boolean;
  /** Already rounded by `hl/format.ts` (5 significant figures, <= 8 - szDecimals decimals, safe side). */
  price: Dec;
  /** Already rounded down to szDecimals. */
  size: Dec;
  tif: "Ioc" | "Gtc";
  /** 0x + 32 hex: `0x || rules_hash[0..8] || counter_be64`. */
  cloid: string;
}

export type HlOrderResult =
  | { status: "filled"; oid: number; filledSize: Dec; avgPx: Dec }
  | { status: "resting"; oid: number }
  | { status: "unfilled" } // IOC that found no liquidity inside the band
  | { status: "rejected"; error: string };

export interface HlPort {
  /** Spot pairs with asset ids, size decimals and 24 h volume. Perps are not returned. */
  getSpotPairs(): Promise<HlSpotPair[]>;
  getMids(): Promise<HlMids>;
  getBook(pair: string): Promise<HlBook>;
  /** Candles of `interval` covering [startMs, endMs]. Used for the `price_change` reference close. */
  getCandles(pair: string, interval: Window, startMs: number, endMs: number): Promise<HlCandle[]>;
  getSpotBalances(account: string): Promise<HlSpotBalance[]>;
  getPerpState(account: string): Promise<HlPerpState>;
  getOpenOrders(account: string): Promise<HlOpenOrder[]>;
  /**
   * ALL spot fills with timeMs >= startMs, oldest first. HL caps a response at 2000 rows and keeps only the 10000 newest, so
   * implementations paginate (hl/pagination.ts) and THROW `FillsTruncatedError` when the answer cannot be proven complete.
   */
  getUserFills(account: string, startMs: number): Promise<HlFill[]>;
  getLedger(account: string, startMs: number): Promise<HlLedgerEntry[]>;
  getApprovedAgents(account: string): Promise<HlApprovedAgent[]>;
  /** Spot only: implementations refuse `assetId < 10000`. */
  placeSpotOrder(order: HlPlaceOrder): Promise<HlOrderResult>;
  cancelOrders(orders: { assetId: number; oid: number }[]): Promise<void>;
  /** Dead-man switch: cancel all open orders at `timeMs`; `null` clears it. */
  scheduleCancel(timeMs: number | null): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP API payloads
// ---------------------------------------------------------------------------------------------------------------------

export interface ConfirmedRules {
  /**
   * Bot this rule set was signed for (ADR-0006). ABSENT only in envelopes written before multi-bot support; those belong to the
   * migrated bot `default` and carry the v1 confirmation message (no `bot:` line).
   */
  bot_id?: string;
  rules: RuleSetV1;
  hash: string;
  /** The exact NEP-413 message that was signed. */
  message: string;
  /** base64 */
  signature: string;
  public_key: string;
  account_id: string;
  /** base64 */
  nonce: string;
  callback_url: string | null;
  confirmed_at_ms: number;
}

export interface TradingStatus {
  enabled: true;
  state: TradingState;
  state_reason: string | null;
  state_detail: string | null;
  hl_network: "mainnet" | "testnet";
  hl_account: string;
  vault: string;
  agent_id: string;
  api_wallet: { address: string; approved: boolean; name: string | null; valid_until_ms: number | null };
  /** Other API wallets approved on the HL master (`extraAgents`), i.e. not the bot's current one. Empty = none seen. */
  other_approved_agents: { address: string; name: string | null; valid_until_ms: number | null }[];
  balances: {
    usdc_free: Dec;
    usdc_total: Dec;
    equity_usdc: Dec;
    positions: { pair: string; base: string; size: Dec; mid: Dec; value_usdc: Dec }[];
  };
  /** Ticks spent in the current state/reason since its state entry was logged (the log has one entry per change). */
  state_repeats: number;
  pnl: {
    /**
     * SEMANTICS CHANGED 2026-11-03: today_usdc / total_usdc are TRADING P&L (bot fills + fees + mark-to-market of the bot's
     * position), not equity deltas. total_usdc used to be equity - net_funded.
     */
    today_usdc: SDec;
    total_usdc: SDec;
    /** Deposits minus withdrawals since TRADING_START_MS, floored at 0. Includes non-vault inflows (faucet): do not label it "sent by the vault". */
    net_funded_usdc: Dec;
    day_start_equity_usdc: Dec;
    /** Inflows matched to confirmed vault top-ups. */
    funded_by_vault_usdc: Dec;
    /** Inflows not matched to a vault top-up (faucet, manual deposit). */
    external_inflow_usdc: Dec;
    /** Withdrawals / transfers out since TRADING_START_MS. Not trading loss; a warning is added while it is > 0. */
    external_outflow_usdc: Dec;
    /** Bot trading fees since TRADING_START_MS (already inside total_usdc). */
    fees_usdc: Dec;
    /** equity - net flow - total_usdc: HL activation fee and anything else that is neither a flow nor a bot fill. May be negative. */
    untracked_delta_usdc: SDec;
  };
  limits: {
    effective: RuleLimits & { price_band_bps: number };
    /** Bot whose rule set `effective` shows (the default bot, else the first active one); null = none, hard caps only. Per-bot limits: `/bots/:id`. */
    effective_bot_id?: string | null;
    today: { orders: number; loss_usdc: Dec };
    position_usdc: Dec;
    vault: {
      status: AgentStatus;
      remaining_today_usdc: Dec;
      per_tx_limit_usdc: Dec;
      payments_today: number;
      max_payments_per_day: number;
      expires_at_ms: number | null;
    };
  };
  open_orders: {
    oid: number;
    cloid: string;
    pair: string;
    side: "buy" | "sell";
    price: Dec;
    size: Dec;
    placed_at_ms: number;
    rule_id: string | null;
    /** Bot whose cloid prefix the order carries (ADR-0006); null for an order no bot owns. */
    bot_id?: string | null;
  }[];
  /** DEPRECATED (ADR-0006): the rule set of bot `default` while it exists. Use `bots` / `GET /trading/bots`. */
  active_rules: { hash: string; name: string; confirmed_at_ms: number; confirmed_by: string } | null;
  /** Bots that are not archived (ADR-0006 section 8, additive). Public view: id, name, state only. */
  bots: { id: string; name: string; state: BotState }[];
  /** `TRADING_MAX_BOTS`. */
  max_bots: number;
  dead_man: {
    cancel_at_ms: number | null;
    /** False while HL refuses scheduleCancel for volume (DEADMAN_VOLUME_GATED): the engine places IOC orders only. */
    available: boolean;
    reason: "DEADMAN_VOLUME_GATED" | null;
  };
  perp_check: { ok: boolean; at_ms: number };
  last_tick_ms: number | null;
  next_tick_ms: number | null;
  warnings: string[];
}

/** `GET /trading/status` while `TRADING_ENABLED=false`. */
export interface TradingStatusDisabled {
  enabled: false;
}

/** New event payload on `/ai/chat` (ADR-0005 "Assistant proposal"). */
export interface TradingRulesProposal {
  id: string;
  type: "TradingRules";
  title: string;
  summary: string;
  rules: RuleSetV1;
  hash: string;
  /** The bot the rules are for, filled by the worker from the request (never by the model): ADR-0006 section 8. */
  bot: { id: string; name: string; is_new: boolean };
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  confirm: { kind: "nep413"; challenge: "/trading/rules/challenge"; endpoint: "/trading/rules/confirm" };
}
