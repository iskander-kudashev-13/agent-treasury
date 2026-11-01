import type { AgentView } from "./types";

/** Footer line of the payout detail card (PayoutDetail.dc.html). */
export function agentTrustLine(agent: AgentView | undefined): { text: string; tone: "ok" | "neutral" } {
  if (!agent) return { text: "Requesting agent no longer listed", tone: "neutral" };
  if (agent.kind === "Tee") return agent.tee?.valid ? { text: "Requested by a TEE agent with an approved attestation", tone: "ok" } : { text: "Requested by a TEE agent whose attestation is not currently valid", tone: "neutral" };
  return { text: "Requested by a key agent, within the limits of its mandate", tone: "neutral" };
}
