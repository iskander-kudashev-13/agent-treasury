import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe as suite, expect, it } from "vitest";
import { canonicalize, confirmationMessage, hashCanonical, hashRuleSet } from "../../src/trading/rules/canonical.js";
import { describe as render, effectiveCooldown } from "../../src/trading/rules/describe.js";
import { ISSUE_CODES, parseRuleSet, toMicro } from "../../src/trading/rules/schema.js";
import { toProposalValidation, validate } from "../../src/trading/rules/validate.js";
import type { HardLimits, PairInfoMap, RuleSetV1, ValidationIssue } from "../../src/trading/types.js";
import { TRADING_STATES } from "../../src/trading/types.js";

interface Vectors {
  context: { hard: HardLimits; pairs: PairInfoMap };
  valid: { name: string; input: unknown; canonical: string; sha256: string; describe: string[] }[];
  invalid: { name: string; layer: "schema" | "limits"; input: unknown; errors: string[] }[];
}
const vectors = JSON.parse(readFileSync(new URL("../../../docs/trading-rules-vectors.json", import.meta.url), "utf8")) as Vectors;
const { hard, pairs } = vectors.context;

const codes = (issues: ValidationIssue[]) => [...new Set(issues.map((i) => i.code))].sort();
function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}
const V = (i: number) => must(vectors.valid[i]);
const R = (rs: RuleSetV1, i: number) => must(rs.rules[i]);
const R0 = (rs: RuleSetV1) => R(rs, 0);
const base = (): RuleSetV1 => structuredClone(V(0).input as RuleSetV1);

suite("shared vectors", () => {
  for (const v of vectors.valid) {
    it(`valid: ${v.name}`, () => {
      const p = parseRuleSet(v.input);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(canonicalize(p.value)).toBe(v.canonical);
      expect(hashRuleSet(p.value)).toBe(v.sha256);
      expect(createHash("sha256").update(v.canonical).digest("hex")).toBe(v.sha256);
      expect(render(p.value)).toEqual(v.describe);
      const val = validate(v.input, hard, pairs);
      expect(val.errors).toEqual([]);
      expect(val.ok).toBe(true);
    });
  }

  it("scrambled key order gives the same hash as the ordered input", () => {
    expect(V(1).sha256).toBe(V(0).sha256);
  });

  for (const v of vectors.invalid) {
    it(`invalid (${v.layer}): ${v.name}`, () => {
      const r = validate(v.input, hard, pairs);
      expect(r.ok).toBe(false);
      expect(codes(r.errors)).toEqual(v.errors);
      if (v.layer === "schema") expect(parseRuleSet(v.input).ok).toBe(false);
      else expect(parseRuleSet(v.input).ok).toBe(true);
    });
  }

  it("every code used in the vectors is a known code, and every expected error is covered at least once", () => {
    const used = new Set(vectors.invalid.flatMap((v) => v.errors));
    for (const c of used) expect(ISSUE_CODES).toContain(c);
    // Codes that are only warnings or unreachable through plain vectors are exempt.
    const uncovered = ISSUE_CODES.filter((c) => !used.has(c));
    expect(uncovered).toEqual(["PAIR_UNKNOWN", "SIZE_NEAR_HL_MINIMUM", "ORDER_BELOW_HL_MIN_AT_CURRENT_PRICE", "LIMIT_NEEDS_DEADMAN"]);
  });
});

suite("canonical form", () => {
  it("is the documented ADR example byte for byte", () => {
    expect(canonicalize(base())).toBe(
      '{"limits":{"daily_loss_stop_usdc":"5","max_order_usdc":"10","max_orders_per_day":3,"max_position_usdc":"40"},"name":"HYPE dip buyer","pairs":["HYPE/USDC"],"rules":[{"action":{"order":{"type":"ioc"},"side":"buy","size":{"usdc":"10"}},"cooldown":"1d","id":"dip","pair":"HYPE/USDC","when":{"op":"lte","pct":"-3","type":"price_change","window":"1d"}}],"version":1}',
    );
  });
  it("omits unset optional keys", () => {
    const rs = base();
    delete R0(rs).cooldown;
    expect(canonicalize(rs)).not.toContain("cooldown");
    expect(canonicalize({ ...base(), rules: [{ ...R0(base()), cooldown: undefined }] })).not.toContain("cooldown");
  });
  it("keeps decimals as written (10 and 10.0 hash differently)", () => {
    const a = base();
    const b = base();
    R0(b).action.size = { usdc: "10.0" };
    expect(hashRuleSet(a)).not.toBe(hashRuleSet(b));
  });
  it("hash changes when any single field changes", () => {
    const h = hashRuleSet(base());
    const m = base();
    m.limits.max_orders_per_day = 4;
    expect(hashRuleSet(m)).not.toBe(h);
    const n = base();
    n.name = "HYPE dip buyer ";
    expect(hashRuleSet(n)).not.toBe(h);
  });
  it("hash is 64 lower-case hex and hashCanonical agrees", () => {
    const h = hashRuleSet(base());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCanonical(canonicalize(base()))).toBe(h);
  });
  it("emits UTF-8 and the hash covers bytes, not code units", () => {
    const rs = base();
    rs.name = "Zażółć 🚀";
    expect(canonicalize(rs)).toContain("Zażółć 🚀");
    expect(hashRuleSet(rs)).toBe(createHash("sha256").update(canonicalize(rs), "utf8").digest("hex"));
  });
  it("sorts nested keys inside arrays", () => {
    const parsed = parseRuleSet(V(1).input);
    expect(parsed.ok && canonicalize(parsed.value)).toBe(V(0).canonical);
  });
});

