/**
 * Trading-rules authoring for the assistant (ADR-0005 §4). The model fills a RuleSetV1; the worker validates it with the
 * same function that runs again at `POST /trading/rules/confirm`, and returns a card. Nothing here places an order,
 * signs, or calls the vault: the LLM output is data, and the owner signs the canonical hash in the dashboard.
 */
import { hashRuleSet } from "../trading/rules/canonical.js";
import { describe } from "../trading/rules/describe.js";
import { parseRuleSet } from "../trading/rules/schema.js";
import { toProposalValidation, validate } from "../trading/rules/validate.js";
import type { HardLimits, PairInfoMap, TradingRulesProposal } from "../trading/types.js";
import { cleanText } from "./proposals.js";
import type { TurnState } from "./proposals.js";

/** Fresh `spotMeta` data for validation. The real implementation comes from the HL adapter (`getSpotPairs`). */
export interface PairInfoProvider {
  getPairInfo(): Promise<PairInfoMap>;
}

/** What `buildTools` needs to offer `propose_trading_rules`. Absent = the tool is not offered (trading disabled). */
export interface TradingAuthoring {
  hard: HardLimits;
  pairs: PairInfoProvider;
}

/** The card the browser receives: the ADR payload plus the deterministic English lines for the review screen. */
export type TradingRulesCard = TradingRulesProposal & { lines: string[] };

/** Stub until the HL adapter exists: serves a fixed map (default empty, so every pair is "unknown" and rejected). */
export function stubPairInfoProvider(map: PairInfoMap = {}): PairInfoProvider {
  return { getPairInfo: () => Promise.resolve(map) };
}

export type TradingBuild =
  | { card: TradingRulesCard; errors?: undefined }
  /** Not a card (structural errors, or the pair data could not be loaded): sent back to the model. */
  | { card?: undefined; errors: string[] };

export async function buildTradingRulesCard(deps: TradingAuthoring, state: TurnState, rules: unknown, opts: { showInvalid: boolean }): Promise<TradingBuild> {
  let info: PairInfoMap;
  try {
    info = await deps.pairs.getPairInfo();
  } catch {
    return { errors: ["Could not load Hyperliquid pair data; tell the owner to try again shortly. Do not guess."] };
  }
  const v = validate(rules, deps.hard, info);
  const parsed = parseRuleSet(rules);
  const msgs = toProposalValidation(v);
  // Structurally broken input has no canonical form, so there is nothing to hash or show.
  if (!parsed.ok) return { errors: msgs.errors };
  // Limit / pair errors: back to the model first so it can fix them; the red card is only shown when it gives up.
  if (!v.ok && !opts.showInvalid) return { errors: msgs.errors };
  const rs = parsed.value;
  const lines = describe(rs);
  return {
    card: {
      id: state.nextId(),
      type: "TradingRules",
      title: `Trading rules: ${cleanText(rs.name, 60)}`,
      summary: `${rs.pairs.join(", ")} · ${rs.rules.length} rule${rs.rules.length === 1 ? "" : "s"} · max position ${rs.limits.max_position_usdc} USDC`,
      rules: rs,
      hash: hashRuleSet(rs),
      validation: msgs,
      confirm: { kind: "nep413", challenge: "/trading/rules/challenge", endpoint: "/trading/rules/confirm" },
      lines,
    },
  };
}

/** Tool description with the live hard limits, so the model can stay inside them. */
export function tradingToolDescription(h: HardLimits): string {
  return [
    "Prepare a card with a trading rule set (Hyperliquid SPOT only) for the owner to review and sign. You only fill the JSON; the server validates it and returns errors you must fix, then the owner signs. You cannot trade.",
    `Hard limits (rejected, never clamped; your limits may be lower): max_position_usdc <= ${h.maxPositionUsdc}, max_order_usdc <= ${h.maxOrderUsdc} (and >= 10), daily_loss_stop_usdc <= ${h.dailyLossUsdc}, max_orders_per_day <= ${h.maxOrdersPerDay}.`,
    `Allowed pairs: ${h.allowedPairs.join(", ") || "(none)"}. Decimals are strings ("10", "-3"). Rule ids: lowercase a-z0-9- up to 16 chars. cooldown is required unless the trigger is an interval.`,
    "Only use numbers the owner gave you. If the owner did not state an amount, a limit or a trigger, ask first.",
  ].join(" ");
}
