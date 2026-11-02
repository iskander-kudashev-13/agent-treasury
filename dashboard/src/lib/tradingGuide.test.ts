import { afterEach, describe, expect, it } from "vitest";
import { setLocaleSilently } from "@/i18n/core";
import type { HlAgent, LogEntry, TradingStatus } from "./tradingClient";
import { apiWalletNameStable, buildExamples, buildTemplates, collapseLog, deriveSteps, describeEvent, DEFAULT_HARD, expiryTooLong, feedLine, fireNow, MAX_WALLET_MS, pickPair, STEP_WALLETS, type StepsInput } from "./tradingGuide";
import { parseRuleSet, type Rule } from "./tradingRules";
import { alwaysSentence, ruleSentence, segsText } from "./tradingSentences";

afterEach(() => setLocaleSilently("en"));

const NOW = 1_800_000_000_000;
const BOT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const status = (o: { approved?: boolean; until?: number | null; equity?: string; rules?: boolean; state?: TradingStatus["state"]; others?: HlAgent[]; vault?: string } = {}): TradingStatus =>
  ({
    enabled: true,
    state: o.state ?? "running",
    hl_network: "testnet",
    hl_account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    api_wallet: { address: BOT, approved: o.approved ?? true, name: null, valid_until_ms: o.until === undefined ? NOW + 47 * 3_600_000 : o.until },
    other_approved_agents: o.others ?? [],
    balances: { usdc_free: "5", usdc_total: "20", equity_usdc: o.equity ?? "25", positions: [{ pair: "PURR/USDC", base: "PURR", size: "3", mid: "0.5", value_usdc: "1.5" }] },
    pnl: {},
    limits: { effective: { max_position_usdc: "50", max_order_usdc: "20", daily_loss_stop_usdc: "10", max_orders_per_day: 20, price_band_bps: 50 }, today: { orders: 0, loss_usdc: "0" }, position_usdc: "0", vault: { status: o.vault ?? "Active" } },
    open_orders: [],
    active_rules: o.rules === false ? null : { hash: "h", name: "n", confirmed_at_ms: 1, confirmed_by: "x" },
    warnings: [],
  }) as unknown as TradingStatus;

