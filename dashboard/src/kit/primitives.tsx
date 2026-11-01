// Base building blocks: buttons, surfaces, pills, text helpers. DESIGN_SYSTEM.md §3–4.
import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Check, Copy, Loader, Pause, Play } from "./icons";
import { avatarColor, initials, shortId, type Accent } from "./tokens";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

/* ───────────── Buttons ───────────── */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-fill" | "approve" | "assistant";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ok text-ok-on border border-ok font-semibold",
  secondary: "bg-transparent text-ink border border-line-strong font-medium",
  ghost: "bg-transparent text-ink-muted border border-transparent hover:text-ink font-medium",
  danger: "bg-danger-tint text-danger-text border border-danger font-semibold",
  "danger-fill": "bg-danger text-white border border-danger font-semibold",
  approve: "bg-warn text-warn-on border border-warn font-semibold",
  assistant: "bg-ai text-ai-text border border-ai-line font-medium",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-[52px] px-5 text-[15px] gap-2.5 rounded-tile",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Shows a spinner and disables the button (e.g. "Confirm in wallet…"). */
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", icon, loading, disabled, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "at-btn inline-flex shrink-0 cursor-pointer items-center justify-center rounded-input whitespace-nowrap select-none disabled:cursor-not-allowed disabled:opacity-40",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader className="spin" size={size === "sm" ? 14 : 16} /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "at-btn inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-input border-0 bg-transparent text-ink-muted hover:text-ink disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** 52 px agent kill switch. Always route the click through a confirm sheet. Sticky at the bottom on mobile (`sticky`). */
export function PauseButton({ paused, onClick, label, sticky, disabled }: { paused: boolean; onClick: () => void; label?: string; sticky?: boolean; disabled?: boolean }) {
  return (
    <div className={cx(sticky && "sticky bottom-0 -mx-4 border-t border-line bg-bg/90 p-4 backdrop-blur md:static md:m-0 md:border-0 md:bg-transparent md:p-0")}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cx(
          "at-btn flex h-[52px] w-full cursor-pointer items-center justify-center gap-2.5 rounded-tile border-[1.5px] text-[15px] font-semibold disabled:opacity-40",
          paused ? "border-ok bg-ok-tint text-ok" : "border-danger-text bg-danger-tint text-danger-text",
        )}
      >
        {paused ? <Play size={18} /> : <Pause size={18} />}
        {label ?? (paused ? "Resume agent" : "Pause agent")}
      </button>
    </div>
  );
}

/* ───────────── Surfaces ───────────── */

export type CardProps = HTMLAttributes<HTMLElement> & {
  /** Dotted grid + one soft corner tint (hero cards only). */
  decorated?: boolean;
  /** One diagonal light pass on mount (Treasury card). */
  foil?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  as?: "section" | "div" | "article";
};

const CARD_PADDING = { none: "", sm: "p-4", md: "px-5 py-4", lg: "p-6" } as const;

export function Card({ decorated, foil, padding = "md", as: Tag = "section", className, children, ...rest }: CardProps) {
  return (
    // `isolate` + `-z-10` keeps decorations above the card background but under the content, without wrapping
    // children — so layout classes passed in `className` (flex, gap, grid) apply to the content directly.
    <Tag className={cx("relative isolate min-w-0 overflow-hidden rounded-card border border-line bg-surface", CARD_PADDING[padding], className)} {...rest}>
      {decorated && (
        <>
          <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 -z-10" />
          <div aria-hidden="true" className="pointer-events-none absolute -top-20 -right-20 -z-10 size-80 rounded-full bg-[radial-gradient(closest-side,rgb(46_204_113/0.12),transparent)]" />
        </>
      )}
      {foil && <div aria-hidden="true" className="foil -z-10" />}
      {children}
    </Tag>
  );
}

/** Card header row: 15 px title, optional badge next to it, actions on the right. */
export function CardHeader({ title, id, badge, actions, className }: { title: ReactNode; id?: string; badge?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      <h2 id={id} className="m-0 text-[15px] font-semibold">
        {title}
      </h2>
      {badge}
      <div className="grow" />
      {actions}
    </div>
  );
}

/** Inner tile inside a card (stats, policy numbers, trust proof). */
export function Tile({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("min-w-0 rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5", className)} {...rest}>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, accent, size = "md" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; accent?: Accent; size?: "sm" | "md" }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={cx("mono mt-0.5 font-semibold", size === "md" ? "text-[22px]" : "text-base", accent && ACCENT_TEXT[accent])}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

export const Overline = ({ children, id }: { children: ReactNode; id?: string }) => (
  <h2 id={id} className="m-0 text-[13px] font-medium tracking-[.06em] text-ink-muted uppercase">
    {children}
  </h2>
);

/* ───────────── Pills & badges ───────────── */

