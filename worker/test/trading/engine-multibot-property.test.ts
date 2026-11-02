/**
 * Property test for several bots on ONE pair (ADR-0006 sections 3-4). Random rule sets for 2-3 bots trading HYPE/USDC on one
 * account, coins held by hand, base-token buy fees, random mids, random kills / resumes of single bots, many ticks across UTC
 * days with the state carried over. Every order the engine hands to the HL port is checked with independent exact arithmetic
 * (no engine/risk.ts code) against:
 *   per bot:     notional <= min(hard, bot) max order; own holdings at mid + own open buys + own buys this tick <= min(hard,
 *                bot) max position; orders per UTC day <= min(hard, bot); never placed while the bot is halted; cloid carries
 *                the bot's active prefix;
 *   per account: everything held at mid + every open buy + every buy this tick <= hard max position; orders per UTC day <= hard;
 *                <= 2 orders per tick; buys covered by free USDC; sells covered by free base;
 *   ownership:   a bot never sells more than its OWN coins (its fills: bought - base fee - sold, minus its open sells and its
 *                earlier sells this tick), so coins held by hand or by another bot are never sold.
 * Deterministic: seeded PRNG. No money moves (FakeHl only simulates balances).
 */
import { describe, expect, it } from "vitest";
import { type ActiveRules, type BotInput, type EngineState, type TickConfig, type VaultView, haltBot, clearHalt, initialEngineState, runTick } from "../../src/trading/engine/tick.js";
import { FakeHl } from "../../src/trading/hl/fake.js";
import type { HardLimits, HlPlaceOrder, Rule, RuleSetV1 } from "../../src/trading/types.js";

