// Server state for the dashboard: TanStack Query hooks over contract views and the worker API.
// Every hook polls every POLL_MS (10 s). Mutations (features/owner) invalidate `vaultKeys.all`.
import { t } from "@/i18n";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { POLL_MS, VAULT_ID, WORKER_URL } from "./config";
import { view } from "./rpc";
import type { AgentView, BalanceView, ContractInfo, Payout, PolicyView, RecipientView, Rejection, Schedule, UpcomingItem, WorkerStatus } from "./types";

export const PAYOUT_PAGE = 20;

export const vaultKeys = {
  all: ["vault", VAULT_ID] as const,
  info: () => [...vaultKeys.all, "info"] as const,
  policy: () => [...vaultKeys.all, "policy"] as const,
  balance: () => [...vaultKeys.all, "balance"] as const,
  recipients: () => [...vaultKeys.all, "recipients"] as const,
  payouts: (limit: number) => [...vaultKeys.all, "payouts", limit] as const,
  pending: () => [...vaultKeys.all, "pending"] as const,
  agents: () => [...vaultKeys.all, "agents"] as const,
  rejections: () => [...vaultKeys.all, "rejections"] as const,
  schedules: () => [...vaultKeys.all, "schedules"] as const,
  upcoming: (days: number) => [...vaultKeys.all, "upcoming", days] as const,
};
export const workerKeys = { all: ["worker", WORKER_URL] as const, status: () => [...workerKeys.all, "status"] as const, runs: () => [...workerKeys.all, "runs"] as const };

const enabled = VAULT_ID !== "";
const poll = { refetchInterval: POLL_MS, enabled, staleTime: POLL_MS / 2 } as const;
const errMsg = (e: unknown): string | null => (e === null || e === undefined ? null : e instanceof Error ? e.message : String(e));

/** Query result reduced to what screens need: `data` is never undefined. */
function shape<T, I = T>(q: UseQueryResult<T, Error>, initial: I): { data: T | I; error: string | null; loading: boolean; refresh: () => Promise<void> } {
  return { data: q.data ?? initial, error: errMsg(q.error), loading: enabled && q.isPending, refresh: async () => void (await q.refetch()) };
}

const NO_RECIPIENTS: RecipientView[] = [];
const NO_PAYOUTS: Payout[] = [];
const NO_AGENTS: AgentView[] = [];
const NO_REJECTIONS: Rejection[] = [];
const NO_SCHEDULES: Schedule[] = [];
const NO_UPCOMING: UpcomingItem[] = [];

/* ───────────── single-view hooks ───────────── */

export const useContractInfo = () => shape(useQuery({ queryKey: vaultKeys.info(), queryFn: () => view<ContractInfo>("get_contract_info"), ...poll }), null);
export const usePolicy = () => shape(useQuery({ queryKey: vaultKeys.policy(), queryFn: () => view<PolicyView>("get_policy"), ...poll }), null);
export const useBalance = () => shape(useQuery({ queryKey: vaultKeys.balance(), queryFn: () => view<BalanceView>("get_balance"), ...poll }), null);
export const useRecipients = () => shape(useQuery({ queryKey: vaultKeys.recipients(), queryFn: () => view<RecipientView[]>("get_recipients", { limit: 200 }), ...poll }), NO_RECIPIENTS);
export const usePendingApprovals = () => shape(useQuery({ queryKey: vaultKeys.pending(), queryFn: () => view<Payout[]>("get_pending_approvals"), ...poll }), NO_PAYOUTS);
export const useAgents = () => shape(useQuery({ queryKey: vaultKeys.agents(), queryFn: () => view<AgentView[]>("get_agents"), ...poll }), NO_AGENTS);
export const useRejections = () => shape(useQuery({ queryKey: vaultKeys.rejections(), queryFn: () => view<Rejection[]>("get_rejections", { limit: 50 }), ...poll }), NO_REJECTIONS);

/** All schedules (the contract caps them at 500). */
export const useSchedules = () => shape(useQuery({ queryKey: vaultKeys.schedules(), queryFn: () => view<Schedule[]>("get_schedules", { limit: 500 }), ...poll }), NO_SCHEDULES);