const base = (o: Partial<StepsInput> = {}): StepsInput => ({
  workerConfigured: true,
  trader: { status: "Active" },
  onchainAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  formAddress: null,
  status: status(),
  trust: { kind: "ok", account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  hlAgents: null,
  aiEnabled: true,
  nowMs: NOW,
  ...o,
});
const states = (i: StepsInput) => deriveSteps(i).map((s) => s.state);

describe("deriveSteps", () => {
  it("everything done", () => expect(states(base())).toEqual(["done", "done", "done", "done", "done", "done"]));
  it("nothing yet: step 1 is Now, the rest Later", () => expect(states(base({ trader: null, onchainAccount: null, status: null, trust: null }))).toEqual(["now", "later", "later", "later", "later", "later"]));
  it("a typed address finishes step 1, step 2 is Now", () => expect(states(base({ trader: null, onchainAccount: null, formAddress: "0xa", status: null, trust: null })).slice(0, 3)).toEqual(["done", "now", "later"]));
  it("worker unreachable blocks step 3", () => {
    const s = deriveSteps(base({ status: null, trust: null }));
    expect(s[2]).toMatchObject({ state: "blocked", note: "worker_down" });
    expect(s[3]?.state).toBe("later");
  });
  it("bot wallet not approved yet is Now", () => expect(deriveSteps(base({ status: status({ approved: false, rules: false, state: "awaiting_api_wallet" }) }))[2]).toMatchObject({ state: "now", note: null }));
  it("untrusted account blocks step 3", () => expect(deriveSteps(base({ trust: { kind: "mismatch", reported: "a", onchain: "b" } }))[2]).toMatchObject({ state: "blocked", note: "untrusted_account" }));
  it("approved but not listed by Hyperliquid is blocked", () => expect(deriveSteps(base({ hlAgents: [] }))[2]).toMatchObject({ state: "blocked", note: "not_listed" }));
  it("warns on expiry over 48 h and on other wallets", () => {
    expect(deriveSteps(base({ status: status({ until: NOW + 100 * 3_600_000 }) }))[2]).toMatchObject({ state: "done", note: "expiry_long" });
    expect(deriveSteps(base({ hlAgents: [{ address: BOT, name: null, valid_until_ms: null }, { address: "0xcc", name: null, valid_until_ms: null }] }))[2]).toMatchObject({ state: "done", note: "other_wallets" });
  });
  it("unfunded is Now at step 4; paused vault blocks it", () => {
    expect(deriveSteps(base({ status: status({ equity: "2", rules: false, state: "no_rules" }) }))[3]).toMatchObject({ state: "now" });
    expect(deriveSteps(base({ status: status({ equity: "2", rules: false, vault: "Paused" }) }))[3]).toMatchObject({ state: "blocked", note: "vault_paused" });
  });
  it("no rules: step 5 Now, or blocked when the assistant is off", () => {
    const st = status({ rules: false, state: "no_rules" });
    expect(deriveSteps(base({ status: st }))[4]).toMatchObject({ state: "now" });
    expect(deriveSteps(base({ status: st, aiEnabled: false }))[4]).toMatchObject({ state: "blocked", note: "ai_off" });
  });
  it("a state like stopped_today blocks step 6", () => expect(deriveSteps(base({ status: status({ state: "stopped_today" }) }))[5]).toMatchObject({ state: "blocked", note: "stopped_today" }));
  it("halted needs new rules", () => expect(deriveSteps(base({ status: status({ state: "halted" }) }))[4]?.state).not.toBe("done"));
});

describe("valid_until", () => {
  it("expiryTooLong at 48 h", () => {
    expect(expiryTooLong(NOW + MAX_WALLET_MS + 1, NOW)).toBe(true);
    expect(expiryTooLong(NOW + MAX_WALLET_MS, NOW)).toBe(false);
    expect(expiryTooLong(null, NOW)).toBe(false);
  });
  it("name is stable for 10 minutes and under 48 h", () => {
    const n = apiWalletNameStable(NOW);
    const ms = Number(n.replace("agent-treasury valid_until ", ""));
    expect(n.startsWith("agent-treasury valid_until ")).toBe(true);
    expect(ms - NOW).toBeLessThanOrEqual(47 * 3_600_000);
    expect(ms - NOW).toBeGreaterThan(46 * 3_600_000);
    expect(apiWalletNameStable(NOW + 1000)).toBe(apiWalletNameStable(NOW + 1000));
  });
  it("each step names its wallets", () => {
    expect(STEP_WALLETS[3]).toEqual(["evm", "bot"]);
    expect(STEP_WALLETS[2]).toEqual(["near"]);
    expect(STEP_WALLETS[6]).toEqual([]);
  });
});

describe("templates and examples", () => {
  it("use the allowed pair and sizes inside the limits", () => {
    const pair = pickPair({ status: null, network: "testnet" });
    expect(pair).toBe("PURR/USDC");
    const tpl = buildTemplates(pair, DEFAULT_HARD)!;
    expect(tpl.map((x) => x.id)).toEqual(["dca", "dip", "tp", "sl", "combo"]);
    for (const x of tpl) {
      expect(x.prompt).toContain("PURR");
      expect(x.prompt).not.toContain("HYPE");
      for (const m of x.prompt.matchAll(/(\d+) USDC/g)) expect(Number(m[1])).toBeLessThanOrEqual(DEFAULT_HARD.maxPosition);
    }
    expect(tpl[0]!.prompt).toContain("12 USDC");
    expect(buildExamples(pair, DEFAULT_HARD)!.length).toBeGreaterThanOrEqual(6);
  });
  it("clamps to a smaller order cap and refuses a cap under 11", () => {
    expect(buildTemplates("HYPE/USDC", { ...DEFAULT_HARD, maxOrder: 11 })![0]!.prompt).toContain("11 USDC");
    expect(buildTemplates("HYPE/USDC", { ...DEFAULT_HARD, maxOrder: 10 })).toBeNull();
  });
  it("pair preference: allowed, then rules, then holdings, then network", () => {
    expect(pickPair({ allowed: ["A/USDC"], rulesPairs: ["B/USDC"], status: null, network: "mainnet" })).toBe("A/USDC");
    expect(pickPair({ rulesPairs: ["B/USDC"], status: null, network: "mainnet" })).toBe("B/USDC");
    expect(pickPair({ status: status(), network: "mainnet" })).toBe("PURR/USDC");
    expect(pickPair({ status: null, network: "mainnet" })).toBe("HYPE/USDC");
  });
  it("ru and uk templates are translated", () => {
    setLocaleSilently("ru");
    expect(buildTemplates("PURR/USDC", DEFAULT_HARD)![0]!.prompt).toMatch(/Каждый день/);
    setLocaleSilently("uk");
    expect(buildTemplates("PURR/USDC", DEFAULT_HARD)![0]!.prompt).toMatch(/Щодня/);
  });
});

describe("log collapsing", () => {
  const e = (at: number, detail: string, kind: LogEntry["kind"] = "state"): LogEntry => ({ at_ms: at, kind, detail });
  it("folds consecutive identical entries", () => {
    const f = collapseLog([e(30, "no_rules"), e(20, "no_rules"), e(10, "no_rules"), e(5, "halted"), e(1, "no_rules")]);
    expect(f.map((x) => x.count)).toEqual([3, 1, 1]);
    expect(f[0]).toMatchObject({ firstAt: 10 });
    expect(feedLine(f[0]!)).toBe("Waiting for rules ×3");
    expect(feedLine(f[1]!)).toBe("Halted");
  });
  it("describes top-ups and unknown text", () => {
    expect(describeEvent(e(1, "pending_approval: payout 7", "topup"))).toMatch(/waiting for your approval/);
    expect(describeEvent(e(1, "something new", "state"))).toBe("something new");
    expect(describeEvent({ at_ms: 1, kind: "skip", detail: "too big", rule_id: "dip" })).toBe("[dip] Skipped: too big");
    setLocaleSilently("ru");
    expect(feedLine({ entry: e(1, "no_rules"), count: 12, firstAt: 0 })).toBe("Ждёт правил ×12");
  });
});

describe("fireNow", () => {
  const price: Rule = { id: "p", pair: "PURR/USDC", when: { type: "price", op: "lte", usdc: "1" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } }, cooldown: "1d" };
  it("answers interval and price rules only", () => {
    expect(fireNow(price, { "PURR/USDC": "0.5" })).toMatchObject({ kind: "price", fires: true });
    expect(fireNow(price, { "PURR/USDC": "2" })).toMatchObject({ fires: false });
    expect(fireNow(price, {})).toBeNull();
    expect(fireNow({ ...price, when: { type: "interval", every: "1d" } }, {})).toEqual({ kind: "interval" });
    expect(fireNow({ ...price, when: { type: "position_pnl", op: "gte", pct: "8" } }, {})).toBeNull();
  });
});

