import { afterEach, describe, expect, it } from "vitest";
import { setLocaleSilently } from "@/i18n/core";
import { BOT_ID_RE, parseProposedRules, TradingHttpError } from "./tradingClient";
import { DEFAULT_HARD, MIN_ORDER_USDC } from "./tradingGuide";
import { parseRuleSet, type Rule } from "./tradingRules";
import {
  appendAiRules,
  assembleRuleSet,
  buildRule,
  defaultFields,
  defaultLimits,
  fieldIssues,
  issueMessage,
  limitIssues,
  MAX_RULES,
  nameIssue,
  newBotId,
  nextRuleId,
  normNumber,
  oversizedBuys,
  pairOptions,
  proposeErrorText,
  signErrorText,
  transliterate,
  WIZ_TEMPLATES,
  type DraftRule,
  type TemplateFields,
} from "./tradingWizard";

afterEach(() => setLocaleSilently("en"));

const PAIR = "HYPE/USDC";
const HARD = { maxOrder: 20, maxPosition: 50, lossStop: 10, maxOrders: 20 };
const draft = (f: TemplateFields, id: string): DraftRule => ({ rule: buildRule(f, PAIR, id, HARD.maxOrder)!, fields: f });
const set = (rules: DraftRule[]) => assembleRuleSet({ name: "My strategy", pair: PAIR, limits: defaultLimits(HARD), rules });

describe("templates -> rules", () => {
  it("every template with its default fields builds a rule that parseRuleSet accepts", () => {
    const rules = WIZ_TEMPLATES.map((k) => draft(defaultFields(k, HARD.maxOrder), nextRuleId(k, [])));
    const parsed = parseRuleSet(set(rules));
    expect(parsed).toEqual({ ok: true, rules: set(rules) });
  });

  it("maps each template to the right trigger and action", () => {
    expect(buildRule({ kind: "dca", usdc: "15", every: "1w" }, PAIR, "buy-1", 20)).toEqual({ id: "buy-1", pair: PAIR, when: { type: "interval", every: "1w" }, action: { side: "buy", size: { usdc: "15" }, order: { type: "ioc" } } });
    expect(buildRule({ kind: "dip", dropPct: "3.5", window: "4h", usdc: "12", cooldown: "1d" }, PAIR, "dip-1", 20)).toEqual({
      id: "dip-1",
      pair: PAIR,
      when: { type: "price_change", window: "4h", op: "lte", pct: "-3.5" },
      action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } },
      cooldown: "1d",
    });
    expect(buildRule({ kind: "tp", upPct: "8", sellPct: "50", cooldown: "4h" }, PAIR, "profit-1", 20)).toEqual({
      id: "profit-1",
      pair: PAIR,
      when: { type: "position_pnl", op: "gte", pct: "8" },
      action: { side: "sell", size: { position_pct: "50" }, order: { type: "ioc" } },
      cooldown: "4h",
    });
    const sl = buildRule({ kind: "sl", downPct: "10", sellPct: "100" }, PAIR, "loss-1", 20)!;
    expect(sl.when).toEqual({ type: "position_pnl", op: "lte", pct: "-10" });
    expect(sl.action.size).toEqual({ position_pct: "100" });
    expect(sl.cooldown).toBe("1h"); // required by the DSL for non-interval rules
  });

  it("accepts a comma decimal and leading zeros", () => {
    expect(normNumber(" 012,5 ")).toBe("12.5");
    expect(buildRule({ kind: "dca", usdc: "12,5", every: "1d" }, PAIR, "buy-1", 20)?.action.size).toEqual({ usdc: "12.5" });
  });

  it("refuses invalid fields", () => {
    expect(buildRule({ kind: "dca", usdc: "", every: "1d" }, PAIR, "buy-1", 20)).toBeNull();
    expect(fieldIssues({ kind: "dca", usdc: "", every: "1d" }, 20).usdc?.code).toBe("required");
    expect(fieldIssues({ kind: "dca", usdc: "1e3", every: "1d" }, 20).usdc?.code).toBe("number");
    expect(fieldIssues({ kind: "dca", usdc: "5", every: "1d" }, 20).usdc).toEqual({ code: "min", n: MIN_ORDER_USDC });
    expect(fieldIssues({ kind: "dip", dropPct: "3", window: "1d", usdc: "25", cooldown: "1d" }, 20).usdc).toEqual({ code: "aboveOrder", n: 20 });
    expect(fieldIssues({ kind: "dip", dropPct: "0", window: "1d", usdc: "12", cooldown: "1d" }, 20).dropPct?.code).toBe("min");
    expect(fieldIssues({ kind: "dip", dropPct: "101", window: "1d", usdc: "12", cooldown: "1d" }, 20).dropPct?.code).toBe("max");
    expect(fieldIssues({ kind: "dip", dropPct: "3.333", window: "1d", usdc: "12", cooldown: "1d" }, 20).dropPct?.code).toBe("number");
    expect(fieldIssues({ kind: "tp", upPct: "8", sellPct: "0.5", cooldown: "1d" }, 20).sellPct?.code).toBe("min");
    expect(fieldIssues({ kind: "sl", downPct: "10", sellPct: "150" }, 20).sellPct?.code).toBe("max");
  });

  it("default buy fits the order cap and the Hyperliquid minimum", () => {
    expect(defaultFields("dca", 20)).toMatchObject({ usdc: "12" });
    expect(defaultFields("dca", 11.5)).toMatchObject({ usdc: "11" });
    expect(defaultFields("dip", 5)).toMatchObject({ usdc: String(MIN_ORDER_USDC) });
  });

  it("issue messages are plain words without field names", () => {
    expect(issueMessage({ code: "aboveOrder", n: 20 })).toBe("Above the max per order (20 USDC)");
    setLocaleSilently("ru");
    expect(issueMessage({ code: "min", n: 11 })).toBe("Не меньше 11");
  });
});

