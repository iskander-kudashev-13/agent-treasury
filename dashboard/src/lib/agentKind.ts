import type { AgentView } from "./types";

/**
 * What an agent DOES (not how it is trusted; that is `AgentView.kind` Tee/Key). Vault agents pay people. Trading agents
 * (ADR-0006) are worker-side bots, not vault agents: they are listed next to the vault agents (`features/trading/BotRows`)
 * and open `botPath(id)`. A vault agent flagged `domain: "trading"` would also route to the trading list.
 */
export type AgentDomain = "payments" | "trading";
export const agentDomain = (a: AgentView): AgentDomain => ((a as { domain?: string }).domain === "trading" ? "trading" : "payments");
export const TRADING_LIST_PATH = "/agents?kind=trading";
export const TRADING_CONNECT_PATH = "/trading/connect";
export const TRADING_NEW_PATH = "/trading/new";
export const botPath = (id: string): string => `/trading/bots/${encodeURIComponent(id)}`;
export const agentPath = (a: AgentView): string => (agentDomain(a) === "trading" ? TRADING_LIST_PATH : `/agents/${encodeURIComponent(a.id)}`);
