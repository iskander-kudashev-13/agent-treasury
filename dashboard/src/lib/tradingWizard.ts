// Pure helpers of the "new trading strategy" wizard (`/trading/new`): rule templates with fields -> `Rule`, limits form ->
// `RuleLimits`, and assembling the `RuleSetV1` the owner signs. No React, no network. The worker re-validates everything
// (hard limits, pairs, market data); these checks only keep the form honest before the wallet is asked.
import { t } from "@/i18n";
import { makeBotId } from "@/features/assistant/botTarget";
import { friendlyAiError } from "./assistantClient";
import { TradingHttpError } from "./tradingClient";
import { MIN_ORDER_USDC, type HardLimits } from "./tradingGuide";
import { toMicro, type Cooldown, type Every, type Rule, type RuleLimits, type RuleSetV1, type Window } from "./tradingRules";

export const MAX_RULES = 5;
export const MAX_NAME = 60;
/** "Limit loss" has no cooldown field (it sells; the worker requires one for every non-interval rule). */
export const SL_COOLDOWN: Cooldown = "1h";

/* ───────────── numbers typed by the owner ───────────── */

const DEC_RE = /^\d+(\.\d{1,6})?$/;
const PCT_RE = /^\d+(\.\d{1,2})?$/;

/** Trim, accept a comma as the decimal separator, drop leading zeros ("012" -> "12"). The result may still be invalid. */
export function normNumber(s: string): string {
  const v = s.trim().replace(",", ".");
  return v.replace(/^0+(?=\d)/, "");
}

export type Issue = { code: "required" | "number" | "invalid" | "min" | "max" | "aboveOrder"; n?: number };

const num = (s: string): number => Number(s);
function checkAmount(raw: string, min: number, max: number | null, pct = false): Issue | null {
  const v = normNumber(raw);
  if (v === "") return { code: "required" };
  if (!(pct ? PCT_RE : DEC_RE).test(v)) return { code: "number" };
  if (num(v) < min) return { code: "min", n: min };
  if (max !== null && num(v) > max) return { code: "max", n: max };
  return null;
}

/** One short line per issue, in the current language. */
export function issueMessage(i: Issue): string {
  switch (i.code) {
    case "required":
      return t("trading.wiz.err.required");
    case "number":
      return t("trading.wiz.err.number");
    case "invalid":
      return t("trading.wiz.err.invalid");
    case "min":
      return t("trading.wiz.err.min", { n: i.n ?? 0 });
    case "max":
      return t("trading.wiz.err.max", { n: i.n ?? 0 });
    case "aboveOrder":
      return t("trading.wiz.err.aboveOrder", { n: i.n ?? 0 });
  }
}

/* ───────────── templates ───────────── */

export const WIZ_TEMPLATES = ["dca", "dip", "tp", "sl"] as const;
export type WizTemplate = (typeof WIZ_TEMPLATES)[number];

export type TemplateFields =
  | { kind: "dca"; usdc: string; every: Every }
  | { kind: "dip"; dropPct: string; window: Window; usdc: string; cooldown: Cooldown }
  | { kind: "tp"; upPct: string; sellPct: string; cooldown: Cooldown }
  | { kind: "sl"; downPct: string; sellPct: string };

/** A sensible buy inside the order cap: 12 USDC when it fits, never under the Hyperliquid minimum (the field shows the error then). */
export const defaultBuy = (maxOrder: number): string => String(Math.max(MIN_ORDER_USDC, Math.min(12, Math.floor(maxOrder))));

export function defaultFields(kind: WizTemplate, maxOrder: number): TemplateFields {
  switch (kind) {
    case "dca":
      return { kind, usdc: defaultBuy(maxOrder), every: "1d" };
    case "dip":
      return { kind, dropPct: "3", window: "1d", usdc: defaultBuy(maxOrder), cooldown: "1d" };
    case "tp":
      return { kind, upPct: "8", sellPct: "50", cooldown: "1d" };
    case "sl":
      return { kind, downPct: "10", sellPct: "100" };
  }
}

export type FieldIssues = Partial<Record<"usdc" | "dropPct" | "upPct" | "downPct" | "sellPct", Issue>>;

