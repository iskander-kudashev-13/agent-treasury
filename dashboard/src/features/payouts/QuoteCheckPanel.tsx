import { useT } from "@/i18n";
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
  const t = useT();
  return (
    <section aria-labelledby="quote-check-title" className="flex flex-col gap-2.5 rounded-tile border border-line bg-surface-sunken p-3">
      <div className="flex items-center gap-2">
        <Icons.ShieldCheck size={16} className="text-ink-muted" />
        <h3 id="quote-check-title" className="m-0 text-sm font-semibold text-ink">
          {t("qc.title")}
        </h3>
        <div className="grow" />
        <Button size="sm" variant="ghost" onClick={onRecheck} disabled={gate.phase === "checking"}>
          {t("qc.recheck")}
        </Button>
      </div>

      {gate.phase === "checking" && (
        <p className="m-0 flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner size={14} /> {t("qc.checking")}
        </p>
      )}

      {gate.phase === "no_address" && (
        <Callout accent="danger" icon={<Icons.AlertTriangle size={16} />}>
          <strong>{t("qc.noAddrBold")}</strong> {t("qc.noAddrTail")}
        </Callout>
      )}

      {gate.phase === "not_found" && (
        <Callout accent="danger" icon={<Icons.AlertTriangle size={16} />}>
          <strong>{t("qc.notFoundBold")}</strong> {t("qc.notFoundTail")}
        </Callout>
      )}

      {gate.phase === "unavailable" && (
        <>
          <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
            <strong>{t("qc.unavailBold")}</strong> {t("qc.unavailTail", { reason: gate.reason })}
          </Callout>
          <Checkbox checked={override} onChange={onOverride} label={t("qc.ackManual")} />
        </>
      )}

      {gate.phase === "simulated" && (
        <>
          <Callout accent="warn" icon={<Icons.AlertTriangle size={16} />}>
            <strong>{t("qc.simBold")}</strong> {t("qc.simTail")}
          </Callout>
          <Checkbox checked={override} onChange={onOverride} label={t("qc.ackSim")} />
        </>
      )}

      {(gate.phase === "verified" || gate.phase === "mismatch") && (
        <>
          {gate.phase === "verified" ? (
            <Callout accent="ok" icon={<Icons.Check size={16} />}>
              {t("qc.matches")}
            </Callout>
          ) : (
            <Callout accent="danger" icon={<Icons.AlertTriangle size={16} />}>
              <strong>{t("qc.mismatchBold")}</strong> {t("qc.mismatchTail", { what: gate.check.mismatches.map((m) => m.label.toLowerCase()).join(", ") })}
            </Callout>
          )}
          <dl className="m-0 grid grid-cols-1 gap-2 text-xs sm:grid-cols-[auto_1fr_1fr]">
            {gate.check.rows.map((r) => (
              <div key={r.key} className="contents">
                <dt className={r.ok ? "text-ink-muted" : "font-semibold text-danger-text"}>
                  {r.ok ? "✓" : "✗"} {r.label}
                </dt>
                <dd className="m-0 break-all">
                  <span className="text-ink-subtle">{t("qc.vault")}</span>
                  <span className="mono">{r.expected}</span>
                </dd>
                <dd className={`m-0 break-all ${r.ok ? "" : "text-danger-text"}`}>
                  <span className="text-ink-subtle">{t("qc.oneclick")}</span>
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
