/**
 * `POST /trading/rules/propose` backend: one assistant turn restricted to the `propose_trading_rules` tool. Same tool,
 * same validator as the chat; the model output is data and nothing is signed or placed here.
 */
import { runChat } from "../ai/chat.js";
import type { AiDeps } from "../ai/route.js";
import { buildTools } from "../ai/tools.js";
import type { TradingAuthoring, TradingRulesCard } from "../ai/trading.js";
import type { RuleSetV1 } from "./types.js";

export interface ProposeResult {
  rules: RuleSetV1;
  hash: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  model: string;
}

export class ProposeError extends Error {
  constructor(
    readonly status: 400 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Proposer = (text: string, ownerAccount: string, signal: AbortSignal) => Promise<ProposeResult>;

export function createProposer(ai: AiDeps, authoring: TradingAuthoring): Proposer {
  const tools = buildTools({ trading: authoring }).filter((t) => t.name === "propose_trading_rules");
  return async (text, ownerAccount, signal) => {
    const cfg = ai.config;
    if (!cfg.apiKey) throw new ProposeError(502, "AI_NOT_CONFIGURED", "The AI assistant is not configured: set NEARAI_API_KEY in the worker environment.");
    const events = runChat(
      { model: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }, view: ai.view, tools, vault: cfg.vault, network: cfg.network, now: ai.now ?? Date.now, usdcAsset: ai.usdcAsset, maxRounds: 4 },
      [{ role: "user", content: text }],
      ownerAccount,
      signal,
    );
    let said = "";
    for await (const ev of events) {
      if (ev.type === "error") throw new ProposeError(502, "AI_ERROR", ev.message);
      if (ev.type === "text") said += ev.delta;
      if (ev.type === "proposal" && (ev.proposal as { type: string }).type === "TradingRules") {
        const card = ev.proposal as unknown as TradingRulesCard;
        return { rules: card.rules, hash: card.hash, validation: card.validation, model: cfg.model };
      }
    }
    throw new ProposeError(400, "NO_PROPOSAL", said.trim().slice(0, 500) || "The assistant did not produce a rule set. Describe the rules in more detail.");
  };
}
