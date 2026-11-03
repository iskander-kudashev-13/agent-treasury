import { t } from "@/i18n";
/**
 * Trading Rules DSL v1 on the dashboard side (docs/adr/0005-hyperliquid-trading-agent.md).
 *
 * The assistant's model proposes rules as JSON; the owner must review and sign what the JSON really says. So the dashboard
 * (1) validates the JSON strictly (an unknown key is an error, never dropped, so the signed bytes equal the rendered rules),
 * (2) renders it with its own deterministic renderer (never with model text), and (3) hashes the canonical form itself.
 * Output must be identical to the worker for docs/trading-rules-vectors.json (see tradingRules.test.ts).
 */

export const WINDOWS = ["1h", "4h", "1d"] as const;
export const EVERIES = ["1h", "4h", "1d", "1w"] as const;
export const TTLS = ["15m", "1h", "4h", "1d"] as const;
export const COOLDOWNS = ["15m", "1h", "4h", "1d", "1w"] as const;
export type Window = (typeof WINDOWS)[number];
export type Every = (typeof EVERIES)[number];
export type Ttl = (typeof TTLS)[number];
export type Cooldown = (typeof COOLDOWNS)[number];

/** Human USDC or price: ^\d+(\.\d{1,6})?$ */
export type Dec = string;
/** Signed percent: ^-?\d+(\.\d{1,2})?$ */
export type SDec = string;

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
  /**
   * ADR-0007: absent = a rules (DSL) bot, exactly as before. "agent" = an AI agent chooses the orders; `rules` must then be [].
   * The only allowed value is "agent" (a "rules" value would give two canonical forms of the same DSL rule set).
   */
  mode?: "agent";
  name: string;
  pairs: string[];
  limits: RuleLimits;
  rules: Rule[];
}

/* ───────────── canonical JSON and hash ───────────── */

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** Keys sorted (UTF-16 order) at every level, no whitespace, `undefined` omitted. Decimals stay the strings they are. */
export function canonicalize(rules: RuleSetV1): string {
  const json = JSON.stringify(sortKeys(rules));
  if (typeof json !== "string") throw new Error("cannot canonicalize");
  return json;
}

/** hex(sha256(utf8(text))) with WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashRuleSet = async (rules: RuleSetV1): Promise<string> => sha256Hex(canonicalize(rules));

export const isAgentMode = (rs: RuleSetV1): boolean => rs.mode === "agent";

/**
 * The exact NEP-413 message the owner signs. With `botId` it is the v2 message of ADR-0006 (a `bot:` line after `agent:`), the
 * only format for new confirmations; without it, the v1 message of ADR-0005 (kept for the shared vectors and the legacy bot).
 * With `mode: "agent"` it is the v3 message of ADR-0007: another header and a `mode:` line, so a rules signature and an
 * AI-agent signature can never stand in for each other. `recipient` of the signature is the vault id.
 */
export function confirmationMessage(p: { vault: string; agentId: string; hlNetwork: "mainnet" | "testnet"; hlAccount: string; rulesSha256: string; botId?: string; mode?: "agent" }): string {
  if (p.mode !== undefined) {
    if (p.mode !== "agent" || p.botId === undefined) throw new Error("agent mode needs a bot id");
    return [
      "Agent Treasury: activate AI agent trading limits",
      `vault: ${p.vault}`,
      `agent: ${p.agentId}`,
      `bot: ${p.botId}`,
      "mode: agent",
      `hl_network: ${p.hlNetwork}`,
      `hl_account: ${p.hlAccount.toLowerCase()}`,
      `rules_sha256: ${p.rulesSha256}`,
    ].join("\n");
  }
  return [
    "Agent Treasury: activate trading rules",
    `vault: ${p.vault}`,
    `agent: ${p.agentId}`,
    ...(p.botId === undefined ? [] : [`bot: ${p.botId}`]),
    `hl_network: ${p.hlNetwork}`,
    `hl_account: ${p.hlAccount.toLowerCase()}`,
    `rules_sha256: ${p.rulesSha256}`,
  ].join("\n");
}

