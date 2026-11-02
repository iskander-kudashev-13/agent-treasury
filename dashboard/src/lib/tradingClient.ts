/**
 * Typed browser client of the worker's trading API (ADR-0005 "Worker HTTP API", mounted at `/trading`).
 * Auth: `owner` = bearer token of the NEP-413 assistant session (`/ai/session`); `confirm` = a NEP-413 signature over the
 * message below. Everything coming back is untrusted: parsed defensively and rendered as text only.
 */
import { t } from "@/i18n";
import { clearSession, loadSession, signInWithWallet, type AiSession, type SignMessageFn } from "./assistantClient";
import { NETWORK, VAULT_ID, WORKER_URL } from "./config";
import { confirmationMessage, hashRuleSet, parseRuleSet, type RuleSetV1 } from "./tradingRules";
import type { HistoryRange } from "./tradingMetrics";

export const TRADER_AGENT_ID = "hl-trader";

export type TradingState = "not_configured" | "awaiting_api_wallet" | "no_rules" | "running" | "paused_onchain" | "stopped_today" | "halted" | "error";
const STATES: readonly string[] = ["not_configured", "awaiting_api_wallet", "no_rules", "running", "paused_onchain", "stopped_today", "halted", "error"];

export interface TradingPosition {
  pair: string;
  base: string;
  size: string;
  mid: string;
  value_usdc: string;
}
export interface TradingOrder {
  oid: number;
  cloid: string;
  pair: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  placed_at_ms: number;
  rule_id: string | null;
}
export interface HlAgent {
  address: string;
  name: string | null;
  valid_until_ms: number | null;
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
  /** Other API wallets approved on the HL account (worker's view). Untrusted; the dashboard also asks Hyperliquid directly. */
  other_approved_agents: HlAgent[];
  balances: { usdc_free: string; usdc_total: string; equity_usdc: string; positions: TradingPosition[] };
  pnl: {
    today_usdc: string;
    total_usdc: string;
    net_funded_usdc: string;
    day_start_equity_usdc: string;
    /** Newer workers only; "0" when absent. */
    funded_by_vault_usdc: string;
    external_inflow_usdc: string;
    external_outflow_usdc: string;
    fees_usdc: string;
    untracked_delta_usdc: string;
  };
  limits: {
    effective: { max_position_usdc: string; max_order_usdc: string; daily_loss_stop_usdc: string; max_orders_per_day: number; price_band_bps: number };
    today: { orders: number; loss_usdc: string };
    position_usdc: string;
    vault: { status: string; remaining_today_usdc: string; per_tx_limit_usdc: string; payments_today: number; max_payments_per_day: number; expires_at_ms: number | null };
  };
  open_orders: TradingOrder[];
  active_rules: { hash: string; name: string; confirmed_at_ms: number; confirmed_by: string } | null;
  /** `available` is false while Hyperliquid has not enabled the auto-cancel for the account; null on older workers that do not report it. */
  dead_man: { cancel_at_ms: number | null; available: boolean | null };
  perp_check: { ok: boolean; at_ms: number };
  last_tick_ms: number | null;
  next_tick_ms: number | null;
  warnings: string[];
}
export type TradingStatusResult = { enabled: false } | TradingStatus;

export interface LogEntry {
  at_ms: number;
  kind: "order" | "skip" | "cancel" | "topup" | "state";
  rule_id?: string;
  detail: string;
  cloid?: string;
  oid?: number;
}
export interface ConfirmedRules {
  rules: RuleSetV1;
  hash: string;
  message: string;
  signature: string;
  public_key: string;
  account_id: string;
  nonce: string;
  callback_url: string | null;
  confirmed_at_ms: number;
}
export interface KillResult {
  state: string;
  cancelled_orders: number;
  steps: { cancel_all: "ok" | "failed"; schedule_cancel: "ok" | "failed"; state_saved?: "ok" | "failed" };
}
export interface ChallengeResponse {
  nonce: string;
  message: string;
  recipient: string;
  hash: string;
  expires_at: number;
}

