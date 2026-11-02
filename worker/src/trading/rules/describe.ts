/**
 * Deterministic English rendering of a rule set (ADR-0005 step 4). Pure function of the JSON: no LLM text ever reaches
 * the owner. The dashboard has its own renderer that must produce the same lines for docs/trading-rules-vectors.json.
 *
 * Output is a flat list of short lines. Numbers and ids are printed exactly as they appear in the JSON.
 */
import type { Cooldown, Every, OrderSpec, Rule, RuleSetV1, Trigger, Ttl, Window } from "../types.js";

const DURATION: Record<Window | Every | Ttl | Cooldown, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
};

const dur = (d: keyof typeof DURATION) => DURATION[d];
const signed = (pct: string) => (pct.startsWith("-") ? pct : `+${pct}`);
const bound = (op: "lte" | "gte") => (op === "lte" ? "at or below" : "at or above");
const baseOf = (pair: string) => pair.split("/")[0] ?? pair;

function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case "price_change":
      return `price change over ${dur(t.window)} is ${bound(t.op)} ${signed(t.pct)}%`;
    case "price":
      return `price is ${bound(t.op)} ${t.usdc} USDC`;
    case "interval":
      return `every ${dur(t.every)} (first run when the rules are activated)`;
    case "position_pnl":
      return `position P&L is ${bound(t.op)} ${signed(t.pct)}% (vs average cost of fills under this rule set; never when flat)`;
  }
}

function describeOrder(side: "buy" | "sell", o: OrderSpec): string {
  if (o.type === "ioc") return "as an immediate-or-cancel limit order at the market price, inside the price band";
  if (o.offset_pct === "0") return `as a limit order at the market price, cancelled after ${dur(o.ttl)}`;
  const dir = side === "buy" ? "below" : "above";
  return `as a limit order ${o.offset_pct}% ${dir} the market price, cancelled after ${dur(o.ttl)}`;
}

/** Cooldown that actually applies: `every` for interval rules. */
export function effectiveCooldown(r: Rule): Cooldown | undefined {
  return r.when.type === "interval" ? r.when.every : r.cooldown;
}

export function describeRule(r: Rule, index: number): string[] {
  const a = r.action;
  const verb = a.side === "buy" ? "Buy" : "Sell";
  const what =
    "usdc" in a.size ? `${verb} ${a.size.usdc} USDC of ${baseOf(r.pair)}` : `${verb} ${a.size.position_pct}% of the ${baseOf(r.pair)} position`;
  const cd = effectiveCooldown(r);
  return [
    `Rule ${index + 1} [${r.id}] on ${r.pair}`,
    `  When: ${describeTrigger(r.when)}`,
    `  Do: ${what} ${describeOrder(a.side, a.order)}`,
    `  Cooldown: ${cd === undefined ? "none" : dur(cd)}`,
  ];
}

export function describe(rs: RuleSetV1): string[] {
  return [
    `Rule set: ${rs.name}`,
    `Pairs: ${rs.pairs.join(", ")}`,
    `Max position: ${rs.limits.max_position_usdc} USDC`,
    `Max order: ${rs.limits.max_order_usdc} USDC`,
    `Daily loss stop: ${rs.limits.daily_loss_stop_usdc} USDC`,
    `Max orders per day: ${rs.limits.max_orders_per_day}`,
    ...rs.rules.flatMap(describeRule),
  ];
}