/* ───────────── strict parse (untrusted JSON -> RuleSetV1) ───────────── */

/** Same codes as the worker (worker/src/trading/rules/schema.ts) so the vectors can be shared. */
export type RuleIssueCode =
  | "SCHEMA"
  | "UNKNOWN_KEY"
  | "BAD_VERSION"
  | "BAD_NAME"
  | "BAD_PAIR"
  | "BAD_RULE_ID"
  | "BAD_DECIMAL"
  | "BAD_SIGNED_DECIMAL"
  | "NO_PAIRS"
  | "TOO_MANY_PAIRS"
  | "NO_RULES"
  | "TOO_MANY_RULES"
  | "MAX_ORDERS_RANGE"
  | "NAME_WHITESPACE"
  | "DUPLICATE_PAIR"
  | "DUPLICATE_RULE_ID"
  | "RULE_PAIR_NOT_LISTED"
  | "COOLDOWN_REQUIRED"
  | "COOLDOWN_NOT_ALLOWED"
  | "POSITION_PCT_ON_BUY"
  | "POSITION_PCT_RANGE"
  | "OFFSET_RANGE"
  | "PRICE_NOT_POSITIVE"
  | "PCT_BELOW_MINUS_100"
  | "MAX_ORDER_BELOW_MIN"
  | "LOSS_STOP_NOT_POSITIVE"
  | "MAX_POSITION_NOT_POSITIVE"
  | "RULE_SIZE_BELOW_MIN"
  | "RULE_SIZE_ABOVE_MAX_ORDER"
  | "BAD_MODE"
  | "AGENT_HAS_RULES"
  | "LIMIT_AGENT_MAX_ORDERS";

export type ParsedRules = { ok: true; rules: RuleSetV1 } | { ok: false; errors: RuleIssueCode[] };

const DEC_RE = /^\d+(\.\d{1,6})?$/;
const SDEC_RE = /^-?\d+(\.\d{1,2})?$/;
const RULE_ID_RE = /^[a-z0-9-]{1,16}$/;
const PAIR_RE = /^[A-Za-z0-9]{1,16}\/USDC$/;
const NAME_RE = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,60}$/u;
const HL_MIN_MICRO = 10_000_000n;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** "12.5" -> 12_500_000n; "-3" -> -3_000_000n. Caller matched DEC_RE / SDEC_RE. */
export function toMicro(s: string): bigint {
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return neg ? -v : v;
}

/**
 * Structure first (every problem collected), then the static cross-field checks. Strict: unknown keys are errors.
 * Hard limits and market data are the worker's business and are checked again there; the dashboard only guarantees
 * that what it renders and hashes is a well-formed v1 rule set.
 */