suite("confirmation message", () => {
  it("matches the ADR layout and lower-cases the HL account", () => {
    const msg = confirmationMessage({
      vault: "vault.near",
      agentId: "hl-trader",
      hlNetwork: "mainnet",
      hlAccount: "0xABCDEFabcdef0123456789ABCDEF0123456789ab",
      rulesSha256: "a".repeat(64),
    });
    expect(msg).toBe(
      [
        "Agent Treasury: activate trading rules",
        "vault: vault.near",
        "agent: hl-trader",
        "hl_network: mainnet",
        "hl_account: 0xabcdefabcdef0123456789abcdef0123456789ab",
        `rules_sha256: ${"a".repeat(64)}`,
      ].join("\n"),
    );
  });
});

suite("parseRuleSet", () => {
  it("returns the typed value and no issues", () => {
    const p = parseRuleSet(base());
    expect(p).toMatchObject({ ok: true, issues: [] });
  });
  it("reports the path of a nested failure", () => {
    const rs = base() as unknown as { rules: { when: { pct: string } }[] };
    must(rs.rules[0]).when.pct = "x";
    const p = parseRuleSet(rs);
    expect(p.ok).toBe(false);
    expect(p.issues[0]).toMatchObject({ code: "BAD_SIGNED_DECIMAL", path: "rules.0.when.pct" });
  });
  it("never throws on garbage", () => {
    for (const x of [null, undefined, 1, [], {}, "x", { version: 1 }]) expect(parseRuleSet(x).ok).toBe(false);
  });
  it("reports several problems at once", () => {
    const rs = base() as unknown as { limits: Record<string, unknown> };
    rs.limits.max_position_usdc = "x";
    rs.limits.max_orders_per_day = 0;
    expect(codes(parseRuleSet(rs).issues)).toEqual(["BAD_DECIMAL", "MAX_ORDERS_RANGE"]);
  });
  it("accepts boundary values", () => {
    const rs = base();
    rs.limits.max_orders_per_day = 50;
    rs.limits.max_order_usdc = "10";
    R0(rs).action.order = { type: "limit", offset_pct: "10", ttl: "1d" };
    R0(rs).when = { type: "price_change", window: "1h", op: "gte", pct: "-100" };
    expect(parseRuleSet(rs).ok).toBe(true);
    rs.pairs = ["HYPE/USDC", "A/USDC", "B/USDC"];
    expect(parseRuleSet(rs).ok).toBe(true);
  });
  it("allows five rules and rejects a sixth", () => {
    const rs = base();
    rs.rules = Array.from({ length: 5 }, (_, i) => ({ ...R0(base()), id: `r${i}` }));
    expect(parseRuleSet(rs).ok).toBe(true);
    rs.rules.push({ ...R0(base()), id: "r5" });
    expect(codes(parseRuleSet(rs).issues)).toEqual(["TOO_MANY_RULES"]);
  });
  it("toMicro parses Dec and SDec", () => {
    expect(toMicro("0.000001")).toBe(1n);
    expect(toMicro("12.5")).toBe(12_500_000n);
    expect(toMicro("-3")).toBe(-3_000_000n);
    expect(toMicro("-0.25")).toBe(-250_000n);
    expect(toMicro("123456789012345678901234567890")).toBe(123456789012345678901234567890n * 1_000_000n);
  });
});

