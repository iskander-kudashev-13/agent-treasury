import { useCallback } from "react";
import { useOwner } from "@/features/owner/OwnerProvider";
import type { OwnerMethod, TxInput } from "@/lib/calls";

/** Thin adapter over `useOwner()` for the agent screens: `call` = one owner call, `sign` = raw transactions (create account, add key ...). */
export function useAgentTx() {
  const { canAct, accountId, busy, act, actTxs } = useOwner();
  const call = useCallback((method: OwnerMethod, args: Record<string, unknown> = {}): Promise<boolean> => act(method, args), [act]);
  const sign = useCallback(
    async (label: string, txs: TxInput[], opts: { requireOwner?: boolean } = {}): Promise<boolean> => (await actTxs(label, txs, opts)).ok,
    [actTxs],
  );
  return { canAct, accountId, busy, call, sign };
}