export function parseRuleSet(input: unknown): ParsedRules {
  const errs = new Set<RuleIssueCode>();
  const add = (c: RuleIssueCode) => void errs.add(c);
  const keys = (o: Record<string, unknown>, allowed: readonly string[]) => {
    if (Object.keys(o).some((k) => !allowed.includes(k))) add("UNKNOWN_KEY");
  };
  const dec = (v: unknown): v is string => {
    if (typeof v !== "string") return add("SCHEMA"), false;
    if (!DEC_RE.test(v)) return add("BAD_DECIMAL"), false;
    return true;
  };
  const sdec = (v: unknown): v is string => {
    if (typeof v !== "string") return add("SCHEMA"), false;
    if (!SDEC_RE.test(v)) return add("BAD_SIGNED_DECIMAL"), false;
    return true;
  };
  const en = <T extends string>(list: readonly T[], v: unknown): v is T => (oneOf(list, v) ? true : (add("SCHEMA"), false));

  if (!isObj(input)) return { ok: false, errors: ["SCHEMA"] };
  const root = input;
  // ADR-0007: the presence of the key (whatever its value) selects the agent-mode shape.
  const agent = "mode" in root;
  keys(root, agent ? ["version", "mode", "name", "pairs", "limits", "rules"] : ["version", "name", "pairs", "limits", "rules"]);
  if (agent && root.mode !== "agent") add("BAD_MODE");
  if (root.version !== 1) add("BAD_VERSION");
  if (typeof root.name !== "string") add("SCHEMA");
  else if (!NAME_RE.test(root.name)) add("BAD_NAME");

  if (!Array.isArray(root.pairs)) add("SCHEMA");
  else {
    if (root.pairs.length < 1) add("NO_PAIRS");
    if (root.pairs.length > 3) add("TOO_MANY_PAIRS");
    for (const p of root.pairs) if (typeof p !== "string" || !PAIR_RE.test(p)) add("BAD_PAIR");
  }

  const lim = root.limits;
  if (!isObj(lim)) add("SCHEMA");
  else {
    keys(lim, ["max_position_usdc", "max_order_usdc", "daily_loss_stop_usdc", "max_orders_per_day"]);
    dec(lim.max_position_usdc);
    dec(lim.max_order_usdc);
    dec(lim.daily_loss_stop_usdc);
    const n = lim.max_orders_per_day;
    if (typeof n !== "number") add("SCHEMA");
    else if (!Number.isInteger(n) || n < 1 || n > 50) add("MAX_ORDERS_RANGE");
  }

  if (!Array.isArray(root.rules)) add("SCHEMA");
  else if (agent) {
    if (root.rules.length > 0) add("AGENT_HAS_RULES");
  } else {
    if (root.rules.length < 1) add("NO_RULES");
    if (root.rules.length > 5) add("TOO_MANY_RULES");
    for (const r of root.rules) {
      if (!isObj(r)) {
        add("SCHEMA");
        continue;
      }
      keys(r, ["id", "pair", "when", "action", "cooldown"]);
      if (typeof r.id !== "string") add("SCHEMA");
      else if (!RULE_ID_RE.test(r.id)) add("BAD_RULE_ID");
      if (typeof r.pair !== "string") add("SCHEMA");
      else if (!PAIR_RE.test(r.pair)) add("BAD_PAIR");
      if (r.cooldown !== undefined) en(COOLDOWNS, r.cooldown);

      const w = r.when;
      if (!isObj(w)) add("SCHEMA");
      else if (w.type === "price_change") {
        keys(w, ["type", "window", "op", "pct"]);
        en(WINDOWS, w.window);
        en(["lte", "gte"], w.op);
        sdec(w.pct);
      } else if (w.type === "price") {
        keys(w, ["type", "op", "usdc"]);
        en(["lte", "gte"], w.op);
        dec(w.usdc);
      } else if (w.type === "interval") {
        keys(w, ["type", "every"]);
        en(EVERIES, w.every);
      } else if (w.type === "position_pnl") {
        keys(w, ["type", "op", "pct"]);
        en(["lte", "gte"], w.op);
        sdec(w.pct);
      } else add("SCHEMA");

      const a = r.action;
      if (!isObj(a)) add("SCHEMA");
      else {
        keys(a, ["side", "size", "order"]);
        en(["buy", "sell"], a.side);
        const sz = a.size;
        if (!isObj(sz)) add("SCHEMA");
        else if ("usdc" in sz && !("position_pct" in sz)) {
          keys(sz, ["usdc"]);
          dec(sz.usdc);
        } else if ("position_pct" in sz && !("usdc" in sz)) {
          keys(sz, ["position_pct"]);
          dec(sz.position_pct);
        } else add("SCHEMA");
        const o = a.order;
        if (!isObj(o)) add("SCHEMA");
        else if (o.type === "ioc") keys(o, ["type"]);
        else if (o.type === "limit") {
          keys(o, ["type", "offset_pct", "ttl"]);
          dec(o.offset_pct);
          en(TTLS, o.ttl);
        } else add("SCHEMA");
      }
    }
  }
  if (errs.size > 0) return { ok: false, errors: [...errs].sort() };

  // Structurally valid: the cast is safe, cross-field checks follow (same as worker `crossCheck`).
  const rs = input as unknown as RuleSetV1;
  if (rs.name.trim() !== rs.name) add("NAME_WHITESPACE");
  const seenPairs = new Set<string>();
  for (const p of rs.pairs) {
    if (seenPairs.has(p)) add("DUPLICATE_PAIR");
    seenPairs.add(p);
  }
  const maxOrder = toMicro(rs.limits.max_order_usdc);
  if (maxOrder < HL_MIN_MICRO) add("MAX_ORDER_BELOW_MIN");
  if (toMicro(rs.limits.daily_loss_stop_usdc) <= 0n) add("LOSS_STOP_NOT_POSITIVE");
  if (toMicro(rs.limits.max_position_usdc) <= 0n) add("MAX_POSITION_NOT_POSITIVE");
  const ids = new Set<string>();
  for (const r of rs.rules) {
    if (ids.has(r.id)) add("DUPLICATE_RULE_ID");
    ids.add(r.id);
    if (!seenPairs.has(r.pair)) add("RULE_PAIR_NOT_LISTED");
    if (r.when.type === "interval") {
      if (r.cooldown !== undefined) add("COOLDOWN_NOT_ALLOWED");
    } else if (r.cooldown === undefined) add("COOLDOWN_REQUIRED");
    if (r.when.type === "price" && toMicro(r.when.usdc) <= 0n) add("PRICE_NOT_POSITIVE");
    if ((r.when.type === "price_change" || r.when.type === "position_pnl") && toMicro(r.when.pct) < -100_000_000n) add("PCT_BELOW_MINUS_100");
    const sz = r.action.size;
    if ("position_pct" in sz) {
      if (r.action.side === "buy") add("POSITION_PCT_ON_BUY");
      const v = toMicro(sz.position_pct);
      if (v < 1_000_000n || v > 100_000_000n) add("POSITION_PCT_RANGE");
    } else {
      const v = toMicro(sz.usdc);
      if (v < HL_MIN_MICRO) add("RULE_SIZE_BELOW_MIN");
      if (v > maxOrder) add("RULE_SIZE_ABOVE_MAX_ORDER");
    }
    if (r.action.order.type === "limit" && toMicro(r.action.order.offset_pct) > 10_000_000n) add("OFFSET_RANGE");
  }
  return errs.size > 0 ? { ok: false, errors: [...errs].sort() } : { ok: true, rules: rs };
}

