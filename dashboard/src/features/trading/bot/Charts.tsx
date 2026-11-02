import { useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time } from "lightweight-charts";
import { intlLocale, useT } from "@/i18n";
import { Skeleton } from "@/kit";
import type { Candle } from "@/lib/tradingBots";
import type { BotFill, HistoryPoint } from "@/lib/tradingClient";
import { candleSeries, hexA, lineSeries, pnlSeries, pricePrecision } from "@/lib/tradingChart";
import { fillMarkers, fmtPrice, fmtSize, type CandleInterval, type FillMarker } from "@/lib/tradingMetrics";

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
    grid: { vertLines: { visible: false, color: line }, horzLines: { visible: false, color: line } },
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

export type PriceMode = "line" | "candles";

interface Tip {
  x: number;
  y: number;
  marks: FillMarker[];
}

/**
 * Price of the pair as a line of closes (default; on a thin testnet book candles are noise) or as candles, with a marker per
 * fill (green arrow up = buy, red arrow down = sell). Hovering a marker shows price, size and time in the owner's time zone.
 * The chart is recreated when the mode changes (the series type differs).
 */
export function PriceChart({ mode, ...rest }: { mode: PriceMode; candles: readonly Candle[]; fills: readonly BotFill[]; interval: CandleInterval; fromMs: number; loading: boolean; unavailable: boolean }) {
  return <PriceChartInner key={mode} mode={mode} {...rest} />;
}

function PriceChartInner({ mode, candles, fills, interval, fromMs, loading, unavailable }: { mode: PriceMode; candles: readonly Candle[]; fills: readonly BotFill[]; interval: CandleInterval; fromMs: number; loading: boolean; unavailable: boolean }) {
  const t = useT();
  const candleData = useMemo(() => candleSeries(candles), [candles]);
  const lineData = useMemo(() => lineSeries(candles), [candles]);
  const precision = useMemo(() => pricePrecision(candleData.flatMap((c) => (mode === "line" ? [c.close] : [c.low, c.high]))), [candleData, mode]);
  const markers = useMemo(() => fillMarkers(fills, fromMs, interval), [fills, fromMs, interval]);
  const markersRef = useRef(markers);
  useEffect(() => {
    markersRef.current = markers;
  });
  const [tip, setTip] = useState<Tip | null>(null);
  const { el, handle } = useLwChart<ISeriesApi<"Line"> | ISeriesApi<"Candlestick">>(H + 60, (lw, chart) => {
    const ok = cssVar("--color-ok", "#2ecc71");
    const bad = cssVar("--color-danger", "#e5484d");
    const priceFormat = { type: "price" as const, precision: 2, minMove: 0.01 };
    const series =
      mode === "line"
        ? chart.addSeries(lw.LineSeries, { color: cssVar("--color-info", "#8ab4ff"), lineWidth: 2, priceFormat, crosshairMarkerRadius: 4 })
        : chart.addSeries(lw.CandlestickSeries, { upColor: ok, downColor: bad, wickUpColor: ok, wickDownColor: bad, borderVisible: false, priceFormat });
    return { series, markers: lw.createSeriesMarkers(series, []) };
  });
  useEffect(() => {
    if (!handle) return;
    handle.series.applyOptions({ priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision } });
    if (mode === "line") (handle.series as ISeriesApi<"Line">).setData(lineData.map((p) => ({ time: p.time as Time, value: p.value })));
    else (handle.series as ISeriesApi<"Candlestick">).setData(candleData.map((c) => ({ ...c, time: c.time as Time })));
    handle.chart.timeScale().fitContent();
  }, [handle, mode, lineData, candleData, precision]);
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
        size: 1.4,
      })),
    );
  }, [handle, markers]);
  // Marker tooltip: the crosshair snaps to bars (magnet), so a marker is "hovered" when its bar is the crosshair bar.
  useEffect(() => {
    if (!handle) return;
    const onMove = (p: { time?: Time; point?: { x: number; y: number } }) => {
      if (p.time === undefined || !p.point) return setTip(null);
      const marks = markersRef.current.filter((m) => m.time === p.time);
      setTip(marks.length ? { x: p.point.x, y: p.point.y, marks } : null);
    };
    handle.chart.subscribeCrosshairMove(onMove);
    return () => handle.chart.unsubscribeCrosshairMove(onMove);
  }, [handle]);
  const empty = !loading && candleData.length === 0;
  const loc = intlLocale();
  return (
    <div className="relative" role="img" aria-label={t("trading.bot.priceChartAria")}>
      <div ref={el} className={empty ? "invisible" : undefined} style={{ height: H + 60 }} />
      {loading && <Skeleton className="absolute inset-0" />}
      {empty && <p className="absolute inset-0 m-0 flex items-center justify-center px-6 text-center text-sm text-ink-muted">{unavailable ? t("trading.bot.noPricePair") : t("trading.bot.noPrices")}</p>}
      {tip && (
        <div
          className="pointer-events-none absolute z-10 flex flex-col gap-1 rounded-tile border border-line-strong bg-surface-raised px-2.5 py-1.5 text-xs text-ink-secondary shadow-lg"
          style={{ left: Math.min(Math.max(tip.x + 12, 0), 9999), top: Math.max(tip.y - 44, 0), transform: tip.x > 260 ? "translateX(calc(-100% - 24px))" : undefined }}
        >
          {tip.marks.map((m, i) => (
            <div key={i} className="flex flex-col">
              <span className={m.side === "buy" ? "font-semibold text-ok" : "font-semibold text-danger-text"}>
                {m.side === "buy" ? "▲ " + t("trading.bot.buy") : "▼ " + t("trading.bot.sell")} · {fmtPrice(m.price)}
              </span>
              <span className="mono text-ink-muted">
                {fmtSize(String(m.size))} · {new Date(m.timeMs).toLocaleString(loc, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
