// AI assistant pieces: proposal card, batch bar, suggestion chip, typing indicator. DESIGN_SYSTEM.md §4, UI_UPDATES §6.
import { useT } from "@/i18n";
import type { ReactNode } from "react";
import type { MessageKey } from "@/i18n";
import { AlertTriangle, Check, ChevronRight, Sparkles } from "./icons";
import { Button, cx } from "./primitives";

export type DiffRow = { label: ReactNode; from?: ReactNode; to: ReactNode };
export type ProposalStatus = "draft" | "queued" | "signed";

const STATUS_STYLE: Record<ProposalStatus, string> = {
  draft: "border-line-strong text-ink-muted",
  queued: "border-ai-active-line bg-ai-active text-ai-text",
  signed: "border-ok/50 bg-ok-tint text-ok",
};
const STATUS_LABEL: Record<ProposalStatus, MessageKey> = { draft: "kit.propDraft", queued: "kit.propQueued", signed: "kit.propSigned" };

/**
 * Structured change the assistant prepared. Nothing is sent until the owner signs.
 * `danger` = emergency variant (pause): red border + a single "Pause now" action passed via `actions`.
 */
export function ProposalCard({
  title,
  status,
  rows,
  warning,
  ok,
  danger,
  actions,
}: {
  title: ReactNode;
  status: ProposalStatus;
  rows: DiffRow[];
  warning?: ReactNode;
  ok?: ReactNode;
  danger?: boolean;
  actions?: ReactNode;
}) {
  const t = useT();
  return (
    <article className={cx("card-in flex flex-col gap-3 rounded-card border bg-surface p-4", danger ? "border-danger/60" : "border-line", status === "signed" && "just-signed")}>
      <header className="flex items-center gap-2">
        <h3 className="m-0 flex-1 text-sm font-semibold">{title}</h3>
        <span className={cx("inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px]", STATUS_STYLE[status])}>
          {status === "signed" && <Check size={11} strokeWidth={3} />}
          {t(STATUS_LABEL[status])}
        </span>
      </header>
      <dl className="m-0 flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[110px_minmax(0,1fr)] items-baseline gap-2 text-[13px]">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-1.5">
              {r.from !== undefined && <span className="mono text-ink-subtle line-through">{r.from}</span>}
              {r.from !== undefined && <span aria-hidden="true" className="text-ink-subtle">→</span>}
              <span className={cx("mono rounded px-1", r.from !== undefined ? "bg-ok-tint text-ok" : "text-ink")}>{r.to}</span>
            </dd>
          </div>
        ))}
      </dl>
      {warning && (
        <p className="m-0 flex items-start gap-1.5 text-xs text-warn">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          {warning}
        </p>
      )}
      {ok && (
        <p className="m-0 flex items-start gap-1.5 text-xs text-ok">
          <Check size={13} className="mt-px shrink-0" />
          {ok}
        </p>
      )}
      {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
    </article>
  );
}

/** Default action row for a draft proposal. */
export function ProposalActions({ onEdit, onDiscard, onQueue }: { onEdit?: () => void; onDiscard: () => void; onQueue: () => void }) {
  const t = useT();
  return (
    <>
      {onEdit && (
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {t("kit.editInForm")}
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={onDiscard}>
        {t("kit.discard")}
      </Button>
      <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={onQueue}>
        {t("kit.addToBatch")}
      </Button>
    </>
  );
}

/** Slides up above the chat input when ≥ 1 change is queued. */
export function BatchBar({ count, onReview }: { count: number; onReview: () => void }) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <div className="slide-up flex items-center gap-3 rounded-card border border-ai-active-line bg-ai-active px-3 py-2.5">
      <span className="mono flex size-6 items-center justify-center rounded-full bg-ok text-xs font-semibold text-ok-on">{count}</span>
      <span className="flex-1 text-[13px] text-ai-text">
        {t("kit.changesReady", { count })}
      </span>
      <Button size="sm" variant="primary" onClick={onReview}>
        {t("kit.reviewSign")} <ChevronRight size={14} />
      </Button>
    </div>
  );
}

export function SuggestionChip({ children, onClick, active }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("at-btn inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] text-ai-text", active ? "border-ai-active-line bg-ai-active" : "border-ai-line bg-ai")}
    >
      <Sparkles size={12} />
      {children}
    </button>
  );
}

export function TypingDots() {
  const t = useT();
  return (
    <span role="status" aria-label={t("kit.thinking")} className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="typing-dot size-1.5 rounded-full bg-ai-text" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

export function AssistantFooter() {
  const t = useT();
  return <p className="m-0 text-center text-[11px] text-ink-subtle">{t("kit.assistantFooter")}</p>;
}

/** Chat bubble. `streaming` shows the blinking block caret. */
export function Message({ from, children, streaming }: { from: "user" | "assistant"; children: ReactNode; streaming?: boolean }) {
  return (
    <div className={cx("flex", from === "user" ? "justify-end" : "justify-start")}>
      <div className={cx("max-w-[85%] rounded-card px-3.5 py-2.5 text-sm", from === "user" ? "bg-surface-raised text-ink" : "border border-ai-line bg-ai text-ink", streaming && "caret")}>{children}</div>
    </div>
  );
}
