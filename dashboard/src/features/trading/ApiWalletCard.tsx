import { useT, rich } from "@/i18n";
import { Button, Callout, Card, CardHeader, Hash, Icons, Pill } from "@/kit";
import { relativeTime } from "@/lib/relativeTime";
import type { HlAgent, TradingStatus } from "@/lib/tradingClient";
import { API_WALLET_HOURS, apiWalletName, hlAppUrl } from "@/lib/tradingView";
import { useNow } from "@/lib/useNow";
import { useState } from "react";

/**
 * The bot's own Hyperliquid API wallet. Only the address leaves the worker; the private key never does. The owner approves it
 * on app.hyperliquid.xyz with the master account (ADR-0005 §3). The indicator comes from the worker's status.
 *
 * Honest about what an API wallet can do (audit 2026-11-03 H2): it cannot withdraw to an external address, but it can trade
 * perps (also on builder dexes the bot does not see), move funds between spot and perp and possibly deposit into HL vaults. So
 * the master holds only session money and the wallet is short-lived and revoked after use.
 * `accountOk`: the worker's HL account matches the vault mandate; without it the approval steps are not shown (M7).
 * `hlAgents`: the API wallets Hyperliquid itself lists for that account (null = not read).
 */
export function ApiWalletCard({ status, accountOk, hlAgents }: { status: TradingStatus; accountOk: boolean; hlAgents: HlAgent[] | null }) {
  const t = useT();
  const now = useNow(30_000);
  const w = status.api_wallet;
  const [copied, setCopied] = useState(false);
  const name = apiWalletName(now);
  const url = hlAppUrl(status.hl_network);
  const mine = w.address.toLowerCase();
  const others = (hlAgents ?? status.other_approved_agents).filter((a) => a.address.toLowerCase() !== mine);
  const missing = w.approved && hlAgents !== null && mine !== "" && !hlAgents.some((a) => a.address.toLowerCase() === mine);
  return (
    <Card aria-labelledby="api-wallet" className="flex flex-col gap-3">
      <CardHeader
        id="api-wallet"
        title={t("trading.wallet.title")}
        badge={
          w.approved ? (
            <Pill accent="ok" icon={<Icons.Check size={12} strokeWidth={3} />}>
              {t("trading.wallet.approved")}
            </Pill>
          ) : (
            <Pill accent="warn">{t("trading.wallet.waiting")}</Pill>
          )
        }
      />
      {w.address ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-ink-muted">{t("trading.wallet.address")}</span>
          <Hash value={w.address} short={false} className="max-w-full" />
        </div>
      ) : (
        <p className="m-0 text-sm text-ink-muted">{t("trading.wallet.notCreated")}</p>
      )}
      {missing && <Callout accent="danger">{t("trading.wallet.missing")}</Callout>}
      {others.length > 0 && (
        <Callout accent="warn">
          {t("trading.wallet.others")}
          <span className="mt-1 flex flex-col gap-1">
            {others.map((a) => (
              <span key={a.address} className="mono text-xs break-all">
                {a.address}
                {a.name ? ` (${a.name})` : ""}
              </span>
            ))}
          </span>
        </Callout>
      )}
      {w.approved ? (
        <p className="m-0 text-xs text-ink-muted">
          {t("trading.wallet.approvedLine", { until: w.valid_until_ms ? t("trading.wallet.validUntil", { date: new Date(w.valid_until_ms).toISOString().slice(0, 10), rel: relativeTime(w.valid_until_ms, now) }) : "" })}
        </p>
      ) : !accountOk ? (
        w.address && <Callout accent="danger">{t("trading.wallet.notShown")}</Callout>
      ) : (
        w.address && (
          <>
            <ol className="m-0 flex flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
              <li>
                {rich("trading.wallet.step1", {
                  link: (
                    <a href={url} target="_blank" rel="noreferrer">
                      {url.replace("https://", "")} <Icons.ExternalLink size={12} className="inline" />
                    </a>
                  ),
                  account: <Hash value={status.hl_account} short copy={false} className="align-bottom" />,
                })}
              </li>
              <li>
                {t("trading.wallet.step2")}
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="mono rounded bg-surface-sunken px-1.5 py-0.5 text-xs break-all">{name}</span>
                  <Button
                    size="sm"
                    icon={<Icons.Copy size={13} />}
                    onClick={() =>
                      void navigator.clipboard?.writeText(name).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                    }
                  >
                    {copied ? t("common.copied") : t("trading.wallet.copyName")}
                  </Button>
                </span>
              </li>
              <li>{rich("trading.wallet.step3", { line: <span className="mono">api-wallet=</span>, hours: API_WALLET_HOURS })}</li>
              <li>{t("trading.wallet.step4")}</li>
            </ol>
            <p className="m-0 text-xs text-ink-subtle">
              {t("trading.wallet.caveat")}
            </p>
          </>
        )
      )}
    </Card>
  );
}
