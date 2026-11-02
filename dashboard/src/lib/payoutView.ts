/** Pure view logic for payouts: filters, explorer links, and the payout timeline (PayoutDetail.dc.html). */
import { chainName } from "../kit/tokens";
import { formatUsdc } from "./amount";
import { explorerAddressUrl, ONECLICK_SIMULATED } from "./config";
import { isSimulatedPayout } from "./oneclickStatus";
import { shortId } from "@/kit/tokens";
import type { AgentView, Payout, PayoutStatus } from "./types";

/* ───────────── filters ───────────── */

export type StatusFilter = "all" | "needs_approval" | "in_progress" | "confirmed" | "failed" | "refunded" | "rejected";
export type SourceFilter = "all" | "scheduled" | "on-demand";
export interface PayoutFilter {
  status: StatusFilter;
  /** agent id or "all" */
  agent: string;
  source: SourceFilter;
}
export const NO_FILTER: PayoutFilter = { status: "all", agent: "all", source: "all" };

const GROUP: Record<StatusFilter, readonly PayoutStatus[] | null> = {
  all: null,
  needs_approval: ["PendingApproval"],
  in_progress: ["Transferring", "Sent"],
  confirmed: ["Confirmed"],
  failed: ["Failed"],
  refunded: ["Refunded"],
  rejected: ["Rejected"],
};
export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All statuses",
  needs_approval: "Needs approval",
  in_progress: "In progress",
  confirmed: "Confirmed",
  failed: "Failed",
  refunded: "Refunded",
  rejected: "Rejected",
};

export const payoutSource = (p: Pick<Payout, "schedule_id">): "scheduled" | "on-demand" => (p.schedule_id !== null ? "scheduled" : "on-demand");

export function filterPayouts(list: Payout[], f: PayoutFilter): Payout[] {
  const statuses = GROUP[f.status];
  return list.filter((p) => (statuses === null || statuses.includes(p.status)) && (f.agent === "all" || p.agent_id === f.agent) && (f.source === "all" || payoutSource(p) === f.source));
}

export const isFiltered = (f: PayoutFilter): boolean => f.status !== "all" || f.agent !== "all" || f.source !== "all";

/* ───────────── links ───────────── */

const TX_URL: Record<string, string> = {
  base: "https://basescan.org/tx/",
  eth: "https://etherscan.io/tx/",
  ethereum: "https://etherscan.io/tx/",
  arb: "https://arbiscan.io/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  sol: "https://solscan.io/tx/",
  solana: "https://solscan.io/tx/",
  tron: "https://tronscan.org/#/transaction/",
};
/** Destination-chain explorer link for a tx hash, or null for chains without a known explorer. */
export function destinationTxUrl(chain: string, hash: string): string | null {
  const base = TX_URL[chain.trim().toLowerCase()];
  return base ? `${base}${encodeURIComponent(hash)}` : null;
}

/** NEAR Intents explorer page of a swap, keyed by deposit address (pattern from the Intents explorer; verify when it changes). */
export const intentsTrackUrl = (depositAddress: string): string => `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`;

/* ───────────── timeline ───────────── */

export type StepState = "done" | "active" | "todo" | "failed";
export interface TimelineItem {
  title: string;
  state: StepState;
  atMs?: number;
  /** Plain text lines (memo and other agent-supplied text are rendered as text by the component). */
  lines: string[];
  links: Array<{ label: string; href: string }>;
}

const APPROVAL_TEXT: Record<string, string> = {
  ABOVE_THRESHOLD: "Above the agent's approval threshold",
  OVERDUE_NEEDS_APPROVAL: "Overdue past the grace period (agent was offline)",
};

