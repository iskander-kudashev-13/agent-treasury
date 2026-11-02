/**
 * Validation of a rule set against the env hard limits and live pair data (ADR-0005 §6). Rejects, never clamps.
 * The same function runs when the worker compiles a proposal and again at `POST /trading/rules/confirm`.
 */
import type { HardLimits, PairInfoMap, RuleSetV1, ValidationIssue } from "../types.js";
import { issue, parseRuleSet, toMicro } from "./schema.js";

export interface ValidateResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Lowest asset id of a spot market. Anything below is a perp. */
export const SPOT_ASSET_ID_MIN = 10_000;

/**
 * @param input    untrusted rule set (parsed here; structural and static errors come back as issues)
 * @param hard     env hard limits
 * @param pairInfo live `spotMeta` data keyed by display name; a pair missing here is unknown
 */
export function validate(input: unknown, hard: HardLimits, pairInfo: PairInfoMap): ValidateResult {
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
