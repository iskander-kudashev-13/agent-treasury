import type { QuoteGate } from "@/lib/oneclickStatus";
import { Button, Callout, Checkbox, Icons, Spinner } from "@/kit";

/** "Quote check" (audit H2): what 1Click says about this deposit address versus what the vault recorded. */
export function QuoteCheckPanel({
  gate,
  override,
  onOverride,
  onRecheck,
}: {
  gate: QuoteGate;
  override: boolean;
  onOverride: (v: boolean) => void;
  onRecheck: () => void;
}) {
  return (
    <section aria-labelledby="quote-check-title" className="flex flex-col gap-2.5 rounded-tile border border-line bg-surface-sunken p-3">
      <div className="flex items-center gap-2">
        <Icons.ShieldCheck size={16} className="text-ink-muted" />
        <h3 id="quote-check-title" className="m-0 text-sm font-semibold text-ink">
          Quote check
        </h3>
        <div className="grow" />
        <Button size="sm" variant="ghost" onClick={onRecheck} disabled={gate.phase === "checking"}>
          Check again
        </Button>
      </div>

      {gate.phase === "checking" && (
        <p className="m-0 flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner size={14} /> Asking NEAR Intents (1Click) which quote belongs to this deposit address…
        </p>
      )}

      {gate.phase === "no_address" && (
        <Callout accent="danger" icon={<Icons.AlertTriangle size={16} />}>
          <strong>This payout has no deposit address, so it cannot be verified.</strong> Reject it.
        </Callout>
      )}

      {gate.phase === "not_found" && (
        <Callout accent="danger" icon={<Icons.AlertTriangle size={16} />}>
          <strong>1Click has no quote for this deposit address.</strong> The agent may have submitted an address that is not a real Intents deposit address. Do not approve. Reject this payout.
        </Callout>
      )}

      {gate.phase === "unavailable" && (
        <>
          <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
            <strong>Could not verify the quote.</strong> {gate.reason}. You can retry, or check the deposit address yourself on the Intents explorer before approving.
          </Callout>
          <Checkbox checked={override} onChange={onOverride} label="I checked it myself: recipient, refund address and amount match this payout" />
        </>
      )}

      {gate.phase === "simulated" && (
        <>
          <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
            <strong>Simulated 1Click — quote check skipped (testnet only).</strong> The agent runs a fake 1Click, so there is no real quote behind this deposit address and nothing leaves NEAR. On mainnet this payout would be blocked.
          </Callout>
          <Checkbox checked={override} onChange={onOverride} label="I understand this is a testnet simulation and want to approve without a quote check" />
        </>
      )}

      {(gate.phase === "verified" || gate.phase === "mismatch") && (
        <>
          {gate.phase === "verified" ? (
            <Callout accent="ok" icon={<Icons.Check size={16} />}>
              The 1Click quote matches this payout.
            </Callout>
          ) : (
            <Callout accent="danger" icon={<Icons.AlertTriangle size={16} />}>
              <strong>Do not approve: the 1Click quote does not match this payout</strong> ({gate.check.mismatches.map((m) => m.label.toLowerCase()).join(", ")}). Funds sent to this deposit address could go to someone else. Reject it.
            </Callout>
          )}
          <dl className="m-0 grid grid-cols-1 gap-2 text-xs sm:grid-cols-[auto_1fr_1fr]">
            {gate.check.rows.map((r) => (
              <div key={r.key} className="contents">
                <dt className={r.ok ? "text-ink-muted" : "font-semibold text-danger-text"}>
                  {r.ok ? "✓" : "✗"} {r.label}
                </dt>
                <dd className="m-0 break-all">
                  <span className="text-ink-subtle">Vault: </span>
                  <span className="mono">{r.expected}</span>
                </dd>
                <dd className={`m-0 break-all ${r.ok ? "" : "text-danger-text"}`}>
                  <span className="text-ink-subtle">1Click: </span>
                  <span className="mono">{r.actual}</span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
