import { t } from "@/i18n";
import type { AgentView } from "./types";

/** Footer line of the payout detail card (PayoutDetail.dc.html). */
export function agentTrustLine(agent: AgentView | undefined): { text: string; tone: "ok" | "neutral" } {
  if (!agent) return { text: t("pt.gone"), tone: "neutral" };
  if (agent.kind === "Tee") return agent.tee?.valid ? { text: t("pt.teeOk"), tone: "ok" } : { text: t("pt.teeBad"), tone: "neutral" };
  return { text: t("pt.key"), tone: "neutral" };
}
