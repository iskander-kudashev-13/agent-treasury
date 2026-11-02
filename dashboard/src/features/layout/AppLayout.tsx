import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { NETWORK, VAULT_ID, AI_ENABLED } from "@/lib/config";
import { usePolicy } from "@/lib/useVault";
import { AppHeader, Banner, Button, Callout, cx, Dot, Icons, Modal, Page, type NavItem } from "@/kit";
import { useAssistantPanel } from "./AssistantContext";
import { AssistantPanel } from "./AssistantPanel";
import { PauseAll } from "./PauseAll";

/** Single source of truth for navigation (desktop header + mobile tabs). `mobile: false` = overflow menu on mobile. */
export const NAV = [
  { label: "Treasury", to: "/", mobile: true },
  { label: "Agents", to: "/agents", mobile: true },
  { label: "Payments", to: "/payments", mobile: true },
  { label: "Payouts", to: "/payouts", mobile: true },
  { label: "Trading", to: "/trading", mobile: false },
  { label: "Policy", to: "/policy", mobile: false },
] as const;

const isActive = (pathname: string, to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));

function MobileNav() {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  const policyActive = NAV.some((n) => !n.mobile && isActive(pathname, n.to)); // "More" is bold when one of its items is open
  return (
    <nav aria-label="Main (mobile)" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-bg/95 backdrop-blur md:hidden">
      {NAV.filter((n) => n.mobile).map((n) => (
        <Link
          key={n.to}
          to={n.to}
          aria-current={isActive(pathname, n.to) ? "page" : undefined}
          className={cx("flex-1 py-3 text-center text-xs no-underline hover:no-underline", isActive(pathname, n.to) ? "font-semibold text-ink" : "text-ink-muted")}
        >
          {n.label}
        </Link>
      ))}
      <div className="relative flex-1">
        <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className={cx("w-full cursor-pointer py-3 text-xs", policyActive ? "font-semibold text-ink" : "text-ink-muted")}>
          More
        </button>
        {more && (
          <div className="absolute right-2 bottom-full mb-2 min-w-32 rounded-tile border border-line bg-surface-raised p-1">
            {NAV.filter((n) => !n.mobile).map((n) => (
              <Link key={n.to} to={n.to} onClick={() => setMore(false)} className="block rounded-input px-3 py-2 text-sm text-ink no-underline hover:bg-surface-hover hover:no-underline">
                {n.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function AccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { accountId, signOut } = useWallet();
  const { canAct, ownerId } = useOwner();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Wallet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => {
              void signOut();
              onClose();
            }}
          >
            Sign out
          </Button>
        </>
      }
    >
      <p className="m-0 mono break-all text-ink">{accountId}</p>
      <p className="mt-2 mb-0">{canAct ? "You are the vault owner." : `Read-only: the vault owner is ${ownerId ?? "unknown"}.`}</p>
    </Modal>
  );
}

function ShellMissingVault() {
  return (
    <Page title="Vault is not configured">
      <Callout accent="danger">
        Set <code>VITE_VAULT_CONTRACT</code> in <code>dashboard/.env.local</code> (see <code>.env.example</code>) and restart the dev server.
      </Callout>
    </Page>
  );
}

/** App shell: header + paused banner + guest banner, routed content, assistant panel, mobile tabs. Pages render inside <Outlet/>. */
export function AppLayout() {
  const { pathname } = useLocation();
  const { accountId, signIn, ready } = useWallet();
  const { canAct, ownerId } = useOwner();
  const { data: policy } = usePolicy();
  const assistant = useAssistantPanel();
  const [accountOpen, setAccountOpen] = useState(false);

  const nav: NavItem[] = NAV.map((n) => ({ label: n.label, href: `#${n.to}`, active: isActive(pathname, n.to) }));
  const guest = accountId !== null && ownerId !== null && !canAct;

  return (
    <div className="min-h-dvh">
      <div className="max-md:[&_nav]:hidden">
        <AppHeader
          vaultId={VAULT_ID || "no vault configured"}
          network={NETWORK}
          nav={nav}
          account={accountId}
          onAccountClick={() => (accountId ? setAccountOpen(true) : ready && signIn())}
          onAssistant={AI_ENABLED ? assistant.toggle : undefined}
          actions={VAULT_ID ? <PauseAll /> : undefined}
          banner={
            policy?.paused ? (
              <Banner icon={<Icons.Pause size={14} />}>Agent paused — no payments will be made until you resume.</Banner>
            ) : undefined
          }
        />
      </div>
      <div className="flex">
        <div className="min-w-0 flex-1 pb-20 md:pb-0">
          {guest && (
            <div className="mx-auto max-w-content px-4 pt-4 md:px-6">
              <Callout accent="neutral" icon={<Dot accent="neutral" hollow />}>
                You are viewing this vault as a guest. Only the owner ({ownerId}) can change settings.
              </Callout>
            </div>
          )}
          {VAULT_ID ? <Outlet /> : <ShellMissingVault />}
        </div>
        <AssistantPanel />
      </div>
      <MobileNav />
      {AI_ENABLED && !assistant.open && (
        <button
          type="button"
          aria-label="Open assistant"
          onClick={assistant.toggle}
          className="at-btn fixed right-4 bottom-20 z-30 flex size-12 cursor-pointer items-center justify-center rounded-full border border-ai-line bg-ai text-ai-text md:hidden"
        >
          <Icons.Sparkles size={20} />
        </button>
      )}
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
