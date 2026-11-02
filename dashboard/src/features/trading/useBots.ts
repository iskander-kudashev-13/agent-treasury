import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { POLL_MS, WORKER_URL } from "@/lib/config";
import { ensureSession, TradingHttpError, type BotDetail, type BotFill, type BotHistory, type BotMetrics, type TradingStatus } from "@/lib/tradingClient";
import { currentToken, loadBotDetail, loadBotFills, loadBotHistory, loadBotMetrics, loadBots, loadCandles, loadMarkerFills, type BotCtx, type BotsLoad, type Candle } from "@/lib/tradingBots";
import { candleStartMs, rangeStartMs, type HistoryRange } from "@/lib/tradingMetrics";
import { useNow } from "@/lib/useNow";
import { clearSession } from "@/lib/assistantClient";
import { useWallet } from "@/features/wallet/WalletProvider";
import { tradingKeys } from "./useTrading";

const EMPTY_CANDLES: Candle[] = [];
const EMPTY_FILLS: BotFill[] = [];
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const botKeys = { all: [...tradingKeys.all, "bots"] as const };

/** The owner's worker session, shared through the query cache. Signing in is a wallet prompt, so only on the owner's click. */
export function useOwnerToken() {
  const { accountId, signMessage } = useWallet();
  const qc = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const key = [...tradingKeys.all, "token", accountId ?? ""] as const;
  const q = useQuery<string | null>({ queryKey: key, queryFn: () => currentToken(accountId), staleTime: 30_000, refetchInterval: 60_000 });
  const token = accountId ? (q.data ?? currentToken(accountId)) : null;
  const signIn = useCallback(async (): Promise<boolean> => {
    if (!accountId) return false;
    setSigningIn(true);
    setAuthError(null);
    try {
      const s = await ensureSession(accountId, signMessage);
      qc.setQueryData(key, s.token);
      void qc.invalidateQueries({ queryKey: botKeys.all });
      return true;
    } catch (e) {
      setAuthError(errText(e));
      return false;
    } finally {
      setSigningIn(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, signMessage, qc]);
  const expire = useCallback(() => {
    clearSession();
    qc.setQueryData(key, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, accountId]);
  return { token, signedIn: token !== null, signIn, signingIn, authError, expire };
}

/** The list of bots, polled. `mode` says whether the worker has `/trading/bots` or the single bot was synthesized. */
export function useBots() {
  const { token, ...auth } = useOwnerToken();
  const q = useQuery<BotsLoad>({
    queryKey: [...botKeys.all, "list", token ?? ""],
    queryFn: ({ signal }) => loadBots(token, signal),
    enabled: WORKER_URL !== "",
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    retry: false,
  });
  return { data: q.data ?? null, loading: WORKER_URL !== "" && q.isPending, error: q.error ? errText(q.error) : null, refresh: () => q.refetch(), token, ...auth };
}

/** Context for the detail loaders. Null until the list (mode + status) is known. */
export function useBotCtx(): { ctx: BotCtx | null; load: ReturnType<typeof useBots> } {
  const load = useBots();
  const s = load.data?.status;
  const ctx = load.data && s && s.enabled ? { mode: load.data.mode, token: load.token, status: s as TradingStatus } : null;
  return { ctx, load };
}

const ctxKey = (c: BotCtx | null) => [c?.mode ?? "", c?.token ?? "", c?.status.hl_account ?? ""] as const;

function useGuard(token: string | null) {
  const { expire } = useOwnerToken();
  return useCallback(
    (e: unknown) => {
      if (token && e instanceof TradingHttpError && e.status === 401) expire();
    },
    [token, expire],
  );
}

export function useBotDetail(ctx: BotCtx | null, id: string) {
  const guard = useGuard(ctx?.token ?? null);
  const q = useQuery<BotDetail | null>({
    queryKey: [...botKeys.all, "detail", id, ...ctxKey(ctx)],
    enabled: ctx !== null,
    refetchInterval: POLL_MS * 2,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return await loadBotDetail(ctx!, id, signal);
      } catch (e) {
        guard(e);
        throw e;
      }
    },
  });
  return { detail: q.data ?? null, loading: ctx === null || q.isPending, error: q.error ? errText(q.error) : null };
}

export function useBotHistory(ctx: BotCtx | null, detail: BotDetail | null, range: HistoryRange) {
  const q = useQuery<BotHistory | null>({
    queryKey: [...botKeys.all, "history", detail?.bot.id ?? "", range, ...ctxKey(ctx)],
    enabled: ctx !== null && detail !== null,
    refetchInterval: POLL_MS * 3,
    retry: false,
    queryFn: ({ signal }) => loadBotHistory(ctx!, detail!.bot.id, range, detail!.bot.created_at_ms || null, signal),
  });
  return { history: q.data ?? null, loading: q.isPending && ctx !== null && detail !== null, error: q.error ? errText(q.error) : null };
}

export function useBotMetrics(ctx: BotCtx | null, detail: BotDetail | null, range: HistoryRange) {
  const q = useQuery<BotMetrics | null>({
    queryKey: [...botKeys.all, "metrics", detail?.bot.id ?? "", range, ...ctxKey(ctx)],
    enabled: ctx !== null && detail !== null,
    refetchInterval: POLL_MS * 3,
    retry: false,
    queryFn: ({ signal }) => loadBotMetrics(ctx!, detail!, range, signal),
  });
  return { metrics: q.data ?? null, loading: q.isPending && ctx !== null && detail !== null, error: q.error ? errText(q.error) : null };
}

/** Trades table: cursor pages, newest first. */
export function useBotTrades(ctx: BotCtx | null, detail: BotDetail | null) {
  const q = useInfiniteQuery({
    queryKey: [...botKeys.all, "fills", detail?.bot.id ?? "", ...ctxKey(ctx)],
    enabled: ctx !== null && detail !== null,
    refetchInterval: POLL_MS * 3,
    retry: false,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => loadBotFills(ctx!, detail!, pageParam, signal),
    getNextPageParam: (last) => last.next_cursor,
  });
  const fills: BotFill[] = q.data?.pages.flatMap((p) => p.fills) ?? [];
  return { fills, loading: q.isPending && ctx !== null && detail !== null, more: q.hasNextPage, loadingMore: q.isFetchingNextPage, loadMore: () => void q.fetchNextPage(), error: q.error ? errText(q.error) : null };
}

/** Candles of the pair (read from Hyperliquid by the browser) and the fills that become markers. */
export function useBotPrice(ctx: BotCtx | null, detail: BotDetail | null, pairName: string | null, range: HistoryRange) {
  const pair = detail?.pairs.find((p) => p.name === pairName) ?? null;
  const created = detail?.bot.created_at_ms || null;
  const nowMs = useNow(60_000);
  const candles = useQuery<Candle[]>({
    queryKey: [...botKeys.all, "candles", pair?.coin ?? "", range, detail?.hl_network ?? ""],
    enabled: detail !== null && pair !== null && pair.coin !== "",
    refetchInterval: POLL_MS * 3,
    retry: false,
    queryFn: ({ signal }) => loadCandles(detail!, pair!, range, signal),
  });
  const fills = useQuery<BotFill[]>({
    queryKey: [...botKeys.all, "markers", detail?.bot.id ?? "", range, ...ctxKey(ctx)],
    enabled: ctx !== null && detail !== null,
    refetchInterval: POLL_MS * 3,
    retry: false,
    queryFn: ({ signal }) => loadMarkerFills(ctx!, detail!, rangeStartMs(range, Date.now(), created), signal),
  });
  const pairFills = useMemo(() => (fills.data ?? EMPTY_FILLS).filter((f) => f.pair === pairName), [fills.data, pairName]);
  return {
    pair,
    candles: candles.data ?? EMPTY_CANDLES,
    fills: pairFills,
    fromMs: candleStartMs(range, nowMs, created),
    loading: candles.isPending && pair !== null && pair.coin !== "",
    error: candles.error ? errText(candles.error) : null,
  };
}
