import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useT } from "@/i18n";
import { Button, Callout, Card, EmptyState, Icons, Page, Pill, Segmented, Skeleton, Tabs } from "@/kit";
import { TRADING_CONNECT_PATH, TRADING_LIST_PATH } from "@/lib/agentKind";
import { WORKER_URL } from "@/lib/config";
import type { HistoryPoint } from "@/lib/tradingClient";
import { candleInterval, RANGES, type HistoryRange } from "@/lib/tradingMetrics";
import type { PriceMode } from "@/features/trading/bot/Charts";
import { BotStatePill, PnlValue } from "@/features/trading/BotRows";
import { Metrics } from "@/features/trading/bot/Metrics";
import { Settings } from "@/features/trading/bot/Settings";
import { StopButton } from "@/features/trading/bot/StopButton";
import { Trades } from "@/features/trading/bot/Trades";
import { useBotCtx, useBotDetail, useBotHistory, useBotMetrics, useBotPrice, useBotTrades } from "@/features/trading/useBots";

// The chart library is its own chunk, fetched only when this page is opened.
const PnlChart = lazy(() => import("@/features/trading/bot/Charts").then((m) => ({ default: m.PnlChart })));
const PriceChart = lazy(() => import("@/features/trading/bot/Charts").then((m) => ({ default: m.PriceChart })));

const NONE: never[] = [];
const SESSION_GAP_MS = 15_000;
const SESSION_MAX = 600;

/**
 * Coarse P&L curve for the time the page is open: the worker's history is empty for a fresh agent, but the header total is
 * polled, so the page keeps its own samples (in memory only) and the chart can draw those until real history exists.
 */
function useSessionPnl(botId: string, total: string | null): HistoryPoint[] {
  const [samples, setSamples] = useState<{ id: string; list: HistoryPoint[] }>({ id: botId, list: [] });
  useEffect(() => {
    if (total === null || !Number.isFinite(Number(total))) return;
    const push = () =>
      setSamples((cur) => {
        const now = Date.now();
        const list = cur.id === botId ? cur.list : [];
        const last = list[list.length - 1];
        if (last && now - last.t < SESSION_GAP_MS) return cur;
        const p: HistoryPoint = { t: now, pnl: total, lo: total, hi: total, today: "0", val: "0", px: {} };
        return { id: botId, list: [...list, p].slice(-SESSION_MAX) };
      });
    push();
    const iv = window.setInterval(push, SESSION_GAP_MS);
    return () => window.clearInterval(iv);
  }, [botId, total]);
  return samples.id === botId ? samples.list : NONE;
}

