import { useState } from "react";
import { isAccountId, measurementLabel, parseMeasurements, parsePpids } from "@/lib/trustAnchors";
import type { ContractInfo } from "@/lib/types";
import { useApprovedMeasurements, useApprovedPpids, useLocalWhitelist } from "@/lib/useTrust";
import { Banner, Button, Card, CardHeader, EmptyState, Field, Icons, Input, Pill, Textarea } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";

const HOUR_MS = 3_600_000;

function Row({ label, detail, onRemove, disabled }: { label: string; detail?: React.ReactNode; onRemove: () => void; disabled: boolean }) {
  return (
    <li className="flex items-start gap-3 border-t border-track py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="mono text-xs break-all">{label}</div>
        {detail}
      </div>
      <Button size="sm" variant="danger" disabled={disabled} onClick={onRemove} title="Agents relying on this are rejected immediately">
        Remove
      </Button>
    </li>
  );
}

/** TEE trust anchors: approved measurements, PPIDs, attestation validity, and the dev-only whitelist (local mode). */
export function TrustAnchors({ info }: { info: ContractInfo | null }) {
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
          Insecure local mode: this vault does not require TEE attestation. Anyone on the whitelist can act as an agent. Development only, never with real funds.
        </Banner>
      )}
      <Card aria-labelledby="tee-title" className="flex flex-col gap-4">
        <CardHeader id="tee-title" title="TEE trust anchors" badge={info && <Pill accent={info.requires_tee ? "ok" : "danger"}>{info.requires_tee ? "TEE required" : "Local mode"}</Pill>} />
        <p className="m-0 text-[13px] text-ink-muted">Only workers whose attestation matches an approved measurement set and an approved PPID can register as a TEE agent. Approving widens trust (1 yocto); removing takes effect immediately.</p>

        <section aria-label="Approved measurements" className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Approved measurements ({meas.data.length})</h3>
          {meas.data.length === 0 ? (
            <EmptyState title="No measurements approved">No TEE agent can register until you approve one.</EmptyState>
          ) : (
            <ul className="m-0 list-none p-0">
              {meas.data.map((x, i) => (
                <Row key={i} label={measurementLabel(x)} disabled={off} onRemove={() => window.confirm("Remove these measurements? Agents running this image are rejected immediately.") && void act("remove_measurements", { measurements: x })} detail={<details className="text-xs text-ink-muted"><summary className="cursor-pointer">Full JSON</summary><pre className="mono m-0 break-all whitespace-pre-wrap">{JSON.stringify(x, null, 2)}</pre></details>} />
              ))}
            </ul>
          )}
          <Field label="Approve measurements (JSON)" error={m?.error} hint="From worker/README.md: {rtmrs:{mrtd,rtmr0,rtmr1,rtmr2}, key_provider_event_digest, app_compose_hash_payload}">
            {(a) => <Textarea {...a} rows={4} className="mono text-xs" value={mText} onChange={(e) => setMText(e.target.value)} />}
          </Field>
          <div>
            <Button disabled={off || !m?.value} onClick={() => m?.value && void act("approve_measurements", { measurements: m.value }).then((ok) => ok && setMText(""))} title="1 yocto">
              Approve measurements
            </Button>
          </div>
        </section>

        <section aria-label="Approved PPIDs" className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Approved PPIDs ({ppids.data.length})</h3>
          {ppids.data.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-muted">None approved yet.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {ppids.data.map((id) => (
                <Row key={id} label={id} disabled={off} onRemove={() => window.confirm("Remove this PPID?") && void act("remove_ppids", { ppids: [id] })} />
              ))}
            </ul>
          )}
          <Field label="Approve PPIDs" error={p.error} hint="16 bytes as 32 hex characters; separate several with spaces, commas or new lines.">
            {(a) => <Textarea {...a} rows={2} className="mono text-xs" value={pText} onChange={(e) => setPText(e.target.value)} />}
          </Field>
          <div>
            <Button disabled={off || p.value.length === 0 || p.error !== null} onClick={() => void act("approve_ppids", { ppids: p.value }).then((ok) => ok && setPText(""))} title="1 yocto">
              Approve PPIDs
            </Button>
          </div>
        </section>

        <section aria-label="Attestation validity" className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Attestation validity</h3>
          <Field label="Re-attest every (hours)" hint={`Currently ${info ? Number(info.attestation_expiration_time_ms) / HOUR_MS : "?"} h. Agents must register again after this.`}>
            {(a) => (
              <div className="flex gap-2">
                <Input {...a} mono inputMode="decimal" className="max-w-32" value={hours} onChange={(e) => setHours(e.target.value)} />
                <Button disabled={off || !hoursOk} onClick={() => void act("update_attestation_expiration_time", { attestation_expiration_time_ms: String(Math.round(hoursNum * HOUR_MS)) }).then((ok) => ok && setHours(""))} title="1 yocto">
                  Update
                </Button>
              </div>
            )}
          </Field>
        </section>

        {local && (
          <section aria-label="Local whitelist" className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Local-mode whitelist ({wl.data.length})</h3>
            <p className="m-0 text-[13px] text-ink-muted">Accounts allowed to take a TEE agent slot without attestation.</p>
            {wl.data.length > 0 && (
              <ul className="m-0 list-none p-0">
                {wl.data.map((acc) => (
                  <Row key={acc} label={acc} disabled={off} onRemove={() => void act("remove_agent_from_whitelist_for_local", { account_id: acc })} />
                ))}
              </ul>
            )}
            <Field label="Whitelist an account" error={aText && !isAccountId(aText.trim()) ? "Not a valid account id" : undefined}>
              {(a) => (
                <div className="flex gap-2">
                  <Input {...a} mono value={aText} onChange={(e) => setAText(e.target.value.trim())} placeholder="agent.testnet" />
                  <Button disabled={off || !isAccountId(aText)} onClick={() => void act("whitelist_agent_for_local", { account_id: aText }).then((ok) => ok && setAText(""))} title="1 yocto">
                    Whitelist
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
