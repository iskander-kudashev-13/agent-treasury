// Readable sentences for a rule set: one sentence per rule, numbers in bold (docs/research/trading-ux.md §5.5).
// Deterministic, built from the validated JSON only (never from model text). The flat `describeRules` lines stay as they are:
// the worker produces the same bytes for the shared vectors.
import { getLocale, interpolate, t, template, type MessageKey } from "@/i18n";
import type { Seg } from "./describeMandate";
import type { Cooldown, Every, OrderSpec, Rule, RuleSetV1, Trigger, Ttl, Window } from "./tradingRules";
import { effectiveCooldown } from "./tradingRules";

type Dur = Window | Every | Ttl | Cooldown;
type P = Record<string, string | number>;

/** Split the template at `**` first, substitute after, so untrusted values (rule names) cannot inject bold. */
function segs(key: MessageKey, params: P = {}): Seg[] {
  return template(getLocale(), key, params)
    .split("**")
    .map((piece, i): Seg => ({ text: interpolate(piece, params), ...(i % 2 === 1 ? { bold: true } : {}) }))
    .filter((s) => s.text !== "");
}
const plain = (text: string): Seg[] => [{ text }];
const dur = (ctx: "plain" | "over" | "every" | "after", d: Dur): string => t(`trading.dur.${ctx}.${d}`);
const cap = (s: string): string => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));
const abs = (pct: string): string => (pct.startsWith("-") ? pct.slice(1) : pct);
const sign = (pct: string): string => (pct.startsWith("-") ? pct : `+${pct}`);
const baseOf = (pair: string): string => pair.split("/")[0] ?? pair;

function whenSegs(w: Trigger, base: string): Seg[] {
  switch (w.type) {
    case "interval":
      return segs("trading.sent.when.every", { every: cap(dur("every", w.every)) });
    case "price":
      return segs(w.op === "lte" ? "trading.sent.when.priceLte" : "trading.sent.when.priceGte", { base, usdc: w.usdc });
    case "price_change": {
      const d = dur("over", w.window);
      const neg = w.pct.startsWith("-") && Number(w.pct) !== 0;
      if (w.op === "lte" && neg) return segs("trading.sent.when.fall", { base, pct: abs(w.pct), dur: d });
      if (w.op === "gte" && !w.pct.startsWith("-") && Number(w.pct) !== 0) return segs("trading.sent.when.rise", { base, pct: w.pct, dur: d });
      return segs(w.op === "lte" ? "trading.sent.when.changeLte" : "trading.sent.when.changeGte", { base, pct: sign(w.pct), dur: d });
    }
    case "position_pnl": {
      const neg = w.pct.startsWith("-") && Number(w.pct) !== 0;
      if (w.op === "gte" && !w.pct.startsWith("-") && Number(w.pct) !== 0) return segs("trading.sent.when.up", { base, pct: w.pct });
      if (w.op === "lte" && neg) return segs("trading.sent.when.down", { base, pct: abs(w.pct) });
      return segs(w.op === "lte" ? "trading.sent.when.pnlLte" : "trading.sent.when.pnlGte", { base, pct: sign(w.pct) });
    }
  }
}

function orderSegs(side: "buy" | "sell", o: OrderSpec): Seg[] {
  if (o.type === "ioc") return segs("trading.sent.order.ioc");
  if (o.offset_pct === "0") return segs("trading.sent.order.limitMarket", { dur: dur("after", o.ttl) });
  return segs(side === "buy" ? "trading.sent.order.limitBelow" : "trading.sent.order.limitAbove", { offset: o.offset_pct, dur: dur("after", o.ttl) });
}

/** "When X, do Y [how]." plus the cooldown sentence; the pieces carry `bold` for the numbers. */
export function ruleSentence(r: Rule): Seg[] {
  const base = baseOf(r.pair);
  const a = r.action;
  const buy = a.side === "buy";
  const doSegs =
    "usdc" in a.size
      ? segs(buy ? "trading.sent.do.buyUsdc" : "trading.sent.do.sellUsdc", { usdc: a.size.usdc, base })
      : segs(buy ? "trading.sent.do.buyPct" : "trading.sent.do.sellPct", { pct: a.size.position_pct, base });
  const out: Seg[] = [...whenSegs(r.when, base), ...plain(", "), ...doSegs, ...plain(" "), ...orderSegs(a.side, a.order), ...plain(".")];
  if (r.when.type === "interval") out.push(...plain(" "), ...segs("trading.sent.firstRun"));
  else {
    const cd = effectiveCooldown(r);
    if (cd) out.push(...plain(" "), ...segs("trading.sent.cooldown", { dur: dur("after", cd) }));
  }
  return out;
}

/** The "Always" line: the limits that apply to every rule. */
export function alwaysSentence(rs: RuleSetV1): Seg[] {
  return segs("trading.sent.always", { pairs: rs.pairs.join(", "), pos: rs.limits.max_position_usdc, order: rs.limits.max_order_usdc, loss: rs.limits.daily_loss_stop_usdc, count: rs.limits.max_orders_per_day });
}

export const segsText = (s: Seg[]): string => s.map((x) => x.text).join("");

export interface RuleSentence {
  id: string;
  index: number;
  segs: Seg[];
}
export const ruleSentences = (rs: RuleSetV1): RuleSentence[] => rs.rules.map((r, index) => ({ id: r.id, index: index + 1, segs: ruleSentence(r) }));
