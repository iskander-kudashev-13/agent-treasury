// Modal (confirm sheet), drawer, toasts. DESIGN_SYSTEM.md §4–5, §7 (role="dialog" aria-modal, Esc closes, focus moves in).
import { useT } from "@/i18n";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "./icons";
import { cx, IconButton } from "./primitives";
import type { Accent } from "./tokens";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[autofocus], input, select, textarea, button:not([data-close])");
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Red border (Revoke / Pause confirmations). */
  danger?: boolean;
  width?: number;
};

/** Centered sheet, max 420–520 px, backdrop rgba(5,6,8,.72), enter translateY(20px) scale(.98). */
export function Modal({ open, onClose, title, children, footer, danger, width = 460 }: ModalProps) {
  const t = useT();
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div className="fade-in fixed inset-0 z-40 flex items-end justify-center bg-[rgb(5_6_8/0.72)] p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx("sheet-in flex w-full flex-col gap-4 rounded-sheet border bg-surface p-6 outline-none", danger ? "border-danger/60" : "border-line")}
        style={{ maxWidth: width }}
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="m-0 flex-1 text-lg font-semibold">
            {title}
          </h2>
          <IconButton label={t("common.close")} data-close onClick={onClose} className="-mt-1 -mr-2">
            <X size={16} />
          </IconButton>
        </div>
        {children && <div className="text-ink-secondary">{children}</div>}
        {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
};

/** Right-side drawer, max 480–520 px. Footer convention: Cancel + primary; amber "Confirm in wallet…" while signing. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 500 }: DrawerProps) {
  const t = useT();
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div className="fade-in fixed inset-0 z-40 flex justify-end bg-[rgb(5_6_8/0.72)]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="drawer-in flex h-full w-full flex-col border-l border-line bg-surface outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex items-start gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 text-lg font-semibold">
              {title}
            </h2>
            {subtitle && <p className="m-0 mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
          </div>
          <IconButton label={t("common.close")} data-close onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Amber "Confirm in wallet…" text for drawer/modal footers while a wallet signature is pending. */
export function SigningHint({ children }: { children?: ReactNode }) {
  const t = useT();
  return <span className="mr-auto text-[13px] text-warn">{children ?? t("common.confirmInWallet")}</span>;
}

/* ───────────── Toasts ───────────── */

export type ToastInput = { text: ReactNode; accent?: Accent; href?: string; hrefLabel?: string; durationMs?: number };
type ToastItem = ToastInput & { id: number };

const ToastCtx = createContext<((t: ToastInput) => void) | null>(null);

const RING: Record<Accent, string> = { ok: "ring-ok/50", warn: "ring-warn/50", danger: "ring-danger/60", info: "ring-info/50", neutral: "ring-line-strong" };
const DOT: Record<Accent, string> = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", info: "bg-info", neutral: "bg-neutral-fill" };

/** Wrap the app once; call `useToast()(…)` anywhere. Bottom-right, auto-hides ~3 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const tr = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.durationMs ?? 3000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      {createPortal(
        <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2 md:right-6 md:bottom-6">
          {items.map((t) => (
            <div key={t.id} role="status" className={cx("sheet-in pointer-events-auto flex max-w-[400px] items-center gap-2.5 rounded-tile bg-surface-raised px-3.5 py-3 text-[13px] ring-1", RING[t.accent ?? "ok"])}>
              <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", DOT[t.accent ?? "ok"])} />
              <span className="min-w-0">
                {t.text}
                {t.href && (
                  <>
                    {" "}
                    <a href={t.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 whitespace-nowrap">
                      {t.hrefLabel ?? tr("common.viewTx")} <ExternalLink size={12} />
                    </a>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): (t: ToastInput) => void {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
