import { useQuery } from "@tanstack/react-query";
import { POLL_MS, VAULT_ID } from "./config";
import { view } from "./rpc";
import type { Payout } from "./types";
import { vaultKeys } from "./useVault";

/** One payout by id (`get_payout`). `payout === null` after load = no such payout. Polls like the other vault views. */
export function usePayout(id: string) {
  const valid = /^\d+$/.test(id);
  const q = useQuery({
    queryKey: [...vaultKeys.all, "payout", id],
    queryFn: () => view<Payout | null>("get_payout", { payout_id: id }),
    enabled: VAULT_ID !== "" && valid,
    refetchInterval: POLL_MS,
  });
  return { payout: valid ? (q.data ?? null) : null, loading: valid && q.isPending, error: q.error ? q.error.message : null, valid };
}
