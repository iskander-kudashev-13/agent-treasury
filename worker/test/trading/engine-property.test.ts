/**
 * Property-style engine test (ADR-0005 section 6/7): random mids, books, balances, open orders, rules and limits, several
 * ticks per scenario with the state carried over. Every order the engine hands to the HL port is checked against the
 * invariants with independent exact arithmetic (no code from engine/risk.ts):
 *   spot only (asset id >= 10000, known spot pair), price inside the band around the tick's mid, notional >= 10 USDC,
 *   notional <= effective max order, held position at mid + open buys + this tick's buys <= effective max position,
 *   buys covered by free USDC and sells by free base, tick-rule-valid price, size within szDecimals, <= 2 per tick,
 *   orders per day <= effective limit, and a cloid of the active rule set.
 * Deterministic: seeded PRNG (mulberry32), no new dependencies.
 */
import { describe, expect, it } from "vitest";
import { cloidPrefix } from "../../src/trading/engine/risk.js";
import type { ActiveRules, TickConfig, VaultView } from "../../src/trading/engine/tick.js";
import { type EngineState, initialEngineState, runTick } from "./legacy.js";
import { FakeHl } from "../../src/trading/hl/fake.js";
import { isValidPrice } from "../../src/trading/hl/format.js";
import type { HardLimits, HlPlaceOrder, HlSpotPair, Rule, RuleSetV1 } from "../../src/trading/types.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const API = "0x2222222222222222222222222222222222222222";

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

// ---- exact decimal arithmetic at a fixed 1e30 scale (independent of engine/risk.ts) ----
const S = 30;
const ONE = 10n ** BigInt(S);
function q(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`bad decimal ${s}`);
  const frac = m[3] ?? "";
  if (frac.length > S) throw new Error(`too many decimals ${s}`);
  const v = BigInt((m[2] ?? "0") + frac.padEnd(S, "0"));
  return m[1] === "-" ? -v : v;
}
const mul = (a: bigint, b: bigint): bigint => (a * b) / ONE; // exact while the inputs have <= 15 decimals each
const decimals = (s: string): number => (s.split(".")[1] ?? "").length;