/** Plain-words explanation for an issue code (the owner never sees raw codes alone). */
const ISSUE_CODES = ["UNKNOWN_KEY", "BAD_VERSION", "BAD_DECIMAL", "BAD_SIGNED_DECIMAL", "RULE_SIZE_BELOW_MIN", "MAX_ORDER_BELOW_MIN", "RULE_SIZE_ABOVE_MAX_ORDER", "COOLDOWN_REQUIRED", "POSITION_PCT_ON_BUY", "BAD_MODE", "AGENT_HAS_RULES"] as const;
export const issueText = (c: RuleIssueCode): string => ((ISSUE_CODES as readonly string[]).includes(c) ? t(`trading.issue.${c as (typeof ISSUE_CODES)[number]}`) : t("trading.issue.fallback", { code: c }));

/* ───────────── renderer ───────────── */

type Dur = Window | Every | Ttl | Cooldown;
/** Duration phrase in the grammatical form the sentence needs (Russian/Ukrainian decline them differently per context). */
const dur = (ctx: "plain" | "over" | "every" | "after", d: Dur): string => t(`trading.dur.${ctx}.${d}`);
const signed = (pct: string) => (pct.startsWith("-") ? pct : `+${pct}`);
const bound = (op: "lte" | "gte") => (op === "lte" ? t("trading.dsl.boundLte") : t("trading.dsl.boundGte"));
const baseOf = (pair: string) => pair.split("/")[0] ?? pair;

