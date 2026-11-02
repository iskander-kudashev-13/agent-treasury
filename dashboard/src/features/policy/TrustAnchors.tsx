import { useT } from "@/i18n";
import { useState } from "react";
import { isAccountId, measurementLabel, parseMeasurements, parsePpids } from "@/lib/trustAnchors";
import type { ContractInfo } from "@/lib/types";
import { useApprovedMeasurements, useApprovedPpids, useLocalWhitelist } from "@/lib/useTrust";
import { Banner, Button, Card, CardHeader, EmptyState, Field, Icons, Input, Pill, Textarea } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

const HOUR_MS = 3_600_000;

function Row({ label, detail, onRemove, disabled }: { label: string; detail?: React.ReactNode; onRemove: () => void; disabled: boolean }) {
  const t = useT();
  return (
    <li className="flex items-start gap-3 border-t border-track py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="mono text-xs break-all">{label}</div>
        {detail}
      </div>
      <Button size="sm" variant="danger" disabled={disabled} onClick={onRemove} title={t("ta.removeTitle")}>
        {t("ta.remove")}
      </Button>
    </li>
  );
}

/** TEE trust anchors: approved measurements, PPIDs, attestation validity, and the dev-only whitelist (local mode). */
export function TrustAnchors({ info }: { info: ContractInfo | null }) {
  const t = useT();
  const { canAct, busy, act } = useOwner();
  const meas = useApprovedMeasurements();
  const ppids = useApprovedPpids();
  const wl = useLocalWhitelist();
  const [mText, setMText] = useState("");
  const [pText, setPText] = useState("");
  const [aText, setAText] = useState("");
  const [hours, setHours] = useState("");
  const off = !canAct || busy;
  const m = mText.trim() ? parseMeasurements(mText) : null;
  const p = parsePpids(pText);
  const local = info !== null && !info.requires_tee;
  const hoursNum = Number(hours);
  const hoursOk = hours.trim() !== "" && Number.isFinite(hoursNum) && hoursNum >= 1;
  return (
    <>
      {local && (
        <Banner accent="danger" icon={<Icons.AlertTriangle size={14} />}>
          {t("ta.insecure")}
        </Banner>
      )}
      <Card aria-labelledby="tee-title" className="flex flex-col gap-4">
        <CardHeader id="tee-title" title={t("ta.title")} badge={info && <Pill accent={info.requires_tee ? "ok" : "danger"}>{info.requires_tee ? t("ta.teeRequired") : t("ta.localMode")}</Pill>} />
        <p className="m-0 text-[13px] text-ink-muted">{t("ta.intro")}</p>

        <section aria-label={t("ta.measAria")} className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">{t("ta.measTitle", { n: meas.data.length })}</h3>
          {meas.data.length === 0 ? (
            <EmptyState title={t("ta.noMeas")}>{t("ta.noMeasHint")}</EmptyState>
          ) : (
            <ul className="m-0 list-none p-0">
              {meas.data.map((x, i) => (
                <Row key={i} label={measurementLabel(x)} disabled={off} onRemove={() => window.confirm(t("ta.confirmRemoveMeas")) && void act("remove_measurements", { measurements: x })} detail={<details className="text-xs text-ink-muted"><summary className="cursor-pointer">{t("ta.fullJson")}</summary><pre className="mono m-0 break-all whitespace-pre-wrap">{JSON.stringify(x, null, 2)}</pre></details>} />
              ))}
            </ul>
          )}
          <Field label={t("ta.approveMeasJson")} error={m?.error} hint={t("ta.measHint", { shape: "{rtmrs:{mrtd,rtmr0,rtmr1,rtmr2}, key_provider_event_digest, app_compose_hash_payload}" })}>
            {(a) => <Textarea {...a} rows={4} className="mono text-xs" value={mText} onChange={(e) => setMText(e.target.value)} />}
          </Field>
          <div>
            <Button disabled={off || !m?.value} onClick={() => m?.value && void act("approve_measurements", { measurements: m.value }).then((ok) => ok && setMText(""))} title={t("pol.oneYocto")}>
              {t("ta.approveMeas")}
            </Button>
          </div>
        </section>

        <section aria-label={t("ta.ppidAria")} className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">{t("ta.ppidTitle", { n: ppids.data.length })}</h3>
          {ppids.data.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-muted">{t("ta.noPpid")}</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {ppids.data.map((id) => (
                <Row key={id} label={id} disabled={off} onRemove={() => window.confirm(t("ta.confirmRemovePpid")) && void act("remove_ppids", { ppids: [id] })} />
              ))}
            </ul>
          )}
          <Field label={t("ta.approvePpids")} error={p.error} hint={t("ta.ppidHint")}>
            {(a) => <Textarea {...a} rows={2} className="mono text-xs" value={pText} onChange={(e) => setPText(e.target.value)} />}
          </Field>
          <div>
            <Button disabled={off || p.value.length === 0 || p.error !== null} onClick={() => void act("approve_ppids", { ppids: p.value }).then((ok) => ok && setPText(""))} title={t("pol.oneYocto")}>
              {t("ta.approvePpids")}
            </Button>
          </div>
        </section>

        <section aria-label={t("ta.attAria")} className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">{t("ta.attTitle")}</h3>
          <Field label={t("ta.reattest")} hint={t("ta.reattestHint", { hours: info ? Number(info.attestation_expiration_time_ms) / HOUR_MS : "?" })}>
            {(a) => (
              <div className="flex gap-2">
                <Input {...a} mono inputMode="decimal" className="max-w-32" value={hours} onChange={(e) => setHours(e.target.value)} />
                <Button disabled={off || !hoursOk} onClick={() => void act("update_attestation_expiration_time", { attestation_expiration_time_ms: String(Math.round(hoursNum * HOUR_MS)) }).then((ok) => ok && setHours(""))} title={t("pol.oneYocto")}>
                  {t("ta.update")}
                </Button>
              </div>
            )}
          </Field>
        </section>

        {local && (
          <section aria-label={t("ta.wlAria")} className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">{t("ta.wlTitle", { n: wl.data.length })}</h3>
            <p className="m-0 text-[13px] text-ink-muted">{t("ta.wlHint")}</p>
            {wl.data.length > 0 && (
              <ul className="m-0 list-none p-0">
                {wl.data.map((acc) => (
                  <Row key={acc} label={acc} disabled={off} onRemove={() => void act("remove_agent_from_whitelist_for_local", { account_id: acc })} />
                ))}
              </ul>
            )}
            <Field label={t("ta.wlAdd")} error={aText && !isAccountId(aText.trim()) ? t("admin.invalidAccount") : undefined}>
              {(a) => (
                <div className="flex gap-2">
                  <Input {...a} mono value={aText} onChange={(e) => setAText(e.target.value.trim())} placeholder="agent.testnet" />
                  <Button disabled={off || !isAccountId(aText)} onClick={() => void act("whitelist_agent_for_local", { account_id: aText }).then((ok) => ok && setAText(""))} title={t("pol.oneYocto")}>
                    {t("ta.wlBtn")}
                  </Button>
                </div>
              )}
            </Field>
          </section>
        )}
      </Card>
    </>
  );
}
