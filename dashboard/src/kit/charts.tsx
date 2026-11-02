import { useId } from "react";

/** Tiny inline-SVG bar sparkline. `values` oldest first; the last bar is highlighted. No dependency. */
export function Sparkline({ values, label, height = 56 }: { values: readonly number[]; label: string; height?: number }) {
  const id = useId();
  const max = Math.max(...values, 0);
  const n = Math.max(values.length, 1);
  const gap = n > 14 ? 1 : 3;
  return (
    <svg role="img" aria-label={label} aria-describedby={id} viewBox={`0 0 ${n * 10} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      <title id={id}>{label}</title>
      {values.map((v, i) => {
        const h = max === 0 ? 2 : Math.max(2, (v / max) * (height - 4));
        return <rect key={i} x={i * 10 + gap / 2} y={height - h} width={10 - gap} height={h} rx={1.5} fill={i === values.length - 1 ? "var(--color-ok)" : "var(--color-line-strong)"} opacity={v === 0 ? 0.5 : 1} />;
      })}
    </svg>
  );
}

/** Line sparkline for a P&L series (may be negative). Green when the last value is >= 0, red otherwise; a dashed zero line when the series crosses it. */
export function PnlSparkline({ values, label, height = 36 }: { values: readonly number[]; label: string; height?: number }) {
  const id = useId();
  if (values.length < 2) return <div aria-hidden="true" className="h-px w-full bg-line" style={{ marginTop: height / 2 }} />;
  const w = 100;
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const span = hi - lo || 1;
  const y = (v: number) => 2 + (1 - (v - lo) / span) * (height - 4);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const up = (values[values.length - 1] ?? 0) >= 0;
  return (
    <svg role="img" aria-label={label} aria-describedby={id} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      <title id={id}>{label}</title>
      {lo < 0 && hi > 0 && <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
      <polyline points={pts} fill="none" stroke={up ? "var(--color-ok)" : "var(--color-danger)"} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
