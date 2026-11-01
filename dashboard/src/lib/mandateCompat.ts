import { usdcGrouped } from "./amount";
import type { AgentView } from "./types";

export interface CompatIssue {
  code: "AGENT_UNAVAILABLE" | "RECIPIENT_NOT_IN_MANDATE" | "CHAIN_NOT_ALLOWED" | "ABOVE_PER_TX_LIMIT" | "BELOW_MIN_PAYMENT" | "ABOVE_APPROVAL_THRESHOLD";
  message: string;
  /** Link label the UI may render next to the message. */
  action?: string;
}
export interface CompatResult {
  /** Red: block Save. */
  errors: CompatIssue[];
  /** Amber: allow Save. */
  warnings: CompatIssue[];
}

/**
 * ADR-0004 §4: is `agent` allowed to pay this recipient and amount? Pure; copy from UI_UPDATES §4.2.
 * The contract re-checks all of this on add/update_schedule and at payment time.
 */
export function checkMandateCompat(input: {
  agent: AgentView | undefined;
  recipient: { id: number | null; chain: string; address: string };
  /** Raw USDC units. */
  amount: string;
  minPayment?: string;
}): CompatResult {
  const errors: CompatIssue[] = [];
  const warnings: CompatIssue[] = [];
  const { agent, recipient } = input;
  if (!agent || agent.status === "Revoked") {
    errors.push({ code: "AGENT_UNAVAILABLE", message: agent ? `${agent.id} is revoked and can't pay anything` : "Select an agent" });
    return { errors, warnings };
  }
  const m = agent.mandate;
  const name = agent.id;

  let allowed: boolean;
  if (m.recipients_mode === "Fixed") allowed = recipient.id !== null && m.recipients.includes(recipient.id);
  else if (m.recipients_mode === "Allowlist") allowed = m.allowlist.some((d) => d.chain === recipient.chain && d.address === recipient.address);
  else allowed = true;
  if (!allowed) errors.push({ code: "RECIPIENT_NOT_IN_MANDATE", message: `${name} can't pay this recipient (not in its mandate)`, action: `Edit ${name}'s mandate` });

  if (!m.allowed_chains.includes(recipient.chain)) {
    errors.push({ code: "CHAIN_NOT_ALLOWED", message: `${name} can't pay on ${recipient.chain} (chain not in its mandate)`, action: `Edit ${name}'s mandate` });
  }

  const amount = BigInt(input.amount || "0");
  if (amount > BigInt(m.per_tx_limit)) {
    errors.push({ code: "ABOVE_PER_TX_LIMIT", message: `Amount exceeds ${name}'s per-payment limit (${usdcGrouped(m.per_tx_limit, 0)})` });
  }
  if (input.minPayment !== undefined && amount < BigInt(input.minPayment)) {
    errors.push({ code: "BELOW_MIN_PAYMENT", message: `Amount is below the vault's minimum payment (${usdcGrouped(input.minPayment, 0)})` });
  }
  if (amount > BigInt(m.approval_threshold)) {
    warnings.push({
      code: "ABOVE_APPROVAL_THRESHOLD",
      message: `Above ${name}'s approval threshold (${usdcGrouped(m.approval_threshold, 0)}): each payment will wait for your approval.`,
    });
  }
  return { errors, warnings };
}