/** Scheduled payments due in `[now, now + rangeDays]` (contract window limit: 62 days). */
export function useUpcoming(rangeDays: 7 | 30 | number) {
  const days = Math.min(Math.max(1, Math.floor(rangeDays)), 62);
  return shape(
    useQuery({
      queryKey: vaultKeys.upcoming(days),
      queryFn: () => {
        const from = Date.now();
        return view<UpcomingItem[]>("get_upcoming", { from_ms: String(from), to_ms: String(from + days * 86_400_000), limit: 500 });
      },
      ...poll,
    }),
    NO_UPCOMING,
  );
}

/** Newest `limit` payouts, newest first. `total` is `get_payouts_count`. */
export function usePayouts(limit = PAYOUT_PAGE) {
  const q = useQuery({
    queryKey: vaultKeys.payouts(limit),
    queryFn: async () => {
      const count = Number(await view<string>("get_payouts_count"));
      const from = Math.max(0, count - limit);
      const list = count === 0 ? [] : await view<Payout[]>("get_payouts", { from_index: from, limit: count - from });
      return { total: count, list: list.reverse() };
    },
    placeholderData: (prev) => prev, // keep the old list while "Load older" fetches
    ...poll,
  });
  return { ...shape(q, { total: 0, list: NO_PAYOUTS }) };
}

/* ───────────── composed hook (kept for existing screens) ───────────── */

export interface VaultState {
  info: ContractInfo | null;
  policy: PolicyView | null;
  balance: BalanceView | null;
  recipients: RecipientView[];
  payouts: Payout[];
  payoutsTotal: number;
  pending: Payout[];
  agents: AgentView[];
  rejections: Rejection[];
}

/** Everything at once: `{ state, errors, loading, refresh, loadMorePayouts }`. Prefer the single-view hooks in new code. */
export function useVault() {
  const qc = useQueryClient();
  const [payoutLimit, setPayoutLimit] = useState(PAYOUT_PAGE);
  const info = useContractInfo();
  const policy = usePolicy();
  const balance = useBalance();
  const recipients = useRecipients();
  const payouts = usePayouts(payoutLimit);
  const pending = usePendingApprovals();
  const agents = useAgents();
  const rejections = useRejections();
  const all = [
    ["get_contract_info", info],
    ["get_policy", policy],
    ["get_balance", balance],
    ["get_recipients", recipients],
    ["get_payouts", payouts],
    ["get_pending_approvals", pending],
    ["get_agents", agents],
    ["get_rejections", rejections],
  ] as const;
  const state: VaultState = {
    info: info.data,
    policy: policy.data,
    balance: balance.data,
    recipients: recipients.data,
    payouts: payouts.data.list,
    payoutsTotal: payouts.data.total,
    pending: pending.data,
    agents: agents.data,
    rejections: rejections.data,
  };
  const errors = all.flatMap(([name, q]) => (q.error ? [`${name}: ${q.error}`] : []));
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: vaultKeys.all }), [qc]);
  return { state, errors, loading: all.some(([, q]) => q.loading), refresh, loadMorePayouts: () => setPayoutLimit((n) => n + PAYOUT_PAGE) };
}

/* ───────────── worker ───────────── */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`);
  if (!res.ok) throw new Error(t("net.http", { status: res.status }));
  return (await res.json()) as T;
}
const workerPoll = { refetchInterval: POLL_MS, enabled: WORKER_URL !== "", retry: false } as const;

/** Worker `/status` + `/runs`. `error` is set when the worker is unset or unreachable (agent card shows "offline"). */
export function useWorker() {
  const statusQ = useQuery({ queryKey: workerKeys.status(), queryFn: () => getJson<WorkerStatus>("/status"), ...workerPoll });
  const runsQ = useQuery({
    queryKey: workerKeys.runs(),
    queryFn: async () => {
      const body = await getJson<unknown>("/runs");
      return Array.isArray(body) ? (body as unknown[]) : [];
    },
    ...workerPoll,
  });
  const qc = useQueryClient();
  const error = WORKER_URL === "" ? t("net.workerUrlMissing") : statusQ.error ? t("net.workerUnreachable", { msg: errMsg(statusQ.error) ?? "" }) : null;
  return {
    status: statusQ.error ? null : (statusQ.data ?? null),
    runs: runsQ.data ?? [],
    error,
    refresh: () => qc.invalidateQueries({ queryKey: workerKeys.all }),
  };
}
