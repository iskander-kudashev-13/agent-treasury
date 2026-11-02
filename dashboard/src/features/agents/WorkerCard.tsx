import { useT } from "@/i18n";
import { shortId } from "@/kit/tokens";
import type { WorkerStatus } from "@/lib/types";
import { Callout, Card, CardHeader, Pill } from "@/kit";

const json = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

export function WorkerCard({ status, error, runs }: { status: WorkerStatus | null; error: string | null; runs: unknown[] }) {
  const t = useT();
  return (
    <Card aria-labelledby="worker-title" className="flex flex-col gap-3">
      <CardHeader id="worker-title" title={t("ag.workerTitle")} badge={status && <Pill accent={status.mode === "tee" ? "ok" : "warn"}>{status.mode.toUpperCase()}</Pill>} />
      {status?.mode === "local" && (
        <Callout accent="warn">
          <strong>{t("ag.workerLocal")}</strong> {t("ag.workerLocalNote")}
        </Callout>
      )}
      {error && <p className="m-0 text-ink-muted">{error}</p>}
      {status && (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-muted">{t("ag.workerAccount")}</dt>
          <dd className="mono m-0 text-xs break-all">{status.agentAccountId ?? "—"}</dd>
          <dt className="text-ink-muted">{t("ag.workerRegistered")}</dt>
          <dd className="m-0">{String(status.registered ?? "—")}</dd>
          <dt className="text-ink-muted">{t("ag.workerValid")}</dt>
          <dd className="m-0">{String(status.valid ?? "—")}</dd>
          <dt className="text-ink-muted">{t("ag.workerLastRun")}</dt>
          <dd className="m-0 break-all">{status.lastRun ? json(status.lastRun) : "—"}</dd>
          <dt className="text-ink-muted">{t("ag.workerNextRun")}</dt>
          <dd className="m-0 break-all">{status.nextRun ? json(status.nextRun) : "—"}</dd>
          {status.attestation !== undefined && status.attestation !== null && (
            <>
              <dt className="text-ink-muted">{t("ag.workerAttestation")}</dt>
              <dd className="mono m-0 text-xs break-all">{shortId(json(status.attestation), 60, 12)}</dd>
            </>
          )}
        </dl>
      )}
      {runs.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-secondary">{t("ag.workerRecent", { n: runs.length })}</summary>
          <ul className="mono mt-1 list-none space-y-1 p-0">
            {runs.slice(0, 10).map((r, i) => (
              <li key={i} className="break-all">
                {json(r)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