/** Problems per field. `maxOrder`: the max order the owner set (or the hard cap): a buy above it could never fire. */
export function fieldIssues(f: TemplateFields, maxOrder: number): FieldIssues {
  const out: FieldIssues = {};
  const put = (k: keyof FieldIssues, i: Issue | null) => {
    if (i) out[k] = i;
  };
  if (f.kind === "dca" || f.kind === "dip") {
    const i = checkAmount(f.usdc, MIN_ORDER_USDC, null);
    put("usdc", i ?? (num(normNumber(f.usdc)) > maxOrder ? { code: "aboveOrder", n: maxOrder } : null));
  }
  if (f.kind === "dip") put("dropPct", checkAmount(f.dropPct, 0.01, 100, true));
  if (f.kind === "tp") put("upPct", checkAmount(f.upPct, 0.01, 1000, true));
  if (f.kind === "sl") put("downPct", checkAmount(f.downPct, 0.01, 100, true));
  if (f.kind === "tp" || f.kind === "sl") put("sellPct", checkAmount(f.sellPct, 1, 100, true));
  return out;
}

export const fieldsOk = (f: TemplateFields, maxOrder: number): boolean => Object.keys(fieldIssues(f, maxOrder)).length === 0;

/** The template as a v1 rule (market IOC orders only). Null while a field is invalid. Checked against `parseRuleSet` in tests. */
export function buildRule(f: TemplateFields, pair: string, id: string, maxOrder: number): Rule | null {
  if (!fieldsOk(f, maxOrder)) return null;
  const order = { type: "ioc" as const };
  switch (f.kind) {
    case "dca":
      return { id, pair, when: { type: "interval", every: f.every }, action: { side: "buy", size: { usdc: normNumber(f.usdc) }, order } };
    case "dip":
      return { id, pair, when: { type: "price_change", window: f.window, op: "lte", pct: `-${normNumber(f.dropPct)}` }, action: { side: "buy", size: { usdc: normNumber(f.usdc) }, order }, cooldown: f.cooldown };
    case "tp":
      return { id, pair, when: { type: "position_pnl", op: "gte", pct: normNumber(f.upPct) }, action: { side: "sell", size: { position_pct: normNumber(f.sellPct) }, order }, cooldown: f.cooldown };
    case "sl":
      return { id, pair, when: { type: "position_pnl", op: "lte", pct: `-${normNumber(f.downPct)}` }, action: { side: "sell", size: { position_pct: normNumber(f.sellPct) }, order }, cooldown: SL_COOLDOWN };
  }
}

/* ───────────── the rule list ───────────── */

export interface DraftRule {
  rule: Rule;
  /** The template fields it was built from; null for rules the AI wrote (they can be removed, not edited). */
  fields: TemplateFields | null;
}

const ID_PREFIX: Record<WizTemplate | "ai", string> = { dca: "buy", dip: "dip", tp: "profit", sl: "loss", ai: "ai" };
const RULE_ID_RE = /^[a-z0-9-]{1,16}$/;

/** "dip-1", "dip-2" ...: short, unique among `taken`, matching the rule id format. */
export function nextRuleId(kind: WizTemplate | "ai", taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; n < 1000; n++) {
    const id = `${ID_PREFIX[kind]}-${n}`;
    if (!used.has(id) && RULE_ID_RE.test(id)) return id;
  }
  return `r-${Date.now().toString(36).slice(-8)}`;
}

/**
 * Rules from the AI (`/trading/rules/propose`) appended to the list: the wizard owns name, pair and limits, so only `rules[]` is
 * used, each rule gets a fresh unique id and the wizard's pair. At most MAX_RULES in total; `dropped` says how many did not fit.
 */
export function appendAiRules(list: readonly DraftRule[], incoming: readonly Rule[], pair: string): { list: DraftRule[]; dropped: number } {
  const out = [...list];
  let dropped = 0;
  for (const r of incoming) {
    if (out.length >= MAX_RULES) {
      dropped += 1;
      continue;
    }
    const id = nextRuleId("ai", out.map((d) => d.rule.id));
    out.push({ rule: { ...r, id, pair }, fields: null });
  }
  return { list: out, dropped };
}

/** Buy rules whose fixed USDC size is above the max order (they could never fire; `parseRuleSet` refuses them). */
export function oversizedBuys(list: readonly DraftRule[], maxOrder: string): string[] {
  if (!DEC_RE.test(maxOrder)) return [];
  const cap = toMicro(maxOrder);
  return list.flatMap((d) => {
    const s = d.rule.action.size;
    return "usdc" in s && DEC_RE.test(s.usdc) && toMicro(s.usdc) > cap ? [d.rule.id] : [];
  });
}

/* ───────────── limits ───────────── */

export interface LimitsForm {
  maxPosition: string;
  maxOrder: string;
  lossStop: string;
  maxOrders: string;
}

/** Prefilled from the worker's hard limits (rounded down, so they never exceed them). */
export function defaultLimits(h: HardLimits): LimitsForm {
  return { maxPosition: String(Math.floor(h.maxPosition)), maxOrder: String(Math.floor(h.maxOrder)), lossStop: String(Math.max(1, Math.floor(h.lossStop))), maxOrders: String(Math.max(1, Math.min(50, Math.floor(h.maxOrders)))) };
}

