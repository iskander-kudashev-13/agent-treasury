// Data display: limits, chains, proof badges, tables, count-up. DESIGN_SYSTEM.md §1.4–1.5, §4, §5.
import { useT } from "@/i18n";
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from "react";
import { Calendar, KeyRound, Lock, ShieldCheck, Zap } from "./icons";
import { cx, Hash } from "./primitives";
import { ACCENT_HEX, chainColor, chainName, clamp01, limitTone } from "./tokens";

/* ───────────── Limits ───────────── */

/**
 * 8 px spend bar with the limit color rule. `spent`/`limit` are display numbers (already divided by token decimals).
 * Label row: "Today · 150.00 / 200.00 USDC".
 */
export function SpendBar({
  spent,
  limit,
  label: labelProp,
  spentText,
  limitText,
  scope = "vault",
  marker80 = false,
}: {
  spent: number;
  limit: number;
  label?: ReactNode;
  spentText: string;
  limitText: string;
  scope?: "vault" | "agent";
  /** Small "80%" tick under the bar (Treasury policy card). */
  marker80?: boolean;
}) {
  const t = useT();
  const label = labelProp ?? t("treasury.spentToday");
  const pct = limit > 0 ? spent / limit : 0;
  const color = ACCENT_HEX[limitTone(pct, scope)];
  return (
    <div>
      <div className="mb-1.5 flex justify-between gap-2 text-[13px]">
        <span className="text-ink-muted">{label}</span>
        <span className="mono">
          <span className="text-ink">{spentText}</span>
          <span className="text-ink-muted"> / {limitText}</span>
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp01(pct) * 100)}
        aria-label={typeof label === "string" ? label : t("kit.spent")}
      >
        <div className="fill-transition h-full rounded-full" style={{ width: `${clamp01(pct) * 100}%`, background: color }} />
      </div>
      {marker80 && (
        <div aria-hidden="true" className="relative h-3.5 text-[10px] text-ink-subtle">
          <span className="absolute top-0.5 left-[80%] -translate-x-1/2">80%</span>
        </div>
      )}
    </div>
  );
}

/** Vault daily-limit ring gauge (148 px, 10 px stroke, dashed inner guide). Animates from 0 on mount. */
export function RingGauge({ pct, caption: captionProp, size = 148 }: { pct: number; caption?: string; size?: number }) {
  const t = useT();
  const caption = captionProp ?? t("kit.ofDailyLimit");
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(clamp01(pct)));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  const color = ACCENT_HEX[limitTone(pct, "vault")];
  const pctText = `${Math.round((Number.isFinite(pct) ? pct : 0) * 100)}%`;
  return (
    <figure className="relative m-0 shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${pctText} ${caption}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-track)" strokeWidth={10} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={1} strokeDasharray="2 6" />
        <circle
          className="fill-transition"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="mono text-2xl font-semibold">{pctText}</span>
        <span className="text-[11px] text-ink-muted">{caption}</span>
      </div>
    </figure>
  );
}

/* ───────────── Count-up & delta ───────────── */

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 900 ms ease-out-cubic count from the previous value to `target` (instant with reduced motion). */
export function useCountUp(target: number, durationMs = 900): number {
  const reduced = prefersReducedMotion();
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (reduced) return;
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const v = origin + (target - origin) * (1 - Math.pow(1 - t, 3));
      from.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, reduced]);
  return reduced ? target : value;
}

/** "−1,200.00" chip that appears, holds and fades (1.8 s). Re-mount with a new `key` to replay. */
export const DeltaChip = ({ text, accent = "danger" }: { text: string; accent?: "danger" | "ok" }) => (
  <span className={cx("delta mono rounded-full px-2 py-0.5 text-xs", accent === "danger" ? "bg-danger/15 text-danger-text" : "bg-ok-tint text-ok")}>{text}</span>
);

/* ───────────── Chains ───────────── */

export const ChainDot = ({ chain, size = 9 }: { chain: string; size?: number }) => (
  <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: chainColor(chain) }} />
);

/** Dot + chain name (color never alone). `arrow` prefixes "→" for payout destinations. */
export function ChainBadge({ chain, arrow, outlined }: { chain: string; arrow?: boolean; outlined?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-ink-secondary", outlined && "h-6 rounded-full border border-line-strong px-2 text-xs")}>
      {arrow && <span aria-hidden="true">→</span>}
      <ChainDot chain={chain} />
      {chainName(chain)}
    </span>
  );
}

/** Overlapping chain dots for compact rows (names in the accessible label). */
export function ChainStack({ chains }: { chains: string[] }) {
  return (
    <span className="inline-flex" role="img" aria-label={chains.map(chainName).join(", ")}>
      {chains.map((c, i) => (
        <span key={c} className="size-[18px] rounded-full border-2 border-surface" style={{ background: chainColor(c), marginLeft: i ? -6 : 0 }} />
      ))}
    </span>
  );
}

/* ───────────── Proof & tags ───────────── */