/* ───────────── lenient parsing of worker answers ───────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d = "", max = 400): string => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : d);
const strOrNull = (v: unknown, max = 400): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const arr = (v: unknown, max = 100): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

function parseHlAgents(v: unknown): HlAgent[] {
  return arr(v, 20).flatMap((x): HlAgent[] => (isObj(x) && typeof x.address === "string" ? [{ address: x.address.slice(0, 64), name: strOrNull(x.name, 80), valid_until_ms: numOrNull(x.valid_until_ms ?? x.validUntil) }] : []));
}

/** Hyperliquid's public info API: the API wallets approved on `user`, read by the browser itself (no trust in the worker). */
export async function fetchHlApprovedAgents(network: "mainnet" | "testnet", user: string, signal?: AbortSignal): Promise<HlAgent[]> {
  const res = await fetch(`https://api.hyperliquid${network === "testnet" ? "-testnet" : ""}.xyz/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "extraAgents", user }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(t("trading.err.hlInfoHttp", { status: res.status }));
  return parseHlAgents(await res.json());
}

export function parseTradingStatus(j: unknown): TradingStatusResult | null {
  if (!isObj(j)) return null;
  if (j.enabled === false) return { enabled: false };
  if (j.enabled !== true || typeof j.state !== "string" || !STATES.includes(j.state)) return null;
  const w = obj(j.api_wallet);
  const b = obj(j.balances);
  const p = obj(j.pnl);
  const l = obj(j.limits);
  const eff = obj(l.effective);
  const today = obj(l.today);
  const v = obj(l.vault);
  const ar = isObj(j.active_rules) ? j.active_rules : null;
  return {
    enabled: true,
    state: j.state as TradingState,
    state_reason: strOrNull(j.state_reason),
    state_detail: strOrNull(j.state_detail, 600),
    hl_network: j.hl_network === "mainnet" ? "mainnet" : "testnet",
    hl_account: str(j.hl_account),
    vault: str(j.vault),
    agent_id: str(j.agent_id, TRADER_AGENT_ID),
    api_wallet: { address: str(w.address), approved: w.approved === true, name: strOrNull(w.name), valid_until_ms: numOrNull(w.valid_until_ms) },
    other_approved_agents: parseHlAgents(j.other_approved_agents),
    balances: {
      usdc_free: str(b.usdc_free, "0"),
      usdc_total: str(b.usdc_total, "0"),
      equity_usdc: str(b.equity_usdc, "0"),
      positions: arr(b.positions, 20).flatMap((x) => (isObj(x) ? [{ pair: str(x.pair), base: str(x.base), size: str(x.size, "0"), mid: str(x.mid, "0"), value_usdc: str(x.value_usdc, "0") }] : [])),
    },
    pnl: {
      today_usdc: str(p.today_usdc, "0"),
      total_usdc: str(p.total_usdc, "0"),
      net_funded_usdc: str(p.net_funded_usdc, "0"),
      day_start_equity_usdc: str(p.day_start_equity_usdc, "0"),
      funded_by_vault_usdc: str(p.funded_by_vault_usdc, "0"),
      external_inflow_usdc: str(p.external_inflow_usdc, "0"),
      external_outflow_usdc: str(p.external_outflow_usdc, "0"),
      fees_usdc: str(p.fees_usdc, "0"),
      untracked_delta_usdc: str(p.untracked_delta_usdc, "0"),
    },
    limits: {
      effective: {
        max_position_usdc: str(eff.max_position_usdc, "0"),
        max_order_usdc: str(eff.max_order_usdc, "0"),
        daily_loss_stop_usdc: str(eff.daily_loss_stop_usdc, "0"),
        max_orders_per_day: num(eff.max_orders_per_day),
        price_band_bps: num(eff.price_band_bps),
      },
      today: { orders: num(today.orders), loss_usdc: str(today.loss_usdc, "0") },
      position_usdc: str(l.position_usdc, "0"),
      vault: {
        status: str(v.status),
        remaining_today_usdc: str(v.remaining_today_usdc, "0"),
        per_tx_limit_usdc: str(v.per_tx_limit_usdc, "0"),
        payments_today: num(v.payments_today),
        max_payments_per_day: num(v.max_payments_per_day),
        expires_at_ms: numOrNull(v.expires_at_ms),
      },
    },
    open_orders: arr(j.open_orders, 50).flatMap((x): TradingOrder[] =>
      isObj(x) ? [{ oid: num(x.oid), cloid: str(x.cloid), pair: str(x.pair), side: x.side === "sell" ? "sell" : "buy", price: str(x.price, "0"), size: str(x.size, "0"), placed_at_ms: num(x.placed_at_ms), rule_id: strOrNull(x.rule_id, 32) }] : [],
    ),
    active_rules: ar ? { hash: str(ar.hash, "", 64), name: str(ar.name, "", 80), confirmed_at_ms: num(ar.confirmed_at_ms), confirmed_by: str(ar.confirmed_by, "", 80) } : null,
    dead_man: { cancel_at_ms: numOrNull(obj(j.dead_man).cancel_at_ms), available: typeof obj(j.dead_man).available === "boolean" ? (obj(j.dead_man).available as boolean) : null },
    perp_check: { ok: obj(j.perp_check).ok !== false, at_ms: num(obj(j.perp_check).at_ms) },
    last_tick_ms: numOrNull(j.last_tick_ms),
    next_tick_ms: numOrNull(j.next_tick_ms),
    warnings: arr(j.warnings, 20).flatMap((x) => (typeof x === "string" ? [x.slice(0, 300)] : [])),
  };
}

const KINDS: readonly string[] = ["order", "skip", "cancel", "topup", "state"];
export function parseLog(j: unknown): LogEntry[] {
  if (!isObj(j)) return [];
  return arr(j.entries, 200).flatMap((x): LogEntry[] => {
    if (!isObj(x) || typeof x.kind !== "string" || !KINDS.includes(x.kind)) return [];
    const e: LogEntry = { at_ms: num(x.at_ms), kind: x.kind as LogEntry["kind"], detail: str(x.detail, "", 300) };
    if (typeof x.rule_id === "string") e.rule_id = x.rule_id.slice(0, 32);
    if (typeof x.cloid === "string") e.cloid = x.cloid.slice(0, 40);
    if (typeof x.oid === "number") e.oid = x.oid;
    return [e];
  });
}

export function parseConfirmed(j: unknown): ConfirmedRules | null {
  if (!isObj(j)) return null;
  const r = parseRuleSet(j.rules);
  if (!r.ok || typeof j.hash !== "string" || typeof j.message !== "string") return null;
  return {
    rules: r.rules,
    hash: j.hash,
    message: j.message,
    signature: str(j.signature, "", 400),
    public_key: str(j.public_key, "", 100),
    account_id: str(j.account_id, "", 80),
    nonce: str(j.nonce, "", 100),
    callback_url: strOrNull(j.callback_url, 400),
    confirmed_at_ms: num(j.confirmed_at_ms),
  };
}

export function parseKill(j: unknown): KillResult | null {
  if (!isObj(j)) return null;
  const s = obj(j.steps);
  return {
    state: str(j.state),
    cancelled_orders: num(j.cancelled_orders),
    steps: {
      cancel_all: s.cancel_all === "ok" ? "ok" : "failed",
      schedule_cancel: s.schedule_cancel === "ok" ? "ok" : "failed",
      ...(s.state_saved === undefined ? {} : { state_saved: s.state_saved === "ok" ? ("ok" as const) : ("failed" as const) }),
    },
  };
}

/* ───────────── assistant proposal (event payload on /ai/chat) ───────────── */

export interface TradingRulesProposal {
  id: string;
  /** Model/worker text. Never used to describe the rules: the card renders `rules` itself. */
  title: string;
  summary: string;
  rules: RuleSetV1;
  /** The hash the worker claims. The card recomputes it and refuses to confirm on mismatch. */
  hash: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  /** ADR-0006: the agent the rules are for. Absent on older workers. */
  bot: { id: string; name: string; is_new: boolean } | null;
}

/** `{ id, type: "TradingRules", title, summary, rules, hash, validation, confirm }` -> typed proposal, or null when malformed. */
export function parseTradingRulesProposal(raw: unknown): TradingRulesProposal | null {
  if (!isObj(raw) || raw.type !== "TradingRules") return null;
  if (typeof raw.id !== "string" || raw.id === "" || raw.id.length > 32) return null;
  if (typeof raw.hash !== "string" || !/^[0-9a-f]{64}$/.test(raw.hash)) return null;
  const rules = parseRuleSet(raw.rules);
  if (!rules.ok) return null;
  const v = obj(raw.validation);
  if (typeof v.ok !== "boolean") return null;
  const strs = (x: unknown): string[] => arr(x, 20).flatMap((e) => (typeof e === "string" ? [e.slice(0, 300)] : []));
  const errors = strs(v.errors);
  const b = obj(raw.bot);
  const bot = typeof b.id === "string" && b.id !== "" ? { id: b.id.slice(0, 64), name: str(b.name, b.id, 80), is_new: b.is_new === true } : null;
  return { id: raw.id, title: str(raw.title, "", 120), summary: str(raw.summary, "", 2000), rules: rules.rules, hash: raw.hash, validation: { ok: v.ok && errors.length === 0, errors, warnings: strs(v.warnings) }, bot };
}

/* ───────────── HTTP ───────────── */

export class TradingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TradingHttpError";
  }
}

async function failure(res: Response): Promise<TradingHttpError> {
  let code = "http_error";
  let msg = t("trading.err.http", { status: res.status });
  try {
    const j: unknown = await res.json();
    if (isObj(j)) {
      if (typeof j.message === "string") msg = j.message;
      if (typeof j.code === "string") code = j.code;
    }
  } catch {
    /* keep the status text */
  }
  return new TradingHttpError(res.status, code, msg);
}

async function request(path: string, init: { method?: "GET" | "POST"; token?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${WORKER_URL}/trading${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Public. A worker with trading switched off answers `{ enabled: false }` (or 404 on older builds: same meaning). */
export async function fetchTradingStatus(signal?: AbortSignal): Promise<TradingStatusResult> {
  try {
    const s = parseTradingStatus(await request("/status", signal ? { signal } : {}));
    if (!s) throw new Error(t("trading.err.unexpectedStatus"));
    return s;
  } catch (e) {
    if (e instanceof TradingHttpError && e.status === 404) return { enabled: false };
    throw e;
  }
}

export async function fetchTradingLog(token: string, limit = 50, signal?: AbortSignal): Promise<LogEntry[]> {
  return parseLog(await request(`/log?limit=${Math.min(200, Math.max(1, limit))}`, { token, ...(signal ? { signal } : {}) }));
}

export async function fetchActiveRules(token: string, signal?: AbortSignal): Promise<ConfirmedRules | null> {
  const j = await request("/rules", { token, ...(signal ? { signal } : {}) });
  return isObj(j) && j.active !== null ? parseConfirmed(j.active) : null;
}

export async function killTrading(token: string, reason?: string): Promise<KillResult> {
  const r = parseKill(await request("/kill", { method: "POST", token, body: reason ? { reason } : {} }));
  if (!r) throw new Error(t("trading.err.unexpectedKill"));
  return r;
}

export async function rotateApiWallet(token: string): Promise<string> {
  const j = await request("/api-wallet/rotate", { method: "POST", token, body: {} });
  if (!isObj(j) || typeof j.address !== "string") throw new Error(t("trading.err.unexpectedRotate"));
  return j.address;
}

/** Owner bearer token: a still-valid session of this account, or a fresh NEP-413 sign-in (one wallet prompt). */
export async function ensureSession(accountId: string, signMessage: SignMessageFn): Promise<AiSession> {
  return loadSession(accountId) ?? (await signInWithWallet(signMessage, accountId));
}

/**
 * Runs `fn(token)` with an owner session. If the worker answers 401 (the 1 h token expired or the worker restarted), the stale
 * session is dropped and the owner signs in again inline, then `fn` runs once more: one click, no page reload.
 */
export async function withOwnerSession<T>(accountId: string, signMessage: SignMessageFn, fn: (token: string) => Promise<T>): Promise<T> {
  const first = await ensureSession(accountId, signMessage);
  try {
    return await fn(first.token);
  } catch (e) {
    if (!(e instanceof TradingHttpError) || e.status !== 401) throw e;
    clearSession();
    const fresh = await signInWithWallet(signMessage, accountId);
    return fn(fresh.token);
  }
}

/* ───────────── rules confirmation (NEP-413) ───────────── */

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface ConfirmDeps {
  accountId: string;
  signMessage: SignMessageFn;
  /**
   * The Hyperliquid account the on-chain `hl-trader` mandate pays (single `hypercore` allowlist entry), from the vault, not from
   * the worker. `null` = the chain cannot vouch for one: confirming is refused. (audit 2026-11-03 M7)
   */
  trustedHlAccount: string | null;
  /** Overridable for tests. */
  vault?: string;
}

/**
 * challenge -> verify everything locally -> wallet signMessage -> confirm.
 * The dashboard never signs a message it did not build itself: the worker's challenge must carry exactly the ADR message for
 * the hash the dashboard computed from the JSON it rendered. Any difference aborts before the wallet is asked.
 */
export async function confirmTradingRules(rules: RuleSetV1, deps: ConfirmDeps): Promise<{ active: ConfirmedRules | null; state: string }> {
  const vault = deps.vault ?? VAULT_ID;
  const localHash = await hashRuleSet(rules);
  const status = await fetchTradingStatus();
  if (!status.enabled) throw new Error(t("trading.err.off"));
  if (vault && status.vault && status.vault !== vault) throw new Error(t("trading.err.otherVault"));
  // The agent id goes into the signed message: refuse anything but the trader agent this dashboard manages.
  if (status.agent_id !== TRADER_AGENT_ID) throw new Error(t("trading.err.otherAgent", { got: status.agent_id, want: TRADER_AGENT_ID }));

  if (deps.trustedHlAccount === null) throw new Error(t("trading.err.noSingleAccount"));
  const HEX_ADDR = /^0x[0-9a-f]{40}$/;
  const reported = status.hl_account.toLowerCase();
  const trusted = deps.trustedHlAccount.toLowerCase();
  if (!HEX_ADDR.test(reported) || !HEX_ADDR.test(trusted)) throw new Error(t("trading.err.badAddress"));
  if (NETWORK === "mainnet" && status.hl_network !== "mainnet") throw new Error(t("trading.err.network", { network: status.hl_network }));
  if (reported !== trusted) {
    throw new Error(t("trading.err.accountDiffers", { reported: status.hl_account, trusted: deps.trustedHlAccount }));
  }

  const session = await ensureSession(deps.accountId, deps.signMessage);
  const ch = await request("/rules/challenge", { method: "POST", token: session.token, body: { rules } });
  if (!isObj(ch) || typeof ch.nonce !== "string" || typeof ch.message !== "string" || typeof ch.recipient !== "string") throw new Error(t("trading.err.unexpectedChallenge"));
  if (ch.hash !== undefined && ch.hash !== localHash) throw new Error(t("trading.err.hashDiffers"));
  if (vault && ch.recipient !== vault) throw new Error(t("trading.err.challengeVault"));
  const expected = confirmationMessage({ vault: status.vault || vault, agentId: status.agent_id, hlNetwork: status.hl_network, hlAccount: status.hl_account, rulesSha256: localHash });
  if (ch.message !== expected) throw new Error(t("trading.err.messageDiffers"));

  const signed = await deps.signMessage({ message: ch.message, recipient: ch.recipient, nonce: b64ToBytes(ch.nonce) });
  if (!signed) throw new Error(t("trading.err.noSignature"));
  if (signed.accountId !== deps.accountId) throw new Error(t("trading.err.otherAccount"));

  const j = await request("/rules/confirm", {
    method: "POST",
    body: { rules, account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: ch.nonce },
  });
  if (!isObj(j)) throw new Error(t("trading.err.unexpectedConfirm"));
  return { active: parseConfirmed(j.active), state: str(j.state) };
}

/* ───────────── bots (ADR-0006 §8) ───────────── */

export type BotState = "draft" | "running" | "stopped_today" | "halted" | "archived" | "blocked";
const BOT_STATES: readonly string[] = ["draft", "running", "stopped_today", "halted", "archived", "blocked"];
export const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

/**
 * `GET /trading/bots`. The public view carries only id, name, state and pairs (owner default 4): the money fields are `null` and
 * `spark` is empty until the request is made with the owner session.
 */
export interface BotSummary {
  id: string;
  name: string;
  state: BotState;
  state_reason: string | null;
  pairs: string[];
  pnl_today_usdc: string | null;
  pnl_total_usdc: string | null;
  position_usdc: string | null;
  /** 24 hourly `pnl_total` closes, oldest first. */
  spark: string[];
  created_at_ms: number;
  archived_at_ms: number | null;
  last_fill_ms: number | null;
}
export interface BotPosition {
  pair: string;
  size: string;
  avg_cost: string | null;
  mid: string;
  value_usdc: string;
}
export interface BotPair {
  name: string;
  /** Hyperliquid coin for `candleSnapshot` ("@107", "PURR/USDC"); "" when unknown. */
  coin: string;
  sz_decimals: number;
}
export interface BotLimits {
  max_position_usdc: string;
  max_order_usdc: string;
  daily_loss_stop_usdc: string;
  max_orders_per_day: number;
}
export interface BotDetail {
  bot: BotSummary;
  rules: ConfirmedRules | null;
  rules_history: { hash: string; name: string; confirmed_at_ms: number; superseded_at_ms: number | null }[];
  limits: { bot: BotLimits | null; account: (BotLimits & { price_band_bps: number }) | null };
  today: { orders: number; loss_usdc: string };
  positions: BotPosition[];
  pairs: BotPair[];
  open_orders: TradingOrder[];
  hl_network: "mainnet" | "testnet";
}
export interface HistoryPoint {
  t: number;
  pnl: string;
  lo: string;
  hi: string;
  today: string;
  val: string;
  px: Record<string, string>;
}
export interface BotHistory {
  range: HistoryRange;
  bucket_ms: number;
  points: HistoryPoint[];
}
export interface BotFill {
  tid: number | null;
  oid: number;
  cloid: string | null;
  rule_id: string | null;
  time_ms: number;
  pair: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  fee_usdc: string;
  fee_token: string;
  realized_usdc: string | null;
}
export interface BotFills {
  fills: BotFill[];
  next_cursor: string | null;
}
export interface BotMetrics {
  range: HistoryRange;
  from_ms: number;
  to_ms: number;
  closed_trades: number;
  /** "0.5714"; null when no trade closed in the range. */
  win_rate: string | null;
  avg_trade_usdc: string | null;
  realized_usdc: string;
  pnl_change_usdc: string;
  max_drawdown_usdc: string;
  turnover_usdc: string;
  fees_usdc: string;
  fills: number;
  orders: number;
}
export interface BotKillResult {
  bot_id: string;
  state: string;
  cancelled_orders: number;
  steps: { cancel: "ok" | "failed"; state_saved: "ok" | "failed" };
}

const DEC = /^-?\d+(\.\d+)?$/;
const dec = (v: unknown, d = "0"): string => (typeof v === "string" && DEC.test(v) ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : d);
const decOrNull = (v: unknown): string | null => (typeof v === "string" && DEC.test(v) ? v : null);

export function parseBotSummary(j: unknown): BotSummary | null {
  if (!isObj(j) || typeof j.id !== "string" || !BOT_ID_RE.test(j.id) || typeof j.state !== "string" || !BOT_STATES.includes(j.state)) return null;
  return {
    id: j.id,
    name: str(j.name, j.id, 60),
    state: j.state as BotState,
    state_reason: strOrNull(j.state_reason, 100),
    pairs: arr(j.pairs, 10).flatMap((p) => (typeof p === "string" ? [p.slice(0, 40)] : [])),
    pnl_today_usdc: decOrNull(j.pnl_today_usdc),
    pnl_total_usdc: decOrNull(j.pnl_total_usdc),
    position_usdc: decOrNull(j.position_usdc),
    spark: arr(j.spark, 48).flatMap((x) => (decOrNull(x) !== null ? [x as string] : [])),
    created_at_ms: num(j.created_at_ms),
    archived_at_ms: numOrNull(j.archived_at_ms),
    last_fill_ms: numOrNull(j.last_fill_ms),
  };
}

export function parseBots(j: unknown): BotSummary[] | null {
  if (!isObj(j) || !Array.isArray(j.bots)) return null;
  return arr(j.bots, 10).flatMap((x) => {
    const b = parseBotSummary(x);
    return b ? [b] : [];
  });
}

const parseLimits = (v: unknown): BotLimits | null => {
  if (!isObj(v)) return null;
  return { max_position_usdc: dec(v.max_position_usdc), max_order_usdc: dec(v.max_order_usdc), daily_loss_stop_usdc: dec(v.daily_loss_stop_usdc), max_orders_per_day: num(v.max_orders_per_day) };
};

function parseOrders(v: unknown): TradingOrder[] {
  return arr(v, 50).flatMap((x): TradingOrder[] =>
    isObj(x) ? [{ oid: num(x.oid), cloid: str(x.cloid), pair: str(x.pair), side: x.side === "sell" ? "sell" : "buy", price: str(x.price, "0"), size: str(x.size, "0"), placed_at_ms: num(x.placed_at_ms), rule_id: strOrNull(x.rule_id, 32) }] : [],
  );
}

export function parseBotDetail(j: unknown): BotDetail | null {
  if (!isObj(j)) return null;
  const bot = parseBotSummary(j.bot);
  if (!bot) return null;
  const lim = obj(j.limits);
  const acc = parseLimits(lim.account);
  const today = obj(j.today);
  return {
    bot,
    rules: isObj(j.rules) ? parseConfirmed(j.rules) : null,
    rules_history: arr(j.rules_history, 70).flatMap((x) => (isObj(x) && typeof x.hash === "string" ? [{ hash: x.hash.slice(0, 64), name: str(x.name, "", 80), confirmed_at_ms: num(x.confirmed_at_ms), superseded_at_ms: numOrNull(x.superseded_at_ms) }] : [])),
    limits: { bot: parseLimits(lim.bot), account: acc ? { ...acc, price_band_bps: num(obj(lim.account).price_band_bps) } : null },
    today: { orders: num(today.orders), loss_usdc: dec(today.loss_usdc) },
    positions: arr(j.positions, 20).flatMap((x) => (isObj(x) ? [{ pair: str(x.pair), size: dec(x.size), avg_cost: decOrNull(x.avg_cost), mid: dec(x.mid), value_usdc: dec(x.value_usdc) }] : [])),
    pairs: arr(j.pairs, 10).flatMap((x) => (isObj(x) && typeof x.name === "string" ? [{ name: x.name.slice(0, 40), coin: str(x.coin, "", 40), sz_decimals: num(x.sz_decimals) }] : [])),
    open_orders: parseOrders(j.open_orders),
    hl_network: j.hl_network === "mainnet" ? "mainnet" : "testnet",
  };
}

const RANGE_LIST: readonly string[] = ["1h", "1d", "1w", "1m", "all"];
const asRange = (v: unknown, d: HistoryRange): HistoryRange => (typeof v === "string" && RANGE_LIST.includes(v) ? (v as HistoryRange) : d);

export function parseBotHistory(j: unknown, range: HistoryRange): BotHistory | null {
  if (!isObj(j) || !Array.isArray(j.points)) return null;
  const points = arr(j.points, 3000).flatMap((x): HistoryPoint[] => {
    if (!isObj(x) || typeof x.t !== "number" || !Number.isFinite(x.t)) return [];
    const pnl = dec(x.pnl);
    const px: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(x.px)).slice(0, 10)) if (decOrNull(v) !== null) px[k.slice(0, 40)] = v as string;
    return [{ t: x.t, pnl, lo: dec(x.lo, pnl), hi: dec(x.hi, pnl), today: dec(x.today), val: dec(x.val), px }];
  });
  return { range: asRange(j.range, range), bucket_ms: num(j.bucket_ms), points };
}

export function parseBotFill(x: unknown): BotFill | null {
  if (!isObj(x) || (x.side !== "buy" && x.side !== "sell") || typeof x.price !== "string" || !DEC.test(x.price) || typeof x.size !== "string" || !DEC.test(x.size)) return null;
  return {
    tid: numOrNull(x.tid),
    oid: num(x.oid),
    cloid: strOrNull(x.cloid, 40),
    rule_id: strOrNull(x.rule_id, 32),
    time_ms: num(x.time_ms),
    pair: str(x.pair, "", 40),
    side: x.side,
    price: x.price,
    size: x.size,
    fee_usdc: dec(x.fee_usdc),
    fee_token: str(x.fee_token, "USDC", 20),
    realized_usdc: decOrNull(x.realized_usdc),
  };
}

export function parseBotFills(j: unknown): BotFills | null {
  if (!isObj(j) || !Array.isArray(j.fills)) return null;
  return { fills: arr(j.fills, 200).flatMap((x) => { const f = parseBotFill(x); return f ? [f] : []; }), next_cursor: strOrNull(j.next_cursor, 200) };
}

export function parseBotMetrics(j: unknown, range: HistoryRange): BotMetrics | null {
  if (!isObj(j)) return null;
  return {
    range: asRange(j.range, range),
    from_ms: num(j.from_ms),
    to_ms: num(j.to_ms),
    closed_trades: num(j.closed_trades),
    win_rate: decOrNull(j.win_rate),
    avg_trade_usdc: decOrNull(j.avg_trade_usdc),
    realized_usdc: dec(j.realized_usdc),
    pnl_change_usdc: dec(j.pnl_change_usdc),
    max_drawdown_usdc: dec(j.max_drawdown_usdc),
    turnover_usdc: dec(j.turnover_usdc),
    fees_usdc: dec(j.fees_usdc),
    fills: num(j.fills),
    orders: num(j.orders),
  };
}

export function parseBotKill(j: unknown): BotKillResult | null {
  if (!isObj(j) || typeof j.bot_id !== "string") return null;
  const s = obj(j.steps);
  return { bot_id: j.bot_id, state: str(j.state), cancelled_orders: num(j.cancelled_orders), steps: { cancel: s.cancel === "ok" ? "ok" : "failed", state_saved: s.state_saved === "ok" ? "ok" : "failed" } };
}

const botPath = (id: string): string => {
  if (!BOT_ID_RE.test(id)) throw new Error(t("trading.err.badBotId"));
  return `/bots/${id}`;
};
const sig = (signal?: AbortSignal) => (signal ? { signal } : {});

/** Public; sends the owner token when there is one so the worker can add P&L and sparklines. 404 = a worker without bots (see `tradingBots.ts`). */
export async function fetchBots(token?: string | null, signal?: AbortSignal): Promise<BotSummary[]> {
  const r = parseBots(await request("/bots", { ...(token ? { token } : {}), ...sig(signal) }));
  if (!r) throw new Error(t("trading.err.unexpectedBots"));
  return r;
}
export async function fetchBot(token: string, id: string, signal?: AbortSignal): Promise<BotDetail> {
  const r = parseBotDetail(await request(botPath(id), { token, ...sig(signal) }));
  if (!r) throw new Error(t("trading.err.unexpectedBots"));
  return r;
}
export async function fetchBotHistory(token: string, id: string, range: HistoryRange, signal?: AbortSignal): Promise<BotHistory> {
  const r = parseBotHistory(await request(`${botPath(id)}/history?range=${range}`, { token, ...sig(signal) }), range);
  if (!r) throw new Error(t("trading.err.unexpectedBots"));
  return r;
}
export async function fetchBotFills(token: string, id: string, q: { cursor?: string | null; limit?: number; from_ms?: number } = {}, signal?: AbortSignal): Promise<BotFills> {
  const p = new URLSearchParams({ limit: String(Math.min(200, Math.max(1, q.limit ?? 50))) });
  if (q.cursor) p.set("cursor", q.cursor);
  if (q.from_ms !== undefined) p.set("from_ms", String(Math.max(0, Math.floor(q.from_ms))));
  const r = parseBotFills(await request(`${botPath(id)}/fills?${p.toString()}`, { token, ...sig(signal) }));
  if (!r) throw new Error(t("trading.err.unexpectedBots"));
  return r;
}
export async function fetchBotMetrics(token: string, id: string, range: HistoryRange, signal?: AbortSignal): Promise<BotMetrics> {
  const r = parseBotMetrics(await request(`${botPath(id)}/metrics?range=${range}`, { token, ...sig(signal) }), range);
  if (!r) throw new Error(t("trading.err.unexpectedBots"));
  return r;
}
/** Stops one bot: its orders are cancelled and it halts; the other bots keep running. */
export async function killBot(token: string, id: string, reason?: string): Promise<BotKillResult> {
  const r = parseBotKill(await request(`${botPath(id)}/kill`, { method: "POST", token, body: reason ? { reason } : {} }));
  if (!r) throw new Error(t("trading.err.unexpectedKill"));
  return r;
}
