import type { MessageKey } from "@/i18n";
/** Pure view logic for payouts: filters, explorer links, and the payout timeline (PayoutDetail.dc.html). */
import { t } from "@/i18n";
import { chainName } from "../kit/tokens";
import { formatUsdc } from "./amount";
import { explorerAddressUrl, ONECLICK_SIMULATED } from "./config";
import { isSimulatedPayout } from "./oneclickStatus";
import { shortId } from "@/kit/tokens";
import type { AgentView, Payout, PayoutStatus, RecipientView } from "./types";

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
export const STATUS_FILTER_LABEL_KEY: Record<StatusFilter, MessageKey> = {
  all: "po.fAll",
  needs_approval: "po.fNeeds",
  in_progress: "po.fProgress",
  confirmed: "po.fConfirmed",
  failed: "po.fFailed",
  refunded: "po.fRefunded",
  rejected: "po.fRejected",
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

const APPROVAL_TEXT: Record<string, MessageKey> = {
  ABOVE_THRESHOLD: "po.aboveThreshold",
  OVERDUE_NEEDS_APPROVAL: "pv.overdueGrace",
};

/** Five steps: requested, approved, transferring, sent to Intents, confirmed/refunded. */
/** `opts.simulated` defaults to the dashboard's testnet simulated-1Click mode (injected in tests). */
export function buildTimeline(p: Payout, agent: AgentView | undefined, opts: { simulated?: boolean } = {}): TimelineItem[] {
  const s = p.status;
  const chain = chainName(p.chain);
  const sentOut = s === "Sent" || s === "Confirmed" || s === "Refunded" || (s === "Failed" && p.funds_left === true);
  const transferFailed = s === "Failed" && p.funds_left !== true;

  const who = agent ? t(agent.kind === "Tee" ? "pv.agentTee" : "pv.agentKey", { name: agent.name }) : p.agent_id;
  const requested: TimelineItem = {
    title: t("pv.requestedBy", { who }),
    state: "done",
    atMs: Number(p.created_at_ms),
    lines: [
      ...(p.agent_account ? [t("pv.account", { account: p.agent_account })] : []),
      p.schedule_id !== null ? t("pv.scheduledN", { id: p.schedule_id }) : t("pv.onDemand"),
      ...(p.memo ? [t("pv.memo", { memo: p.memo })] : []),
    ],
    links: [],
  };

  let approval: TimelineItem;
  const reason = p.approval_reason ? (APPROVAL_TEXT[p.approval_reason] ? t(APPROVAL_TEXT[p.approval_reason]!) : p.approval_reason) : null;
  if (s === "PendingApproval") approval = { title: t("pv.waitingApproval"), state: "active", lines: reason ? [reason] : [], links: [] };
  else if (s === "Rejected") approval = { title: t("pv.rejectedByOwner"), state: "failed", atMs: Number(p.updated_at_ms), lines: [t("pv.nothingSent")], links: [] };
  else if (p.approval_reason) approval = { title: t("pv.approvedByOwner"), state: "done", lines: reason ? [reason] : [], links: [] };
  else approval = { title: t("pv.policyPassed"), state: "done", lines: [t("pv.withinLimits")], links: [] };

  const afterApproval = s !== "PendingApproval" && s !== "Rejected";
  const transferring: TimelineItem = {
    title: t("pv.reserved"),
    state: !afterApproval ? "todo" : transferFailed ? "failed" : s === "Transferring" ? "active" : "done",
    lines: afterApproval ? [t("pv.held", { amount: formatUsdc(p.amount) })] : [],
    links: [],
  };
  if (transferFailed) {
    transferring.atMs = Number(p.updated_at_ms);
    transferring.lines.push(t("pv.transferFailed"));
  } else if (s === "Transferring") transferring.atMs = Number(p.updated_at_ms);

  const sent: TimelineItem = {
    title: t("pv.sentToIntents"),
    state: sentOut ? "done" : "todo",
    lines: p.deposit_address ? [t("pv.depositShort", { addr: shortId(p.deposit_address, 10, 8) })] : [],
    links: p.deposit_address ? [{ label: t("pv.depositLink"), href: explorerAddressUrl(p.deposit_address) }] : [],
  };

  const final: TimelineItem = { title: t("pv.arrives", { chain }), state: "todo", lines: [], links: [] };
  if (s === "Sent") {
    final.title = t("pv.waitingDeliver", { chain });
    final.state = "active";
  } else if (s === "Confirmed") {
    final.title = t("pv.arrived", { chain });
    final.state = "done";
    final.atMs = Number(p.updated_at_ms);
    final.lines.push(t("pv.receivedBy", { addr: shortId(p.address, 8, 6) }));
  } else if (s === "Refunded") {
    final.title = t("pv.refundedVault");
    final.state = "failed";
    final.atMs = Number(p.updated_at_ms);
    final.lines.push(p.refund_credited ? t("pv.refundCredited") : t("pv.refundOwnerCredits"));
  } else if (s === "Failed" && p.funds_left === true) {
    final.title = t("pv.swapFailedAfter");
    final.state = "failed";
    final.atMs = Number(p.updated_at_ms);
    final.lines.push(p.refund_credited ? t("pv.refundCredited") : t("pv.mayReturn"));
  }
  if (isSimulatedPayout(p, opts.simulated ?? ONECLICK_SIMULATED)) {
    // Testnet simulated 1Click: the "destination tx" is a placeholder, nothing to link to.
    final.lines.push(t("pv.simulated"));
    return [requested, approval, transferring, sent, final];
  }
  if (p.deposit_address && sentOut) final.links.push({ label: t("pv.trackLink"), href: intentsTrackUrl(p.deposit_address) });
  if (s === "Confirmed" && p.tx_hash) {
    const href = destinationTxUrl(p.chain, p.tx_hash);
    if (href) final.links.push({ label: t("pv.chainTx", { chain, hash: shortId(p.tx_hash, 8, 6) }), href });
    else final.lines.push(t("pv.tx", { hash: p.tx_hash }));
  }
  return [requested, approval, transferring, sent, final];
}

/** "In progress · step 3 of 5" / "Money arrived" / "Refunded" ... for the detail header. */
export function timelineSummary(steps: TimelineItem[], status: PayoutStatus): { text: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (status === "Confirmed") return { text: t("pv.arrivedSum"), tone: "ok" };
  if (status === "Refunded") return { text: t("status.Refunded"), tone: "warn" };
  if (status === "Failed") return { text: t("status.Failed"), tone: "danger" };
  if (status === "Rejected") return { text: t("status.Rejected"), tone: "neutral" };
  const active = steps.findIndex((x) => x.state === "active");
  return { text: t("pv.inProgress", { n: (active === -1 ? steps.length : active) + 1, total: steps.length }), tone: "warn" };
}

const sameDest = (chain: string, a: string, b: string): boolean =>
  /^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Display name for a payout's destination: the vault recipient, else (on-demand payouts) the label from the requesting
 * agent's allowlist or a vault recipient with the same chain and address, else the short address. Untrusted text.
 */
export function payoutLabel(p: Pick<Payout, "recipient_id" | "agent_id" | "chain" | "address">, recipients: RecipientView[], agents: AgentView[]): string {
  if (p.recipient_id !== null) return recipients.find((r) => r.id === p.recipient_id)?.label ?? t("call.recipientN", { id: p.recipient_id });
  const listed = agents.find((a) => a.id === p.agent_id)?.mandate.allowlist.find((d) => d.chain === p.chain && sameDest(d.chain, d.address, p.address));
  if (listed?.label) return listed.label;
  const known = recipients.find((r) => r.destination_chain === p.chain && sameDest(r.destination_chain, r.destination_address, p.address));
  if (known) return known.label;
  return p.address ? shortId(p.address, 6, 4) : t("po.adHoc");
}
