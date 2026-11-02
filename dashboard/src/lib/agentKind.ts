import type { AgentView } from "./types";

/**
 * Extension point: what an agent DOES (not how it is trusted; that is `AgentView.kind` Tee/Key).
 * Trading agents will be added here: return "trading" for them, then `agentPath` routes their detail page
 * and `AgentKindBadge` labels the row. Today every vault agent pays people.
 */
export type AgentDomain = "payments" | "trading";
export const agentDomain = (a: AgentView): AgentDomain => ((a as { domain?: string }).domain === "trading" ? "trading" : "payments");
export const agentPath = (a: AgentView): string => (agentDomain(a) === "trading" ? "/trading" : `/agents/${encodeURIComponent(a.id)}`);
