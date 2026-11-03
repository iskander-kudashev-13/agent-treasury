/**
 * Bots data layer (ADR-0006 D5). Two sources behind one shape:
 *  - "bots": the worker implements `/trading/bots*` (ADR-0006 §8);
 *  - "fallback": it does not yet (404). One bot, `default`, is synthesized from `/trading/status`, `/trading/rules` and the
 *    account's own Hyperliquid data read by the browser (fills, candles): no trust in the worker for prices or trades.
 *    P&L history is sampled locally each time the status is read ("history starts now").
 * Everything from the network is untrusted and parsed defensively.
 */
import { t } from "@/i18n";
import { loadSession } from "./assistantClient";
import {
  fetchActiveRules,
  fetchBot,
  fetchBotFills,
  fetchBotHistory,
  fetchBotMetrics,
  fetchBots,
  fetchTradingStatus,
  killBot,
  killTrading,
  TradingHttpError,
  type BotDetail,
  type BotFill,
  type BotFills,
  type BotHistory,
  type BotKillResult,
  type BotMetrics,
  type BotPair,
  type BotState,
  type BotSummary,
  type ConfirmedRules,
  type TradingState,
  type TradingStatus,
  type TradingStatusResult,
} from "./tradingClient";
import { hashRuleSet } from "./tradingRules";
import { addSample, candleStartMs, candleInterval, computeMetrics, hourlySpark, rangeStartMs, samplesToPoints, withRealized, type CandleInterval, type HistoryRange, type PnlSample } from "./tradingMetrics";

export const DEFAULT_BOT_ID = "default";
export type BotsMode = "bots" | "fallback";

export const isNotFound = (e: unknown): boolean => e instanceof TradingHttpError && e.status === 404;

/* ───────────── local store (samples + pairs of the confirmed rules) ───────────── */

interface Store {
  samples: PnlSample[];
  /** rules hash -> pairs, remembered from the last time the owner session read the rules (the public status has no pairs). */
  pairs: Record<string, string[]>;
}
const storeKey = (network: string, account: string) => `at.trading.bot.${network}.${account.toLowerCase()}`;
type KV = Pick<Storage, "getItem" | "setItem">;
const kv = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadStore(network: string, account: string, storage: KV | null = kv()): Store {
  try {
    const raw = storage?.getItem(storeKey(network, account));
    const j: unknown = raw ? JSON.parse(raw) : null;
    if (typeof j === "object" && j !== null) {
      const o = j as { samples?: unknown; pairs?: unknown };
      const samples = Array.isArray(o.samples) ? o.samples.flatMap((s): PnlSample[] => (Array.isArray(s) && typeof s[0] === "number" && typeof s[1] === "string" && typeof s[2] === "string" ? [[s[0], s[1], s[2]] as const] : [])) : [];
      const pairs: Record<string, string[]> = {};
      if (typeof o.pairs === "object" && o.pairs !== null) for (const [h, v] of Object.entries(o.pairs).slice(0, 20)) if (Array.isArray(v)) pairs[h] = v.filter((x): x is string => typeof x === "string").slice(0, 10);
      return { samples, pairs };
    }
  } catch {
    /* corrupt or unavailable: start empty */
  }
  return { samples: [], pairs: {} };
}
function saveStore(network: string, account: string, s: Store, storage: KV | null = kv()) {
  try {
    storage?.setItem(storeKey(network, account), JSON.stringify(s));
  } catch {
    /* quota or private mode: the history is just not kept */
  }
}
/** Called whenever the status is read in fallback mode. */
export function recordSample(status: TradingStatus, nowMs: number, storage: KV | null = kv()): Store {
  const s = loadStore(status.hl_network, status.hl_account, storage);
  const next = { ...s, samples: addSample(s.samples, nowMs, status.pnl.total_usdc, status.pnl.today_usdc) };
  if (next.samples.length !== s.samples.length || next.samples[next.samples.length - 1] !== s.samples[s.samples.length - 1]) saveStore(status.hl_network, status.hl_account, next, storage);
  return next;
}
export function rememberPairs(status: TradingStatus, hash: string, pairs: string[], storage: KV | null = kv()) {
  const s = loadStore(status.hl_network, status.hl_account, storage);
  if (s.pairs[hash]?.join() === pairs.join()) return;
  saveStore(status.hl_network, status.hl_account, { ...s, pairs: { ...s.pairs, [hash]: pairs } }, storage);
}

/* ───────────── fallback: summary ───────────── */