suite("validate() still enforces name characters that providerSafeSchema hides from the model", () => {
  it.each([
    ["BEL control character", "bell\u0007name"],
    ["right-to-left override", "evil\u202Ename"],
    ["line separator", "a\u2028b"],
  ])("BAD_NAME for %s", (_label, name) => {
    const rs = base();
    rs.name = name;
    const r = validate(rs, hard, pairs);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("BAD_NAME");
  });
});

suite("validate against hard limits", () => {
  it("accepts a rule set exactly at every hard limit", () => {
    const rs = base();
    rs.limits = { max_position_usdc: "50", max_order_usdc: "20", daily_loss_stop_usdc: "10", max_orders_per_day: 20 };
    R0(rs).action.size = { usdc: "20" };
    expect(validate(rs, hard, pairs)).toMatchObject({ ok: true, errors: [] });
  });
  it("rejects one micro-unit over a limit rather than clamping", () => {
    const rs = base();
    rs.limits.max_position_usdc = "50.000001";
    const r = validate(rs, hard, pairs);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: "LIMIT_MAX_POSITION", path: "limits.max_position_usdc" });
    expect(rs.limits.max_position_usdc).toBe("50.000001");
  });
  it("collects every violated limit", () => {
    const rs = base();
    rs.limits = { max_position_usdc: "500", max_order_usdc: "100", daily_loss_stop_usdc: "99", max_orders_per_day: 50 };
    R0(rs).action.size = { usdc: "100" };
    expect(codes(validate(rs, hard, pairs).errors)).toEqual(["LIMIT_DAILY_LOSS", "LIMIT_MAX_ORDER", "LIMIT_MAX_ORDERS", "LIMIT_MAX_POSITION"]);
  });
  it("respects tighter env limits than the default", () => {
    const r = validate(base(), { ...hard, maxOrderUsdc: "10", maxPositionUsdc: "30" }, pairs);
    expect(codes(r.errors)).toEqual(["LIMIT_MAX_POSITION"]);
  });
  it("compares decimals numerically, not as strings", () => {
    const rs = base();
    rs.limits.max_position_usdc = "9.5"; // string-wise > "50"
    rs.limits.max_order_usdc = "10";
    expect(codes(validate(rs, hard, pairs).errors)).toEqual([]);
  });
  it("PAIR_NOT_ALLOWED beats lookup, PAIR_UNKNOWN when allowed but absent from spotMeta", () => {
    const rs = base();
    expect(codes(validate(rs, { ...hard, allowedPairs: ["PURR/USDC"] }, pairs).errors)).toEqual(["PAIR_NOT_ALLOWED"]);
    expect(codes(validate(rs, hard, {}).errors)).toEqual(["PAIR_UNKNOWN"]);
  });
  it("refuses perps (asset id < 10000) including id 9999", () => {
    const p: PairInfoMap = { "HYPE/USDC": { name: "HYPE/USDC", assetId: 9999, szDecimals: 2, volume24hUsdc: "9999999" } };
    expect(codes(validate(base(), hard, p).errors)).toEqual(["PAIR_PERP"]);
    const ok: PairInfoMap = { "HYPE/USDC": { name: "HYPE/USDC", assetId: 10000, szDecimals: 2, volume24hUsdc: "9999999" } };
    expect(validate(base(), hard, ok).ok).toBe(true);
  });
  it("volume threshold is inclusive", () => {
    const at: PairInfoMap = { "HYPE/USDC": { name: "HYPE/USDC", assetId: 10107, szDecimals: 2, volume24hUsdc: "1000000" } };
    expect(validate(base(), hard, at).ok).toBe(true);
    const below: PairInfoMap = { "HYPE/USDC": { name: "HYPE/USDC", assetId: 10107, szDecimals: 2, volume24hUsdc: "999999.999999" } };
    expect(codes(validate(base(), hard, below).errors)).toEqual(["PAIR_LOW_VOLUME"]);
  });
  it("structural errors short-circuit with no warnings", () => {
    const r = validate({ nope: 1 }, hard, pairs);
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual([]);
  });
  it("warns, but does not fail, when max_position is below max_order", () => {
    const rs = base();
    rs.limits.max_position_usdc = "10";
    rs.limits.max_order_usdc = "15";
    R0(rs).action.size = { usdc: "15" };
    const r = validate(rs, hard, pairs);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("warns when a usdc size is below 11 (HL minimum notional plus rounding)", () => {
    const rs = base(); // base size is 10
    const r = validate(rs, hard, pairs);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "SIZE_NEAR_HL_MINIMUM" && w.path === "rules.0.action.size.usdc")).toBe(true);
    R0(rs).action.size = { usdc: "11" };
    rs.limits.max_order_usdc = "12";
    expect(validate(rs, hard, pairs).warnings.some((w) => w.code === "SIZE_NEAR_HL_MINIMUM")).toBe(false);
  });
  it("warns when lot rounding pushes the notional under 10 USDC at the current price (PURR, szDecimals 0)", () => {
    const rs = base();
    R0(rs).action.size = { usdc: "12" };
    rs.limits.max_order_usdc = "12";
    const info = must(pairs[rs.pairs[0] as string]);
    const coarse: PairInfoMap = { ...pairs, [info.name]: { ...info, szDecimals: 0, mid: "4.62" } };
    const w = validate(rs, hard, coarse).warnings.find((x) => x.code === "ORDER_BELOW_HL_MIN_AT_CURRENT_PRICE");
    expect(w?.path).toBe("rules.0.action.size.usdc");
    expect(w?.message).toContain("2 coins");
    expect(w?.message).toContain("use at least 15 USDC");
    expect(w?.message).toContain("exceeds max order 12");
    // enough size, no mid, or fine lots: no warning
    R0(rs).action.size = { usdc: "20" };
    rs.limits.max_order_usdc = "20";
    expect(validate(rs, hard, coarse).warnings.some((x) => x.code === "ORDER_BELOW_HL_MIN_AT_CURRENT_PRICE")).toBe(false);
    R0(rs).action.size = { usdc: "12" };
    const noMid: PairInfoMap = { ...pairs, [info.name]: { ...info, szDecimals: 0 } };
    expect(validate(rs, hard, noMid).warnings.some((x) => x.code === "ORDER_BELOW_HL_MIN_AT_CURRENT_PRICE")).toBe(false);
  });
  it("warns when a buy is larger than max_position", () => {
    const rs = base();
    rs.limits.max_position_usdc = "5";
    const r = validate(rs, hard, pairs);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.path === "rules.0.action.size.usdc")).toBe(true);
  });
  it("toProposalValidation flattens issues to strings", () => {
    const rs = base();
    rs.limits.max_order_usdc = "30";
    R0(rs).action.size = { usdc: "30" };
    const v = toProposalValidation(validate(rs, hard, pairs));
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([expect.stringMatching(/^LIMIT_MAX_ORDER: /)]);
  });
});

