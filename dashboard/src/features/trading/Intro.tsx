import { useT, rich } from "@/i18n";
import { useState } from "react";
import { Callout, Card, Icons, Pill } from "@/kit";
import { usdcGrouped } from "@/lib/amount";
import { hardLimitsOf, STEP_WALLETS, type StepId, type WalletKind } from "@/lib/tradingGuide";
import type { TradingStatus } from "@/lib/tradingClient";
import type { AgentView } from "@/lib/types";

const WALLET_ACCENT: Record<WalletKind, "ok" | "warn" | "neutral"> = { near: "ok", evm: "warn", bot: "neutral" };

/** A small badge naming the wallet the owner needs for a step. */
export function WalletBadge({ kind }: { kind: WalletKind }) {
  const t = useT();
  return <Pill accent={WALLET_ACCENT[kind]}>{t(`trading.wallet.kind.${kind}`)}</Pill>;
}

const BOX = "flex min-w-[130px] flex-1 flex-col gap-0.5 rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5 text-center";

/** Three boxes and two arrows: Vault -> (NEAR Intents) -> your Hyperliquid account <- bot. */
function MoneyFlow() {
  const t = useT();
  return (
    <div role="img" aria-label={t("trading.intro.flowAria")} className="flex flex-wrap items-stretch gap-2 md:flex-nowrap md:items-center">
      <div className={BOX}>
        <span className="text-sm font-semibold">{t("trading.intro.box.vault")}</span>
        <span className="text-xs text-ink-muted">{t("trading.intro.box.vaultSub")}</span>
      </div>
      <div className="flex flex-col items-center px-1 text-xs text-ink-muted">
        <span>{t("trading.intro.arrow.topup")}</span>
        <span aria-hidden="true" className="text-base leading-none">→</span>
      </div>
      <div className={BOX}>
        <span className="text-sm font-semibold">{t("trading.intro.box.hl")}</span>
        <span className="text-xs text-ink-muted">{t("trading.intro.box.hlSub")}</span>
      </div>
      <div className="flex flex-col items-center px-1 text-xs text-ink-muted">
        <span>{t("trading.intro.arrow.orders")}</span>
        <span aria-hidden="true" className="text-base leading-none">←</span>
      </div>
      <div className={BOX}>
        <span className="text-sm font-semibold">{t("trading.intro.box.bot")}</span>
        <span className="text-xs text-ink-muted">{t("trading.intro.box.botSub")}</span>
      </div>
    </div>
  );
}

function ThreeWallets() {
  const t = useT();
  const kinds: WalletKind[] = ["near", "evm", "bot"];
  const steps: StepId[] = [1, 2, 3, 4, 5, 6];
  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-sm font-semibold">{t("trading.intro.walletsTitle")}</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {kinds.map((k) => (
          <div key={k} className="flex flex-col gap-1.5 rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5">
            <div>
              <WalletBadge kind={k} />
            </div>
            <div className="text-sm font-semibold">{t(`trading.intro.w.${k}.name`)}</div>
            <p className="m-0 text-xs text-ink-secondary">{t(`trading.intro.w.${k}.what`)}</p>
            <p className="m-0 text-xs text-ink-muted">{t(`trading.intro.w.${k}.where`)}</p>
          </div>
        ))}
      </div>
      <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
        {t("trading.intro.neverNear")}
      </Callout>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-ink-muted">{t("trading.intro.perStep")}</div>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
          {steps.map((id) => (
            <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-[210px] text-ink-secondary">
                {id}. {t(`trading.step.${id}.title`)}
              </span>
              {STEP_WALLETS[id].length === 0 ? <span className="text-xs text-ink-subtle">{t("trading.intro.noWallet")}</span> : STEP_WALLETS[id].map((k) => <WalletBadge key={k} kind={k} />)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * What the trading agent is, where the money goes, what is and is not protected, and the three wallets. Open for a new user,
 * one line once set up. Numbers come from the mandate and the worker's limits, never typed into the copy.
 */
export function Intro({ trader, status, defaultOpen }: { trader: AgentView | null; status: TradingStatus | null; defaultOpen: boolean }) {
  const t = useT();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  const hard = hardLimitsOf(status);
  const daily = trader ? `${usdcGrouped(trader.mandate.daily_limit, 0)} USDC` : t("trading.intro.dailyWord");
  const approval = trader !== null && trader.mandate.approval_threshold === "0" ? t("trading.intro.p.approvalTail") : "";
  return (
    <Card aria-labelledby="trading-intro" className="flex flex-col gap-4">
      <details open={open} onToggle={(e) => setUserOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary id="trading-intro" className="cursor-pointer text-[15px] font-semibold">
          {open ? t("trading.intro.title") : t("trading.intro.collapsed")}
        </summary>
        <div className="mt-4 flex flex-col gap-5">
          <p className="m-0 text-sm leading-relaxed text-ink-secondary">{t("trading.intro.what")}</p>
          <MoneyFlow />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ok">
                <Icons.ShieldCheck size={15} /> {t("trading.intro.protected")}
              </h3>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-secondary">
                <li>{t("trading.intro.p.vault", { daily, tail: approval })}</li>
                <li>{t("trading.intro.p.bot")}</li>
                <li>{t("trading.intro.p.rules")}</li>
                <li>{hard ? t("trading.intro.p.caps", { pos: hard.maxPosition, order: hard.maxOrder, loss: hard.lossStop }) : t("trading.intro.p.capsGeneric")}</li>
                <li>{t("trading.intro.p.kill")}</li>
              </ul>
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-danger-text">
                <Icons.AlertTriangle size={15} /> {t("trading.intro.notProtected")}
              </h3>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-secondary">
                <li>{t("trading.intro.n.loss")}</li>
                <li>{t("trading.intro.n.account")}</li>
                <li>{t("trading.intro.n.perps")}</li>
                <li>{rich("trading.intro.n.local", { tee: <span className="mono">TEE</span> })}</li>
              </ul>
            </div>
          </div>
          <ThreeWallets />
        </div>
      </details>
    </Card>
  );
}
