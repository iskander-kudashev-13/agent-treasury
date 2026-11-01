// App shell: sticky header with logo, vault id, network pill, nav, assistant button, account. Matches Main.dc.html.
import type { ReactNode } from "react";
import { Sparkles } from "./icons";
import { cx, Dot, Hash, Pill } from "./primitives";

export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
    <rect x="1" y="1" width="26" height="26" rx="8" fill="var(--color-surface)" stroke="var(--color-line)" />
    <path d="M8 12h12v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z" fill="none" stroke="var(--color-ok)" strokeWidth="1.6" />
    <path d="M10.5 12V9.5a3.5 3.5 0 0 1 7 0V12" fill="none" stroke="var(--color-ok)" strokeWidth="1.6" />
    <circle cx="14" cy="16.5" r="1.4" fill="var(--color-ok)" />
  </svg>
);

export type NavItem = { label: string; href: string; active?: boolean };

export function AppHeader({
  vaultId,
  network,
  nav,
  account,
  onAccountClick,
  onAssistant,
  actions,
  banner,
}: {
  vaultId: string;
  network: "testnet" | "mainnet";
  nav: NavItem[];
  account?: string | null;
  onAccountClick?: () => void;
  onAssistant?: () => void;
  /** Extra controls right before the Assistant button (e.g. the global "Pause all agents" button). */
  actions?: ReactNode;
  /** e.g. <Banner>Agent paused — …</Banner> */
  banner?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-content flex-wrap items-center gap-3 px-4 py-3 md:gap-4 md:px-6">
        <a href="#/" className="flex items-center gap-2.5 text-ink no-underline hover:text-ink hover:no-underline">
          <Logo />
          <span className="text-[15px] font-semibold">Agent Treasury</span>
        </a>
        <span className="hidden h-8 items-center rounded-input border border-line bg-surface pl-2.5 text-ink-muted sm:inline-flex">
          <Hash value={vaultId} short={false} className="[&>span:first-child]:text-xs" />
        </span>
        {network === "testnet" ? <Pill accent="warn">testnet</Pill> : <Pill accent="ok">mainnet</Pill>}
        <nav aria-label="Main" className="order-last flex w-full gap-1 overflow-x-auto md:order-none md:ml-2 md:w-auto">
          {nav.map((n) => (
            <a
              key={n.href}
              href={n.href}
              aria-current={n.active ? "page" : undefined}
              className={cx("rounded-input px-2.5 py-1.5 whitespace-nowrap no-underline hover:no-underline", n.active ? "bg-surface-raised text-ink hover:text-ink" : "text-ink-muted hover:text-ink")}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="grow" />
        {actions}
        {onAssistant && (
          <button type="button" onClick={onAssistant} className="at-btn inline-flex h-9 cursor-pointer items-center gap-2 rounded-input border border-ai-line bg-ai px-3 text-[13px] text-ai-text">
            <Sparkles size={14} />
            <span className="sr-only sm:not-sr-only">Assistant</span>
          </button>
        )}
        <button type="button" onClick={onAccountClick} className="at-btn inline-flex h-9 cursor-pointer items-center gap-2 rounded-input border border-line bg-surface px-3 text-ink">
          {account ? (
            <>
              <Dot accent="ok" />
              <span className="mono text-xs">{account}</span>
            </>
          ) : (
            <span className="text-[13px] font-medium">Connect wallet</span>
          )}
        </button>
      </div>
      {banner}
    </header>
  );
}

/** Page container: max 1280, 24 px gutter (16 on mobile), 16 px vertical rhythm. */
export function Page({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-content flex-col gap-4 px-4 py-6 md:px-6">
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-3">
          {title && <h1 className="m-0 text-2xl font-semibold">{title}</h1>}
          <div className="grow" />
          {actions}
        </div>
      )}
      {children}
    </main>
  );
}

/** Mandate sentence: glue words secondary, numbers/chains bold. Pass parts as children with <MandateValue>. */
export const MandateSentence = ({ children }: { children: ReactNode }) => <p className="m-0 text-sentence text-ink-secondary">{children}</p>;
export const MandateValue = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-ink">{children}</strong>;
