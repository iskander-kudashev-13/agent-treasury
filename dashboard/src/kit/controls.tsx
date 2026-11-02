// Form controls and navigation: inputs, toggle, chips, segmented, tabs, stepper, timeline. DESIGN_SYSTEM.md §4, §7.
import { useT } from "@/i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Check, Loader } from "./icons";
import { cx } from "./primitives";

/* ───────────── Field + inputs ───────────── */

export type FieldState = "default" | "error" | "valid";

const INPUT_BASE =
  "w-full min-w-0 rounded-input border bg-surface-sunken px-3 text-sm text-ink placeholder:text-ink-subtle transition-[border-color,box-shadow] duration-150 outline-none focus:border-ok focus:shadow-[0_0_0_3px_rgb(46_204_113/0.18)] disabled:opacity-40";
const INPUT_STATE: Record<FieldState, string> = {
  default: "border-line-strong",
  error: "border-danger focus:border-danger focus:shadow-[0_0_0_3px_rgb(229_72_77/0.18)]",
  valid: "border-ok/60",
};

/**
 * Label + control + hint/error. The child receives `id`, `aria-invalid`, `aria-describedby` via render prop,
 * so any control (Input, Select, custom) gets correct a11y wiring.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (a11y: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  const hasMsg = Boolean(error || hint);
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-secondary">
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": hasMsg ? msgId : undefined })}
      {error ? (
        <p id={msgId} className="m-0 text-xs text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="m-0 text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { state?: FieldState; mono?: boolean; suffix?: ReactNode };

export function Input({ state = "default", mono, suffix, className, ...rest }: InputProps) {
  const input = <input className={cx(INPUT_BASE, "h-10", INPUT_STATE[state], mono && "mono", suffix ? "pr-14" : undefined, className)} {...rest} />;
  if (!suffix) return input;
  return (
    <div className="relative">
      {input}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-muted">{suffix}</span>
    </div>
  );
}

export function Select({ state = "default", className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { state?: FieldState }) {
  return (
    <select className={cx(INPUT_BASE, "h-10 cursor-pointer appearance-none bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2212%22%20height=%2212%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%238A93A3%22%20stroke-width=%222%22%3E%3Cpath%20d=%22m6%209%206%206%206-6%22/%3E%3C/svg%3E')] bg-[position:right_12px_center] bg-no-repeat pr-9", INPUT_STATE[state], className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ state = "default", className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { state?: FieldState }) {
  return <textarea className={cx(INPUT_BASE, "min-h-20 py-2.5", INPUT_STATE[state], className)} {...rest} />;
}

/** Blurred until hover/focus, amber border. For one-time secrets ("Save this key now. You won't see it again."). */
export function SecretField({ value, label: labelProp }: { value: string; label?: string }) {
  const t = useT();
  const label = labelProp ?? t("cs.secretLabel");
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-secondary">{label}</span>
      <div tabIndex={0} aria-label={t("kit.focusToReveal", { label })} className="secret mono rounded-input border border-warn bg-surface-sunken px-3 py-2.5 text-[13px] break-all">
        {value}
      </div>
      <p className="m-0 text-xs text-warn">{t("kit.saveKeyShort")}</p>
    </div>
  );
}

/** Done button that unlocks after `delayMs` and a "saved" checkbox (Connect step of the add-agent wizard). */
export function useSecretAck(delayMs = 3000) {
  const [ready, setReady] = useState(false);
  const [acked, setAcked] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
  return { canFinish: ready && acked, ready, acked, setAcked };
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2.5 text-sm", disabled && "cursor-not-allowed opacity-40")}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden="true"
        className={cx(
          "flex size-[18px] items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:shadow-[0_0_0_3px_rgb(46_204_113/0.18)]",
          checked ? "border-ok bg-ok text-ok-on" : "border-line-strong bg-surface-sunken",
        )}
      >
        {checked && <Check size={12} strokeWidth={3} className="check-pop" />}
      </span>
      {label}
    </label>
  );
}

/* ───────────── Toggle ───────────── */

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-6 w-10 shrink-0 cursor-pointer rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-ok bg-ok" : "border-line-strong bg-track",
      )}
    >
      <span className={cx("absolute top-[3px] left-[3px] size-4 rounded-full transition-transform duration-200 ease-sheet", checked ? "translate-x-4 bg-ok-on" : "bg-ink-muted")} />
    </button>
  );
}

/* ───────────── Chips & segmented ───────────── */