describe("rule ids and the list", () => {
  it("rule ids are short, unique and match the DSL format", () => {
    expect(nextRuleId("dip", [])).toBe("dip-1");
    expect(nextRuleId("dip", ["dip-1", "dip-2"])).toBe("dip-3");
    expect(nextRuleId("tp", [])).toMatch(/^[a-z0-9-]{1,16}$/);
  });

  const aiRule = (id: string, pair = "PURR/USDC"): Rule => ({ id, pair, when: { type: "interval", every: "1d" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } });

  it("AI rules get fresh ids and the wizard's pair, up to MAX_RULES", () => {
    const start = [draft(defaultFields("dca", 20), "buy-1")];
    const r = appendAiRules(start, [aiRule("buy-1"), aiRule("x")], PAIR);
    expect(r.list.map((d) => d.rule.id)).toEqual(["buy-1", "ai-1", "ai-2"]);
    expect(r.list.every((d) => d.rule.pair === PAIR)).toBe(true);
    expect(r.list[1]!.fields).toBeNull();
    expect(r.dropped).toBe(0);
    const full = appendAiRules(r.list, [aiRule("a"), aiRule("b"), aiRule("c")], PAIR);
    expect(full.list).toHaveLength(MAX_RULES);
    expect(full.dropped).toBe(1);
    expect(parseRuleSet(set(full.list)).ok).toBe(true);
  });

  it("finds buys above the max order", () => {
    const list = [draft({ kind: "dca", usdc: "18", every: "1d" }, "buy-1"), draft(defaultFields("tp", 20), "profit-1")];
    expect(oversizedBuys(list, "20")).toEqual([]);
    expect(oversizedBuys(list, "15")).toEqual(["buy-1"]);
    expect(parseRuleSet(assembleRuleSet({ name: "x", pair: PAIR, limits: { ...defaultLimits(HARD), maxOrder: "15" }, rules: list }))).toEqual({ ok: false, errors: ["RULE_SIZE_ABOVE_MAX_ORDER"] });
  });

  it("parses proposed rules one by one and drops what does not parse", () => {
    const good = aiRule("r1");
    const bad = { ...aiRule("r2"), extra: 1 };
    const raw = { rules: { version: 1, name: "AI name", pairs: ["PURR/USDC"], limits: { max_position_usdc: "1", max_order_usdc: "1", daily_loss_stop_usdc: "1", max_orders_per_day: 1 }, rules: [good, bad] }, hash: "00", validation: { ok: false, errors: [], warnings: [] }, model: "m" };
    expect(parseProposedRules(raw)).toEqual([good]);
    expect(parseProposedRules(null)).toEqual([]);
  });
});