const STATE_MAP: Record<TradingState, BotState | null> = {
  not_configured: null,
  awaiting_api_wallet: null,
  no_rules: null,
  running: "running",
  stopped_today: "stopped_today",
  halted: "halted",
  paused_onchain: "blocked",
  error: "blocked",
};

/** The one bot of a worker without `/trading/bots`: `null` until trading is connected and rules are signed. */
export function fallbackSummary(status: TradingStatusResult, store: Store, nowMs: number): BotSummary | null {
  if (!status.enabled) return null;
  const state = STATE_MAP[status.state];
  if (state === null || status.active_rules === null) return null;
  const pairs = store.pairs[status.active_rules.hash] ?? status.balances.positions.map((p) => p.pair);
  return {
    id: DEFAULT_BOT_ID,
    name: status.active_rules.name || t("trading.bot.defaultName"),
    kind: "rules",
    state,
    state_reason: status.state === "running" ? null : status.state_reason ?? status.state,
    pairs,
    pnl_today_usdc: status.pnl.today_usdc,
    pnl_total_usdc: status.pnl.total_usdc,
    position_usdc: status.limits.position_usdc,
    spark: hourlySpark(store.samples, nowMs),
    created_at_ms: status.active_rules.confirmed_at_ms,
    archived_at_ms: null,
    last_fill_ms: null,
  };
}

export interface BotsLoad {
  mode: BotsMode;
  bots: BotSummary[];
  status: TradingStatusResult;
}

