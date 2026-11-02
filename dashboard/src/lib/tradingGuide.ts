// Pure helpers of the redesigned Trading page (docs/research/trading-ux.md): stepper state, prompt templates, event feed.
// No React, no network. Text goes through i18n (`t`), read at call time.
import { t } from "@/i18n";
import type { AccountTrust } from "./tradingView";
import type { AgentStatus } from "./types";
import type { HlAgent, LogEntry, TradingStatus } from "./tradingClient";
import type { Rule } from "./tradingRules";

/* ───────────── the three wallets ───────────── */

export type WalletKind = "near" | "evm" | "bot";
/** Which wallet the owner needs at each step (shown as badges and in the "Three wallets" table). */
export const STEP_WALLETS: Record<StepId, readonly WalletKind[]> = { 1: ["evm"], 2: ["near"], 3: ["evm", "bot"], 4: ["near"], 5: ["near"], 6: [] };

/* ───────────── stepper ───────────── */

export type StepId = 1 | 2 | 3 | 4 | 5 | 6;
export type StepState = "done" | "now" | "blocked" | "later";
/** Why a step is blocked, or a warning on a finished step. UI text is looked up by note code. */
export type StepNote =
  | "no_worker"
  | "worker_down"
  | "no_bot_wallet"
  | "untrusted_account"
  | "not_listed"
  | "expiry_long"
  | "other_wallets"
  | "agent_paused"
  | "vault_paused"
  | "ai_off"
  | "stopped_today"
  | "paused_onchain"
  | "halted"
  | "error";
export interface StepInfo {
  id: StepId;
  state: StepState;
  note: StepNote | null;
}

/** Hyperliquid's own minimum order is 10 USDC; 11 leaves room for rounding. */
export const MIN_ORDER_USDC = 11;
/** An API wallet should expire within the session (audit H2): the page warns when HL lists one that lives longer. */
export const MAX_WALLET_MS = 48 * 3_600_000;

export const expiryTooLong = (validUntilMs: number | null, nowMs: number): boolean => validUntilMs !== null && validUntilMs - nowMs > MAX_WALLET_MS;

export interface StepsInput {
  workerConfigured: boolean;
  /** The non-revoked `hl-trader` agent, if any. */
  trader: { status: AgentStatus } | null;
  /** The Hyperliquid account named by the on-chain allowlist. */
  onchainAccount: string | null;
  /** A valid address typed in the step 1 field. */
  formAddress: string | null;
  /** Live trading status (null: unreachable, loading, or trading switched off). */
  status: TradingStatus | null;
  trust: AccountTrust | null;
  /** API wallets Hyperliquid lists for the account (null: not read yet). */
  hlAgents: HlAgent[] | null;
  aiEnabled: boolean;
  nowMs: number;
}