/** Random decimal string with at most `maxDec` decimals in [lo, hi). */
function randDec(r: () => number, lo: number, hi: number, maxDec: number): string {
  const v = lo + (hi - lo) * r();
  const d = Math.floor(r() * (maxDec + 1));
  const s = v.toFixed(d);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

/** FakeHl that records every attempted order before its own checks (so a perp attempt is visible too). */
class RecordingHl extends FakeHl {
  attempts: { order: HlPlaceOrder; mid: string | undefined }[] = [];
  override placeSpotOrder(order: HlPlaceOrder) {
    const pair = this.pairs.find((p) => p.assetId === order.assetId);
    this.attempts.push({ order, mid: pair ? this.mids[pair.name] : undefined });
    return super.placeSpotOrder(order);
  }
}

interface Scenario {
  hard: HardLimits;
  rules: RuleSetV1;
  pair: HlSpotPair;
  perpPair: HlSpotPair;
}

function randomRule(r: () => number, i: number, pairs: string[]): Rule {
  const side = r() < 0.6 ? "buy" : "sell";
  const size = r() < 0.75 ? { usdc: r() < 0.8 ? randDec(r, 10, 20, 2) : randDec(r, 5, 30, 2) } : { position_pct: randDec(r, 1, 100, 1) };
  const order = r() < 0.6 ? { type: "ioc" as const } : { type: "limit" as const, offset_pct: randDec(r, 0, 3, 2), ttl: pick(r, ["15m", "1h"] as const) };
  const when =
    r() < 0.5
      ? { type: "interval" as const, every: "1h" as const }
      : { type: "price" as const, op: pick(r, ["gte", "lte"] as const), usdc: r() < 0.5 ? "0" : "1000000" };
  const rule: Rule = { id: `r${i}`, pair: pick(r, pairs), when, action: { side, size, order } };
  if (when.type !== "interval") rule.cooldown = pick(r, ["15m", "1h"] as const);
  return rule;
}

function scenario(r: () => number): Scenario {
  const szDecimals = Math.floor(r() * 6); // 0..5
  const pair: HlSpotPair = { name: "HYPE/USDC", base: "HYPE", assetId: 10000 + Math.floor(r() * 300), szDecimals, volume24hUsdc: "5000000", midUsdc: null };
  // A "pair" whose asset id is a perp id, wrongly present in pair data and in both allow lists. Must never be traded.
  const perpPair: HlSpotPair = { name: "BTC/USDC", base: "BTC", assetId: Math.floor(r() * 200), szDecimals: 3, volume24hUsdc: "5000000", midUsdc: null };
  const hardOrder = 10 + Math.floor(r() * 16);
  const hard: HardLimits = {
    maxPositionUsdc: String(hardOrder + Math.floor(r() * 50)),
    maxOrderUsdc: String(hardOrder),
    dailyLossUsdc: String(2 + Math.floor(r() * 20)),
    maxOrdersPerDay: 1 + Math.floor(r() * 8),
    allowedPairs: ["HYPE/USDC", "BTC/USDC"],
    minPairVolumeUsdc: "1000000",
    priceBandBps: 10 + Math.floor(r() * 191),
  };
  const pairs = ["HYPE/USDC", "BTC/USDC"];
  const n = 1 + Math.floor(r() * 4);
  // Limits are random and may be LOOSER than the hard limits (an old file): the engine must take the minimum.
  const rules: RuleSetV1 = {
    version: 1,
    name: "prop",
    pairs,
    limits: {
      max_position_usdc: randDec(r, 5, 80, 2),
      max_order_usdc: r() < 0.8 ? randDec(r, 15, 30, 2) : randDec(r, 5, 30, 2),
      daily_loss_stop_usdc: randDec(r, 1, 30, 2),
      max_orders_per_day: 1 + Math.floor(r() * 10),
    },
    rules: Array.from({ length: n }, (_, i) => randomRule(r, i, pairs)),
  };
  return { hard, rules, pair, perpPair };
}

/** Mid with at most 6 decimals (keeps size x mid exact at the engine's 1e12 scale), log-uniform over 1e-4..1e5. */
function randomMid(r: () => number): string {
  const v = r() < 0.8 ? 10 ** (-1 + r() * 4) : 10 ** (-4 + r() * 9);
  const s = v.toFixed(Math.min(6, Math.max(0, 5 - Math.floor(Math.log10(v)))));
  const t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return q(t) === 0n ? "0.0001" : t;
}

function randomBook(r: () => number, mid: string, bandBps: number): { bid: string | null; ask: string | null } {
  const x = r();
  if (x < 0.05) return { bid: null, ask: mid };
  if (x < 0.1) return { bid: mid, ask: null };
  const m = Number(mid);
  const spreadBps = r() < 0.8 ? r() * bandBps * 0.9 : r() * 500; // sometimes wider than the band
  const f = (v: number) => (v > 0 ? v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "0");
  const bid = f(m * (1 - spreadBps / 20_000));
  const ask = f(m * (1 + spreadBps / 20_000));
  return r() < 0.05 ? { bid: ask, ask: bid } : { bid, ask }; // sometimes crossed
}

const minStr = (a: string, b: string): bigint => (q(a) < q(b) ? q(a) : q(b));

async function runScenario(seed: number): Promise<{ attempts: number; placed: number; violations: string[] }> {
  const r = mulberry32(seed);
  const sc = scenario(r);
  const clock = { t: T0 };
  const hl = new RecordingHl({ now: () => clock.t, pairs: [sc.pair, sc.perpPair] });
  hl.account = ACCOUNT;
  hl.setApprovedAgents(ACCOUNT, [{ address: API, name: "agent", validUntilMs: null }]);
  const baseStep = sc.pair.szDecimals;
  hl.setBalances(ACCOUNT, [
    { coin: "USDC", total: randDec(r, 0, 200, 6), hold: "0" },
    { coin: "HYPE", total: r() < 0.5 ? "0" : randDec(r, 0, 5, baseStep), hold: "0" },
  ]);
  const cfg: TickConfig = { account: ACCOUNT, apiWalletAddress: API, hard: sc.hard, tickSec: 60, deadmanSec: 180, fundedSinceMs: T0 - 86_400_000 };
  const vault: VaultView = { vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: null };
  const hash = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
  const active: ActiveRules = { rules: sc.rules, hash, confirmedAtMs: T0 - 3_600_000 };
  const effMaxOrder = minStr(sc.hard.maxOrderUsdc, sc.rules.limits.max_order_usdc);
  const effMaxPos = minStr(sc.hard.maxPositionUsdc, sc.rules.limits.max_position_usdc);
  const accountMaxPos = q(sc.hard.maxPositionUsdc);
  const effOrdersPerDay = Math.min(sc.hard.maxOrdersPerDay, sc.rules.limits.max_orders_per_day);
  const bps = BigInt(sc.hard.priceBandBps);
  const violations: string[] = [];
  let state: EngineState = initialEngineState();
  let mid = randomMid(r);

  for (let t = 0; t < 8; t++) {
    clock.t += t === 0 ? 0 : r() < 0.3 ? 60_000 : 3_600_000;
    if (t > 0 && r() < 0.7) mid = randomMid(r) === "0.0001" ? mid : (() => {
      const m = Number(mid) * (0.9 + r() * 0.2);
      return randomMid(() => (Math.log10(Math.max(m, 1e-4)) + 4) / 9);
    })();
    hl.setMid("HYPE/USDC", mid);
    hl.setMid("BTC/USDC", randomMid(r));
    const book = randomBook(r, mid, sc.hard.priceBandBps);
    hl.setBook("HYPE/USDC", book.bid, book.ask);
    // Sometimes an order placed by hand (no cloid) rests on the book: it counts toward the position cap.
    const manual = r() < 0.25 ? [{ oid: 9000 + t, cloid: null, market: "spot" as const, pair: "HYPE/USDC", side: "buy" as const, price: mid, size: randDec(r, 0, 0.5, baseStep) || "0", placedAtMs: clock.t }] : [];
    const own = (hl.openOrders[ACCOUNT.toLowerCase()] ?? []).filter((o) => o.cloid !== null);
    hl.setOpenOrders(ACCOUNT, [...own, ...manual]);

    // Snapshot BEFORE the tick (what the engine reads).
    const bal = hl.balances[ACCOUNT.toLowerCase()] ?? [];
    const usdc = bal.find((b) => b.coin === "USDC");
    const base = bal.find((b) => b.coin === "HYPE");
    let freeUsdc = q(usdc?.total ?? "0") - q(usdc?.hold ?? "0");
    let freeBase = q(base?.total ?? "0") - q(base?.hold ?? "0");
    const held = mul(q(base?.total ?? "0"), q(mid));
    const openBefore = (hl.openOrders[ACCOUNT.toLowerCase()] ?? []).filter((o) => o.market === "spot" && o.side === "buy");
    const cancelledFrom = hl.cancelled.length;
    const ordersBefore = state.ordersToday;
    const dayBefore = state.day?.dayIndex;
    const from = hl.attempts.length;

    const res = await runTick({ hl, vault: () => Promise.resolve(vault), config: cfg }, { nowMs: clock.t, rules: active, state });
    state = res.state;
    const tickAttempts = hl.attempts.slice(from);
    const tag = `seed ${seed} tick ${t}`;
    if (tickAttempts.length > 2) violations.push(`${tag}: ${tickAttempts.length} orders in one tick`);
    const rolled = state.day?.dayIndex !== dayBefore;
    if ((rolled ? 0 : ordersBefore) + tickAttempts.length > effOrdersPerDay) violations.push(`${tag}: orders per day above ${effOrdersPerDay}`);
    // Orders the engine cancelled in this tick (ttl / other rule set) before evaluating rules no longer count.
    const gone = new Set(hl.cancelled.slice(cancelledFrom).map((c) => c.oid));
    const openBuys = openBefore.filter((o) => !gone.has(o.oid)).reduce((a, o) => a + mul(q(o.price), q(o.size)), 0n);
    let tickBuys = 0n;
    for (const { order: o, mid: m } of tickAttempts) {
      const where = `${tag} ${o.isBuy ? "buy" : "sell"} ${o.size} @ ${o.price} (mid ${m}, band ${bps} bps, szDec ${sc.pair.szDecimals})`;
      if (o.assetId < 10_000) {
        violations.push(`${where}: perp asset id ${o.assetId}`);
        continue;
      }
      if (o.assetId !== sc.pair.assetId) violations.push(`${where}: unknown asset id`);
      if (m === undefined) {
        violations.push(`${where}: no mid`);
        continue;
      }
      if (!o.cloid.startsWith(cloidPrefix(hash)) || !/^0x[0-9a-f]{32}$/.test(o.cloid)) violations.push(`${where}: bad cloid ${o.cloid}`);
      if (!isValidPrice(o.price, sc.pair.szDecimals)) violations.push(`${where}: price not on HL tick rules`);
      if (decimals(o.price) > 8 - sc.pair.szDecimals) violations.push(`${where}: too many price decimals`);
      if (decimals(o.size) > sc.pair.szDecimals) violations.push(`${where}: too many size decimals`);
      const p = q(o.price);
      const s = q(o.size);
      const mm = q(m);
      if (p <= 0n || s <= 0n) violations.push(`${where}: non-positive`);
      if (o.isBuy && p * 10_000n > mm * (10_000n + bps)) violations.push(`${where}: buy above band`);
      if (!o.isBuy && p * 10_000n < mm * (10_000n - bps)) violations.push(`${where}: sell below band`);
      const notional = mul(p, s);
      if (notional < q("10")) violations.push(`${where}: notional below 10`);
      if (notional > effMaxOrder) violations.push(`${where}: notional above max order`);
      if (o.isBuy) {
        tickBuys += notional;
        // ADR-0006: the ACCOUNT cap (hard limit) covers everything the account holds, by hand or from bots, plus every open buy;
        // the rule set's own limit covers the bot's own holdings, so this tick's buys alone may never exceed it either.
        if (held + openBuys + tickBuys > accountMaxPos) violations.push(`${where}: account position cap (held ${held}, open ${openBuys}, buys ${tickBuys}, cap ${accountMaxPos})`);
        if (tickBuys > effMaxPos) violations.push(`${where}: bot position cap (buys ${tickBuys}, cap ${effMaxPos})`);
        if (notional > freeUsdc) violations.push(`${where}: buy not covered by free USDC`);
        freeUsdc -= notional;
      } else {
        if (s > freeBase) violations.push(`${where}: sell not covered by free base`);
        freeBase -= s;
      }
    }
  }
  return { attempts: hl.attempts.length, placed: hl.placed.length, violations };
}

describe("engine invariants under random markets and rules", () => {
  it("no attempted order ever violates spot-only, band, min notional, max order, max position, funds, tick rules", async () => {
    let attempts = 0;
    let placed = 0;
    const violations: string[] = [];
    for (let seed = 1; seed <= 1500; seed++) {
      const r = await runScenario(seed);
      attempts += r.attempts;
      placed += r.placed;
      violations.push(...r.violations);
    }
    expect(violations.slice(0, 20)).toEqual([]);
    // The generator must actually exercise the placement path, or this test proves nothing.
    expect(attempts).toBeGreaterThan(100);
    expect(placed).toBeGreaterThan(50);
  });
});
