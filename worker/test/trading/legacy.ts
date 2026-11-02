/**
 * Single-bot (version 1) view over the multi-bot engine, for the engine tests that were written before ADR-0006.
 *
 * `runTick(deps, { nowMs, rules, state })` takes and returns the OLD `EngineState` shape. Each call converts the state with the
 * production migration (`migrateV1`), runs ONE bot named `default` through the real v2 engine, and converts the result back, so
 * every assertion of those tests still checks the real code path (migration included). Conversions that cannot be represented
 * in version 1 (the `ACCOUNT_LOSS_STOP` reason) are mapped to the closest old value.
 *
 * Note: converting on every call means `day.startPositions` (all allowed coins the ACCOUNT held at the snapshot) become the
 * bot's start positions, i.e. exactly the old loss-stop behaviour. The new per-bot rule (a bot marks only its own holdings) is
 * tested in engine-multibot.test.ts.
 */
import { type EngineStateV1, initialEngineStateV1, migrateV1 } from "../../src/trading/engine/migrate.js";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import { type ActiveRules, type EngineState as EngineStateV2, type TickDeps, type TickResult as TickResultV2, runTick as runTickV2 } from "../../src/trading/engine/tick.js";
import { emptyBotState } from "../../src/trading/engine/state.js";
import type { HaltReason } from "../../src/trading/types.js";

export type EngineState = EngineStateV1;
export type TickResult = Omit<TickResultV2, "state"> & { state: EngineStateV1 };

export const initialEngineState = (): EngineStateV1 => initialEngineStateV1();

export function haltState(s: EngineStateV1, atMs: number, reason: HaltReason, detail: string): EngineStateV1 {
  return { ...s, halt: { reason, atMs, detail } };
}

export function clearHalt(s: EngineStateV1): EngineStateV1 {
  return { ...s, halt: null };
}

/** Back to the old shape (the `default` bot plus the account block). */
export function downgrade(s: EngineStateV2, prefixes: string[]): EngineStateV1 {
  const a = s.account;
  const b = s.bots["default"] ?? emptyBotState();
  const stopped = a.stoppedDayIndex ?? b.stoppedDayIndex;
  const reason = a.stoppedDayIndex !== null ? (a.stopReason === "EQUITY_DROP" ? "EQUITY_DROP" : "DAILY_LOSS_STOP") : b.stoppedDayIndex !== null ? "DAILY_LOSS_STOP" : null;
  const c = a.fillCursor;
  return {
    version: 1,
    rulesHash: b.rulesHash,
    day: a.day,
    ordersToday: a.ordersToday,
    stoppedDayIndex: stopped,
    halt: a.halt ?? b.halt,
    orderCounter: a.orderCounter,
    firedAt: b.firedAt,
    orders: b.orders,
    lastSkip: b.lastSkip,
    deadManAtMs: a.deadManAtMs,
    deadManGatedAtMs: a.deadManGatedAtMs,
    lastTickMs: a.lastTickMs,
    recent: a.recent,
    botPrefixes: prefixes,
    botOids: Object.keys(s.oidBot).map(Number),
    prefixesDropped: 0,
    fills:
      c === null
        ? null
        : {
            cursorMs: c.cursorMs,
            seen: c.seen,
            totalComplete: b.agg.totalComplete,
            completeFromMs: c.completeFromMs,
            todayFromMs: c.todayFromMs,
            total: b.agg.total,
            today: b.agg.today,
            botFillsToday: b.agg.botFillsToday,
            botOidsToday: b.agg.botOidsToday,
            basis: b.agg.basis,
            foreignFills: c.foreignFills,
          },
    stopReason: reason,
    filledOrdersToday: b.filledOrdersToday,
    filledOidsToday: b.filledOidsToday,
    lastStateKey: a.lastStateKey,
    lastStateRepeats: a.lastStateRepeats,
  };
}

export async function runTick(
  deps: TickDeps,
  input: { nowMs: number; rules: ActiveRules | null; state: EngineStateV1 },
): Promise<TickResult> {
  const m = migrateV1({ ...initialEngineStateV1(), ...input.state });
  const prefixes = [...m.prefixes];
  if (input.rules !== null && !prefixes.includes(cloidPrefix(input.rules.hash))) prefixes.push(cloidPrefix(input.rules.hash));
  const r = await runTickV2(deps, { nowMs: input.nowMs, bots: [{ id: "default", createdAtMs: 0, archived: false, prefixes, rules: input.rules }], state: m.state });
  // Rule-set prefixes of resting orders placed this tick are covered by the hash prefix above.
  return { ...r, state: downgrade(r.state, prefixes) };
}
