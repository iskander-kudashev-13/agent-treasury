/**
 * ADR-0007 engine path: an AI agent's intent goes through the same `attempt()` as a DSL rule, after every account gate of the
 * same tick. Real engine + FakeHl; no money moves.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { DAY_MS, utcDayIndex } from "../../src/trading/engine/pnl.js";
import { type ActiveRules, type BotInput, type EngineState, type TickConfig, type TickInput, type TickResult, type VaultView, haltBot, initialEngineState, runTick } from "../../src/trading/engine/tick.js";
import { FakeHl, HYPE_PAIR } from "../../src/trading/hl/fake.js";
import { FillsTruncatedError } from "../../src/trading/hl/pagination.js";
import type { AgentIntent, HardLimits, RuleLimits, RuleSetV1 } from "../../src/trading/types.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";
const HASH_AG = "ab".repeat(32);
const HASH_DSL = "cd".repeat(32);
const PRE_AG = cloidPrefix(HASH_AG);
const PRE_DSL = cloidPrefix(HASH_DSL);
const PURR = { name: "PURR/USDC", base: "PURR", assetId: 10000, szDecimals: 0, volume24hUsdc: "2000000", midUsdc: "0.2" };

const vaultOk: VaultView = { vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: null };
const limits = (o: Partial<RuleLimits> = {}): RuleLimits => ({ max_position_usdc: "25", max_order_usdc: "12", daily_loss_stop_usdc: "3", max_orders_per_day: 6, ...o });
const mandate = (o: Partial<RuleLimits> = {}, pairs = ["HYPE/USDC"]): ActiveRules => ({
  hash: HASH_AG,
  confirmedAtMs: T0 - 3_600_000,
  rules: { version: 1, mode: "agent", name: "agent", pairs, limits: limits(o), rules: [] } satisfies RuleSetV1,
});
const dsl = (): ActiveRules => ({
  hash: HASH_DSL,
  confirmedAtMs: T0 - 3_600_000,
  rules: {
    version: 1,
    name: "dca",
    pairs: ["HYPE/USDC"],
    limits: limits({ max_position_usdc: "50", max_order_usdc: "20", daily_loss_stop_usdc: "8", max_orders_per_day: 10 }),
    rules: [{ id: "dca", pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } }],
  },
});
const agentBot = (rules: ActiveRules | null = mandate()): BotInput => ({ id: "ag", createdAtMs: 0, archived: false, prefixes: [PRE_AG], rules });
const dslBot = (): BotInput => ({ id: "dsl", createdAtMs: 0, archived: false, prefixes: [PRE_DSL], rules: dsl() });
const buy = (usdc: string, pair = "HYPE/USDC"): AgentIntent => ({ pair, side: "buy", size: { usdc } });
const sell = (size: AgentIntent["size"], pair = "HYPE/USDC"): AgentIntent => ({ pair, side: "sell", size });

let hl: FakeHl;
let clock: { t: number };
let hard: HardLimits;
let cfg: TickConfig;

beforeEach(() => {
  clock = { t: T0 };
  hl = new FakeHl({ now: () => clock.t, pairs: [HYPE_PAIR, PURR] });
  hl.account = ACCOUNT;
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent-treasury", validUntilMs: null }]);
  hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  hard = { maxPositionUsdc: "50", maxOrderUsdc: "20", dailyLossUsdc: "10", maxOrdersPerDay: 20, allowedPairs: ["HYPE/USDC", "PURR/USDC"], minPairVolumeUsdc: "1000000", priceBandBps: 100, agentMaxOrdersPerDay: 10 };
  cfg = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 10 * DAY_MS };
});

async function tick(now: number, bots: BotInput[], state: EngineState = initialEngineState(), agent?: TickInput["agent"], deps: Partial<Parameters<typeof runTick>[0]> = {}): Promise<TickResult> {
  clock.t = now;
  return runTick({ hl, vault: () => Promise.resolve(vaultOk), config: { ...cfg, hard }, ...deps }, { nowMs: now, bots, state, ...(agent ? { agent } : {}) });
}
const ag = (intent: AgentIntent, note: string | null = "why"): TickInput["agent"] => ({ botId: "ag", intent, note });
const code = (r: TickResult): string | undefined => (r.agent && !r.agent.placed ? r.agent.code : undefined);

describe("agent tick: orders go through attempt()", () => {
  it("a buy within the limits fills; counters +1 on the bot and the account, once; the fill is attributed with the note", async () => {
    const r = await tick(T0, [agentBot()], undefined, ag(buy("12"), "dip looks good"));
    expect(r.agent?.placed).toBe(true);
    expect(hl.placed).toHaveLength(1);
    expect(hl.placed[0]?.cloid.startsWith(PRE_AG)).toBe(true);
    expect(hl.placed[0]?.tif).toBe("Ioc");
    expect(r.state.bots["ag"]?.ordersToday).toBe(1);
    expect(r.state.account.ordersToday).toBe(1);
    const order = r.entries.find((e) => e.kind === "order");
    expect(order).toMatchObject({ bot_id: "ag", rule_id: "agent", source: "agent", note: "dip looks good" });
    // The following scheduled tick re-counts nothing, places nothing (no rules) and attributes the fill with the note.
    const r2 = await tick(T0 + 60_000, [agentBot()], r.state);
    expect(hl.placed).toHaveLength(1);
    expect(r2.state.bots["ag"]?.ordersToday).toBe(1);
    expect(r2.state.account.ordersToday).toBe(1);
    expect(r2.attributed).toHaveLength(1);
    expect(r2.attributed[0]).toMatchObject({ botId: "ag", ruleId: "agent", note: "dip looks good" });
    expect(r2.agent).toBeUndefined();
  });

  it("oversized: MAX_ORDER, no HL order, counters unchanged", async () => {
    const r = await tick(T0, [agentBot()], undefined, ag(buy("100")));
    expect(code(r)).toBe("MAX_ORDER");
    expect(hl.placed).toHaveLength(0);
    expect(r.state.bots["ag"]?.ordersToday).toBe(0);
    expect(r.state.account.ordersToday).toBe(0);
    expect(r.entries.find((e) => e.kind === "skip")).toMatchObject({ source: "agent", code: "MAX_ORDER", note: "why" });
  });

  it("a pair outside the mandate: PAIR_NOT_IN_RULES; a pair outside TRADING_ALLOWED_PAIRS: PAIR_NOT_ALLOWED", async () => {
    const r = await tick(T0, [agentBot(mandate({}, ["PURR/USDC"]))], undefined, ag(buy("12", "HYPE/USDC")));
    expect(code(r)).toBe("PAIR_NOT_IN_RULES");
    hard.allowedPairs = ["PURR/USDC"];
    const r2 = await tick(T0 + 60_000, [agentBot(mandate({}, ["PURR/USDC"]))], r.state, ag(buy("12", "HYPE/USDC")));
    expect(code(r2)).toBe("PAIR_NOT_ALLOWED");
    expect(hl.placed).toHaveLength(0);
  });

  it("sells only its own coins: INSUFFICIENT_BOT_BASE while the account holds coins by hand; position_pct 100 sells exactly its own size", async () => {
    hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "0.2", hold: "0" }]);
    const r = await tick(T0, [agentBot()], undefined, ag(sell({ usdc: "12" })));
    expect(code(r)).toBe("INSUFFICIENT_BOT_BASE");
    expect(hl.placed).toHaveLength(0);
    const r2 = await tick(T0 + 60_000, [agentBot()], r.state, ag(buy("12")));
    expect(r2.agent?.placed).toBe(true);
    const bought = hl.placed[0]?.size;
    const r3 = await tick(T0 + 120_000, [agentBot()], r2.state, ag(sell({ position_pct: "100" })));
    expect(r3.agent?.placed).toBe(true);
    expect(hl.placed[1]?.isBuy).toBe(false);
    expect(hl.placed[1]?.size).toBe(bought);
  });

  it("incomplete history: BOT_POSITION_UNKNOWN on a sell", async () => {
    const r = await tick(T0, [agentBot()]);
    const st = structuredClone(r.state);
    (st.bots["ag"] as NonNullable<typeof st.bots["ag"]>).agg.totalComplete = false;
    const r2 = await tick(T0 + 60_000, [agentBot()], st, ag(sell({ position_pct: "50" })));
    expect(code(r2)).toBe("BOT_POSITION_UNKNOWN");
    expect(hl.placed).toHaveLength(0);
  });

  it("the bot's loss stop: DAILY_LOSS_STOP (alone: the tick reports it; next to a live bot: the agent branch does)", async () => {
    const r = await tick(T0, [agentBot()]);
    const st = structuredClone(r.state);
    const b = st.bots["ag"] as NonNullable<typeof st.bots["ag"]>;
    b.stoppedDayIndex = utcDayIndex(T0);
    b.stopReason = "DAILY_LOSS_STOP";
    const alone = await tick(T0 + 60_000, [agentBot()], structuredClone(st), ag(buy("12")));
    expect(alone.agent).toBeUndefined();
    expect(alone.status.state_reason).toBe("DAILY_LOSS_STOP");
    const withDsl = await tick(T0 + 60_000, [agentBot(), dslBot()], structuredClone(st), ag(buy("12")));
    expect(code(withDsl)).toBe("DAILY_LOSS_STOP");
    expect(hl.placed.filter((o) => o.cloid.startsWith(PRE_AG))).toHaveLength(0);
  });

  it("account gates end the tick before step 7: paused vault, FILLS_TRUNCATED, account loss stop; no HL order", async () => {
    const paused = await tick(T0, [agentBot()], undefined, ag(buy("12")), { vault: () => Promise.resolve({ ...vaultOk, vaultPaused: true }) });
    expect(paused.agent).toBeUndefined();
    expect(paused.status.state_reason).toBe("VAULT_PAUSED");
    const origFills = hl.getUserFills.bind(hl);
    hl.getUserFills = () => Promise.reject(new FillsTruncatedError("10000 rows"));
    const trunc = await tick(T0, [agentBot()], undefined, ag(buy("12")));
    expect(trunc.agent).toBeUndefined();
    expect(trunc.status.state_reason).toBe("FILLS_TRUNCATED");
    hl.getUserFills = origFills;
    const ok = await tick(T0, [agentBot()]);
    const st = structuredClone(ok.state);
    st.account.stoppedDayIndex = utcDayIndex(T0);
    st.account.stopReason = "ACCOUNT_LOSS_STOP";
    const stopped = await tick(T0 + 60_000, [agentBot()], st, ag(buy("12")));
    expect(stopped.agent).toBeUndefined();
    expect(stopped.status.state_reason).toBe("ACCOUNT_LOSS_STOP");
    expect(hl.placed).toHaveLength(0);
  });

  it("IOC-only (dead-man volume gate) still places agent orders", async () => {
    hl.scheduleCancelError = new Error("Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.");
    const r = await tick(T0, [agentBot()], undefined, ag(buy("12")));
    expect(r.status.dead_man.available).toBe(false);
    expect(r.agent?.placed).toBe(true);
    expect(hl.placed).toHaveLength(1);
  });

  it("DSL bots are not evaluated in an agent tick; a scheduled tick places nothing for an agent bot", async () => {
    const r = await tick(T0, [dslBot(), agentBot()], undefined, ag(buy("12")));
    expect(hl.placed.map((o) => o.cloid.slice(0, 18))).toEqual([PRE_AG]);
    const r2 = await tick(T0 + 60_000, [dslBot(), agentBot()], r.state);
    expect(hl.placed.map((o) => o.cloid.slice(0, 18))).toEqual([PRE_AG, PRE_DSL]);
    const r3 = await tick(T0 + 120_000, [agentBot()], r2.state);
    expect(hl.placed).toHaveLength(2);
    expect(r3.agent).toBeUndefined();
  });

  it("kill during the agent tick: KILLED, no order", async () => {
    const r = await tick(T0, [agentBot()], undefined, ag(buy("12")), { shouldStop: (id) => id === "ag" });
    expect(code(r)).toBe("KILLED");
    expect(hl.placed).toHaveLength(0);
  });

  it("beforeOrder throws: STATE_WRITE_FAILED, no order, counters rolled back", async () => {
    const r = await tick(T0, [agentBot()], undefined, ag(buy("12")), {
      beforeOrder: () => {
        throw new Error("disk full");
      },
    });
    expect(r.agent).toBeUndefined();
    expect(r.status.state_reason).toBe("STATE_WRITE_FAILED");
    expect(hl.placed).toHaveLength(0);
    expect(r.state.bots["ag"]?.ordersToday).toBe(0);
    expect(r.state.account.ordersToday).toBe(0);
  });

  it("not an agent mandate: NOT_AGENT_BOT; no verified mandate: BOT_NOT_ACTIVE; halted bot: BOT_HALTED", async () => {
    const notAgent = await tick(T0, [{ ...dslBot(), id: "ag" }], undefined, ag(buy("12")));
    expect(code(notAgent)).toBe("NOT_AGENT_BOT");
    const none = await tick(T0, [agentBot(null), dslBot()], undefined, ag(buy("12")));
    expect(code(none)).toBe("BOT_NOT_ACTIVE");
    const base = await tick(T0, [agentBot(), dslBot()]);
    const halted = await tick(T0 + 60_000, [agentBot(), dslBot()], haltBot(base.state, "ag", T0, "KILLED", "stop"), ag(buy("12")));
    expect(code(halted)).toBe("BOT_HALTED");
    expect(hl.placed.filter((o) => o.cloid.startsWith(PRE_AG))).toHaveLength(0);
  });

  it("agent mode caps orders per day at TRADING_AGENT_MAX_ORDERS_PER_DAY", async () => {
    hard.agentMaxOrdersPerDay = 1;
    let r = await tick(T0, [agentBot()], undefined, ag(buy("12")));
    expect(r.agent?.placed).toBe(true);
    r = await tick(T0 + 60_000, [agentBot()], r.state, ag(buy("12")));
    expect(code(r)).toBe("MAX_ORDERS_PER_DAY");
  });

  it("an IOC without liquidity inside the band is placed and counts (unfilled)", async () => {
    hl.orderResults = [{ status: "unfilled" }];
    const r = await tick(T0, [agentBot()], undefined, ag(buy("12")));
    expect(r.agent?.placed).toBe(true);
    expect(r.agent?.placed === true && r.agent.result.status).toBe("unfilled");
    expect(r.state.bots["ag"]?.ordersToday).toBe(1);
  });
});
