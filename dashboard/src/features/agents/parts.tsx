// Small shared pieces for the agent screens.
import type { ReactNode } from "react";
import { cx, Icons, MandateSentence, MandateValue } from "@/kit";
import { mandateSegments, type RecipientNames } from "@/lib/describeMandate";
import type { Trust } from "@/lib/agentView";
import type { Mandate } from "@/lib/types";

/** Mandate as a sentence: numbers and chains bold (DESIGN_AGENTS §5). */
export function MandateText({ mandate, names, nowMs }: { mandate: Mandate; names?: RecipientNames; nowMs?: number }) {
  return (
    <MandateSentence>
      {mandateSegments(mandate, names, nowMs).map((s, i) => (s.bold ? <MandateValue key={i}>{s.text}</MandateValue> : <span key={i}>{s.text}</span>))}
    </MandateSentence>
  );
}

/** Shield (TEE: green when verified, amber while waiting) or key (muted) + the trust line. */
export function TrustLine({ trust, className }: { trust: Trust; className?: string }) {
  const Icon = trust.kind === "tee" ? Icons.ShieldCheck : Icons.KeyRound;
  const tone = trust.tone === "ok" ? "text-ok" : trust.tone === "warn" ? "text-warn" : "text-ink-muted";
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-xs", tone, className)}>
      <Icon size={15} className="shrink-0" />
      <span className="mono truncate">{trust.line}</span>
    </span>
  );
}

/** Key/value rows. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">{children}</dl>;
}
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink">{children}</dd>
    </>
  );
}