/** Five steps: requested, approved, transferring, sent to Intents, confirmed/refunded. */
/** `opts.simulated` defaults to the dashboard's testnet simulated-1Click mode (injected in tests). */
export function buildTimeline(p: Payout, agent: AgentView | undefined, opts: { simulated?: boolean } = {}): TimelineItem[] {
  const s = p.status;
  const chain = chainName(p.chain);
  const sentOut = s === "Sent" || s === "Confirmed" || s === "Refunded" || (s === "Failed" && p.funds_left === true);
  const transferFailed = s === "Failed" && p.funds_left !== true;

  const who = agent ? `${agent.name} (${agent.kind === "Tee" ? "TEE" : "key"} agent)` : p.agent_id;
  const requested: TimelineItem = {
    title: `Requested by ${who}`,
    state: "done",
    atMs: Number(p.created_at_ms),
    lines: [
      ...(p.agent_account ? [`Account ${p.agent_account}`] : []),
      p.schedule_id !== null ? `Scheduled payment #${p.schedule_id}` : "On demand",
      ...(p.memo ? [`Memo: ${p.memo}`] : []),
    ],
    links: [],
  };

  let approval: TimelineItem;
  const reason = p.approval_reason ? (APPROVAL_TEXT[p.approval_reason] ?? p.approval_reason) : null;
  if (s === "PendingApproval") approval = { title: "Waiting for your approval", state: "active", lines: reason ? [reason] : [], links: [] };
  else if (s === "Rejected") approval = { title: "Rejected by owner", state: "failed", atMs: Number(p.updated_at_ms), lines: ["Nothing was sent"], links: [] };
  else if (p.approval_reason) approval = { title: "Approved by owner", state: "done", lines: reason ? [reason] : [], links: [] };
  else approval = { title: "Policy check passed", state: "done", lines: ["Within the agent's limits, no approval needed"], links: [] };

  const afterApproval = s !== "PendingApproval" && s !== "Rejected";
  const transferring: TimelineItem = {
    title: "Reserved and transferring",
    state: !afterApproval ? "todo" : transferFailed ? "failed" : s === "Transferring" ? "active" : "done",
    lines: afterApproval ? [`${formatUsdc(p.amount)} USDC held in the vault`] : [],
    links: [],
  };
  if (transferFailed) {
    transferring.atMs = Number(p.updated_at_ms);
    transferring.lines.push("The transfer failed. Reservation released; daily limit restored");
  } else if (s === "Transferring") transferring.atMs = Number(p.updated_at_ms);

  const sent: TimelineItem = {
    title: "Sent to NEAR Intents",
    state: sentOut ? "done" : "todo",
    lines: p.deposit_address ? [`Deposit address ${shortId(p.deposit_address, 10, 8)}`] : [],
    links: p.deposit_address ? [{ label: "Deposit address on NEAR explorer", href: explorerAddressUrl(p.deposit_address) }] : [],
  };

  const final: TimelineItem = { title: `Arrives on ${chain}`, state: "todo", lines: [], links: [] };
  if (s === "Sent") {
    final.title = `Waiting for Intents to deliver on ${chain}`;
    final.state = "active";
  } else if (s === "Confirmed") {
    final.title = `Arrived on ${chain}`;
    final.state = "done";
    final.atMs = Number(p.updated_at_ms);
    final.lines.push(`Received by ${shortId(p.address, 8, 6)}`);
  } else if (s === "Refunded") {
    final.title = "Refunded to the vault";
    final.state = "failed";
    final.atMs = Number(p.updated_at_ms);
    final.lines.push(p.refund_credited ? "Refund credited back to the vault balance" : "Funds returned to the vault. The owner credits them with Credit refund");
  } else if (s === "Failed" && p.funds_left === true) {
    final.title = "Swap failed after sending";
    final.state = "failed";
    final.atMs = Number(p.updated_at_ms);
    final.lines.push(p.refund_credited ? "Refund credited back to the vault balance" : "Funds may be returned to the vault. The owner credits them with Credit refund");
  }
  if (isSimulatedPayout(p, opts.simulated ?? ONECLICK_SIMULATED)) {
    // Testnet simulated 1Click: the "destination tx" is a placeholder, nothing to link to.
    final.lines.push("Simulated 1Click (testnet): no real cross-chain transfer");
    return [requested, approval, transferring, sent, final];
  }
  if (p.deposit_address && sentOut) final.links.push({ label: "Track on Intents explorer", href: intentsTrackUrl(p.deposit_address) });
  if (s === "Confirmed" && p.tx_hash) {
    const href = destinationTxUrl(p.chain, p.tx_hash);
    if (href) final.links.push({ label: `${chain} tx ${shortId(p.tx_hash, 8, 6)}`, href });
    else final.lines.push(`Tx ${p.tx_hash}`);
  }
  return [requested, approval, transferring, sent, final];
}

/** "In progress · step 3 of 5" / "Money arrived" / "Refunded" ... for the detail header. */
export function timelineSummary(steps: TimelineItem[], status: PayoutStatus): { text: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (status === "Confirmed") return { text: "Money arrived", tone: "ok" };
  if (status === "Refunded") return { text: "Refunded", tone: "warn" };
  if (status === "Failed") return { text: "Failed", tone: "danger" };
  if (status === "Rejected") return { text: "Rejected", tone: "neutral" };
  const active = steps.findIndex((x) => x.state === "active");
  return { text: `In progress · step ${(active === -1 ? steps.length : active) + 1} of ${steps.length}`, tone: "warn" };
}