describe("limits", () => {
  it("prefills from the hard limits, rounded down", () => {
    expect(defaultLimits({ maxOrder: 20.7, maxPosition: 50.2, lossStop: 0.5, maxOrders: 80 })).toEqual({ maxOrder: "20", maxPosition: "50", lossStop: "1", maxOrders: "50" });
    expect(limitIssues(defaultLimits(HARD), HARD)).toEqual({});
    expect(limitIssues(defaultLimits(DEFAULT_HARD), DEFAULT_HARD)).toEqual({});
  });

  it("refuses values above the hard limits or below the minimum", () => {
    const base = defaultLimits(HARD);
    expect(limitIssues({ ...base, maxOrder: "25" }, HARD).maxOrder).toEqual({ code: "max", n: 20 });
    expect(limitIssues({ ...base, maxOrder: "10" }, HARD).maxOrder).toEqual({ code: "min", n: MIN_ORDER_USDC });
    expect(limitIssues({ ...base, maxPosition: "60" }, HARD).maxPosition?.code).toBe("max");
    expect(limitIssues({ ...base, lossStop: "0" }, HARD).lossStop?.code).toBe("min");
    expect(limitIssues({ ...base, maxOrders: "21" }, HARD).maxOrders).toEqual({ code: "max", n: 20 });
    expect(limitIssues({ ...base, maxOrders: "0" }, HARD).maxOrders?.code).toBe("min");
    expect(limitIssues({ ...base, maxOrders: "" }, HARD).maxOrders?.code).toBe("required");
    expect(limitIssues({ ...base, maxPosition: "abc" }, HARD).maxPosition?.code).toBe("number");
  });

  it("assembles limits in the DSL format", () => {
    const rs = assembleRuleSet({ name: "  Daily  ", pair: PAIR, limits: { maxPosition: "40", maxOrder: "15,5", lossStop: "5", maxOrders: "4" }, rules: [draft(defaultFields("dca", 15), "buy-1")] });
    expect(rs.name).toBe("Daily");
    expect(rs.pairs).toEqual([PAIR]);
    expect(rs.limits).toEqual({ max_position_usdc: "40", max_order_usdc: "15.5", daily_loss_stop_usdc: "5", max_orders_per_day: 4 });
    expect(parseRuleSet(rs).ok).toBe(true);
  });
});

describe("name, pair, bot id", () => {
  it("name is required and plain text", () => {
    expect(nameIssue("  ")?.code).toBe("required");
    expect(nameIssue("a\u0007b")?.code).toBe("invalid");
    expect(nameIssue("Покупка HYPE")).toBeNull();
  });

  it("pair options: suggested first, deduped, only valid pairs", () => {
    expect(pairOptions("HYPE/USDC", ["PURR/USDC", "HYPE/USDC", "bad"])).toEqual(["HYPE/USDC", "PURR/USDC"]);
    expect(pairOptions("HYPE/USDC", [])).toEqual(["HYPE/USDC"]);
  });

  it("Cyrillic names become readable bot ids", () => {
    expect(transliterate("Покупка")).toBe("pokupka");
    expect(newBotId("Покупка на просадке", [])).toBe("pokupka-na-p");
    expect(newBotId("Щоденна купівля", [])).toMatch(BOT_ID_RE);
    expect(newBotId("Daily HYPE", ["daily-hype"])).toBe("daily-hype-2");
    expect(newBotId("🚀", [])).toBe("bot");
  });
});

describe("errors", () => {
  it("maps worker codes to plain sentences", () => {
    expect(signErrorText(new TradingHttpError(409, "MAX_BOTS", "At most 3 bots"))).toBe("You already have the most strategies allowed. Archive one first.");
    expect(signErrorText(new TradingHttpError(400, "RULES_INVALID", "Rules rejected: ABOVE_HARD rules[0]"))).not.toContain("ABOVE_HARD");
    expect(signErrorText(new Error("local check"))).toBe("local check");
    expect(proposeErrorText(new TradingHttpError(400, "NO_PROPOSAL", "model text"))).not.toContain("model text");
    expect(proposeErrorText(new TradingHttpError(429, "RATE_LIMITED", "Too many"))).toBe("Busy right now. Try again in a minute.");
  });
});
