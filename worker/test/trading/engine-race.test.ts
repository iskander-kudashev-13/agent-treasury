/**
 * Race between a ttl cancel and a fill (ADR-0005 section 6 "position cap counts held + every open buy").
 *
 * The engine reads balances and open orders at the start of a tick, then (step 6) cancels expired orders and drops them
 * from `openBuyValue` before it evaluates rules (step 7). The HL adapter treats "already canceled, or filled" on cancel as
 * success (hl/nktkas.ts:41, :390). If the expired order FILLED between the tick's reads and the cancel, it is neither in
 * the balances the engine read nor in the open buys it counts, so a new buy in the same tick can push the position past
 * max_position_usdc by up to one order.
 */
import { describe, expect, it } from "vitest";
import type { ActiveRules, TickConfig, VaultView } from "../../src/trading/engine/tick.js";
import { initialEngineState, runTick } from "./legacy.js";
import { FakeHl } from "../../src/trading/hl/fake.js";
import { addDec, cmpDec, mulDec, subDec } from "../../src/trading/hl/format.js";
import type { HardLimits, RuleSetV1 } from "../../src/trading/types.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";
const HASH = "cd".repeat(32);

/** On cancel, the targeted resting orders fill instead (HL answers "already ... filled", the adapter returns success). */
class FillOnCancelHl extends FakeHl {
  fillOnCancel = false;
  override cancelOrders(orders: { assetId: number; oid: number }[]): Promise<void> {
    if (!this.fillOnCancel) return super.cancelOrders(orders);
    const k = this.account.toLowerCase();
    const bal = this.balances[k] ?? [];
    const usdc = bal.find((b) => b.coin === "USDC");
    for (const t of orders) {
      const o = (this.openOrders[k] ?? []).find((x) => x.oid === t.oid);
      if (!o || !usdc) continue;
      const notional = mulDec(o.price, o.size);
      usdc.total = subDec(usdc.total, notional);
      usdc.hold = cmpDec(usdc.hold, notional) >= 0 ? subDec(usdc.hold, notional) : "0";
      const base = bal.find((b) => b.coin === "HYPE");
      if (base) base.total = addDec(base.total, o.size);
      else bal.push({ coin: "HYPE", total: o.size, hold: "0" });
      this.openOrders[k] = (this.openOrders[k] ?? []).filter((x) => x.oid !== t.oid);
    }
    return Promise.resolve();
  }
}

const hard: HardLimits = { maxPositionUsdc: "50", maxOrderUsdc: "20", dailyLossUsdc: "10", maxOrdersPerDay: 20, allowedPairs: ["HYPE/USDC"], minPairVolumeUsdc: "1000000", priceBandBps: 100 };
const cfg: TickConfig = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 86_400_000 };
const vault: VaultView = { vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: null };
const rules: RuleSetV1 = {
  version: 1,
  name: "ladder",
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "20", max_order_usdc: "15", daily_loss_stop_usdc: "5", max_orders_per_day: 10 },
  rules: [
    { id: "bid", pair: "HYPE/USDC", when: { type: "price", op: "lte", usdc: "1000" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "limit", offset_pct: "1", ttl: "15m" } }, cooldown: "15m" },
  ],
};
const active: ActiveRules = { rules, hash: HASH, confirmedAtMs: T0 - 3_600_000 };

function setup() {
  const clock = { t: T0 };
  const hl = new FillOnCancelHl({ now: () => clock.t });
  hl.account = ACCOUNT;
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent", validUntilMs: null }]);
  hl.setBalances(ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  return { clock, hl };
}
const exposure = (hl: FakeHl): number => {
  const k = ACCOUNT.toLowerCase();
  const held = Number((hl.balances[k] ?? []).find((b) => b.coin === "HYPE")?.total ?? "0") * Number(hl.mids["HYPE/USDC"]);
  const open = (hl.openOrders[k] ?? []).filter((o) => o.side === "buy").reduce((a, o) => a + Number(o.price) * Number(o.size), 0);
  return held + open;
};

describe("ttl cancel vs fill race", () => {
  it("control: a ttl cancel that really cancels lets the rule re-place on the next tick (the cancelled buy stays counted for the rest of its own tick)", async () => {
    const { clock, hl } = setup();
    const st = (await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, rules: active, state: initialEngineState() })).state;
    expect(hl.placed).toHaveLength(1);
    clock.t += 16 * 60_000;
    const st2 = (await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, rules: active, state: st })).state;
    expect(hl.placed).toHaveLength(1); // fail closed: the order cancelled in this tick still counts toward the cap
    clock.t += 60_000;
    await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, rules: active, state: st2 });
    expect(hl.placed).toHaveLength(2);
    expect(exposure(hl)).toBeLessThanOrEqual(20);
  });

  it("an expired order that filled before the cancel is not counted; a same-tick buy exceeds max_position (engine/tick.ts:412-437 drops ttl-cancelled buys from openBuyValue; hl/nktkas.ts:390 maps 'filled' to success)", async () => {
    const { clock, hl } = setup();
    const st = (await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, rules: active, state: initialEngineState() })).state;
    expect(hl.placed).toHaveLength(1); // resting buy 0.3 @ 39.6 = 11.88 USDC
    clock.t += 16 * 60_000;
    hl.fillOnCancel = true; // the resting order fills between the tick's reads and the ttl cancel
    await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, rules: active, state: st });
    // Held 0.3 HYPE (12 USDC at mid 40) + a second resting buy of 11.88 = 23.88 > max_position_usdc 20.
    expect(exposure(hl)).toBeLessThanOrEqual(20);
  });
});
