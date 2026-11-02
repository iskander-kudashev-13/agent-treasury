/**
 * Trading-rules authoring for the assistant (ADR-0005 §4). The model fills a RuleSetV1; the worker validates it with the
 * same function that runs again at `POST /trading/rules/confirm`, and returns a card. Nothing here places an order,
 * signs, or calls the vault: the LLM output is data, and the owner signs the canonical hash in the dashboard.
 */
import { RegistryError, cleanBotName } from "../trading/bots.js";
import type { BotRegistry } from "../trading/bots.js";
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
  /** Absent = available. False while HL refuses the dead-man switch: limit orders then only get a warning. */
  deadManAvailable?: (() => boolean) | undefined;
  /** Bot registry (ADR-0006): the card names the bot it is for, taken from the request, never from the model. Absent = single-bot card for `default`. */
  bots?: { registry: BotRegistry; maxBots: number } | undefined;
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
  const v = validate(rules, deps.hard, info, { deadManAvailable: deps.deadManAvailable?.() ?? true });
  const parsed = parseRuleSet(rules);
  const msgs = toProposalValidation(v);
  // Structurally broken input has no canonical form, so there is nothing to hash or show.
  if (!parsed.ok) return { errors: msgs.errors };
  // Limit / pair errors: back to the model first so it can fix them; the red card is only shown when it gives up.
  if (!v.ok && !opts.showInvalid) return { errors: msgs.errors };
  const rs = parsed.value;
  const lines = describe(rs);
  const hash = hashRuleSet(rs);
  const target = resolveTarget(deps, state.tradingBot, rs.name);
  if (target.error !== undefined) return { errors: [target.error] };
  // Bot-level refusals (MAX_BOTS, rules already used by another bot ...) make the card red, like a limit error would.
  const botErrors: string[] = [];
  if (deps.bots) {
    try {
      deps.bots.registry.check({ botId: target.bot.id, hash, name: target.bot.name, maxBots: deps.bots.maxBots });
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      botErrors.push(`${e.code}: ${e.message}`);
    }
  }
  const validation = botErrors.length === 0 ? msgs : { ok: false, errors: [...msgs.errors, ...botErrors], warnings: msgs.warnings };
  return {
    card: {
      id: state.nextId(),
      type: "TradingRules",
      title: `Trading rules: ${cleanText(rs.name, 60)}`,
      summary: `${rs.pairs.join(", ")} · ${rs.rules.length} rule${rs.rules.length === 1 ? "" : "s"} · max position ${rs.limits.max_position_usdc} USDC`,
      rules: rs,
      hash,
      bot: target.bot,
      validation,
      confirm: { kind: "nep413", challenge: "/trading/rules/challenge", endpoint: "/trading/rules/confirm" },
      lines,
    },
  };
}

/**
 * The bot a card is for. `trading_bot` comes from the dashboard: "new" = a new strategy (id derived from the rule set name), an id =
 * changes to that bot. Absent (clients from before bots): the bot `default` if it exists, else a new one.
 */
function resolveTarget(deps: TradingAuthoring, requested: string | undefined, ruleSetName: string): { bot: TradingRulesProposal["bot"]; error?: undefined } | { error: string; bot?: undefined } {
  const reg = deps.bots?.registry;
  const name = cleanBotName(ruleSetName) || "Strategy";
  if (reg === undefined) return { bot: { id: "default", name, is_new: false } };
  const target = requested ?? (reg.get("default") !== undefined ? "default" : "new");
  if (target === "new") return { bot: { id: reg.suggestId(name), name, is_new: true } };
  const b = reg.get(target);
  if (b === undefined) return { error: `The bot '${target}' does not exist. Tell the owner to pick an existing strategy or start a new one in the dashboard.` };
  if (b.archived_at_ms !== null) return { error: `The bot '${target}' is archived and cannot get new rules. Tell the owner to start a new strategy.` };
  return { bot: { id: b.id, name: b.name, is_new: false } };
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
