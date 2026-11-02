import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { Callout, Checkbox, Icons } from "@/kit";
import type { CompatResult } from "@/lib/mandateCompat";
import type { AgentView } from "@/lib/types";

/**
 * Live mandate check (UI_UPDATES §4.2): red blocks Save, amber allows it. When the recipient is the only problem and the
 * mandate lists recipients (Fixed / Allowlist), the owner can tick a box that adds an `update_mandate` call to the same batch.
 */
export function MandateCompatibility({
  agent,
  compat,
  offerAddToMandate,
  addToMandate,
  onAddToMandate,
  disabled,
}: {
  agent: AgentView | undefined;
  compat: CompatResult;
  offerAddToMandate: boolean;
  addToMandate: boolean;
  onAddToMandate: (v: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const agentName = agent?.name ?? t("mc.theAgent");
  return (
    <div className="flex flex-col gap-2">
      {compat.errors.map((e) => (
        <Callout key={e.code} accent="danger" icon={<Icons.AlertTriangle size={14} />}>
          {e.message}
          {e.action && agent && (
            <>
              {" "}
              <Link to={`/agents/${encodeURIComponent(agent.id)}`}>{e.action}</Link>
            </>
          )}
        </Callout>
      ))}
      {offerAddToMandate && (
        <div className="rounded-tile border border-line bg-surface-sunken px-3 py-2.5">
          <Checkbox label={<span className="text-[13px]">{t("mc.alsoAdd", { agent: agentName })}</span>} checked={addToMandate} disabled={disabled} onChange={onAddToMandate} />
          <p className="m-0 mt-1 ml-7 text-xs text-ink-subtle">{t("mc.alsoAddHint")}</p>
        </div>
      )}
      {compat.warnings.map((w) => (
        <Callout key={w.code} accent="warn" icon={<Icons.AlertTriangle size={14} />}>
          {w.message}
        </Callout>
      ))}
    </div>
  );
}