function describeTrigger(trig: Trigger): string {
  switch (trig.type) {
    case "price_change":
      return t("trading.dsl.trigPriceChange", { dur: dur("over", trig.window), bound: bound(trig.op), pct: signed(trig.pct) });
    case "price":
      return t("trading.dsl.trigPrice", { bound: bound(trig.op), usdc: trig.usdc });
    case "interval":
      return t("trading.dsl.trigInterval", { every: dur("every", trig.every) });
    case "position_pnl":
      return t("trading.dsl.trigPnl", { bound: bound(trig.op), pct: signed(trig.pct) });
  }
}

function describeOrder(side: "buy" | "sell", o: OrderSpec): string {
  if (o.type === "ioc") return t("trading.dsl.orderIoc");
  if (o.offset_pct === "0") return t("trading.dsl.orderLimitMarket", { dur: dur("after", o.ttl) });
  return t("trading.dsl.orderLimitOffset", { offset: o.offset_pct, where: side === "buy" ? t("trading.dsl.below") : t("trading.dsl.above"), dur: dur("after", o.ttl) });
}

/** Cooldown that applies: `every` for interval rules. */
export const effectiveCooldown = (r: Rule): Cooldown | undefined => (r.when.type === "interval" ? r.when.every : r.cooldown);

export function describeRule(r: Rule, index: number): string[] {
  const a = r.action;
  const buy = a.side === "buy";
  const base = baseOf(r.pair);
  const what = "usdc" in a.size ? t(buy ? "trading.dsl.buyUsdc" : "trading.dsl.sellUsdc", { usdc: a.size.usdc, base }) : t(buy ? "trading.dsl.buyPct" : "trading.dsl.sellPct", { pct: a.size.position_pct, base });
  const cd = effectiveCooldown(r);
  return [
    t("trading.dsl.ruleTitle", { n: index + 1, id: r.id, pair: r.pair }),
    t("trading.dsl.ruleWhen", { text: describeTrigger(r.when) }),
    t("trading.dsl.ruleDo", { what, order: describeOrder(a.side, a.order) }),
    t("trading.dsl.ruleCooldown", { text: cd === undefined ? t("trading.dsl.cooldownNone") : dur("plain", cd) }),
  ];
}

/** Flat English lines, identical to the worker's `describe` (shared vectors). */
export function describeRules(rs: RuleSetV1): string[] {
  return [
    t("trading.dsl.ruleSet", { name: rs.name }),
    t("trading.dsl.pairs", { pairs: rs.pairs.join(", ") }),
    t("trading.dsl.maxPosition", { n: rs.limits.max_position_usdc }),
    t("trading.dsl.maxOrder", { n: rs.limits.max_order_usdc }),
    t("trading.dsl.dailyLossStop", { n: rs.limits.daily_loss_stop_usdc }),
    t("trading.dsl.maxOrdersDay", { n: rs.limits.max_orders_per_day }),
    ...rs.rules.flatMap(describeRule),
    ...(isAgentMode(rs) ? [t("trading.dsl.agentOrders")] : []),
  ];
}

/** Structured form for the UI: header lines plus one block per rule. */
export function describeBlocks(rs: RuleSetV1): { name: string; summary: string[]; rules: { title: string; lines: string[] }[] } {
  return {
    name: rs.name,
    summary: [
      t("trading.dsl.pairs", { pairs: rs.pairs.join(", ") }),
      t("trading.dsl.sumMaxPos", { n: rs.limits.max_position_usdc }),
      t("trading.dsl.sumMaxOrder", { n: rs.limits.max_order_usdc }),
      t("trading.dsl.sumLossStop", { n: rs.limits.daily_loss_stop_usdc }),
      t("trading.dsl.sumOrders", { count: rs.limits.max_orders_per_day }),
      ...(isAgentMode(rs) ? [t("trading.dsl.agentOrders")] : []),
    ],
    rules: rs.rules.map((r, i) => {
      const [title = "", ...lines] = describeRule(r, i);
      return { title, lines: lines.map((l) => l.trim()) };
    }),
  };
}