const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const DAY = 86_400_000;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";
const PAIR = "HYPE/USDC";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const S = 30;
const ONE = 10n ** BigInt(S);
function q(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`bad decimal ${s}`);
  const v = BigInt((m[2] ?? "0") + (m[3] ?? "").padEnd(S, "0"));
  return m[1] === "-" ? -v : v;
}
const mul = (a: bigint, b: bigint): bigint => (a * b) / ONE;
const minQ = (a: string, b: string): bigint => (q(a) < q(b) ? q(a) : q(b));
const randDec = (r: () => number, lo: number, hi: number, d: number): string => {
  const s = (lo + (hi - lo) * r()).toFixed(d);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const hex64 = (r: () => number): string => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
const prefixOf = (hash: string): string => `0x${hash.slice(0, 16)}`;

class RecordingHl extends FakeHl {
  attempts: HlPlaceOrder[] = [];
  override placeSpotOrder(order: HlPlaceOrder) {
    this.attempts.push(order);
    return super.placeSpotOrder(order);
  }
}

function randomRule(r: () => number, i: number): Rule {
  const side = r() < 0.55 ? "buy" : "sell";
  const size =
    side === "sell" && r() < 0.6 ? { position_pct: pick(r, ["25", "50", "100", randDec(r, 1, 100, 1)]) } : { usdc: r() < 0.85 ? randDec(r, 10, 20, 2) : randDec(r, 5, 30, 2) };
  const order = r() < 0.7 ? { type: "ioc" as const } : { type: "limit" as const, offset_pct: randDec(r, 0.1, 2, 2), ttl: pick(r, ["15m", "1h"] as const) };
  const when = r() < 0.5 ? { type: "interval" as const, every: "1h" as const } : { type: "price" as const, op: pick(r, ["gte", "lte"] as const), usdc: pick(r, ["0", "1000000", "30"]) };
  const rule: Rule = { id: `r${i}`, pair: PAIR, when, action: { side, size, order } };
  if (when.type !== "interval") rule.cooldown = pick(r, ["15m", "1h"] as const);
  return rule;
}

interface SimBot {
  id: string;
  hash: string;
  rules: RuleSetV1;
}

async function runScenario(seed: number): Promise<{ attempts: number; sells: number; violations: string[] }> {
  const r = mulberry32(seed);
  const hard: HardLimits = {
    maxPositionUsdc: String(30 + Math.floor(r() * 50)),
    maxOrderUsdc: String(12 + Math.floor(r() * 10)),
    dailyLossUsdc: String(5 + Math.floor(r() * 30)),
    maxOrdersPerDay: 2 + Math.floor(r() * 10),
    allowedPairs: [PAIR],
    minPairVolumeUsdc: "1000000",
    priceBandBps: 50 + Math.floor(r() * 150),
  };
  const nBots = 2 + Math.floor(r() * 2);
  const bots: SimBot[] = Array.from({ length: nBots }, (_, b) => ({
    id: `bot${b}`,
    hash: hex64(r),
    rules: {
      version: 1,
      name: `b${b}`,
      pairs: [PAIR],
      limits: {
        max_position_usdc: randDec(r, 10, 60, 2),
        max_order_usdc: randDec(r, 10, 30, 2),
        daily_loss_stop_usdc: randDec(r, 2, 30, 2),
        max_orders_per_day: 1 + Math.floor(r() * 8),
      },
      rules: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => randomRule(r, i)),
    },
  }));
  const clock = { t: T0 };
  const hl = new RecordingHl({ now: () => clock.t });
  hl.account = ACCOUNT;
  hl.buyFeeBaseFraction = pick(r, ["0", "0", "0.0007", "0.01"]);
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent", validUntilMs: null }]);
  // Coins held by hand: no bot may ever sell them.
  const byHand = r() < 0.5 ? "0" : randDec(r, 0.1, 1.5, 2);
  hl.setBalances(ACCOUNT, [
    { coin: "USDC", total: randDec(r, 20, 300, 2), hold: "0" },
    { coin: "HYPE", total: byHand, hold: "0" },
  ]);
  const cfg: TickConfig = { account: ACCOUNT, apiWalletAddress: API, hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - DAY };
  const vault: VaultView = { vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: null };
  const inputs = (): BotInput[] =>
    bots.map((b, i) => ({ id: b.id, createdAtMs: T0 - (nBots - i) * 1000, archived: false, prefixes: [prefixOf(b.hash)], rules: { rules: b.rules, hash: b.hash, confirmedAtMs: T0 - 3_600_000 } satisfies ActiveRules }));
  const botOfCloid = (c: string | null): SimBot | undefined => (c === null ? undefined : bots.find((b) => c.toLowerCase().startsWith(prefixOf(b.hash))));
  const effMaxOrder = new Map(bots.map((b) => [b.id, minQ(hard.maxOrderUsdc, b.rules.limits.max_order_usdc)]));
  const effMaxPos = new Map(bots.map((b) => [b.id, minQ(hard.maxPositionUsdc, b.rules.limits.max_position_usdc)]));
  const effPerDay = new Map(bots.map((b) => [b.id, Math.min(hard.maxOrdersPerDay, b.rules.limits.max_orders_per_day)]));
  const perDay = new Map<string, number>();
  const violations: string[] = [];
  let state: EngineState = initialEngineState();
  let mid = randDec(r, 20, 50, 2);
  let sells = 0;

  for (let t = 0; t < 30; t++) {
    clock.t += t === 0 ? 0 : pick(r, [60_000, 15 * 60_000, 3_600_000, 3_600_000, 6 * 3_600_000]);
    if (t > 0 && r() < 0.6) mid = randDec(r, Math.max(5, Number(mid) * 0.9), Number(mid) * 1.1, 2);
    hl.setMid(PAIR, mid);
    // Random owner actions between ticks: kill one bot, or resume it (a confirm clears its halt).
    const act = r();
    if (act < 0.08) state = haltBot(state, pick(r, bots).id, clock.t, "KILLED", "kill switch");
    else if (act < 0.16) state = clearHalt(state, pick(r, bots).id);
    const halted = new Set(Object.entries(state.bots).filter(([, s]) => s.halt !== null).map(([id]) => id));

    // What the engine reads at the start of the tick.
    const k = ACCOUNT.toLowerCase();
    const bal = hl.balances[k] ?? [];
    const usdc = bal.find((b) => b.coin === "USDC");
    const base = bal.find((b) => b.coin === "HYPE");
    let freeUsdc = q(usdc?.total ?? "0") - q(usdc?.hold ?? "0");
    let freeBase = q(base?.total ?? "0") - q(base?.hold ?? "0");
    const held = mul(q(base?.total ?? "0"), q(mid));
    const openBefore = (hl.openOrders[k] ?? []).map((o) => ({ ...o }));
    // Each bot's own coins, from the fills HL has for its cloids (net of the base-token fee on buys).
    const own = new Map<string, bigint>(bots.map((b) => [b.id, 0n]));
    for (const f of hl.fills[k] ?? []) {
      const b = botOfCloid(f.cloid);
      if (b === undefined) continue;
      const fee = f.side === "buy" && f.feeToken !== undefined && f.feeToken !== "USDC" && f.feeAmount !== undefined ? q(f.feeAmount) : 0n;
      own.set(b.id, (own.get(b.id) ?? 0n) + (f.side === "buy" ? q(f.size) - fee : -q(f.size)));
    }
    const cancelledFrom = hl.cancelled.length;
    const from = hl.attempts.length;

    const res = await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, bots: inputs(), state });
    state = res.state;
    const tag = `seed ${seed} tick ${t}`;
    const tickAttempts = hl.attempts.slice(from);
    if (tickAttempts.length > 2) violations.push(`${tag}: ${tickAttempts.length} orders in one tick`);
    const gone = new Set(hl.cancelled.slice(cancelledFrom).map((c) => c.oid));
    const open = openBefore.filter((o) => !gone.has(o.oid));
    const openBuy = (pred: (c: string | null) => boolean): bigint => open.filter((o) => o.side === "buy" && pred(o.cloid)).reduce((a, o) => a + mul(q(o.price), q(o.size)), 0n);
    let accountBuys = 0n;
    const botBuys = new Map<string, bigint>();
    const botSells = new Map<string, bigint>();
    const dayKey = Math.floor(clock.t / DAY);
    for (const o of tickAttempts) {
      const b = botOfCloid(o.cloid);
      const where = `${tag} ${o.isBuy ? "buy" : "sell"} ${o.size} @ ${o.price} (mid ${mid}) cloid ${o.cloid}`;
      if (b === undefined) {
        violations.push(`${where}: cloid of no bot`);
        continue;
      }
      if (halted.has(b.id)) violations.push(`${where}: ${b.id} is halted`);
      const pd = `${b.id}|${dayKey}`;
      perDay.set(pd, (perDay.get(pd) ?? 0) + 1);
      perDay.set(`*|${dayKey}`, (perDay.get(`*|${dayKey}`) ?? 0) + 1);
      if ((perDay.get(pd) ?? 0) > (effPerDay.get(b.id) ?? 0)) violations.push(`${where}: ${b.id} orders per day above ${effPerDay.get(b.id)}`);
      if ((perDay.get(`*|${dayKey}`) ?? 0) > hard.maxOrdersPerDay) violations.push(`${where}: account orders per day above ${hard.maxOrdersPerDay}`);
      const notional = mul(q(o.price), q(o.size));
      if (notional > (effMaxOrder.get(b.id) ?? 0n)) violations.push(`${where}: notional above ${b.id}'s max order`);
      if (notional < q("10")) violations.push(`${where}: notional below 10`);
      if (o.isBuy) {
        accountBuys += notional;
        botBuys.set(b.id, (botBuys.get(b.id) ?? 0n) + notional);
        const mine = mul(own.get(b.id) ?? 0n, q(mid)) + openBuy((c) => botOfCloid(c)?.id === b.id) + (botBuys.get(b.id) ?? 0n);
        if (mine > (effMaxPos.get(b.id) ?? 0n)) violations.push(`${where}: ${b.id} position cap (${mine} > ${effMaxPos.get(b.id)})`);
        const all = held + openBuy(() => true) + accountBuys;
        if (all > q(hard.maxPositionUsdc)) violations.push(`${where}: ACCOUNT position cap (${all} > ${hard.maxPositionUsdc})`);
        if (notional > freeUsdc) violations.push(`${where}: buy not covered by free USDC`);
        freeUsdc -= notional;
      } else {
        sells += 1;
        const openSells = open.filter((x) => x.side === "sell" && botOfCloid(x.cloid)?.id === b.id).reduce((a, x) => a + q(x.size), 0n);
        const capacity = (own.get(b.id) ?? 0n) - openSells - (botSells.get(b.id) ?? 0n);
        if (q(o.size) > capacity) violations.push(`${where}: ${b.id} sells more than its own coins (own ${own.get(b.id)}, open sells ${openSells}, capacity ${capacity})`);
        botSells.set(b.id, (botSells.get(b.id) ?? 0n) + q(o.size));
        if (q(o.size) > freeBase) violations.push(`${where}: sell not covered by free base`);
        freeBase -= q(o.size);
      }
    }
  }
  return { attempts: hl.attempts.length, sells, violations };
}

describe("multi-bot engine invariants on one pair (random rules for 2-3 bots, many ticks)", () => {
  it("no order ever breaks a bot cap, an account cap, or sells coins the bot does not own", async () => {
    let attempts = 0;
    let sells = 0;
    const violations: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const r = await runScenario(seed);
      attempts += r.attempts;
      sells += r.sells;
      violations.push(...r.violations);
    }
    expect(violations.slice(0, 20)).toEqual([]);
    // the generator must exercise buys and sells of several bots, or this proves nothing
    expect(attempts).toBeGreaterThan(500);
    expect(sells).toBeGreaterThan(50);
  });
});
