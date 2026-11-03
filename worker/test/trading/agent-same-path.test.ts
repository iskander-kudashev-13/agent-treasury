/**
 * ADR-0007 test plan 6, "same path": for an equal action, a DSL rule that fires and an AI agent's intent reach the SAME
 * `checkOrder` with identical inputs and get identical verdicts, over a table of market and position cases. `checkOrder` is spied
 * on through the module mock (the real function runs).
 *
 * The only inputs that differ by construction are `cooldownMs` / `lastFiredAtMs`: a DSL rule has a cooldown, an agent order has
 * none (it is rate limited by the worker's per-bot gate instead). Both are compared separately below.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderCandidate, RiskContext } from "../../src/trading/engine/risk.js";

const calls: { o: OrderCandidate; c: RiskContext; ok: boolean; code: string | null }[] = [];
vi.mock("../../src/trading/engine/risk.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/trading/engine/risk.js")>();
  return {
    ...mod,
    checkOrder: (o: OrderCandidate, c: RiskContext) => {
      const r = mod.checkOrder(o, c);
      calls.push({ o: structuredClone(o), c: structuredClone(c), ok: r.ok, code: r.ok ? null : r.code });
      return r;
    },
  };
});

const { cloidPrefix } = await import("../../src/trading/engine/risk.js");
const { DAY_MS } = await import("../../src/trading/engine/pnl.js");
const { initialEngineState, runTick } = await import("../../src/trading/engine/tick.js");
const { FakeHl, HYPE_PAIR } = await import("../../src/trading/hl/fake.js");
type BotInput = import("../../src/trading/engine/tick.js").BotInput;
type EngineState = import("../../src/trading/engine/tick.js").EngineState;
type Action = import("../../src/trading/types.js").Action;
type HardLimits = import("../../src/trading/types.js").HardLimits;
type RuleLimits = import("../../src/trading/types.js").RuleLimits;
type FakeHlT = InstanceType<typeof FakeHl>;

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";
const HASH = "ee".repeat(32);

interface Case {
  name: string;
  action: Action;
  limits?: Partial<RuleLimits>;
  /** Pairs of the rule set / mandate (default HYPE/USDC). */
  pairs?: string[];
  pair?: string;
  setup?: (hl: FakeHlT, hard: HardLimits) => void;
  state?: (s: EngineState, botId: string) => void;
  expectCode: string | null;
}

const ioc = (side: "buy" | "sell", size: Action["size"]): Action => ({ side, size, order: { type: "ioc" } });
const cases: Case[] = [
  { name: "plain buy inside the limits", action: ioc("buy", { usdc: "12" }), expectCode: null },
  { name: "oversized buy", action: ioc("buy", { usdc: "15" }), limits: { max_order_usdc: "12" }, expectCode: "MAX_ORDER" },
  { name: "tight two-sided book around the mid", action: ioc("buy", { usdc: "12" }), setup: (hl) => { hl.setBook("HYPE/USDC", "39.9", "40.1"); }, expectCode: null },
  { name: "spread wider than the band", action: ioc("buy", { usdc: "12" }), setup: (hl) => { hl.setBook("HYPE/USDC", "39", "41"); }, expectCode: "SPREAD_TOO_WIDE" },
  { name: "empty book", action: ioc("buy", { usdc: "12" }), setup: (hl) => { hl.setBook("HYPE/USDC", null, "40"); }, expectCode: "BOOK_EMPTY" },
  { name: "not enough USDC", action: ioc("buy", { usdc: "12" }), setup: (hl) => { hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "5", hold: "0" }]); }, expectCode: "INSUFFICIENT_USDC" },
  {
    name: "account position cap (coins held by hand)",
    action: ioc("buy", { usdc: "12" }),
    setup: (hl) => {
      hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]);
    },
    expectCode: "ACCOUNT_POSITION_CAP",
  },
  { name: "below the HL minimum", action: ioc("buy", { usdc: "10" }), expectCode: "MIN_NOTIONAL" },
  { name: "pair outside the signed pairs", action: ioc("buy", { usdc: "12" }), pairs: ["PURR/USDC"], pair: "HYPE/USDC", expectCode: "PAIR_NOT_IN_RULES" },
  { name: "the bot's own position cap", action: ioc("buy", { usdc: "12" }), limits: { max_position_usdc: "11" }, expectCode: "POSITION_CAP" },
  { name: "sell with no own coins", action: ioc("sell", { usdc: "12" }), setup: (hl) => { hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }, { coin: "HYPE", total: "1", hold: "0" }]); }, expectCode: "INSUFFICIENT_BOT_BASE" },
];