export function Chip({ selected, onClick, children, icon, size = "md" }: { selected?: boolean; onClick?: () => void; children: ReactNode; icon?: ReactNode; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        "at-btn inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap",
        size === "md" ? "h-9" : "h-8",
        selected ? "border-ok bg-ok-tint text-ink" : "border-line-strong bg-transparent text-ink-secondary",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode };

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: SegmentOption<T>[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-[9px] border border-line bg-surface-sunken p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx("h-7 cursor-pointer rounded-[7px] border-0 px-2.5 text-xs transition-colors", on ? "bg-line text-ink" : "bg-transparent text-ink-muted hover:text-ink")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ───────────── Tabs ───────────── */

export type TabItem<T extends string> = { value: T; label: ReactNode; count?: number };

/** 44 px text tabs with a sliding 2 px green underline; `count` renders as an amber mono pill. */
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: TabItem<T>[]; label: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  // Position the underline imperatively (no state → no extra render); CSS transitions do the slide.
  useLayoutEffect(() => {
    const list = listRef.current;
    const bar = barRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!bar || !tab) return;
    bar.style.width = `${tab.offsetWidth - 24}px`;
    bar.style.transform = `translateX(${tab.offsetLeft + 12}px)`;
  }, [value, items]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = items.findIndex((t) => t.value === value);
    const next = items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
    if (next) onChange(next.value);
  };
  return (
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKey} className="relative flex gap-1 overflow-x-auto border-b border-line">
      {items.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cx("relative flex h-11 shrink-0 cursor-pointer items-center gap-2 border-0 bg-transparent px-4 font-medium transition-colors", on ? "text-ink" : "text-ink-muted hover:text-ink")}
          >
            {t.label}
            {t.count ? <span className="mono rounded-full bg-warn-tint px-1.5 text-[11px] text-warn">{t.count}</span> : null}
          </button>
        );
      })}
      <span ref={barRef} aria-hidden="true" className="absolute bottom-0 left-0 h-0.5 rounded-full bg-ok transition-[transform,width] duration-300 ease-sheet motion-reduce:transition-none" />
    </div>
  );
}

/* ───────────── Stepper ───────────── */

/** Thin progress segments + numbered labels; done steps get a green check. `current` is 0-based. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  const t = useT();
  return (
    <ol className="m-0 grid list-none gap-2 p-0" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label={t("kit.progress")}>
      {steps.map((s, i) => {
        const done = i < current;
        const on = i === current;
        return (
          <li key={s} aria-current={on ? "step" : undefined} className="flex min-w-0 flex-col gap-2">
            <span className="h-[3px] overflow-hidden rounded-full bg-track">
              <span className="fill-transition block h-full bg-ok" style={{ width: done || on ? "100%" : "0%", opacity: on ? 0.55 : 1 }} />
            </span>
            <span className={cx("flex min-w-0 items-center gap-1.5 text-xs", done || on ? "text-ink" : "text-ink-subtle")}>
              <span className={cx("mono flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10px]", done ? "border-ok bg-ok text-ok-on" : on ? "border-ok text-ok" : "border-line-strong")}>
                {done ? <Check size={11} strokeWidth={3} className="check-pop" /> : i + 1}
              </span>
              <span className="truncate">{s}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ───────────── Timeline ───────────── */

export type TimelineStep = { title: ReactNode; detail?: ReactNode; state: "done" | "active" | "todo" | "failed" };

/** Vertical payout timeline: green fill grows down to the active step; done = check pops in, active = amber spinner. */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  const reached = steps.reduce((n, s, i) => (s.state === "done" || s.state === "active" || s.state === "failed" ? i : n), 0);
  const fillPct = steps.length > 1 ? (reached / (steps.length - 1)) * 100 : 0;
  return (
    <ol className="relative m-0 list-none p-0">
      <span aria-hidden="true" className="absolute top-3 bottom-3 left-[11px] w-0.5 bg-track">
        <span className="fill-transition block w-full bg-ok" style={{ height: `${fillPct}%` }} />
      </span>
      {steps.map((s, i) => (
        <li key={i} className={cx("relative flex gap-3.5 pb-5 last:pb-0", s.state === "todo" && "opacity-45")}>
          <span className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full bg-surface">
            {s.state === "done" && (
              <span className="check-pop flex size-6 items-center justify-center rounded-full bg-ok text-ok-on">
                <Check size={13} strokeWidth={3} />
              </span>
            )}
            {s.state === "active" && <Loader size={20} className="spin text-warn" />}
            {s.state === "failed" && <span className="flex size-6 items-center justify-center rounded-full bg-danger text-xs font-bold text-white">!</span>}
            {s.state === "todo" && <span className="size-5 rounded-full border-[1.5px] border-dashed border-ink-subtle" />}
          </span>
          <div className="min-w-0 pt-0.5">
            <div className={cx("font-medium", s.state === "failed" && "text-danger-text")}>{s.title}</div>
            {s.detail && <div className="mt-0.5 text-[13px] text-ink-muted">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
