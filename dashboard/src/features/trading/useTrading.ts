import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { clearSession, loadSession } from "@/lib/assistantClient";
import { POLL_MS, WORKER_URL } from "@/lib/config";
import { ensureSession, fetchActiveRules, fetchTradingLog, fetchTradingStatus, TradingHttpError, type ConfirmedRules, type LogEntry, type TradingStatusResult } from "@/lib/tradingClient";
import { hashRuleSet } from "@/lib/tradingRules";
import { useWallet } from "@/features/wallet/WalletProvider";

export const tradingKeys = {
  all: ["trading", WORKER_URL] as const,
  status: () => [...tradingKeys.all, "status"] as const,
  details: (account: string) => [...tradingKeys.all, "details", account] as const,
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Public `GET /trading/status`, polled like the other worker views. `data` is `{ enabled: false }` when trading is off. */
export function useTradingStatus() {
  const q = useQuery<TradingStatusResult>({
    queryKey: tradingKeys.status(),
    queryFn: ({ signal }) => fetchTradingStatus(signal),
    enabled: WORKER_URL !== "",
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    retry: false,
  });
  return { status: q.data ?? null, loading: WORKER_URL !== "" && q.isPending, error: WORKER_URL === "" ? "VITE_WORKER_URL is not set" : q.error ? errText(q.error) : null, refresh: () => q.refetch() };
}

/**
 * Owner-only reads (`/trading/rules`, `/trading/log`) need the NEP-413 session. Signing in is a wallet prompt, so it only
 * happens when the owner asks for it ("Sign in to see details"), never on page load.
 */
export function useOwnerDetails() {
  const { accountId, signMessage } = useWallet();
  const qc = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bumps after sign-in / sign-out so `token` is re-read
  const token = accountId ? (loadSession(accountId)?.token ?? null) : null;

  const q = useQuery<{ log: LogEntry[]; rules: ConfirmedRules | null; rulesVerified: boolean }>({
    queryKey: [...tradingKeys.details(accountId ?? ""), version],
    enabled: WORKER_URL !== "" && token !== null,
    refetchInterval: POLL_MS * 3,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        const [log, rules] = await Promise.all([fetchTradingLog(token!, 50, signal), fetchActiveRules(token!, signal)]);
        // The worker is not trusted for what the rules say: they must hash to what the owner signed.
        const rulesVerified = rules !== null && (await hashRuleSet(rules.rules)) === rules.hash;
        return { log, rules: rulesVerified ? rules : null, rulesVerified };
      } catch (e) {
        if (e instanceof TradingHttpError && e.status === 401) {
          clearSession();
          setVersion((v) => v + 1);
        }
        throw e;
      }
    },
  });

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!accountId) return false;
    setSigningIn(true);
    setAuthError(null);
    try {
      await ensureSession(accountId, signMessage);
      setVersion((v) => v + 1);
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      return true;
    } catch (e) {
      setAuthError(errText(e));
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [accountId, signMessage, qc]);

  return { signedIn: token !== null, signIn, signingIn, authError, log: q.data?.log ?? [], rules: q.data?.rules ?? null, rulesVerified: q.data?.rulesVerified ?? true, loading: token !== null && q.isPending, error: q.error ? errText(q.error) : null };
}