const PURR = { name: "PURR/USDC", base: "PURR", assetId: 10000, szDecimals: 0, volume24hUsdc: "2000000", midUsdc: "0.2" };

async function run(c: Case, mode: "rules" | "agent"): Promise<{ calls: typeof calls; skip: string | null; placed: number }> {
  calls.length = 0;
  const clock = { t: T0 };
  const hl = new FakeHl({ now: () => clock.t, pairs: [HYPE_PAIR, PURR] });
  hl.account = ACCOUNT;
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent-treasury", validUntilMs: null }]);
  hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  const hard: HardLimits = { maxPositionUsdc: "50", maxOrderUsdc: "20", dailyLossUsdc: "10", maxOrdersPerDay: 20, allowedPairs: ["HYPE/USDC", "PURR/USDC"], minPairVolumeUsdc: "1000000", priceBandBps: 100, agentMaxOrdersPerDay: 20 };
  c.setup?.(hl, hard);
  const limits: RuleLimits = { max_position_usdc: "50", max_order_usdc: "20", daily_loss_stop_usdc: "8", max_orders_per_day: 10, ...c.limits };
  const pair = c.pair ?? "HYPE/USDC";
  const pairs = c.pairs ?? ["HYPE/USDC"];
  // Same id, hash, limits and pairs for both bots: only `mode` and `rules` differ.
  const bot: BotInput = {
    id: "b",
    createdAtMs: 0,
    archived: false,
    prefixes: [cloidPrefix(HASH)],
    rules: {
      hash: HASH,
      confirmedAtMs: T0 - 3_600_000,
      rules:
        mode === "agent"
          ? { version: 1, mode: "agent", name: "x", pairs, limits, rules: [] }
          : { version: 1, name: "x", pairs, limits, rules: [{ id: "r", pair, when: { type: "price", op: "gte", usdc: "0.000001" }, action: c.action, cooldown: "15m" }] },
    },
  };
  const state = initialEngineState();
  state.bots["b"] = (await import("../../src/trading/engine/state.js")).emptyBotState(true);
  c.state?.(state, "b");
  const cfg = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 10 * DAY_MS };
  const r = await runTick(
    { hl, vault: () => Promise.resolve({ vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: null }), config: cfg },
    { nowMs: T0, bots: [bot], state, ...(mode === "agent" ? { agent: { botId: "b", intent: { pair, side: c.action.side, size: c.action.size }, note: null } } : {}) },
  );
  const skip = r.entries.find((e) => e.kind === "skip" && e.bot_id === "b")?.detail.split(":")[0] ?? null;
  return { calls: [...calls], skip, placed: hl.placed.length };
}

describe("same path: DSL rule vs agent intent", () => {
  beforeEach(() => {
    calls.length = 0;
  });
  for (const c of cases) {
    it(c.name, async () => {
      const a = await run(c, "rules");
      const b = await run(c, "agent");
      expect(b.calls.length).toBe(a.calls.length);
      for (let i = 0; i < a.calls.length; i++) {
        const x = a.calls[i] as (typeof calls)[number];
        const y = b.calls[i] as (typeof calls)[number];
        expect(y.o).toEqual(x.o);
        const { cooldownMs: cdX, lastFiredAtMs: lfX, ...restX } = x.c;
        const { cooldownMs: cdY, lastFiredAtMs: lfY, ...restY } = y.c;
        expect(restY).toEqual(restX);
        expect(cdX).toBe(15 * 60_000); // the DSL rule's cooldown
        expect(cdY).toBeUndefined(); // agent orders have none
        expect(lfX).toBeUndefined();
        expect(lfY).toBeUndefined();
        expect(y.ok).toBe(x.ok);
        expect(y.code).toBe(x.code);
      }
      expect(b.skip).toBe(a.skip);
      expect(b.placed).toBe(a.placed);
      expect(a.skip).toBe(c.expectCode);
      if (c.expectCode !== "INSUFFICIENT_BOT_BASE") expect(a.calls.length).toBe(1); // the gate really ran
    });
  }
});