/** `/trading/bots/:id` (ADR-0006 §9): header, range tabs, P&L curve, price chart with trades, numbers, rules, trades table. */
export function TradingBotPage() {
  const t = useT();
  const { id = "" } = useParams();
  const [range, setRange] = useState<HistoryRange>("1d");
  const [pairPick, setPairPick] = useState<string | null>(null);
  const [mode, setMode] = useState<PriceMode>("line");
  const { ctx, load } = useBotCtx();
  const { detail, loading: detailLoading, error: detailError } = useBotDetail(ctx, id);
  const history = useBotHistory(ctx, detail, range);
  const metrics = useBotMetrics(ctx, detail, range);
  const trades = useBotTrades(ctx, detail);
  const pairName = pairPick && detail?.bot.pairs.includes(pairPick) ? pairPick : (detail?.bot.pairs[0] ?? null);
  const price = useBotPrice(ctx, detail, pairName, range);

  const sessionPnl = useSessionPnl(id, detail?.bot.pnl_total_usdc ?? null);
  const pnlPoints = useMemo(() => {
    const real = history.history?.points ?? NONE;
    if (real.length >= 2) return real;
    return sessionPnl.length >= 2 ? sessionPnl : real;
  }, [history.history, sessionPnl]);

  const back = (
    <Link to={TRADING_LIST_PATH} className="inline-flex items-center gap-1 text-sm text-ink-muted no-underline hover:text-ink">
      <Icons.ChevronLeft size={14} /> {t("trading.bot.back")}
    </Link>
  );
  const shell = (children: ReactNode) => (
    <Page title={t("trading.bot.pageTitle")} actions={back}>
      {children}
    </Page>
  );

  if (WORKER_URL === "") return shell(<EmptyState title={t("trading.page.workerNotConfigured")}>{t("trading.page.setWorkerUrl")}</EmptyState>);
  if (load.loading || (ctx !== null && detailLoading)) return shell(<Skeleton className="h-64" />);
  if (load.error) {
    return shell(
      <Callout accent="danger" action={<button type="button" className="cursor-pointer text-sm underline" onClick={() => void load.refresh()}>{t("common.retry")}</button>}>
        {t("trading.page.cantReach", { error: load.error })}
      </Callout>,
    );
  }
  if (!ctx) {
    return shell(
      <EmptyState title={t("trading.bot.notConnected")} action={<Link to={TRADING_CONNECT_PATH}><Button variant="primary">{t("trading.bots.connectRow")}</Button></Link>}>
        {t("trading.bot.notConnectedHint")}
      </EmptyState>,
    );
  }
  if (detailError) return shell(<Callout accent="danger">{detailError}</Callout>);
  if (!detail) {
    // Bots mode without an owner session: the detail is owner-only. Otherwise the id is unknown.
    return shell(
      ctx.mode === "bots" && !ctx.token ? (
        <EmptyState title={t("trading.bot.signInTitle")} action={<Button variant="primary" loading={load.signingIn} onClick={() => void load.signIn()}>{t("trading.rules.signInShow")}</Button>}>
          {load.authError ?? t("trading.bot.signInHint")}
        </EmptyState>
      ) : (
        <EmptyState title={t("trading.bot.notFound")} action={<Link to={TRADING_LIST_PATH}><Button>{t("trading.bot.back")}</Button></Link>}>
          {id}
        </EmptyState>
      ),
    );
  }

  const bot = detail.bot;
  const stoppable = bot.state === "running" || bot.state === "blocked";
  return (
    <Page title={bot.name} actions={back}>
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Icons.TrendingUp size={22} className="text-info" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Pill accent="info">{t("trading.bots.kind")}</Pill>
            <span className="mono text-sm text-ink-secondary">{bot.pairs.join(", ") || "—"}</span>
            <BotStatePill state={bot.state} />
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-ink-muted">
            <span>
              {t("trading.bots.pnl")} <PnlValue value={bot.pnl_total_usdc} className="text-lg" />
            </span>
            <span>
              {t("trading.bots.today")} <PnlValue value={bot.pnl_today_usdc} />
            </span>
            {detail.positions.map((p) => (
              <span key={p.pair} className="mono">
                {t("trading.bot.holding", { size: p.size, pair: p.pair })}
              </span>
            ))}
          </div>
        </div>
        <StopButton ctx={ctx} id={bot.id} disabled={!stoppable} />
      </Card>

      <Tabs value={range} onChange={setRange} label={t("trading.bot.rangeAria")} items={RANGES.map((r) => ({ value: r, label: t(`trading.bot.range.${r}`) }))} />

      <Card aria-labelledby="bot-pnl" className="flex flex-col gap-2">
        <h2 id="bot-pnl" className="m-0 text-[15px] font-semibold">
          {t("trading.bot.pnlTitle")}
        </h2>
        <Suspense fallback={<Skeleton className="h-60" />}>
          <PnlChart points={pnlPoints} loading={history.loading && pnlPoints.length < 2} />
        </Suspense>
      </Card>

      <Card aria-labelledby="bot-price" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="bot-price" className="m-0 flex-1 text-[15px] font-semibold">
            {t("trading.bot.priceTitle")}
          </h2>
          {bot.pairs.length > 1 && <Segmented label={t("trading.bot.pairAria")} value={pairName ?? ""} onChange={setPairPick} options={bot.pairs.map((p) => ({ value: p, label: p }))} />}
          <Segmented label={t("trading.bot.modeAria")} value={mode} onChange={setMode} options={[{ value: "line", label: t("trading.bot.modeLine") }, { value: "candles", label: t("trading.bot.modeCandles") }]} />
        </div>
        <Suspense fallback={<Skeleton className="h-72" />}>
          <PriceChart mode={mode} candles={price.candles} fills={price.fills} interval={candleInterval(range)} fromMs={price.fromMs} loading={price.loading} unavailable={price.pair === null || price.pair.coin === ""} />
        </Suspense>
        {price.error && <p className="m-0 text-xs text-ink-muted">{price.error}</p>}
        <p className="m-0 text-xs text-ink-subtle">{t("trading.bot.markersLegend")}</p>
      </Card>

      <Metrics metrics={metrics.metrics} loading={metrics.loading} total={bot.pnl_total_usdc} />

      <Settings detail={detail} status={ctx.status} signedIn={ctx.token !== null} signingIn={load.signingIn} signIn={() => void load.signIn()} error={load.authError} />

      <Trades fills={trades.fills} loading={trades.loading} more={trades.more} loadingMore={trades.loadingMore} loadMore={trades.loadMore} error={trades.error} />
    </Page>
  );
}
