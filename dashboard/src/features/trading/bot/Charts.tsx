import { useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import { useT } from "@/i18n";
import { Skeleton } from "@/kit";
import type { Candle } from "@/lib/tradingBots";
import type { BotFill, HistoryPoint } from "@/lib/tradingClient";
import { candleSeries, hexA, pnlSeries } from "@/lib/tradingChart";
import { fillMarkers, type CandleInterval } from "@/lib/tradingMetrics";

/**
 * Charts of the bot page. `lightweight-charts` (TradingView, Apache-2.0, attribution logo kept on) is imported lazily on
 * first render, so the main bundle does not carry it. Each chart is created once and fed through `setData`; the CSS theme
 * colors are read at creation (the library cannot parse CSS variables).
 */
type Lw = typeof import("lightweight-charts");

const cssVar = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

function baseOptions(lw: Lw, height: number) {
  const text = cssVar("--color-ink-muted", "#8a93a3");
  const line = cssVar("--color-line", "#232832");
  return {
    autoSize: true,
    height,
    layout: { background: { type: lw.ColorType.Solid, color: "transparent" }, textColor: text, fontFamily: "inherit", attributionLogo: true },
    grid: { vertLines: { color: line }, horzLines: { color: line } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: lw.CrosshairMode.Magnet },
  };
}

interface Handle<S> {
  chart: IChartApi;
  series: S;
  markers?: ISeriesMarkersPluginApi<Time>;
}

/** Creates the chart once (after the lazy import) and returns the handle; disposes on unmount. */
function useLwChart<S>(height: number, make: (lw: Lw, chart: IChartApi) => { series: S; markers?: ISeriesMarkersPluginApi<Time> }) {
  const el = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<Handle<S> | null>(null);
  const makeRef = useRef(make);
  useEffect(() => {
    makeRef.current = make;
  });
  useEffect(() => {
    let disposed = false;
    let chart: IChartApi | null = null;
    void import("lightweight-charts").then((lw) => {
      if (disposed || !el.current) return;
      chart = lw.createChart(el.current, baseOptions(lw, height));
      setHandle({ chart, ...makeRef.current(lw, chart) });
    });
    return () => {
      disposed = true;
      chart?.remove();
      setHandle(null);
    };
  }, [height]);
  return { el, handle };
}

const H = 240;

/** P&L curve: green above zero, red below. */
export function PnlChart({ points, loading }: { points: readonly HistoryPoint[]; loading: boolean }) {
  const t = useT();
  const data = useMemo(() => pnlSeries(points), [points]);
  const { el, handle } = useLwChart<ISeriesApi<"Baseline">>(H, (lw, chart) => {
    const ok = cssVar("--color-ok", "#2ecc71");
    const bad = cssVar("--color-danger", "#e5484d");
    const series = chart.addSeries(lw.BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: ok,
      topFillColor1: hexA(ok, 0.28),
      topFillColor2: hexA(ok, 0.02),
      bottomLineColor: bad,
      bottomFillColor1: hexA(bad, 0.02),
      bottomFillColor2: hexA(bad, 0.28),
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    return { series };
  });
  useEffect(() => {
    if (!handle) return;
    handle.series.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
    handle.chart.timeScale().fitContent();
  }, [handle, data]);
  const empty = !loading && data.length < 2;
  return (
    <div className="relative" role="img" aria-label={t("trading.bot.pnlChartAria")}>
      <div ref={el} className={empty ? "invisible" : undefined} style={{ height: H }} />
      {loading && <Skeleton className="absolute inset-0" />}
      {empty && <p className="absolute inset-0 m-0 flex items-center justify-center px-6 text-center text-sm text-ink-muted">{t("trading.bot.historyStarts")}</p>}
    </div>
  );
}

/** Candles of the pair with a marker per fill (green arrow up = buy, red arrow down = sell). */
export function PriceChart({ candles, fills, interval, fromMs, loading, unavailable }: { candles: readonly Candle[]; fills: readonly BotFill[]; interval: CandleInterval; fromMs: number; loading: boolean; unavailable: boolean }) {
  const t = useT();
  const data = useMemo(() => candleSeries(candles), [candles]);
  const markers = useMemo(() => fillMarkers(fills, fromMs, interval), [fills, fromMs, interval]);
  const { el, handle } = useLwChart<ISeriesApi<"Candlestick">>(H + 60, (lw, chart) => {
    const ok = cssVar("--color-ok", "#2ecc71");
    const bad = cssVar("--color-danger", "#e5484d");
    const series = chart.addSeries(lw.CandlestickSeries, { upColor: ok, downColor: bad, wickUpColor: ok, wickDownColor: bad, borderVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
    return { series, markers: lw.createSeriesMarkers(series, []) };
  });
  useEffect(() => {
    if (!handle) return;
    handle.series.setData(data.map((c) => ({ ...c, time: c.time as Time })));
    handle.chart.timeScale().fitContent();
  }, [handle, data]);
  useEffect(() => {
    if (!handle) return;
    const ok = cssVar("--color-ok", "#2ecc71");
    const bad = cssVar("--color-danger", "#e5484d");
    handle.markers?.setMarkers(
      markers.map((m) => ({
        time: m.time as Time,
        position: m.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
        shape: m.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
        color: m.side === "buy" ? ok : bad,
      })),
    );
  }, [handle, markers]);
  const empty = !loading && data.length === 0;
  return (
    <div className="relative" role="img" aria-label={t("trading.bot.priceChartAria")}>
      <div ref={el} className={empty ? "invisible" : undefined} style={{ height: H + 60 }} />
      {loading && <Skeleton className="absolute inset-0" />}
      {empty && <p className="absolute inset-0 m-0 flex items-center justify-center px-6 text-center text-sm text-ink-muted">{unavailable ? t("trading.bot.noPricePair") : t("trading.bot.noPrices")}</p>}
    </div>
  );
}