describe("sentence renderer", () => {
  const set = parseRuleSet({
    version: 1,
    name: "t",
    pairs: ["HYPE/USDC"],
    limits: { max_position_usdc: "40", max_order_usdc: "15", daily_loss_stop_usdc: "5", max_orders_per_day: 4 },
    rules: [
      { id: "dip", pair: "HYPE/USDC", when: { type: "price_change", window: "1d", op: "lte", pct: "-3" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } }, cooldown: "1d" },
      { id: "tp", pair: "HYPE/USDC", when: { type: "position_pnl", op: "gte", pct: "8" }, action: { side: "sell", size: { position_pct: "50" }, order: { type: "ioc" } }, cooldown: "1d" },
      { id: "lim", pair: "HYPE/USDC", when: { type: "interval", every: "4h" }, action: { side: "buy", size: { usdc: "15" }, order: { type: "limit", offset_pct: "2", ttl: "4h" } } },
    ],
  });
  if (!set.ok) throw new Error("fixture");
  const rs = set.rules;
  it("english, numbers in bold", () => {
    const [dip, tp, lim] = rs.rules.map(ruleSentence);
    expect(segsText(dip!)).toBe("When HYPE falls 3% or more over 1 day, buy 12 USDC of HYPE right away. It can fire again no sooner than 1 day later.");
    expect(dip!.filter((s) => s.bold).map((s) => s.text)).toEqual(["3% or more over 1 day", "12 USDC", "1 day"]);
    expect(segsText(tp!)).toContain("position is up 8% or more");
    expect(segsText(tp!)).toContain("sell 50% of the bot's HYPE");
    expect(segsText(lim!)).toBe("Every 4 hours, buy 15 USDC of HYPE as a limit order 2% below the market price, cancelled if not filled in 4 hours. The first run happens when you sign.");
    expect(segsText(alwaysSentence(rs))).toContain("at most 4 orders a day");
  });
  it("russian", () => {
    setLocaleSilently("ru");
    expect(segsText(ruleSentence(rs.rules[0]!))).toBe("Когда HYPE падает на 3% и более за 1 день, купить HYPE на 12 USDC сразу. Сработает снова не раньше, чем через 1 день.");
    expect(segsText(alwaysSentence(rs))).toContain("не больше 4 ордеров в день");
    expect(segsText(ruleSentence(rs.rules[2]!))).toMatch(/^Каждые? /);
  });
  it("ukrainian", () => {
    setLocaleSilently("uk");
    expect(segsText(ruleSentence(rs.rules[0]!))).toBe("Коли HYPE падає на 3% і більше за 1 день, купити HYPE на 12 USDC одразу. Спрацює знову не раніше ніж через 1 день.");
    expect(segsText(alwaysSentence(rs))).toContain("не більше 4 ордерів на день");
  });
  it("rule names cannot inject bold", () => {
    const hostile = { ...rs, name: "**x**" };
    expect(alwaysSentence(hostile).every((s) => !s.text.includes("**x**") || !s.bold)).toBe(true);
  });
});
