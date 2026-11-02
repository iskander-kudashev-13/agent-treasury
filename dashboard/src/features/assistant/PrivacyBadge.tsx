import { useT, rich } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { MessageKey } from "@/i18n";
import { Button, Icons, Modal } from "@/kit";
import { fetchAiInfo } from "@/lib/assistantClient";
import { WORKER_URL } from "@/lib/config";

const TIER_KEY: Record<string, MessageKey> = {
  confidential_tee: "as.tierConfidential",
  third_party_tee: "as.tierThird",
  incognito: "as.tierIncognito",
  unknown: "as.tierUnknown",
};

/**
 * Panel header badge (UI_UPDATES §6.6). Clicking opens the model and what the worker could say about attestation. The worker
 * FETCHES the NEAR AI attestation report but does not verify the TDX/NVIDIA evidence, and this UI says exactly that.
 */
export function AssistantPrivacyBadge() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["ai", "info", WORKER_URL], queryFn: ({ signal }) => fetchAiInfo(signal), staleTime: 5 * 60_000, retry: false });
  const info = q.data;
  const confirmed = info?.private === true;
  const label = q.isPending ? t("as.privChecking") : confirmed ? t("kit.privacyBadge") : q.isError ? t("as.privUnknown") : "NEAR AI Cloud";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("as.privBadgeTitle")}
        className={`inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border bg-transparent px-2.5 text-[11px] ${confirmed ? "shimmer-privacy border-ai-line text-ai-text" : "border-line-strong text-ink-muted"}`}
      >
        <Icons.Lock size={12} />
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("as.privTitle")} footer={<Button onClick={() => setOpen(false)}>{t("common.close")}</Button>}>
        <div className="flex flex-col gap-3 text-[13px]">
          {q.isPending && <p className="m-0">{t("as.askingWorker")}</p>}
          {q.isError && <p className="m-0 text-danger-text">{t("as.infoFailed")}</p>}
          {info && (
            <>
              <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                <dt className="text-ink-muted">{t("as.provider")}</dt>
                <dd className="m-0">{info.provider}</dd>
                <dt className="text-ink-muted">{t("as.model")}</dt>
                <dd className="mono m-0 break-all">{info.model}</dd>
                <dt className="text-ink-muted">{t("as.tier")}</dt>
                <dd className="m-0">{t(TIER_KEY[info.tier] ?? "as.tierUnknown")}</dd>
                <dt className="text-ink-muted">{t("as.attestation")}</dt>
                <dd className="m-0">
                  {info.attestation ? (
                    <>
                      <strong className="text-warn">{info.attestation.status === "fetched_unverified" ? t("as.fetchedUnverified") : info.attestation.status}</strong>
                      {info.attestation.fetched_at && <span className="text-ink-subtle"> · {info.attestation.fetched_at.slice(0, 16).replace("T", " ")} UTC</span>}
                    </>
                  ) : (
                    t("as.attNA")
                  )}
                </dd>
                {info.attestation?.model_signing_address && (
                  <>
                    <dt className="text-ink-muted">{t("as.signingKey")}</dt>
                    <dd className="mono m-0 break-all">{info.attestation.model_signing_address}</dd>
                  </>
                )}
                {info.attestation && (
                  <>
                    <dt className="text-ink-muted">{t("as.evidence")}</dt>
                    <dd className="m-0">
                      {t("as.evidenceLine", { tdx: info.attestation.has_intel_quote ? t("as.present") : t("as.absent"), nv: info.attestation.has_nvidia_payload ? t("as.present") : t("as.absent"), nonce: info.attestation.nonce_echoed ? t("as.echoed") : t("as.notEchoed") })}
                    </dd>
                  </>
                )}
              </dl>
              {info.attestation?.note && <p className="m-0 text-ink-muted">{info.attestation.note}</p>}
              <p className="m-0 text-ink-muted">
                {rich("as.cannotVerify", { link: <a href={info.attestation?.verify_url ?? "https://cloud.near.ai/verify"} target="_blank" rel="noreferrer">{t("as.verifyCenter")}</a> })}
              </p>
            </>
          )}
          <p className="m-0 text-ink-muted">{t("as.noKeys")}</p>
        </div>
      </Modal>
    </>
  );
}