export type LimitIssues = Partial<Record<keyof LimitsForm, Issue>>;

export function limitIssues(f: LimitsForm, h: HardLimits): LimitIssues {
  const out: LimitIssues = {};
  const put = (k: keyof LimitsForm, i: Issue | null) => {
    if (i) out[k] = i;
  };
  put("maxPosition", checkAmount(f.maxPosition, 1, h.maxPosition));
  put("maxOrder", checkAmount(f.maxOrder, MIN_ORDER_USDC, h.maxOrder));
  put("lossStop", checkAmount(f.lossStop, 1, h.lossStop));
  const n = f.maxOrders.trim();
  if (n === "") out.maxOrders = { code: "required" };
  else if (!/^\d+$/.test(n)) out.maxOrders = { code: "number" };
  else if (Number(n) < 1) out.maxOrders = { code: "min", n: 1 };
  else if (Number(n) > Math.min(50, h.maxOrders)) out.maxOrders = { code: "max", n: Math.min(50, h.maxOrders) };
  return out;
}

export const toRuleLimits = (f: LimitsForm): RuleLimits => ({
  max_position_usdc: normNumber(f.maxPosition),
  max_order_usdc: normNumber(f.maxOrder),
  daily_loss_stop_usdc: normNumber(f.lossStop),
  max_orders_per_day: Number(f.maxOrders.trim()),
});

/** The rule set to sign. Every rule trades the wizard's pair. */
export function assembleRuleSet(p: { name: string; pair: string; limits: LimitsForm; rules: readonly DraftRule[] }): RuleSetV1 {
  return { version: 1, name: p.name.trim(), pairs: [p.pair], limits: toRuleLimits(p.limits), rules: p.rules.map((d) => ({ ...d.rule, pair: p.pair })) };
}

/* ───────────── name and pair ───────────── */

const NAME_RE = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,60}$/u;
export function nameIssue(name: string): Issue | null {
  const v = name.trim();
  if (v === "") return { code: "required" };
  if (!NAME_RE.test(v)) return { code: "invalid" };
  return null;
}

const PAIR_RE = /^[A-Za-z0-9]{1,16}\/USDC$/;
/** Pairs the owner can pick: the one `pickPair` suggests first, then pairs other strategies already trade. */
export function pairOptions(suggested: string, botPairs: readonly string[]): string[] {
  return [...new Set([suggested, ...botPairs])].filter((p) => PAIR_RE.test(p));
}

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "e", є: "ye", ж: "zh", з: "z", и: "i", і: "i", ї: "yi", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
/** Cyrillic -> Latin, so "Покупка на просадке" becomes the id "pokupka-na-pr" rather than "bot". */
export const transliterate = (s: string): string => [...s.toLowerCase()].map((c) => CYR[c] ?? c).join("");

/** A new, unused bot id for the strategy name (see `makeBotId`). */
export const newBotId = (name: string, taken: readonly string[]): string => makeBotId(transliterate(name.trim()), taken);

/* ───────────── worker errors in plain words ───────────── */

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `/trading/rules/propose` failures. The model's own text (NO_PROPOSAL) is untrusted and not shown. */
export function proposeErrorText(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") return t("ac.errTimeout");
  if (!(e instanceof TradingHttpError)) return errMsg(e);
  switch (e.code) {
    case "NO_PROPOSAL":
      return t("trading.wiz.ai.noRules");
    case "RATE_LIMITED":
      return t("trading.wiz.err.busy");
    case "AI_NOT_CONFIGURED":
      return t("ac.errNotConfigured");
    case "AI_ERROR":
      return friendlyAiError(e.message);
    default:
      return e.message;
  }
}

/** Challenge / confirm failures (the local checks of `confirmTradingRules` already throw plain sentences). */
export function signErrorText(e: unknown): string {
  if (!(e instanceof TradingHttpError)) return errMsg(e);
  switch (e.code) {
    case "MAX_BOTS":
      return t("trading.wiz.err.maxBots");
    case "RULES_USED_BY_OTHER_BOT":
      return t("trading.wiz.err.sameRules");
    case "RULES_INVALID":
      return t("trading.wiz.err.rulesRefused");
    case "RATE_LIMITED":
    case "TOO_MANY_CHALLENGES":
      return t("trading.wiz.err.busy");
    case "KILLED_SINCE_CHALLENGE":
      return t("as.rulesStopped");
    default:
      return e.message;
  }
}
