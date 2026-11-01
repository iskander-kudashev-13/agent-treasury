// Policy-page data: TEE trust anchors and USDC token views. Same polling/shape as lib/useVault.ts.
import { useQuery } from "@tanstack/react-query";
import { POLL_MS, USDC_ID, VAULT_ID } from "./config";
import { view } from "./rpc";
import { vaultKeys } from "./useVault";

const enabled = VAULT_ID !== "";
const poll = { refetchInterval: POLL_MS, enabled, staleTime: POLL_MS / 2 } as const;
const EMPTY: never[] = [];

function shape<T>(q: { data: T | undefined; error: Error | null; isPending: boolean }, initial: T) {
  return { data: q.data ?? initial, error: q.error ? q.error.message : null, loading: enabled && q.isPending };
}

export const useApprovedMeasurements = () =>
  shape(useQuery({ queryKey: [...vaultKeys.all, "measurements"], queryFn: () => view<unknown[]>("get_approved_measurements", { limit: 100 }), ...poll }), EMPTY as unknown[]);
export const useApprovedPpids = () => shape(useQuery({ queryKey: [...vaultKeys.all, "ppids"], queryFn: () => view<string[]>("get_approved_ppids", { limit: 100 }), ...poll }), EMPTY as string[]);
export const useLocalWhitelist = () => shape(useQuery({ queryKey: [...vaultKeys.all, "whitelist"], queryFn: () => view<string[]>("get_whitelisted_agents_for_local"), ...poll }), EMPTY as string[]);

/* ───────────── USDC token views (deposit / withdraw modals) ───────────── */

export const usdcKeys = { all: ["usdc", USDC_ID] as const };
interface StorageBalance {
  total: string;
  available?: string;
}

/** `ft_balance_of(account)` on the USDC contract. Disabled without VITE_USDC_CONTRACT or an account. */
export const useUsdcBalance = (account: string | null) =>
  shape(
    useQuery({
      queryKey: [...usdcKeys.all, "balance", account],
      queryFn: () => view<string>("ft_balance_of", { account_id: account }, USDC_ID),
      enabled: USDC_ID !== "" && account !== null,
      refetchInterval: POLL_MS,
    }),
    null as string | null,
  );

/** `storage_balance_of(account)`: null result = not registered on the token (NEP-145). `data` is undefined while loading. */
export function useStorageRegistered(account: string | null) {
  const q = useQuery({
    queryKey: [...usdcKeys.all, "storage", account],
    queryFn: () => view<StorageBalance | null>("storage_balance_of", { account_id: account }, USDC_ID),
    enabled: USDC_ID !== "" && account !== null && account !== "",
    staleTime: POLL_MS,
  });
  return { registered: q.data === undefined ? undefined : q.data !== null, loading: q.isPending && q.fetchStatus !== "idle", error: q.error ? q.error.message : null };
}

/** `storage_balance_bounds().min` on the USDC contract (yoctoNEAR), or null when unavailable. */
export const useStorageMin = () =>
  useQuery({
    queryKey: [...usdcKeys.all, "bounds"],
    queryFn: async () => (await view<{ min: string }>("storage_balance_bounds", {}, USDC_ID)).min,
    enabled: USDC_ID !== "",
    staleTime: 10 * 60_000,
  }).data ?? null;
