/**
 * Validation of a rule set against the env hard limits and live pair data (ADR-0005 §6). Rejects, never clamps.
 * The same function runs when the worker compiles a proposal and again at `POST /trading/rules/confirm`.
 */
import type { HardLimits, PairInfoMap, RuleSetV1, ValidationIssue } from "../types.js";
import { describeMinOrder, fx, minOrderAdvice, orderPrice } from "../engine/risk.js";
import { issue, parseRuleSet, toMicro } from "./schema.js";

export interface ValidateResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Lowest asset id of a spot market. Anything below is a perp. */
export const SPOT_ASSET_ID_MIN = 10_000;
/** 11 USDC in micro units: smallest order size that reliably clears HL's 10 USDC minimum after rounding. */
const MIN_RELIABLE_ORDER_MICRO = 11_000_000n;

/**
 * @param input    untrusted rule set (parsed here; structural and static errors come back as issues)
 * @param hard     env hard limits
 * @param pairInfo live `spotMeta` data keyed by display name; a pair missing here is unknown
 * @param opts     `deadManAvailable: false` (HL refuses scheduleCancel for volume) turns limit orders into a warning: they
 *                 would be rejected at run time (LIMIT_NEEDS_DEADMAN) while only IOC orders are allowed
 */
export function validate(input: unknown, hard: HardLimits, pairInfo: PairInfoMap, opts: { deadManAvailable?: boolean } = {}): ValidateResult {
  const parsed = parseRuleSet(input);
  if (!parsed.ok) return { ok: false, errors: parsed.issues, warnings: [] };
  const rs: RuleSetV1 = parsed.value;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const over = (code: "LIMIT_MAX_POSITION" | "LIMIT_MAX_ORDER" | "LIMIT_DAILY_LOSS", path: string, got: string, max: string) => {
    if (toMicro(got) > toMicro(max)) errors.push(issue(code, path, `${path} ${got} is above the hard limit ${max}`));
  };
  over("LIMIT_MAX_POSITION", "limits.max_position_usdc", rs.limits.max_position_usdc, hard.maxPositionUsdc);
  over("LIMIT_MAX_ORDER", "limits.max_order_usdc", rs.limits.max_order_usdc, hard.maxOrderUsdc);
  over("LIMIT_DAILY_LOSS", "limits.daily_loss_stop_usdc", rs.limits.daily_loss_stop_usdc, hard.dailyLossUsdc);
  if (rs.limits.max_orders_per_day > hard.maxOrdersPerDay)
    errors.push(
      issue("LIMIT_MAX_ORDERS", "limits.max_orders_per_day", `max_orders_per_day ${rs.limits.max_orders_per_day} is above the hard limit ${hard.maxOrdersPerDay}`),
    );

  // Agent-driven bots have their own, usually lower, orders-per-day cap (ADR-0007 section 8).
  if (rs.mode === "agent" && hard.agentMaxOrdersPerDay !== undefined && rs.limits.max_orders_per_day > hard.agentMaxOrdersPerDay)
    errors.push(
      issue("LIMIT_AGENT_MAX_ORDERS", "limits.max_orders_per_day", `max_orders_per_day ${rs.limits.max_orders_per_day} is above the agent-mode limit ${hard.agentMaxOrdersPerDay} (TRADING_AGENT_MAX_ORDERS_PER_DAY)`),
    );

  const minVol = toMicro(hard.minPairVolumeUsdc);
  rs.pairs.forEach((p, i) => {
    const at = `pairs.${i}`;
    if (!hard.allowedPairs.includes(p)) {
      errors.push(issue("PAIR_NOT_ALLOWED", at, `${p} is not in TRADING_ALLOWED_PAIRS`));
      return;
    }
    const info = pairInfo[p];
    if (info === undefined) {
      errors.push(issue("PAIR_UNKNOWN", at, `${p} is not a Hyperliquid spot pair`));
    } else if (info.assetId < SPOT_ASSET_ID_MIN) {
      errors.push(issue("PAIR_PERP", at, `${p} resolves to asset id ${info.assetId}, which is a perp; spot only`));
    } else if (toMicro(info.volume24hUsdc) < minVol) {
      errors.push(issue("PAIR_LOW_VOLUME", at, `${p} 24h volume ${info.volume24hUsdc} is below the minimum ${hard.minPairVolumeUsdc}`));
    }
  });

  // Soft findings: legal but probably not what the owner meant.
  if (toMicro(rs.limits.max_position_usdc) < toMicro(rs.limits.max_order_usdc))
    warnings.push(issue("LIMIT_MAX_POSITION", "limits.max_position_usdc", "max_position_usdc is below max_order_usdc, so a full-size buy would be skipped"));
  rs.rules.forEach((r, i) => {
    if (opts.deadManAvailable === false && r.action.order.type === "limit")
      warnings.push(issue("LIMIT_NEEDS_DEADMAN", `rules.${i}.action.order`, "limit orders rest on the book and need the dead-man switch, which Hyperliquid currently refuses for this account (it needs $1M traded volume); this rule will be skipped until it works. Use an IOC order instead"));
    // HL's minimum order value is 10 USDC and sizes round down to szDecimals, so an order of exactly 10 ends up below it.
    if ("usdc" in r.action.size && toMicro(r.action.size.usdc) < MIN_RELIABLE_ORDER_MICRO)
      warnings.push(
        issue("SIZE_NEAR_HL_MINIMUM", `rules.${i}.action.size.usdc`, `size ${r.action.size.usdc} USDC is below 11: Hyperliquid needs 10 USDC per order and size rounding can drop it under, so this rule may never fire`),
      );
    // Lot rounding: coarse szDecimals (e.g. 0 for PURR) can push a 12 USDC order under 10 USDC at the real price.
    const info = pairInfo[r.pair];
    if ("usdc" in r.action.size && info?.mid !== undefined && info.assetId >= SPOT_ASSET_ID_MIN) {
      const price = orderPrice(r.action, fx(info.mid), hard.priceBandBps, info.szDecimals);
      if (price !== null) {
        const adv = minOrderAdvice(fx(r.action.size.usdc), price, info.szDecimals);
        if (adv.belowMin) {
          const maxOrder = fx(toMicro(rs.limits.max_order_usdc) < toMicro(hard.maxOrderUsdc) ? rs.limits.max_order_usdc : hard.maxOrderUsdc);
          warnings.push(
            issue("ORDER_BELOW_HL_MIN_AT_CURRENT_PRICE", `rules.${i}.action.size.usdc`, `at the current price ${r.pair} ${r.action.size.usdc} USDC becomes ${describeMinOrder(adv, maxOrder)}; the rule would be skipped (MIN_NOTIONAL) until then`),
          );
        }
      }
    }
    if ("usdc" in r.action.size && r.action.side === "buy" && toMicro(r.action.size.usdc) > toMicro(rs.limits.max_position_usdc))
      warnings.push(issue("LIMIT_MAX_POSITION", `rules.${i}.action.size.usdc`, `buy size ${r.action.size.usdc} is above max_position_usdc, so this rule can never fire`));
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** Shape used by the assistant proposal and `/trading/rules/propose`. */
export function toProposalValidation(r: ValidateResult): { ok: boolean; errors: string[]; warnings: string[] } {
  const s = (i: ValidationIssue) => `${i.code}: ${i.message}`;
  return { ok: r.ok, errors: r.errors.map(s), warnings: r.warnings.map(s) };
}