/** Trust badge: TEE (green when hash approved, amber while waiting) or key (muted), then the mono hash/public key. */
export function TrustBadge({ kind, value, approved = true }: { kind: "tee" | "key"; value: string; approved?: boolean }) {
  const t = useT();
  const isTee = kind === "tee";
  const tone = !isTee ? "text-ink-muted" : approved ? "text-ok" : "text-warn";
  const label = !isTee ? t("kit.keyAccount") : approved ? t("kit.teeHashApproved") : t("trust.teeWaiting");
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", tone)}>
        {isTee ? <ShieldCheck size={15} /> : <KeyRound size={15} />}
        {label}
      </span>
      <Hash value={value} />
    </span>
  );
}

/** Large shield proof tile used on agent cards. */
export function ShieldProof({ title: titleProp, hash, approved = true, link }: { title?: string; hash: string; approved?: boolean; link?: ReactNode }) {
  const t = useT();
  const title = titleProp ?? t("kit.codeHash");
  const stroke = approved ? "var(--color-ok)" : "var(--color-warn)";
  return (
    <div className="flex items-center gap-3.5 rounded-tile border border-tile-line bg-surface-sunken p-3">
      <svg width="40" height="44" viewBox="0 0 40 44" aria-hidden="true">
        <path d="M20 2 37 8v12c0 11-7.4 19-17 22C10.4 39 3 31 3 20V8z" fill={approved ? "rgb(46 204 113/.10)" : "rgb(245 181 68/.10)"} stroke={stroke} strokeWidth="1.5" />
        {approved ? (
          <path d="m13 22 5 5 9-10" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M20 14v9M20 28h.01" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
        )}
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-muted">{title}</div>
        <Hash value={hash} />
        <div className={cx("text-xs", approved ? "text-ok" : "text-warn")}>{link ?? (approved ? t("kit.hashMatches") : t("kit.waitingReg"))}</div>
      </div>
    </div>
  );
}

/** Mono 11 px refusal code: border only, calm (refusals are not errors). */
export const ReasonChip = ({ code }: { code: string }) => (
  <span className="mono inline-flex h-5 items-center rounded-full border border-line-strong px-2 text-[11px] text-ink-secondary">{code}</span>
);

/** Tiny outline pill on payout rows. */
export function SourceTag({ source }: { source: "scheduled" | "on-demand" }) {
  const t = useT();
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full border border-line-strong px-1.5 text-[11px] text-ink-muted whitespace-nowrap">
      {source === "scheduled" ? <Calendar size={11} /> : <Zap size={11} />}
      {source === "scheduled" ? t("kit.sourceScheduled") : t("kit.sourceOnDemand")}
    </span>
  );
}

export function PrivacyBadge() {
  const t = useT();
  return (
    <span
      className="shimmer-privacy inline-flex h-6 items-center gap-1.5 rounded-full border border-ai-line px-2.5 text-[11px] text-ai-text"
      title={t("kit.privacyTitle")}
    >
      <Lock size={12} />
      {t("kit.privacyBadge")}
    </span>
  );
}

/* ───────────── Payout route ───────────── */

function RouteNode({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-16 flex-col items-center gap-1">
      <span className="flex size-8 items-center justify-center rounded-tile border border-line-strong bg-surface-raised text-[11px] font-semibold">{children}</span>
      <span className="text-[11px] text-ink-muted">{label}</span>
    </div>
  );
}

function RouteLink({ running, delay }: { running: boolean; delay?: string }) {
  return (
    <div className="relative mb-[18px] h-0.5 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-line-strong)_0_4px,transparent_4px_8px)]">
      {running && <span className="travel absolute -top-[3px] -ml-1 size-2 rounded-full bg-ok shadow-[0_0_10px_rgb(46_204_113/0.7)]" style={{ animationDelay: delay }} />}
    </div>
  );
}

/** Vault → Intents → chains with a traveling dot (stops when `running` is false). */
export function PayoutRoute({ chains, running }: { chains: string[]; running: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center" role="img" aria-label={t("kit.routeAria", { chains: chains.map(chainName).join(", ") })}>
      <RouteNode label={t("kit.routeVault")}>V</RouteNode>
      <RouteLink running={running} />
      <RouteNode label={t("kit.routeIntents")}>⇄</RouteNode>
      <RouteLink running={running} delay="1.4s" />
      <div className="flex w-16 flex-col items-center gap-1">
        <span className="flex h-8 items-center">
          <ChainStack chains={chains} />
        </span>
        <span className="text-[11px] text-ink-muted">{t("kit.routeChains")}</span>
      </div>
    </div>
  );
}

/* ───────────── Table ───────────── */

/** Wide tables scroll inside their own container, never the page. */
export function Table({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse text-[13px]", className)} {...rest}>
        {children}
      </table>
    </div>
  );
}
export const Th = ({ className, align, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" }) => (
  <th scope="col" className={cx("border-b border-line px-5 py-2.5 text-xs font-normal whitespace-nowrap text-ink-muted", align === "right" ? "text-right" : "text-left", className)} {...rest} />
);
export const Tr = ({ className, fresh, ...rest }: HTMLAttributes<HTMLTableRowElement> & { fresh?: boolean }) => (
  <tr className={cx("at-row border-b border-track last:border-b-0", fresh && "row-new", className)} {...rest} />
);
export const Td = ({ className, align, mono, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right"; mono?: boolean }) => (
  <td className={cx("px-5 py-3 align-middle", align === "right" && "text-right", mono && "mono", className)} {...rest} />
);
