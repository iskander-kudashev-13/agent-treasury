import { Callout, Hash } from "@/kit";
import type { AccountTrust } from "@/lib/tradingView";

/**
 * Danger callout when the Hyperliquid account the worker reports is not the one the vault pays (audit M7). Shown on the
 * Trading page; rules cannot be confirmed while it is up. Renders nothing when the chain agrees.
 */
export function AccountTrustCallout({ trust }: { trust: AccountTrust | null }) {
  if (!trust || trust.kind === "ok") return null;
  if (trust.kind === "mismatch") {
    return (
      <Callout accent="danger">
        <strong>The worker reports a different Hyperliquid account than your vault pays.</strong> Do not approve any API wallet and do not confirm rules. Check{" "}
        <span className="mono">VITE_WORKER_URL</span> and the worker&apos;s <span className="mono">HL_MASTER_ADDRESS</span>.
        <span className="mt-1.5 flex flex-col gap-1 text-xs">
          <span>
            Worker says: <Hash value={trust.reported} short={false} copy={false} className="align-bottom" />
          </span>
          <span>
            Vault pays: <Hash value={trust.onchain} short={false} copy={false} className="align-bottom" />
          </span>
        </span>
      </Callout>
    );
  }
  return (
    <Callout accent="warn">
      {trust.reason} Rules cannot be confirmed until it can.
    </Callout>
  );
}
