import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { Icons, Pill } from "@/kit";

export interface AttentionCounts { approvals: number; missed: number; refused: number }

/** "Needs your attention": only rendered when something is pending. Each item is a pill linking to where it is fixed. */
export function HomeAttention({ approvals, missed, refused }: AttentionCounts) {
  const t = useT();
  if (approvals + missed + refused === 0) return null;
  return (
    <section aria-label={t("home.attention")} className="flex flex-wrap items-center gap-2.5 rounded-card border border-warn-line bg-warn-soft px-4 py-3">
      <Icons.AlertTriangle size={16} className="text-warn" aria-hidden="true" />
      <h2 className="m-0 text-sm font-semibold text-warn">{t("home.attention")}</h2>
      {approvals > 0 && <Link to="/payments?tab=approvals" className="no-underline"><Pill accent="warn">{t("home.toApprove", { count: approvals })}</Pill></Link>}
      {missed > 0 && <Link to="/payments" className="no-underline"><Pill accent="warn">{t("treasury.missed", { count: missed })}</Pill></Link>}
      {refused > 0 && <Link to="/agents" className="no-underline"><Pill>{t("home.refused", { count: refused })}</Pill></Link>}
    </section>
  );
}
