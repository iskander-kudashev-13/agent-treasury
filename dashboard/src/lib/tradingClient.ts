/**
 * Typed browser client of the worker's trading API (ADR-0005 "Worker HTTP API", mounted at `/trading`).
 * Auth: `owner` = bearer token of the NEP-413 assistant session (`/ai/session`); `confirm` = a NEP-413 signature over the
 * message below. Everything coming back is untrusted: parsed defensively and rendered as text only.
 */
import { clearSession, loadSession, signInWithWallet, type AiSession, type SignMessageFn } from "./assistantClient";
import { NETWORK, VAULT_ID, WORKER_URL } from "./config";
import { confirmationMessage, hashRuleSet, parseRuleSet, type RuleSetV1 } from "./tradingRules";

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
  pnl: { today_usdc: string; total_usdc: string; net_funded_usdc: string; day_start_equity_usdc: string };
  limits: {
    effective: { max_position_usdc: string; max_order_usdc: string; daily_loss_stop_usdc: string; max_orders_per_day: number; price_band_bps: number };
    today: { orders: number; loss_usdc: string };
    position_usdc: string;
    vault: { status: string; remaining_today_usdc: string; per_tx_limit_usdc: string; payments_today: number; max_payments_per_day: number; expires_at_ms: number | null };
  };
  open_orders: TradingOrder[];
  active_rules: { hash: string; name: string; confirmed_at_ms: number; confirmed_by: string } | null;
  dead_man: { cancel_at_ms: number | null };
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
  if (!res.ok) throw new Error(`Hyperliquid info HTTP ${res.status}`);
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
    pnl: { today_usdc: str(p.today_usdc, "0"), total_usdc: str(p.total_usdc, "0"), net_funded_usdc: str(p.net_funded_usdc, "0"), day_start_equity_usdc: str(p.day_start_equity_usdc, "0") },
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
    dead_man: { cancel_at_ms: numOrNull(obj(j.dead_man).cancel_at_ms) },
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
  return { id: raw.id, title: str(raw.title, "", 120), summary: str(raw.summary, "", 2000), rules: rules.rules, hash: raw.hash, validation: { ok: v.ok && errors.length === 0, errors, warnings: strs(v.warnings) } };
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
  let msg = `HTTP ${res.status}`;
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
    if (!s) throw new Error("Unexpected /trading/status response");
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
  if (!r) throw new Error("Unexpected /trading/kill response");
  return r;
}

export async function rotateApiWallet(token: string): Promise<string> {
  const j = await request("/api-wallet/rotate", { method: "POST", token, body: {} });
  if (!isObj(j) || typeof j.address !== "string") throw new Error("Unexpected rotate response");
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
  if (!status.enabled) throw new Error("Trading is switched off on this worker");
  if (vault && status.vault && status.vault !== vault) throw new Error("The worker trades for a different vault than this dashboard");
  // The agent id goes into the signed message: refuse anything but the trader agent this dashboard manages.
  if (status.agent_id !== TRADER_AGENT_ID) throw new Error(`The worker trades as agent "${status.agent_id}", not "${TRADER_AGENT_ID}". Nothing was signed.`);

  if (deps.trustedHlAccount === null) throw new Error("The vault does not name a single Hyperliquid account for hl-trader, so the account the worker reports cannot be verified. Nothing was signed.");
  const HEX_ADDR = /^0x[0-9a-f]{40}$/;
  const reported = status.hl_account.toLowerCase();
  const trusted = deps.trustedHlAccount.toLowerCase();
  if (!HEX_ADDR.test(reported) || !HEX_ADDR.test(trusted)) throw new Error("Not a valid Hyperliquid address (expected 0x and 40 hex characters). Nothing was signed.");
  if (NETWORK === "mainnet" && status.hl_network !== "mainnet") throw new Error(`The worker trades on Hyperliquid ${status.hl_network}, but this dashboard is on mainnet. Nothing was signed.`);
  if (reported !== trusted) {
    throw new Error(`The worker reports Hyperliquid account ${status.hl_account}, but the vault pays ${deps.trustedHlAccount}. Nothing was signed.`);
  }

  const session = await ensureSession(deps.accountId, deps.signMessage);
  const ch = await request("/rules/challenge", { method: "POST", token: session.token, body: { rules } });
  if (!isObj(ch) || typeof ch.nonce !== "string" || typeof ch.message !== "string" || typeof ch.recipient !== "string") throw new Error("Unexpected challenge response");
  if (ch.hash !== undefined && ch.hash !== localHash) throw new Error("The worker computed a different hash for these rules. Nothing was signed.");
  if (vault && ch.recipient !== vault) throw new Error("The challenge is addressed to a different vault. Nothing was signed.");
  const expected = confirmationMessage({ vault: status.vault || vault, agentId: status.agent_id, hlNetwork: status.hl_network, hlAccount: status.hl_account, rulesSha256: localHash });
  if (ch.message !== expected) throw new Error("The message to sign does not match the rules shown. Nothing was signed.");

  const signed = await deps.signMessage({ message: ch.message, recipient: ch.recipient, nonce: b64ToBytes(ch.nonce) });
  if (!signed) throw new Error("The wallet did not return a signature (it may have redirected). Try again.");
  if (signed.accountId !== deps.accountId) throw new Error("The wallet signed with a different account than the connected one");

  const j = await request("/rules/confirm", {
    method: "POST",
    body: { rules, account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: ch.nonce },
  });
  if (!isObj(j)) throw new Error("Unexpected confirm response");
  return { active: parseConfirmed(j.active), state: str(j.state) };
}
