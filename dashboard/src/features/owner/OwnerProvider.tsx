import { t } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { chunkCalls, methodLabel, toTxAction, type OwnerMethod, type PlannedCall, type TxInput } from "@/lib/calls";
import { explorerTxUrl, VAULT_ID } from "@/lib/config";
import { useContractInfo, vaultKeys } from "@/lib/useVault";
import { useToast } from "@/kit";
import { outcomeTxHash, useWallet } from "@/features/wallet/WalletProvider";

export interface ActResult {
  ok: boolean;
  /** First transaction hash (explorer link). */
  hash: string | null;
}

export interface OwnerCtx {
  accountId: string | null;
  /** `get_contract_info.owner_id` (null until loaded). */
  ownerId: string | null;
  /** Connected account is the vault owner. Every owner action must be disabled unless this is true. */
  canAct: boolean;
  /** A wallet request is in flight. */
  busy: boolean;
  /** Set while a batch is split over several wallet requests: `done` of `total` transactions signed. */
  progress: { done: number; total: number } | null;
  /** Sign one owner call (deposit/gas from `buildCall`). Resolves true on success; errors and successes are toasted. */
  act: (method: OwnerMethod, args?: Record<string, unknown>) => Promise<boolean>;
  /** Several owner calls. Up to MAX_ACTIONS_PER_TX go into ONE transaction; more are split into consecutive requests with progress toasts. */
  actBatch: (calls: PlannedCall[], label?: string) => Promise<ActResult>;
  /** Raw transactions with any action type (create account, transfer, add/delete key, function calls) in ONE wallet request. `requireOwner: false` for e.g. deleting an agent key. */
  actTxs: (label: string, txs: TxInput[], opts?: { requireOwner?: boolean }) => Promise<ActResult>;
}

const Ctx = createContext<OwnerCtx | null>(null);

/** Owner gating + owner calls with toasts and query refresh. Read-only everywhere unless `canAct`. */
export const useOwner = (): OwnerCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOwner must be used inside <OwnerProvider>");
  return c;
};

const isRejection = (msg: string) => /reject|cancel|denied|declin/i.test(msg);

export function OwnerProvider({ children }: { children: ReactNode }) {
  const { accountId, signAndSendTransactions } = useWallet();
  const { data: info } = useContractInfo();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OwnerCtx["progress"]>(null);
  const ownerId = info?.owner_id ?? null;
  const canAct = ownerId !== null && accountId === ownerId;

  const refreshSoon = useCallback(() => {
    void qc.invalidateQueries({ queryKey: vaultKeys.all });
    setTimeout(() => void qc.invalidateQueries({ queryKey: vaultKeys.all }), 2000); // RPC may lag one block
  }, [qc]);

  /** Sign `requests` one wallet request after the other. Each request is a list of transactions. Never throws. */
  const run = useCallback(
    async (label: string, requests: TxInput[][]): Promise<ActResult> => {
      setBusy(true);
      let hash: string | null = null;
      try {
        for (const [i, txs] of requests.entries()) {
          if (requests.length > 1) setProgress({ done: i, total: requests.length });
          const outcome = await signAndSendTransactions(txs);
          hash ??= outcomeTxHash(outcome);
          if (requests.length > 1 && i < requests.length - 1) toast({ text: t("owner.partSubmitted", { label, done: i + 1, total: requests.length }), accent: "info" });
        }
        toast({ text: t("owner.submitted", { label }), accent: "ok", ...(hash ? { href: explorerTxUrl(hash) } : {}) });
        refreshSoon();
        return { ok: true, hash };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast(isRejection(msg) ? { text: t("owner.cancelled"), accent: "neutral" } : { text: t("owner.error", { label, msg }), accent: "danger", durationMs: 6000 });
        if (hash) refreshSoon(); // an earlier part of a split batch went through
        return { ok: false, hash };
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [signAndSendTransactions, toast, refreshSoon],
  );

  const actBatch = useCallback<OwnerCtx["actBatch"]>(
    async (calls, label) => {
      if (!canAct || calls.length === 0) return { ok: false, hash: null };
      const requests = chunkCalls(calls).map((c) => [{ receiverId: VAULT_ID, actions: c.map(toTxAction) }]);
      return run(label ?? t("owner.changes", { count: calls.length }), requests);
    },
    [canAct, run],
  );

  const act = useCallback<OwnerCtx["act"]>(
    async (method, args = {}) => {
      if (!canAct && method !== "accept_owner") return false; // accept_owner is sent by the proposed owner
      const r = await run(methodLabel(method), [[{ receiverId: VAULT_ID, actions: [toTxAction({ method, args })] }]]);
      return r.ok;
    },
    [canAct, run],
  );

  const actTxs = useCallback<OwnerCtx["actTxs"]>(
    async (label, txs, opts = {}) => {
      if ((opts.requireOwner !== false && !canAct) || txs.length === 0) return { ok: false, hash: null };
      return run(label, [txs]);
    },
    [canAct, run],
  );

  const value = useMemo(() => ({ accountId, ownerId, canAct, busy, progress, act, actBatch, actTxs }), [accountId, ownerId, canAct, busy, progress, act, actBatch, actTxs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
