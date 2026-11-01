import { useCallback } from "react";
import type { PlannedCall } from "@/lib/calls";
import { useOwner, type ActResult } from "@/features/owner/OwnerProvider";

export type SendResult = ActResult;

/** Thin adapter over `useOwner().actBatch` for the Payments forms and the assistant: `send(calls, label)` -> `{ ok, hash }`. */
export function useOwnerTx() {
  const { canAct, busy, actBatch } = useOwner();
  const send = useCallback((calls: PlannedCall[], label: string): Promise<SendResult> => actBatch(calls, label), [actBatch]);
  return { send, busy, canAct };
}
