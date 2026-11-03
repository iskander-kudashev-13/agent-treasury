/**
 * ADR-0007 coverage gaps (tester pass 2026-11-03), engine level: an agent intent next to a DSL bot on the SAME account.
 *   - orders/day: one counter per order that reaches HL, across DSL and agent ticks; the account cap stops both;
 *   - account TRADING_HARD_* position total with another bot holding a position;
 *   - selling more than its own fills while another bot holds the coin;
 *   - perp alarm / paused_onchain / account halt / archived or refused mandate: no HL order.
 * Real engine + FakeHl; no money moves.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { DAY_MS } from "../../src/trading/engine/pnl.js";
import { type ActiveRules, type BotInput, type EngineState, type TickConfig, type TickInput, type TickResult, type VaultView, haltAll, initialEngineState, runTick } from "../../src/trading/engine/tick.js";
import { FakeHl, HYPE_PAIR } from "../../src/trading/hl/fake.js";
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
const mandate = (o: Partial<RuleLimits> = {}): ActiveRules => ({
  hash: HASH_AG,
  confirmedAtMs: T0 - 3_600_000,
  rules: { version: 1, mode: "agent", name: "agent", pairs: ["HYPE/USDC"], limits: limits(o), rules: [] } satisfies RuleSetV1,
});
/** DSL bot that buys 12 USDC of HYPE every hour. */
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
const agentBot = (o: Partial<BotInput> = {}): BotInput => ({ id: "ag", createdAtMs: 0, archived: false, prefixes: [PRE_AG], rules: mandate(), ...o });
const dslBot = (): BotInput => ({ id: "dsl", createdAtMs: 0, archived: false, prefixes: [PRE_DSL], rules: dsl() });
const buy = (usdc: string): AgentIntent => ({ pair: "HYPE/USDC", side: "buy", size: { usdc } });
const sell = (size: AgentIntent["size"]): AgentIntent => ({ pair: "HYPE/USDC", side: "sell", size });

let hl: FakeHl;
let clock: { t: number };
let hard: HardLimits;
let cfg: TickConfig;
let vault: VaultView;

beforeEach(() => {
  clock = { t: T0 };
  hl = new FakeHl({ now: () => clock.t, pairs: [HYPE_PAIR, PURR] });
  hl.account = ACCOUNT;
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent-treasury", validUntilMs: null }]);
  hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  hard = { maxPositionUsdc: "50", maxOrderUsdc: "20", dailyLossUsdc: "10", maxOrdersPerDay: 20, allowedPairs: ["HYPE/USDC", "PURR/USDC"], minPairVolumeUsdc: "1000000", priceBandBps: 100, agentMaxOrdersPerDay: 10 };
  cfg = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 10 * DAY_MS };
  vault = vaultOk;
});

async function tick(now: number, bots: BotInput[], state: EngineState = initialEngineState(), agent?: TickInput["agent"]): Promise<TickResult> {
  clock.t = now;
  return runTick({ hl, vault: () => Promise.resolve(vault), config: { ...cfg, hard } }, { nowMs: now, bots, state, ...(agent ? { agent } : {}) });
}
const ag = (intent: AgentIntent): TickInput["agent"] => ({ botId: "ag", intent, note: null });
const code = (r: TickResult): string | undefined => (r.agent && !r.agent.placed ? r.agent.code : undefined);
const placedBy = (prefix: string) => hl.placed.filter((o) => o.cloid.startsWith(prefix));
const MIN = 60_000;
const HOUR = 3_600_000;

