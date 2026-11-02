/**
 * zod schema for Rules DSL v1 (docs/adr/0005-hyperliquid-trading-agent.md "Rules DSL v1").
 *
 * Every object is strict: an unknown key is an error, never silently dropped. That matters because the owner signs the
 * hash of the canonical JSON; a dropped key would mean the signed bytes differ from what the engine runs.
 *
 * Structural problems carry a stable machine code as the zod message; cross-field problems are found by `crossCheck`
 * (run only after the structural parse succeeded). `parseRuleSet` returns both as `ValidationIssue`s. The same codes are
 * listed in docs/trading-rules-vectors.json for the dashboard.
 */
import { z } from "zod";
import type { RuleSetV1, ValidationIssue } from "../types.js";
import { COOLDOWNS, EVERIES, TTLS, WINDOWS } from "../types.js";

/** HL rejects orders below 10 USDC notional. */
export const HL_MIN_ORDER_MICRO = 10_000_000n;
export const MAX_RULES = 5;
export const MAX_PAIRS = 3;
export const MAX_ORDERS_PER_DAY_CAP = 50;

const DEC_RE = /^\d+(\.\d{1,6})?$/;
const SDEC_RE = /^-?\d+(\.\d{1,2})?$/;
const RULE_ID_RE = /^[a-z0-9-]{1,16}$/;
/** Display name of an HL spot pair quoted in USDC. */
const PAIR_RE = /^[A-Za-z0-9]{1,16}\/USDC$/;
/** 1..60 code points, no control/format characters or line separators. */
const NAME_RE = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,60}$/u;

/** Parse a `Dec` / `SDec` string into micro-units (1e-6) as a bigint. Caller must have matched DEC_RE / SDEC_RE. */
export function toMicro(s: string): bigint {
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return neg ? -v : v;
}

const dec = z.string().regex(DEC_RE, "BAD_DECIMAL");
const sdec = z.string().regex(SDEC_RE, "BAD_SIGNED_DECIMAL");
const op = z.enum(["lte", "gte"]);

const trigger = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("price_change"), window: z.enum(WINDOWS), op, pct: sdec }),
  z.strictObject({ type: z.literal("price"), op, usdc: dec }),
  z.strictObject({ type: z.literal("interval"), every: z.enum(EVERIES) }),
  z.strictObject({ type: z.literal("position_pnl"), op, pct: sdec }),
]);

const size = z.union([z.strictObject({ usdc: dec }), z.strictObject({ position_pct: dec })]);

const order = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ioc") }),
  z.strictObject({ type: z.literal("limit"), offset_pct: dec, ttl: z.enum(TTLS) }),
]);

const rule = z.strictObject({
  id: z.string().regex(RULE_ID_RE, "BAD_RULE_ID"),
  pair: z.string().regex(PAIR_RE, "BAD_PAIR"),
  when: trigger,
  action: z.strictObject({ side: z.enum(["buy", "sell"]), size, order }),
  cooldown: z.enum(COOLDOWNS).optional(),
});

export const ruleSetSchema = z.strictObject({
  version: z.literal(1, "BAD_VERSION"),
  name: z.string().regex(NAME_RE, "BAD_NAME"),
  pairs: z.array(z.string().regex(PAIR_RE, "BAD_PAIR")).min(1, "NO_PAIRS").max(MAX_PAIRS, "TOO_MANY_PAIRS"),
  limits: z.strictObject({
    max_position_usdc: dec,
    max_order_usdc: dec,
    daily_loss_stop_usdc: dec,
    max_orders_per_day: z
      .number()
      .int("MAX_ORDERS_RANGE")
      .min(1, "MAX_ORDERS_RANGE")
      .max(MAX_ORDERS_PER_DAY_CAP, "MAX_ORDERS_RANGE"),
  }),
  rules: z.array(rule).min(1, "NO_RULES").max(MAX_RULES, "TOO_MANY_RULES"),
});

// The schema output must stay assignable to the hand-written interface (and vice versa for the fields we read).
type Inferred = z.infer<typeof ruleSetSchema>;
export type SchemaMatchesInterface = Inferred extends RuleSetV1 ? true : never;

const pathString = (p: readonly PropertyKey[]) => p.map(String).join(".");

/** Every code `parseRuleSet` / `validate` can emit. Kept in one place so the vectors file can be checked against it. */
export const ISSUE_CODES = [
  // structural (zod)
  "SCHEMA",
  "UNKNOWN_KEY",
  "BAD_VERSION",
  "BAD_NAME",
  "BAD_PAIR",
  "BAD_RULE_ID",
  "BAD_DECIMAL",
  "BAD_SIGNED_DECIMAL",
  "NO_PAIRS",
  "TOO_MANY_PAIRS",
  "NO_RULES",
  "TOO_MANY_RULES",
  "MAX_ORDERS_RANGE",
  // cross-field (static)
  "NAME_WHITESPACE",
  "DUPLICATE_PAIR",
  "DUPLICATE_RULE_ID",
  "RULE_PAIR_NOT_LISTED",
  "COOLDOWN_REQUIRED",
  "COOLDOWN_NOT_ALLOWED",
  "POSITION_PCT_ON_BUY",
  "POSITION_PCT_RANGE",
  "OFFSET_RANGE",
  "PRICE_NOT_POSITIVE",
  "PCT_BELOW_MINUS_100",
  "MAX_ORDER_BELOW_MIN",
  "LOSS_STOP_NOT_POSITIVE",
  "MAX_POSITION_NOT_POSITIVE",
  "RULE_SIZE_BELOW_MIN",
  "RULE_SIZE_ABOVE_MAX_ORDER",
  // against hard limits / market data (validate.ts)
  "LIMIT_MAX_POSITION",
  "LIMIT_MAX_ORDER",
  "LIMIT_DAILY_LOSS",
  "LIMIT_MAX_ORDERS",
  "PAIR_NOT_ALLOWED",
  "PAIR_UNKNOWN",
  "PAIR_PERP",
  "PAIR_LOW_VOLUME",
  /** Warning only. */
  "SIZE_NEAR_HL_MINIMUM",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];
