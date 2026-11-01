// Per-agent server state (TanStack Query). Keys live under `vaultKeys.all` so every signed call refreshes them.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { view } from "@/lib/rpc";
import { vaultKeys, POLL_MS_FOR_AGENTS } from "./polling";
import type { DueItem, Payout, Rejection } from "@/lib/types";

export interface AgentBudget {
  agent_id: string;
  remaining_today: string;
  vault_remaining_today: string;
  per_tx_limit: string;
  approval_threshold: string;
  allowed_chains: string[];
  recipients_mode: "Fixed" | "Allowlist" | "Open";
  expires_at: string | null;
  status: string;
  vault_paused: boolean;
  balance: string;
  min_payment: string;
  max_payments_per_day: number;
  payments_today: number;
}

const poll = POLL_MS_FOR_AGENTS;
const NONE_P: Payout[] = [];
const NONE_R: Rejection[] = [];
const NONE_D: DueItem[] = [];

export function useAgentBudget(agentId: string) {
  const q = useQuery({ queryKey: [...vaultKeys.all, "agent-budget", agentId], queryFn: () => view<AgentBudget | null>("get_agent_budget", { agent_id: agentId }), ...poll, enabled: poll.enabled && agentId !== "" });
  return { data: q.data ?? null, loading: q.isPending && poll.enabled, error: q.error instanceof Error ? q.error.message : null };
}

export const AGENT_PAYOUT_PAGE = 10;

/** Newest first. `get_payouts({agent_id})` indexes the agent's own list oldest-first, so the newest page is fetched from the end. */
export function useAgentPayouts(agentId: string) {
  const [limit, setLimit] = useState(AGENT_PAYOUT_PAGE);
  const q = useQuery({
    queryKey: [...vaultKeys.all, "agent-payouts", agentId, limit],
    queryFn: async () => {
      const total = Number(await view<string>("get_agent_payouts_count", { agent_id: agentId }));
      const from = Math.max(0, total - limit);
      const list = total === 0 ? [] : await view<Payout[]>("get_payouts", { from_index: from, limit: total - from, agent_id: agentId });
      return { total, list: list.reverse() };
    },
    placeholderData: (prev) => prev,
    ...poll,
    enabled: poll.enabled && agentId !== "",
  });
  const data = q.data ?? { total: 0, list: NONE_P };
  return { total: data.total, list: data.list, loading: q.isPending && poll.enabled, error: q.error instanceof Error ? q.error.message : null, hasMore: data.list.length < data.total, loadMore: () => setLimit((n) => n + AGENT_PAYOUT_PAGE) };
}

export function useAgentRejections(agentId: string) {
  const q = useQuery({ queryKey: [...vaultKeys.all, "agent-rejections", agentId], queryFn: () => view<Rejection[]>("get_rejections", { agent_id: agentId, limit: 50 }), ...poll, enabled: poll.enabled && agentId !== "" });
  return { list: q.data ?? NONE_R, loading: q.isPending && poll.enabled };
}

/** Scheduled payments this agent should already have paid and didn't within the grace period ("Missed N"). */
export function useAgentMissed(agentId: string) {
  const q = useQuery({ queryKey: [...vaultKeys.all, "agent-due", agentId], queryFn: () => view<DueItem[]>("get_due", { agent_id: agentId, limit: 100 }), ...poll, enabled: poll.enabled && agentId !== "" });
  const due = q.data ?? NONE_D;
  return useMemo(() => ({ due, missed: due.filter((d) => d.overdue) }), [due]);
}

/** Overdue scheduled payments per agent id, for the list badges. */
export function useMissedByAgent() {
  const q = useQuery({ queryKey: [...vaultKeys.all, "due-all"], queryFn: () => view<DueItem[]>("get_due", { limit: 500 }), ...poll });
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const d of q.data ?? NONE_D) if (d.overdue) m.set(d.agent_id, (m.get(d.agent_id) ?? 0) + 1);
    return m;
  }, [q.data]);
}