suite("describe", () => {
  it("renders the ADR example", () => {
    expect(render(base())).toEqual([
      "Rule set: HYPE dip buyer",
      "Pairs: HYPE/USDC",
      "Max position: 40 USDC",
      "Max order: 10 USDC",
      "Daily loss stop: 5 USDC",
      "Max orders per day: 3",
      "Rule 1 [dip] on HYPE/USDC",
      "  When: price change over 1 day is at or below -3%",
      "  Do: Buy 10 USDC of HYPE as an immediate-or-cancel limit order at the market price, inside the price band",
      "  Cooldown: 1 day",
    ]);
  });
  it("interval rules show the interval as the cooldown", () => {
    const m = parseRuleSet(V(2).input);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const lines = render(m.value);
    expect(lines).toContain("  When: every 1 week (first run when the rules are activated)");
    expect(effectiveCooldown(R(m.value,0))).toBe("1w");
    expect(effectiveCooldown(R(m.value,1))).toBe("1d");
  });
  it("signs positive percentages and describes limit offsets by side", () => {
    const m = parseRuleSet(V(2).input);
    if (!m.ok) throw new Error("vector");
    const text = render(m.value).join("\n");
    expect(text).toContain("is at or above +12.5%");
    expect(text).toContain("Buy 12.25 USDC of HYPE as a limit order 0.5% below the market price, cancelled after 4 hours");
    expect(text).toContain("Sell 25.5% of the PURR position as a limit order 10% above the market price, cancelled after 1 day");
    expect(text).toContain("Sell 100% of the HYPE position as a limit order at the market price, cancelled after 15 minutes");
  });
  it("every line is short and single-line", () => {
    for (const v of vectors.valid)
      for (const l of v.describe) {
        expect(l.length).toBeLessThan(160);
        expect(l).not.toContain("\n");
      }
  });
  it("does not change when key order changes", () => {
    const a = parseRuleSet(V(0).input);
    const b = parseRuleSet(V(1).input);
    expect(a.ok && b.ok && render(a.value)).toEqual(b.ok && render(b.value));
  });
});

suite("types", () => {
  it("exposes the state enum from the ADR", () => {
    expect([...TRADING_STATES]).toEqual([
      "not_configured",
      "awaiting_api_wallet",
      "no_rules",
      "running",
      "paused_onchain",
      "stopped_today",
      "halted",
      "error",
    ]);
  });
});
