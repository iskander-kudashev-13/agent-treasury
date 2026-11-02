import { Button, Card, CardHeader, Hash, Icons, Pill } from "@/kit";
import { relativeTime } from "@/lib/relativeTime";
import type { TradingStatus } from "@/lib/tradingClient";
import { API_WALLET_DAYS, apiWalletName, hlAppUrl } from "@/lib/tradingView";
import { useNow } from "@/lib/useNow";
import { useState } from "react";

/**
 * The bot's own Hyperliquid API wallet. Only the address leaves the worker; the private key never does. The owner approves it
 * on app.hyperliquid.xyz with the master account (ADR-0005 §3). The indicator comes from the worker's status.
 */
export function ApiWalletCard({ status }: { status: TradingStatus }) {
  const now = useNow(30_000);
  const w = status.api_wallet;
  const [copied, setCopied] = useState(false);
  const name = apiWalletName(now);
  const url = hlAppUrl(status.hl_network);
  return (
    <Card aria-labelledby="api-wallet" className="flex flex-col gap-3">
      <CardHeader
        id="api-wallet"
        title="Bot wallet"
        badge={
          w.approved ? (
            <Pill accent="ok" icon={<Icons.Check size={12} strokeWidth={3} />}>
              approved
            </Pill>
          ) : (
            <Pill accent="warn">waiting for approval</Pill>
          )
        }
      />
      {w.address ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-ink-muted">Address</span>
          <Hash value={w.address} short={false} className="max-w-full" />
        </div>
      ) : (
        <p className="m-0 text-sm text-ink-muted">The bot has not created its wallet yet. Start the worker with trading enabled.</p>
      )}
      {w.approved ? (
        <p className="m-0 text-xs text-ink-muted">
          Approved{w.valid_until_ms ? `, valid until ${new Date(w.valid_until_ms).toISOString().slice(0, 10)} (${relativeTime(w.valid_until_ms, now)})` : ""}. It can trade but cannot withdraw or send funds.
        </p>
      ) : (
        w.address && (
          <>
            <ol className="m-0 flex flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
              <li>
                Open{" "}
                <a href={url} target="_blank" rel="noreferrer">
                  {url.replace("https://", "")} <Icons.ExternalLink size={12} className="inline" />
                </a>{" "}
                and connect your Hyperliquid account <Hash value={status.hl_account} short copy={false} className="align-bottom" />.
              </li>
              <li>
                Paste the address above as a new API wallet and name it:
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
                    {copied ? "Copied" : "Copy name"}
                  </Button>
                </span>
              </li>
              <li>Set the expiry to {API_WALLET_DAYS} days (180 at most), press Authorize and sign with your account.</li>
              <li>Come back here. This page checks every 10 seconds and turns green once it sees the approval.</li>
            </ol>
            <p className="m-0 text-xs text-ink-subtle">Hyperliquid cannot limit an API wallet to spot trading. The bot only places spot orders and stops if it sees a perpetuals position.</p>
          </>
        )
      )}
    </Card>
  );
}
