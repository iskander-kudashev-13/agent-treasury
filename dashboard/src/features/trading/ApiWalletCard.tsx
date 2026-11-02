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
      {missing && <Callout accent="danger">Hyperliquid does not list this address as an API wallet of your account, although the worker says it is approved. Do not trust the worker&apos;s status.</Callout>}
      {others.length > 0 && (
        <Callout accent="warn">
          Other API wallets are approved on your Hyperliquid account. Revoke any you do not recognise (they have the same powers as the bot&apos;s wallet; a rotated wallet stays approved until you revoke it):
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
          Approved{w.valid_until_ms ? `, valid until ${new Date(w.valid_until_ms).toISOString().slice(0, 10)} (${relativeTime(w.valid_until_ms, now)})` : ""}. It cannot withdraw to another address, but it can trade perpetuals, move funds between spot and perp and more on your account. Keep only the session amount there and revoke it on Hyperliquid when you are done.
        </p>
      ) : !accountOk ? (
        w.address && <Callout accent="danger">Not shown: this dashboard could not confirm that the worker uses the Hyperliquid account your vault pays. Do not approve this address (see above).</Callout>
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
              <li>Check that the address matches the <span className="mono">api-wallet=</span> line in the worker console. Set the expiry to {API_WALLET_HOURS} hours at most (less than the mandate expiry), press Authorize and sign with your account.</li>
              <li>Come back here. This page checks every 10 seconds and turns green once it sees the approval.</li>
            </ol>
            <p className="m-0 text-xs text-ink-subtle">
              Hyperliquid cannot limit an API wallet to spot trading. The bot only places spot orders and stops if it sees a perpetuals position on the main account, but whoever holds this wallet&apos;s key
              can trade perpetuals (also on builder dexes the bot does not watch), move funds between spot and perp and more. It cannot withdraw to another address. So use a dedicated account that holds only
              the session amount, keep the expiry short, and revoke the wallet when the session ends.
            </p>
          </>
        )
      )}
    </Card>
  );
}
