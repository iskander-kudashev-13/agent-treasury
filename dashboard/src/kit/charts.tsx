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
