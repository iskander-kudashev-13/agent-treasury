import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Icons, Modal } from "@/kit";
import { fetchAiInfo } from "@/lib/assistantClient";
import { WORKER_URL } from "@/lib/config";

const TIER_TEXT: Record<string, string> = {
  confidential_tee: "Confidential TEE: NEAR AI runs this model itself inside a trusted execution environment.",
  third_party_tee: "Third-party TEE: the model runs in an enclave operated by another provider.",
  incognito: "Not a confidential model: NEAR AI proxies it. Privacy depends on the model provider.",
  unknown: "The privacy tier of this model could not be determined.",
};

/**
 * Panel header badge (UI_UPDATES §6.6). Clicking opens the model and what the worker could say about attestation. The worker
 * FETCHES the NEAR AI attestation report but does not verify the TDX/NVIDIA evidence, and this UI says exactly that.
 */
export function AssistantPrivacyBadge() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["ai", "info", WORKER_URL], queryFn: ({ signal }) => fetchAiInfo(signal), staleTime: 5 * 60_000, retry: false });
  const info = q.data;
  const confirmed = info?.private === true;
  const label = q.isPending ? "Checking privacy…" : confirmed ? "Private · NEAR AI Cloud (TEE)" : q.isError ? "Privacy unknown" : "NEAR AI Cloud";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Your prompts and vault data are processed by a model on NEAR AI Cloud. Click for the model and attestation status."
        className={`inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border bg-transparent px-2.5 text-[11px] ${confirmed ? "shimmer-privacy border-ai-line text-ai-text" : "border-line-strong text-ink-muted"}`}
      >
        <Icons.Lock size={12} />
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Assistant privacy" footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
        <div className="flex flex-col gap-3 text-[13px]">
          {q.isPending && <p className="m-0">Asking the worker…</p>}
          {q.isError && <p className="m-0 text-danger-text">The worker did not answer GET /ai/info, so privacy and attestation could not be checked.</p>}
          {info && (
            <>
              <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                <dt className="text-ink-muted">Provider</dt>
                <dd className="m-0">{info.provider}</dd>
                <dt className="text-ink-muted">Model</dt>
                <dd className="mono m-0 break-all">{info.model}</dd>
                <dt className="text-ink-muted">Privacy tier</dt>
                <dd className="m-0">{TIER_TEXT[info.tier] ?? TIER_TEXT.unknown}</dd>
                <dt className="text-ink-muted">Attestation</dt>
                <dd className="m-0">
                  {info.attestation ? (
                    <>
                      <strong className="text-warn">{info.attestation.status === "fetched_unverified" ? "Fetched, unverified" : info.attestation.status}</strong>
                      {info.attestation.fetched_at && <span className="text-ink-subtle"> · {info.attestation.fetched_at.slice(0, 16).replace("T", " ")} UTC</span>}
                    </>
                  ) : (
                    "Not available (the worker has no NEAR AI key or the report could not be fetched)"
                  )}
                </dd>
                {info.attestation?.model_signing_address && (
                  <>
                    <dt className="text-ink-muted">Signing key</dt>
                    <dd className="mono m-0 break-all">{info.attestation.model_signing_address}</dd>
                  </>
                )}
                {info.attestation && (
                  <>
                    <dt className="text-ink-muted">Evidence</dt>
                    <dd className="m-0">
                      Intel TDX quote {info.attestation.has_intel_quote ? "present" : "absent"} · NVIDIA payload {info.attestation.has_nvidia_payload ? "present" : "absent"} · nonce {info.attestation.nonce_echoed ? "echoed" : "not echoed"}
                    </dd>
                  </>
                )}
              </dl>
              {info.attestation?.note && <p className="m-0 text-ink-muted">{info.attestation.note}</p>}
              <p className="m-0 text-ink-muted">
                The dashboard cannot verify the hardware evidence itself. Verify it independently:{" "}
                <a href={info.attestation?.verify_url ?? "https://cloud.near.ai/verify"} target="_blank" rel="noreferrer">
                  NEAR AI Verification Center
                </a>
                .
              </p>
            </>
          )}
          <p className="m-0 text-ink-muted">The assistant has no keys. It reads the vault and only prepares changes; nothing happens until you sign in your wallet.</p>
        </div>
      </Modal>
    </>
  );
}