export const ACCENT_TEXT: Record<Accent, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger-text",
  info: "text-info",
  neutral: "text-ink-secondary",
};
const ACCENT_TINT: Record<Accent, string> = {
  ok: "bg-ok-tint text-ok",
  warn: "bg-warn-tint text-warn",
  danger: "bg-danger-tint text-danger-text",
  info: "bg-info-tint text-info",
  neutral: "bg-surface-raised text-ink-secondary",
};
const ACCENT_BG: Record<Accent, string> = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", info: "bg-info", neutral: "bg-neutral-fill" };

/** Tinted 22 px pill: "testnet", "Allowlist only", counts. */
export function Pill({ accent = "neutral", icon, mono, children, title }: { accent?: Accent; icon?: ReactNode; mono?: boolean; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", ACCENT_TINT[accent], mono && "mono")}>
      {icon}
      {children}
    </span>
  );
}

/** Small colored dot. `live` adds the slow ping (only for running/active things). */
export function Dot({ accent = "ok", live, hollow, square, className }: { accent?: Accent; live?: boolean; hollow?: boolean; square?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block size-2 shrink-0",
        square ? "rounded-[2px]" : "rounded-full",
        hollow ? "border-[1.5px] border-ink-subtle bg-transparent" : ACCENT_BG[accent],
        live && "live",
        className,
      )}
    />
  );
}

export type AgentState = "active" | "paused" | "revoked" | "ended" | "waiting";

const STATUS_PILL: Record<AgentState, { label: string; accent: Accent; live?: boolean; hollow?: boolean }> = {
  active: { label: "Active", accent: "ok", live: true },
  paused: { label: "Paused", accent: "warn" },
  waiting: { label: "Waiting for registration", accent: "warn" },
  revoked: { label: "Revoked", accent: "neutral", hollow: true },
  ended: { label: "Ended", accent: "neutral", hollow: true },
};

/** Dot + word, no filled background (§4 Status pill). */
export function StatusPill({ state, label }: { state: AgentState; label?: string }) {
  const s = STATUS_PILL[state];
  return (
    <span className={cx("inline-flex items-center gap-2 text-[13px] font-medium whitespace-nowrap", s.hollow ? "text-ink-muted" : ACCENT_TEXT[s.accent])}>
      <Dot accent={s.accent} live={s.live} hollow={s.hollow} />
      {label ?? s.label}
    </span>
  );
}

/* ───────────── Text helpers ───────────── */

/** Mono amount with optional unit; never rounds itself — pass the already formatted string. */
export function Amount({ value, unit = "USDC", size = "md", accent, className }: { value: ReactNode; unit?: string | null; size?: "sm" | "md" | "lg" | "hero"; accent?: Accent; className?: string }) {
  const sizes = { sm: "text-[13px]", md: "text-base", lg: "text-[32px] leading-tight", hero: "text-balance" };
  return (
    <span className={cx("inline-flex items-baseline gap-1.5", className)}>
      <span className={cx("mono font-semibold", sizes[size], accent && ACCENT_TEXT[accent])}>{value}</span>
      {unit && <span className={cx("font-sans font-normal text-ink-muted", size === "hero" ? "text-[15px]" : "text-xs")}>{unit}</span>}
    </span>
  );
}

/** Short hash / account id with a copy button. Full value in `title` for hover. */
export function Hash({ value, short = true, copy = true, className }: { value: string; short?: boolean; copy?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1", className)}>
      <span className="mono truncate text-[13px]" title={value}>
        {short ? shortId(value) : value}
      </span>
      {copy && (
        <IconButton label={copied ? "Copied" : "Copy"} onClick={onCopy} className="size-7">
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
        </IconButton>
      )}
    </span>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-ink"
      style={{ width: size, height: size, background: avatarColor(name), fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

export const Spinner = ({ size = 16, className }: { size?: number; className?: string }) => <Loader size={size} className={cx("spin", className)} />;

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden="true" className={cx("skeleton rounded-input", className)} />;

/** Inline callout inside a card: amber warning, red error, blue info, green ok. */
export function Callout({ accent = "warn", children, action, icon }: { accent?: Accent; children: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  const tone: Record<Accent, string> = {
    warn: "bg-warn-soft border-warn-line text-warn",
    danger: "bg-danger-tint border-danger/40 text-danger-text",
    info: "bg-info-tint border-info/30 text-info",
    ok: "bg-ok-tint border-ok/30 text-ok",
    neutral: "bg-surface-sunken border-line text-ink-secondary",
  };
  return (
    <div role={accent === "danger" ? "alert" : "status"} className={cx("flex flex-wrap items-center gap-2.5 rounded-tile border px-3 py-2.5 text-[13px]", tone[accent])}>
      {icon}
      <span className="min-w-[220px] flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Full-width banner under the header (e.g. "Agent paused — no payments will be made until you resume"). */
export function Banner({ accent = "danger", icon, children }: { accent?: "danger" | "warn"; icon?: ReactNode; children: ReactNode }) {
  return (
    <div role="status" className={cx("fade-in text-[13px] font-medium", accent === "danger" ? "bg-danger text-white" : "bg-warn text-warn-on")}>
      <div className="mx-auto flex max-w-content items-center gap-2 px-4 py-[7px] md:px-6">
        {icon}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <p className="m-0 max-w-sm text-ink-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
