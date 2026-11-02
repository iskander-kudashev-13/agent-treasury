import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { NETWORK, VAULT_ID, AI_ENABLED } from "@/lib/config";
import { useContractInfo, usePolicy } from "@/lib/useVault";
import type { MessageKey } from "@/i18n";
import { LanguageSwitcher, useT } from "@/i18n";
import { AppHeader, Banner, Button, Callout, cx, Dot, Icons, Modal, Page, Pill, type NavItem } from "@/kit";
import { useAssistantPanel } from "./AssistantContext";
import { AssistantPanel } from "./AssistantPanel";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { PauseAll } from "./PauseAll";

/** Single source of truth for navigation (desktop header + mobile tabs). `also` = other path prefixes that keep the tab highlighted. */
export const NAV = [
  { label: "nav.overview", to: "/", also: [] },
  { label: "nav.agents", to: "/agents", also: [] },
  { label: "nav.payments", to: "/payments", also: ["/payouts"] },
  { label: "nav.settings", to: "/settings", also: [] },
] as const satisfies readonly { label: MessageKey; to: string; also: readonly string[] }[];

const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);
const isActive = (pathname: string, n: { to: string; also: readonly string[] }) => (n.to === "/" ? pathname === "/" : under(pathname, n.to) || n.also.some((p) => under(pathname, p)));

function MobileNav() {
  const t = useT();
  const { pathname } = useLocation();
  return (
    <nav aria-label={t("nav.mainMobile")} className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-bg/95 backdrop-blur md:hidden">
      {NAV.map((n) => (
        <Link
          key={n.to}
          to={n.to}
          aria-current={isActive(pathname, n) ? "page" : undefined}
          className={cx("flex-1 py-3 text-center text-xs no-underline hover:no-underline", isActive(pathname, n) ? "font-semibold text-ink" : "text-ink-muted")}
        >
          {t(n.label)}
        </Link>
      ))}
    </nav>
  );
}

function AccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { accountId, signOut } = useWallet();
  const { canAct, ownerId } = useOwner();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("layout.walletTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            onClick={() => {
              void signOut();
              onClose();
            }}
          >
            {t("layout.signOut")}
          </Button>
        </>
      }
    >
      <p className="m-0 mono break-all text-ink">{accountId}</p>
      <p className="mt-2 mb-0">{canAct ? t("layout.youAreOwner") : t("layout.readOnly", { owner: ownerId ?? t("common.unknown") })}</p>
    </Modal>
  );
}

function ShellMissingVault() {
  const t = useT();
  return (
    <Page title={t("layout.vaultNotConfigured")}>
      <Callout accent="danger">
        {t("layout.setVaultEnv", { var: "VITE_VAULT_CONTRACT", file: "dashboard/.env.local", example: ".env.example" })}
      </Callout>
    </Page>
  );
}

/** App shell: header + paused banner + guest banner, routed content, assistant panel, mobile tabs. Pages render inside <Outlet/>. */
export function AppLayout() {
  const t = useT();
  const { pathname } = useLocation();
  const { accountId, signIn, ready } = useWallet();
  const { canAct, ownerId } = useOwner();
  const { data: policy } = usePolicy();
  const { data: info } = useContractInfo();
  const assistant = useAssistantPanel();
  const [accountOpen, setAccountOpen] = useState(false);

  const nav: NavItem[] = NAV.map((n) => ({ label: t(n.label), href: `#${n.to}`, active: isActive(pathname, n) }));
  const guest = accountId !== null && ownerId !== null && !canAct;

  return (
    <div className="min-h-dvh">
      <div className="max-md:[&_nav]:hidden">
        <AppHeader
          vaultId={VAULT_ID || t("layout.noVault")}
          network={NETWORK}
          nav={nav}
          account={accountId}
          onAccountClick={() => (accountId ? setAccountOpen(true) : ready && signIn())}
          onAssistant={AI_ENABLED ? assistant.toggle : undefined}
          badge={info && !info.requires_tee ? <Pill accent="warn" title={t("layout.testModeHint")}>{t("layout.testMode")}</Pill> : undefined}
          actions={
            <>
              <LanguageSwitcher />
              {VAULT_ID ? <PauseAll /> : undefined}
            </>
          }
          banner={
            policy?.paused ? (
              <Banner icon={<Icons.Pause size={14} />}>{t("layout.pausedBanner")}</Banner>
            ) : undefined
          }
        />
      </div>
      <div className="flex">
        <div className="min-w-0 flex-1 pb-20 md:pb-0">
          {guest && (
            <div className="mx-auto max-w-content px-4 pt-4 md:px-6">
              <Callout accent="neutral" icon={<Dot accent="neutral" hollow />}>
                {t("layout.guest", { owner: ownerId })}
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
          aria-label={t("layout.openAssistant")}
          onClick={assistant.toggle}
          className="at-btn fixed right-4 bottom-20 z-30 flex size-12 cursor-pointer items-center justify-center rounded-full border border-ai-line bg-ai text-ai-text md:hidden"
        >
          <Icons.Sparkles size={20} />
        </button>
      )}
      {VAULT_ID && <Onboarding />}
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
