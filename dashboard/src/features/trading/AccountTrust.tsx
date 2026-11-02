import { useT, rich } from "@/i18n";
import { Callout, Hash } from "@/kit";
import type { AccountTrust } from "@/lib/tradingView";

/**
 * Danger callout when the Hyperliquid account the worker reports is not the one the vault pays (audit M7). Shown on the
 * Trading page; rules cannot be confirmed while it is up. Renders nothing when the chain agrees.
 */
export function AccountTrustCallout({ trust }: { trust: AccountTrust | null }) {
  const t = useT();
  if (!trust || trust.kind === "ok") return null;
  if (trust.kind === "mismatch") {
    return (
      <Callout accent="danger">
        <strong>{t("trading.trustCallout.mismatchBold")}</strong> {rich("trading.trustCallout.mismatchTail", { url: <span className="mono">VITE_WORKER_URL</span>, env: <span className="mono">HL_MASTER_ADDRESS</span> })}
        <span className="mt-1.5 flex flex-col gap-1 text-xs">
          <span>
            {rich("trading.trustCallout.workerSays", { account: <Hash value={trust.reported} short={false} copy={false} className="align-bottom" /> })}
          </span>
          <span>
            {rich("trading.trustCallout.vaultPays", { account: <Hash value={trust.onchain} short={false} copy={false} className="align-bottom" /> })}
          </span>
        </span>
      </Callout>
    );
  }
  return (
    <Callout accent="warn">
      {t("trading.trustCallout.unverified", { reason: trust.reason })}
    </Callout>
  );
}
