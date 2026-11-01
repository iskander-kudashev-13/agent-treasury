import { QueryErrors } from "@/features/layout/QueryErrors";
import { OwnerAdmin } from "@/features/policy/OwnerAdmin";
import { PolicyCard } from "@/features/policy/PolicyForm";
import { TrustAnchors } from "@/features/policy/TrustAnchors";
import { explorerAddressUrl } from "@/lib/config";
import { useContractInfo, usePolicy } from "@/lib/useVault";
import { Page } from "@/kit";

/** `/policy` — vault policy, pause, owner admin, TEE trust anchors. */
export function PolicyPage() {
  const info = useContractInfo();
  const policy = usePolicy();
  return (
    <Page title="Policy">
      <QueryErrors sources={[{ label: "policy", ...policy }, { label: "contract info", ...info }]} />
      <PolicyCard policy={policy.data} />
      <TrustAnchors info={info.data} />
      <OwnerAdmin info={info.data} />
      {info.data && (
        <p className="m-0 text-xs break-all text-ink-subtle">
          Owner <a href={explorerAddressUrl(info.data.owner_id)} target="_blank" rel="noreferrer">{info.data.owner_id}</a> · token {info.data.treasury_token} · TEE required: {String(info.data.requires_tee)} · contract v{info.data.version}
        </p>
      )}
    </Page>
  );
}