/** `GET /trading/bots`; on 404 the single synthesized bot. The token is optional (the public view is thinner). */
export async function loadBots(token: string | null, signal?: AbortSignal, nowMs: number = Date.now()): Promise<BotsLoad> {
  const status = await fetchTradingStatus(signal);
  try {
    return { mode: "bots", bots: await fetchBots(token, signal), status };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (!status.enabled) return { mode: "fallback", bots: [], status };
  const store = recordSample(status, nowMs);
  const bot = fallbackSummary(status, store, nowMs);
  return { mode: "fallback", bots: bot ? [bot] : [], status };
}

/* ───────────── Hyperliquid info API, from the browser ───────────── */

const hlUrl = (network: "mainnet" | "testnet") => `https://api.hyperliquid${network === "testnet" ? "-testnet" : ""}.xyz/info`;
async function hlInfo(network: "mainnet" | "testnet", body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(hlUrl(network), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(t("trading.err.hlInfoHttp", { status: res.status }));
  return res.json();
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Candle {
  /** Unix seconds (lightweight-charts time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function parseCandles(j: unknown): Candle[] {
  if (!Array.isArray(j)) return [];
  return j.slice(0, 5000).flatMap((c): Candle[] => {
    if (!isObj(c)) return [];
    const t0 = Number(c.t);
    const [open, high, low, close] = [c.o, c.h, c.l, c.c].map(Number) as [number, number, number, number];
    return [t0, open, high, low, close].every(Number.isFinite) ? [{ time: Math.floor(t0 / 1000), open, high, low, close }] : [];
  });
}

/** `candleSnapshot` for a spot coin ("@107"). Oldest first. */
export async function fetchHlCandles(network: "mainnet" | "testnet", coin: string, interval: CandleInterval, startMs: number, endMs: number, signal?: AbortSignal): Promise<Candle[]> {
  return parseCandles(await hlInfo(network, { type: "candleSnapshot", req: { coin, interval, startTime: Math.floor(startMs), endTime: Math.floor(endMs) } }, signal));
}

/** Pair names ("HYPE/USDC") to HL spot coins ("@107") through `spotMeta`; unknown pairs get `coin: ""`. */
export function coinsFromSpotMeta(meta: unknown, pairs: readonly string[]): BotPair[] {
  const m = isObj(meta) ? meta : {};
  const tokens = Array.isArray(m.tokens) ? m.tokens : [];
  const universe = Array.isArray(m.universe) ? m.universe : [];
  const nameOf = new Map<number, { name: string; sz: number }>();
  for (const x of tokens) if (isObj(x) && typeof x.index === "number" && typeof x.name === "string") nameOf.set(x.index, { name: x.name, sz: typeof x.szDecimals === "number" ? x.szDecimals : 0 });
  return pairs.map((pair): BotPair => {
    const [base = "", quote = "USDC"] = pair.split("/");
    for (const u of universe) {
      if (!isObj(u) || !Array.isArray(u.tokens) || typeof u.name !== "string") continue;
      const b = nameOf.get(Number(u.tokens[0]));
      const q = nameOf.get(Number(u.tokens[1]));
      if (b?.name === base && q?.name === quote) return { name: pair, coin: u.name, sz_decimals: b.sz };
    }
    return { name: pair, coin: "", sz_decimals: 0 };
  });
}
export async function resolveSpotCoins(network: "mainnet" | "testnet", pairs: readonly string[], signal?: AbortSignal): Promise<BotPair[]> {
  return coinsFromSpotMeta(await hlInfo(network, { type: "spotMeta" }, signal), pairs);
}

/** One HL fill -> `BotFill`; spot fees paid in the base token are converted to USDC at the fill price (as the worker does). */
export function hlFillToBotFill(x: unknown, coinToPair: ReadonlyMap<string, string>): BotFill | null {
  if (!isObj(x) || typeof x.coin !== "string") return null;
  const pair = coinToPair.get(x.coin);
  const px = Number(x.px);
  const sz = Number(x.sz);
  const fee = Number(x.fee);
  const time = Number(x.time);
  if (!pair || !Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(time) || (x.side !== "B" && x.side !== "A")) return null;
  const token = typeof x.feeToken === "string" ? x.feeToken : "USDC";
  const feeUsdc = Number.isFinite(fee) ? (token === "USDC" ? fee : fee * px) : 0;
  return {
    tid: typeof x.tid === "number" ? x.tid : null,
    oid: typeof x.oid === "number" ? x.oid : 0,
    cloid: typeof x.cloid === "string" ? x.cloid.slice(0, 40) : null,
    rule_id: null,
    time_ms: time,
    pair,
    side: x.side === "B" ? "buy" : "sell",
    price: String(x.px),
    size: String(x.sz),
    fee_usdc: String(feeUsdc),
    fee_token: token.slice(0, 20),
    realized_usdc: null,
    note: null,
  };
}

const fillCache = new Map<string, { at: number; fills: BotFill[] }>();
/** Fills of the account in the bot's pairs since `startMs`, newest first, with realized P&L. Cached for 15 s. */
export async function fetchAccountFills(network: "mainnet" | "testnet", account: string, pairs: readonly BotPair[], startMs: number, signal?: AbortSignal, nowMs: number = Date.now()): Promise<BotFill[]> {
  const key = `${network}:${account}:${pairs.map((p) => p.coin).join(",")}:${startMs}`;
  const hit = fillCache.get(key);
  if (hit && nowMs - hit.at < 15_000) return hit.fills;
  const coinToPair = new Map(pairs.filter((p) => p.coin !== "").map((p) => [p.coin, p.name] as const));
  const raw = await hlInfo(network, { type: "userFillsByTime", user: account, startTime: Math.floor(startMs) }, signal);
  const fills = withRealized((Array.isArray(raw) ? raw : []).slice(0, 2000).flatMap((x) => { const f = hlFillToBotFill(x, coinToPair); return f ? [f] : []; })).reverse();
  fillCache.set(key, { at: nowMs, fills });
  return fills;
}

/* ───────────── detail, history, fills, metrics ───────────── */

export interface BotCtx {
  mode: BotsMode;
  /** Owner session token (null = not signed in). */
  token: string | null;
  status: TradingStatus;
}
export const currentToken = (accountId: string | null): string | null => (accountId ? (loadSession(accountId)?.token ?? null) : null);

/** The rules the worker returns must hash to what the owner signed; otherwise they are dropped. */
async function verified(rules: ConfirmedRules | null): Promise<ConfirmedRules | null> {
  return rules !== null && (await hashRuleSet(rules.rules)) === rules.hash ? rules : null;
}

export async function loadBotDetail(ctx: BotCtx, id: string, signal?: AbortSignal): Promise<BotDetail | null> {
  const { status } = ctx;
  if (ctx.mode === "bots") {
    if (!ctx.token) return null;
    const d = await fetchBot(ctx.token, id, signal);
    return { ...d, rules: await verified(d.rules) };
  }
  if (id !== DEFAULT_BOT_ID) return null;
  const rules = ctx.token ? await verified(await fetchActiveRules(ctx.token, signal).catch(() => null)) : null;
  if (rules) rememberPairs(status, rules.hash, rules.rules.pairs);
  const summary = fallbackSummary(status, loadStore(status.hl_network, status.hl_account), Date.now());
  if (!summary) return null;
  const pairNames = rules ? rules.rules.pairs : summary.pairs;
  const pairs = pairNames.length ? await resolveSpotCoins(status.hl_network, pairNames, signal).catch(() => pairNames.map((name): BotPair => ({ name, coin: "", sz_decimals: 0 }))) : [];
  const eff = status.limits.effective;
  return {
    bot: { ...summary, pairs: pairNames },
    rules,
    rules_history: [],
    limits: { bot: rules ? rules.rules.limits : null, account: eff },
    today: status.limits.today,
    positions: status.balances.positions.map((p) => ({ pair: p.pair, size: p.size, avg_cost: null, mid: p.mid, value_usdc: p.value_usdc })),
    pairs,
    open_orders: status.open_orders,
    hl_network: status.hl_network,
    kind: "rules",
    agent: null,
  };
}

export async function loadBotHistory(ctx: BotCtx, id: string, range: HistoryRange, createdAtMs: number | null, signal?: AbortSignal, nowMs: number = Date.now()): Promise<BotHistory | null> {
  if (ctx.mode === "bots") return ctx.token ? fetchBotHistory(ctx.token, id, range, signal) : null;
  const store = loadStore(ctx.status.hl_network, ctx.status.hl_account);
  const from = rangeStartMs(range, nowMs, createdAtMs);
  return { range, bucket_ms: 60_000, points: samplesToPoints(store.samples, from, nowMs) };
}

const PAGE = 50;
/** One page of trades, newest first. Fallback pages are slices of the browser's own Hyperliquid read (cursor = offset). */
export async function loadBotFills(ctx: BotCtx, detail: BotDetail, cursor: string | null, signal?: AbortSignal): Promise<BotFills> {
  if (ctx.mode === "bots") {
    if (!ctx.token) return { fills: [], next_cursor: null };
    return fetchBotFills(ctx.token, detail.bot.id, { cursor, limit: PAGE }, signal);
  }
  const all = await fetchAccountFills(detail.hl_network, ctx.status.hl_account, detail.pairs, Date.now() - 90 * 86_400_000, signal);
  const off = cursor && /^o:\d+$/.test(cursor) ? Number(cursor.slice(2)) : 0;
  return { fills: all.slice(off, off + PAGE), next_cursor: off + PAGE < all.length ? `o:${off + PAGE}` : null };
}

/** Fills inside the chart range for the markers (newest 500). */
export async function loadMarkerFills(ctx: BotCtx, detail: BotDetail, fromMs: number, signal?: AbortSignal): Promise<BotFill[]> {
  if (ctx.mode === "bots") {
    if (!ctx.token) return [];
    const out: BotFill[] = [];
    let cursor: string | null = null;
    do {
      const page: BotFills = await fetchBotFills(ctx.token, detail.bot.id, { cursor, limit: 200, from_ms: fromMs }, signal);
      out.push(...page.fills);
      cursor = page.next_cursor;
    } while (cursor && out.length < 500);
    return out.slice(0, 500);
  }
  const all = await fetchAccountFills(detail.hl_network, ctx.status.hl_account, detail.pairs, Date.now() - 90 * 86_400_000, signal);
  return all.filter((f) => f.time_ms >= fromMs).slice(0, 500);
}

export async function loadBotMetrics(ctx: BotCtx, detail: BotDetail, range: HistoryRange, signal?: AbortSignal, nowMs: number = Date.now()): Promise<BotMetrics | null> {
  if (ctx.mode === "bots") return ctx.token ? fetchBotMetrics(ctx.token, detail.bot.id, range, signal) : null;
  const fills = await fetchAccountFills(detail.hl_network, ctx.status.hl_account, detail.pairs, Date.now() - 90 * 86_400_000, signal);
  const from = rangeStartMs(range, nowMs, detail.bot.created_at_ms || null);
  const points = samplesToPoints(loadStore(ctx.status.hl_network, ctx.status.hl_account).samples, from, nowMs);
  return computeMetrics({ fills, points, range, fromMs: from, toMs: nowMs });
}

export async function loadCandles(detail: BotDetail, pair: BotPair, range: HistoryRange, signal?: AbortSignal, nowMs: number = Date.now()): Promise<Candle[]> {
  if (pair.coin === "") return [];
  const from = candleStartMs(range, nowMs, detail.bot.created_at_ms || null);
  return fetchHlCandles(detail.hl_network, pair.coin, candleInterval(range), from, nowMs, signal);
}

/** Stop one bot. The fallback has only the account kill (it is the only bot), which the worker already provides. */
export async function stopBot(ctx: BotCtx, id: string, token: string): Promise<BotKillResult> {
  if (ctx.mode === "bots") return killBot(token, id, "dashboard stop");
  const r = await killTrading(token, "dashboard stop");
  return { bot_id: id, state: r.state, cancelled_orders: r.cancelled_orders, steps: { cancel: r.steps.cancel_all, state_saved: r.steps.state_saved ?? "ok" } };
}