const KNOWN = new Set<string>(ISSUE_CODES);

export const issue = (code: IssueCode, path: string, message: string): ValidationIssue => ({ code, path, message });

/** Static cross-field rules that do not depend on env or market data. Input is structurally valid. */
export function crossCheck(rs: RuleSetV1): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (rs.name.trim() !== rs.name) out.push(issue("NAME_WHITESPACE", "name", "name must not start or end with whitespace"));

  const seenPairs = new Set<string>();
  rs.pairs.forEach((p, i) => {
    if (seenPairs.has(p)) out.push(issue("DUPLICATE_PAIR", `pairs.${i}`, `pair ${p} is listed twice`));
    seenPairs.add(p);
  });

  const maxOrder = toMicro(rs.limits.max_order_usdc);
  if (maxOrder < HL_MIN_ORDER_MICRO)
    out.push(issue("MAX_ORDER_BELOW_MIN", "limits.max_order_usdc", "max_order_usdc must be at least 10 (Hyperliquid minimum order)"));
  if (toMicro(rs.limits.daily_loss_stop_usdc) <= 0n)
    out.push(issue("LOSS_STOP_NOT_POSITIVE", "limits.daily_loss_stop_usdc", "daily_loss_stop_usdc must be greater than 0"));
  if (toMicro(rs.limits.max_position_usdc) <= 0n)
    out.push(issue("MAX_POSITION_NOT_POSITIVE", "limits.max_position_usdc", "max_position_usdc must be greater than 0"));

  const seenIds = new Set<string>();
  rs.rules.forEach((r, i) => {
    const at = `rules.${i}`;
    if (seenIds.has(r.id)) out.push(issue("DUPLICATE_RULE_ID", `${at}.id`, `rule id ${r.id} is used twice`));
    seenIds.add(r.id);
    if (!seenPairs.has(r.pair)) out.push(issue("RULE_PAIR_NOT_LISTED", `${at}.pair`, `rule pair ${r.pair} is not in pairs`));

    if (r.when.type === "interval") {
      if (r.cooldown !== undefined)
        out.push(issue("COOLDOWN_NOT_ALLOWED", `${at}.cooldown`, "interval rules use `every` as the cooldown; omit cooldown"));
    } else if (r.cooldown === undefined) {
      out.push(issue("COOLDOWN_REQUIRED", `${at}.cooldown`, "cooldown is required unless the trigger is an interval"));
    }

    if (r.when.type === "price" && toMicro(r.when.usdc) <= 0n)
      out.push(issue("PRICE_NOT_POSITIVE", `${at}.when.usdc`, "price must be greater than 0"));
    if ((r.when.type === "price_change" || r.when.type === "position_pnl") && toMicro(r.when.pct) < -100_000_000n)
      out.push(issue("PCT_BELOW_MINUS_100", `${at}.when.pct`, "a change below -100% is impossible"));

    const a = r.action;
    if ("position_pct" in a.size) {
      if (a.side === "buy") out.push(issue("POSITION_PCT_ON_BUY", `${at}.action.size`, "position_pct is allowed for sell only"));
      const v = toMicro(a.size.position_pct);
      if (v < 1_000_000n || v > 100_000_000n)
        out.push(issue("POSITION_PCT_RANGE", `${at}.action.size.position_pct`, "position_pct must be between 1 and 100"));
    } else {
      const v = toMicro(a.size.usdc);
      if (v < HL_MIN_ORDER_MICRO)
        out.push(issue("RULE_SIZE_BELOW_MIN", `${at}.action.size.usdc`, "order size must be at least 10 USDC (Hyperliquid minimum)"));
      if (v > maxOrder)
        out.push(issue("RULE_SIZE_ABOVE_MAX_ORDER", `${at}.action.size.usdc`, "order size is above limits.max_order_usdc, so the rule could never fire"));
    }
    if (a.order.type === "limit" && toMicro(a.order.offset_pct) > 10_000_000n)
      out.push(issue("OFFSET_RANGE", `${at}.action.order.offset_pct`, "offset_pct must be between 0 and 10"));
  });
  return out;
}

export type ParseResult = { ok: true; value: RuleSetV1; issues: [] } | { ok: false; issues: ValidationIssue[] };

/** Structural parse + static cross-field checks. Never throws. */
export function parseRuleSet(input: unknown): ParseResult {
  const r = ruleSetSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i): ValidationIssue => {
      const code = i.code === "unrecognized_keys" ? "UNKNOWN_KEY" : KNOWN.has(i.message) ? (i.message as IssueCode) : "SCHEMA";
      return { code, path: pathString(i.path), message: code === "SCHEMA" || code === "UNKNOWN_KEY" ? i.message : `${code} at ${pathString(i.path) || "root"}` };
    });
    return { ok: false, issues };
  }
  const cross = crossCheck(r.data);
  return cross.length > 0 ? { ok: false, issues: cross } : { ok: true, value: r.data, issues: [] };
}