const num = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * One state per step. A step is Done when its own facts hold. The first step that is not done is Now (or Blocked when something
 * outside the owner's hands stops it); every later step that is not done is Later. Finished steps can still carry a warning note.
 */
export function deriveSteps(i: StepsInput): StepInfo[] {
  const s = i.status;
  const trustOk = i.trust?.kind === "ok";
  const botAddr = s?.api_wallet.address.toLowerCase() ?? "";
  const listed = i.hlAgents === null || botAddr === "" ? true : i.hlAgents.some((a) => a.address.toLowerCase() === botAddr);
  const approved = s !== null && s.api_wallet.approved && botAddr !== "" && trustOk && listed;

  const done: Record<StepId, boolean> = {
    1: i.onchainAccount !== null || i.formAddress !== null,
    2: i.trader !== null,
    3: approved,
    4: s !== null && num(s.balances.equity_usdc) >= MIN_ORDER_USDC,
    5: s !== null && s.active_rules !== null && s.state !== "halted",
    6: s !== null && s.state === "running",
  };

  const blockedReason = (id: StepId): StepNote | null => {
    if (id === 3) {
      if (!i.workerConfigured) return "no_worker";
      if (s === null) return "worker_down";
      if (botAddr === "") return "no_bot_wallet";
      if (!trustOk) return "untrusted_account";
      if (s.api_wallet.approved && !listed) return "not_listed";
      return null;
    }
    if (id === 4) return s !== null && (s.limits.vault.status === "Paused" || s.limits.vault.status === "Revoked") ? "vault_paused" : i.trader?.status === "Paused" ? "agent_paused" : null;
    if (id === 5) return !i.aiEnabled ? "ai_off" : null;
    if (id === 6) {
      const st = s?.state;
      return st === "stopped_today" || st === "paused_onchain" || st === "halted" || st === "error" ? st : null;
    }
    return null;
  };

  const warn = (id: StepId): StepNote | null => {
    if (id === 2) return i.trader?.status === "Paused" ? "agent_paused" : null;
    if (id === 3 && approved && s) {
      if (expiryTooLong(s.api_wallet.valid_until_ms, i.nowMs)) return "expiry_long";
      const mine = botAddr;
      const others = (i.hlAgents ?? s.other_approved_agents).filter((a) => a.address.toLowerCase() !== mine);
      if (others.length > 0) return "other_wallets";
    }
    return null;
  };

  let firstOpen = true;
  return ([1, 2, 3, 4, 5, 6] as const).map((id): StepInfo => {
    if (done[id]) return { id, state: "done", note: warn(id) };
    if (!firstOpen) return { id, state: "later", note: null };
    firstOpen = false;
    const reason = blockedReason(id);
    return { id, state: reason ? "blocked" : "now", note: reason };
  });
}

export const doneCount = (steps: StepInfo[]): number => steps.filter((s) => s.state === "done").length;

/* ───────────── API wallet name (HL API page, field 1) ───────────── */

/** `valid_until` is rounded down to 10 minutes so the text on screen does not change while the owner copies it. */
export const apiWalletNameStable = (nowMs: number, hours = 47): string => `agent-treasury valid_until ${Math.floor((nowMs + hours * 3_600_000) / 600_000) * 600_000}`;

/* ───────────── which pair, which sizes ───────────── */

const DEFAULT_PAIR = { mainnet: "HYPE/USDC", testnet: "PURR/USDC" } as const;

/**
 * The pair to use in examples. The worker does not publish `TRADING_ALLOWED_PAIRS` in `/trading/status` (yet), so: an explicit
 * `allowed` list if the status ever carries one, then what the dashboard can see (signed rules, positions, open orders), then the
 * network default. The worker re-checks every pair anyway (`PAIR_NOT_ALLOWED`).
 */
export function pickPair(p: { allowed?: readonly string[] | undefined; rulesPairs?: readonly string[] | undefined; status: TradingStatus | null; network: "mainnet" | "testnet" }): string {
  const fromStatus = p.status?.balances.positions.find((x) => x.pair)?.pair ?? p.status?.open_orders.find((o) => o.pair)?.pair;
  return p.allowed?.[0] ?? p.rulesPairs?.[0] ?? fromStatus ?? DEFAULT_PAIR[p.network];
}
export const baseOfPair = (pair: string): string => pair.split("/")[0] ?? pair;

export interface HardLimits {
  maxOrder: number;
  maxPosition: number;
  lossStop: number;
  maxOrders: number;
}
export const hardLimitsOf = (s: TradingStatus | null): HardLimits | null =>
  s ? { maxOrder: num(s.limits.effective.max_order_usdc), maxPosition: num(s.limits.effective.max_position_usdc), lossStop: num(s.limits.effective.daily_loss_stop_usdc), maxOrders: s.limits.effective.max_orders_per_day } : null;
/** Shown before the worker answers: the ADR-0005 defaults (50 / 20 / 10). */
export const DEFAULT_HARD: HardLimits = { maxOrder: 20, maxPosition: 50, lossStop: 10, maxOrders: 20 };

export interface Sizes {
  /** A normal buy: at least MIN_ORDER_USDC, at most the order cap. */
  buy: number;
  /** Position cap to state in the rules. */
  position: number;
  loss: number;
  orders: number;
}
/** Sizes for the example prompts: always inside the hard limits and never under the Hyperliquid minimum. Null when the cap is below it. */
export function promptSizes(h: HardLimits): Sizes | null {
  const maxOrder = Math.floor(h.maxOrder);
  const maxPos = Math.floor(h.maxPosition);
  if (maxOrder < MIN_ORDER_USDC || maxPos < MIN_ORDER_USDC) return null;
  return { buy: Math.min(12, maxOrder, maxPos), position: Math.min(40, maxPos), loss: Math.max(1, Math.min(5, Math.floor(h.lossStop))), orders: Math.max(1, Math.min(4, h.maxOrders)) };
}

export const TEMPLATE_IDS = ["dca", "dip", "tp", "sl", "combo"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const EXAMPLE_IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const params = (pair: string, z: Sizes) => ({ pair, base: baseOfPair(pair), buy: z.buy, pos: z.position, loss: z.loss, orders: z.orders });

/** The five template chips: each is a full prompt ending with the limits sentence, in the current language. */
export function buildTemplates(pair: string, h: HardLimits): { id: TemplateId; label: string; prompt: string }[] | null {
  const z = promptSizes(h);
  if (!z) return null;
  const p = params(pair, z);
  return TEMPLATE_IDS.map((id) => ({ id, label: t(`trading.tpl.${id}.label`), prompt: t(`trading.tpl.${id}.prompt`, p) }));
}

/** Six to eight example sentences; same sizes rules as the templates. */
export function buildExamples(pair: string, h: HardLimits): string[] | null {
  const z = promptSizes(h);
  if (!z) return null;
  const p = params(pair, z);
  return EXAMPLE_IDS.map((n) => t(`trading.ex.${n}`, p));
}

/* ───────────── "would it fire right now?" ───────────── */

export type FireNow = { kind: "interval" } | { kind: "price"; fires: boolean; mid: string; pair: string } | null;

/**
 * Only what the status can really answer. Interval rules run once when the rules are signed. `price` rules compare with the mid
 * price of a pair the account holds (the status carries mids for held positions only). Price change and position P&L need price
 * history or the bot's cost basis, which the dashboard does not have: no line, rather than a guess.
 */
export function fireNow(r: Rule, mids: Readonly<Record<string, string>>): FireNow {
  if (r.when.type === "interval") return { kind: "interval" };
  if (r.when.type === "price") {
    const mid = mids[r.pair];
    const m = mid === undefined ? NaN : Number(mid);
    if (!Number.isFinite(m) || m <= 0) return null;
    const lim = Number(r.when.usdc);
    return { kind: "price", fires: r.when.op === "lte" ? m <= lim : m >= lim, mid: mid ?? "", pair: r.pair };
  }
  return null;
}
export const midsOf = (s: TradingStatus | null): Record<string, string> => Object.fromEntries((s?.balances.positions ?? []).map((p) => [p.pair, p.mid]));

/* ───────────── event feed ───────────── */

export interface FeedItem {
  entry: LogEntry;
  /** How many identical entries in a row were folded into this one. */
  count: number;
  /** Time of the oldest folded entry. */
  firstAt: number;
}

/** Newest-first log -> consecutive identical entries (same kind, rule and text) shown once with a count. */
export function collapseLog(entries: readonly LogEntry[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.entry.kind === e.kind && last.entry.detail === e.detail && (last.entry.rule_id ?? "") === (e.rule_id ?? "")) {
      last.count += 1;
      last.firstAt = Math.min(last.firstAt, e.at_ms);
    } else out.push({ entry: e, count: 1, firstAt: e.at_ms });
  }
  return out;
}

const STATE_WORDS = ["not_configured", "awaiting_api_wallet", "no_rules", "paused_onchain", "stopped_today", "halted", "error"] as const;

/** A log entry in a sentence. Worker detail text is untrusted and English; known shapes become translated sentences, the rest is shown as is. */
export function describeEvent(e: LogEntry): string {
  const d = e.detail;
  const rule = e.rule_id ? t("trading.ev.rule", { id: e.rule_id }) : "";
  if (e.kind === "state") {
    const word = STATE_WORDS.find((w) => d === w || d.startsWith(`${w}:`) || d.startsWith(`${w} (`));
    if (word) return t(`trading.ev.state.${word}`, { why: d.slice(word.length).replace(/^[:\s]+/, "") });
    if (d.startsWith("KILL SWITCH")) return t("trading.ev.kill");
    if (d.startsWith("ALARM")) return t("trading.ev.alarm");
    const rules = /^rules ([0-9a-f]{4,16}) confirmed by (\S+)/.exec(d);
    if (rules) return t("trading.ev.rulesConfirmed", { who: rules[2] ?? "" });
    if (d.startsWith("API wallet rotated")) return t("trading.ev.rotated");
    return d;
  }
  if (e.kind === "topup") {
    const m = /^(submitted|pending_approval|transfer_failed): payout (\S+)/.exec(d);
    if (m?.[1] === "submitted") return t("trading.ev.topupSent", { id: m[2] ?? "" });
    if (m?.[1] === "pending_approval") return t("trading.ev.topupApprove", { id: m[2] ?? "" });
    if (m?.[1] === "transfer_failed") return t("trading.ev.topupFailed", { id: m[2] ?? "" });
    if (d.startsWith("skipped:")) return t("trading.ev.topupSkipped", { why: d.slice(8).trim() });
    if (d.startsWith("rejected:")) return t("trading.ev.topupRejected", { why: d.slice(9).trim() });
    return t("trading.ev.topup", { text: d });
  }
  const head = e.kind === "order" ? t("trading.ev.order") : e.kind === "skip" ? t("trading.ev.skip") : t("trading.ev.cancel");
  return `${rule}${head}: ${d}`;
}

/** "Waiting for rules ×12" */
export const feedLine = (f: FeedItem): string => (f.count > 1 ? t("trading.ev.times", { text: describeEvent(f.entry), count: f.count }) : describeEvent(f.entry));
