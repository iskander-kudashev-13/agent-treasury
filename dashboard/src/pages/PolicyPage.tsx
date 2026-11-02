import { useT } from "@/i18n";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { OwnerAdmin } from "@/features/policy/OwnerAdmin";
import { PolicyCard } from "@/features/policy/PolicyForm";
import { TrustAnchors } from "@/features/policy/TrustAnchors";
import { explorerAddressUrl } from "@/lib/config";
import { useContractInfo, usePolicy } from "@/lib/useVault";
import { Page } from "@/kit";

/** `/policy` — vault policy, pause, owner admin, TEE trust anchors. */
export function PolicyPage() {
  const t = useT();
  const info = useContractInfo();
  const policy = usePolicy();
  return (
    <Page title={t("nav.policy")}>
      <QueryErrors sources={[{ label: t("src.policy"), ...policy }, { label: t("src.contractInfo"), ...info }]} />
      <PolicyCard policy={policy.data} />
      <TrustAnchors info={info.data} />
      <OwnerAdmin info={info.data} />
      {info.data && (
        <p className="m-0 text-xs break-all text-ink-subtle">
          {t("page.owner")} <a href={explorerAddressUrl(info.data.owner_id)} target="_blank" rel="noreferrer">{info.data.owner_id}</a> · {t("page.token")} {info.data.treasury_token} · {t("page.teeRequired")}: {info.data.requires_tee ? t("page.yes") : t("page.no")} · {t("page.contractVersion", { version: info.data.version })}
        </p>
      )}
    </Page>
  );
}