describe("one account, a DSL bot and an agent bot", () => {
  it("orders/day: every HL order counted exactly once on the account; the account cap stops the agent AND the DSL bot", async () => {
    hard.maxOrdersPerDay = 3;
    // t0: scheduled tick, the DSL rule fires (account 1).
    let r = await tick(T0, [dslBot(), agentBot()]);
    expect(placedBy(PRE_DSL)).toHaveLength(1);
    // agent order (account 2), then an unfilled IOC (counts: account 3).
    r = await tick(T0 + MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(r.agent?.placed).toBe(true);
    hl.orderResults = [{ status: "unfilled" }];
    r = await tick(T0 + 2 * MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(r.agent?.placed).toBe(true);
    expect(r.state.account.ordersToday).toBe(3);
    // Several scheduled ticks in between never re-count.
    for (let i = 3; i < 6; i += 1) r = await tick(T0 + i * MIN, [dslBot(), agentBot()], r.state);
    expect(r.state.account.ordersToday).toBe(3);
    expect(r.state.account.ordersToday).toBe(hl.placed.length);
    // Account cap reached: the agent is refused ACCOUNT_MAX_ORDERS_PER_DAY with its own bot cap (6) still open ...
    r = await tick(T0 + 6 * MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(code(r)).toBe("ACCOUNT_MAX_ORDERS_PER_DAY");
    expect(r.state.bots["ag"]?.ordersToday).toBe(2);
    // ... and the DSL rule, due again an hour later, is refused too.
    r = await tick(T0 + HOUR + 7 * MIN, [dslBot(), agentBot()], r.state);
    expect(hl.placed).toHaveLength(3);
    expect(r.state.account.ordersToday).toBe(3);
    expect(r.state.bots["dsl"]?.ordersToday).toBe(1);
  });

  it("a gate refusal of the agent does not consume the DSL bot's or the account's orders", async () => {
    hard.maxOrdersPerDay = 2;
    let r = await tick(T0, [dslBot(), agentBot()]);
    for (let i = 1; i <= 4; i += 1) {
      r = await tick(T0 + i * MIN, [dslBot(), agentBot()], r.state, ag(buy("100")));
      expect(code(r)).toBe("MAX_ORDER");
    }
    expect(r.state.account.ordersToday).toBe(1);
    r = await tick(T0 + 5 * MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(r.agent?.placed).toBe(true);
    expect(r.state.account.ordersToday).toBe(2);
  });

  it("account position total (TRADING_HARD_MAX_POSITION_USDC): the agent buy is refused ACCOUNT_POSITION_CAP while the DSL bot holds a position", async () => {
    hard.maxPositionUsdc = "20";
    let r = await tick(T0, [dslBot(), agentBot()]); // DSL buys ~11.7 USDC of HYPE
    expect(placedBy(PRE_DSL)).toHaveLength(1);
    r = await tick(T0 + MIN, [dslBot(), agentBot()], r.state); // fold the fill in
    // The agent bot's own cap (25) has room for 12; the account total (20) does not.
    r = await tick(T0 + 2 * MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(code(r)).toBe("ACCOUNT_POSITION_CAP");
    expect(placedBy(PRE_AG)).toHaveLength(0);
    expect(r.state.bots["ag"]?.ordersToday ?? 0).toBe(0);
  });

  it("account order total (TRADING_HARD_MAX_ORDER_USDC) wins over a larger signed max order", async () => {
    hard.maxOrderUsdc = "11";
    const r = await tick(T0, [agentBot()], undefined, ag(buy("12")));
    expect(code(r)).toBe("MAX_ORDER");
    expect(hl.placed).toHaveLength(0);
  });

  it("selling more than its own fills while the DSL bot holds the coin: INSUFFICIENT_BOT_BASE; position_pct 100 sells only its own size", async () => {
    let r = await tick(T0, [dslBot(), agentBot()]); // DSL holds ~0.29 HYPE
    r = await tick(T0 + MIN, [dslBot(), agentBot()], r.state);
    r = await tick(T0 + 2 * MIN, [dslBot(), agentBot()], r.state, ag(sell({ usdc: "11" })));
    expect(code(r)).toBe("INSUFFICIENT_BOT_BASE");
    r = await tick(T0 + 3 * MIN, [dslBot(), agentBot()], r.state, ag(sell({ position_pct: "100" })));
    expect(r.agent?.placed).not.toBe(true);
    expect(placedBy(PRE_AG)).toHaveLength(0);
    // The agent buys its own, then tries to sell twice that.
    r = await tick(T0 + 4 * MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(r.agent?.placed).toBe(true);
    const own = hl.placed.at(-1)?.size as string;
    r = await tick(T0 + 5 * MIN, [dslBot(), agentBot()], r.state);
    r = await tick(T0 + 6 * MIN, [dslBot(), agentBot()], r.state, ag(sell({ usdc: "12" }))); // own value ~11.6 < 12
    expect(code(r)).toBe("INSUFFICIENT_BOT_BASE");
    r = await tick(T0 + 7 * MIN, [dslBot(), agentBot()], r.state, ag(sell({ position_pct: "100" })));
    expect(r.agent?.placed).toBe(true);
    const s = hl.placed.at(-1);
    expect(s?.isBuy).toBe(false);
    expect(s?.size).toBe(own);
    expect(s?.cloid.startsWith(PRE_AG)).toBe(true);
  });
});

describe("states that end the agent tick before step 7: no HL order", () => {
  it("perp alarm: PERP_POSITION_DETECTED halts the account and every bot", async () => {
    hl.setPerp(ACCOUNT, { positions: [], openPerpOrders: 1, accountValueUsdc: "0" });
    const r = await tick(T0, [dslBot(), agentBot()], undefined, ag(buy("12")));
    expect(r.agent).toBeUndefined();
    expect(r.status.state_reason).toBe("PERP_POSITION_DETECTED");
    expect(r.state.account.halt?.reason).toBe("PERP_POSITION_DETECTED");
    expect(r.state.bots["ag"]?.halt).not.toBeNull();
    expect(hl.placed).toHaveLength(0);
    // Perp closed: still halted (only a re-sign clears it).
    hl.setPerp(ACCOUNT, { positions: [], openPerpOrders: 0, accountValueUsdc: "0" });
    const r2 = await tick(T0 + MIN, [dslBot(), agentBot()], r.state, ag(buy("12")));
    expect(r2.agent).toBeUndefined();
    expect(hl.placed).toHaveLength(0);
  });

  it("paused_onchain: VAULT_PAUSED, AGENT_PAUSED, AGENT_REVOKED, AGENT_EXPIRED", async () => {
    for (const [v, reason] of [
      [{ ...vaultOk, vaultPaused: true }, "VAULT_PAUSED"],
      [{ ...vaultOk, status: "Paused" }, "AGENT_PAUSED"],
      [{ ...vaultOk, status: "Revoked" }, "AGENT_REVOKED"],
      [{ ...vaultOk, expiresAtMs: T0 }, "AGENT_EXPIRED"],
    ] as const) {
      vault = v;
      const r = await tick(T0, [agentBot()], undefined, ag(buy("12")));
      expect(r.agent, reason).toBeUndefined();
      expect(r.tradingState).toBe("paused_onchain");
      expect(r.status.state_reason).toBe(reason);
    }
    expect(hl.placed).toHaveLength(0);
  });

  it("kill-all halt in the state: halted KILLED", async () => {
    const base = await tick(T0, [agentBot()]);
    const st = haltAll(base.state, T0, "KILLED", "kill switch", ["ag"]);
    const r = await tick(T0 + MIN, [agentBot()], st, ag(buy("12")));
    expect(r.agent).toBeUndefined();
    expect(r.status.state_reason).toBe("KILLED");
    expect(hl.placed).toHaveLength(0);
  });

  it("archived bot (rules still loaded) and a refused mandate: BOT_NOT_ACTIVE next to a live DSL bot", async () => {
    const a = await tick(T0, [agentBot({ archived: true }), dslBot()], undefined, ag(buy("12")));
    expect(code(a)).toBe("BOT_NOT_ACTIVE");
    const b = await tick(T0 + MIN, [agentBot({ rules: null, refused: true }), dslBot()], a.state, ag(buy("12")));
    expect(code(b)).toBe("BOT_NOT_ACTIVE");
    expect(placedBy(PRE_AG)).toHaveLength(0);
  });

  it("an intent for an unknown bot id: BOT_NOT_ACTIVE, nothing placed for anyone", async () => {
    const r = await tick(T0, [dslBot()], undefined, { botId: "ghost", intent: buy("12"), note: null });
    expect(code(r)).toBe("BOT_NOT_ACTIVE");
    expect(hl.placed).toHaveLength(0);
  });
});
