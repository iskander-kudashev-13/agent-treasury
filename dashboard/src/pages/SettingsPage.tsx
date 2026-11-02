import { useT } from "@/i18n";
import { useSearchParams } from "react-router-dom";
import { QueryErrors } from "@/features/layout/QueryErrors";
import { reopenOnboarding } from "@/features/onboarding/storage";
import { OwnerAdmin } from "@/features/policy/OwnerAdmin";
import { PolicyCard } from "@/features/policy/PolicyForm";
import { TrustAnchors } from "@/features/policy/TrustAnchors";
import { SurplusAction } from "@/features/treasury/SurplusCard";
import { explorerAddressUrl } from "@/lib/config";
import { useContractInfo, usePolicy } from "@/lib/useVault";
import { Button, Page, Tabs } from "@/kit";

type Tab = "limits" | "advanced";

/** `/settings` — "Limits" (daily limit, minimum, grace, pause) and "Advanced" (TEE trust, owner controls, contract info). */
export function SettingsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "advanced" ? "advanced" : "limits";
  const info = useContractInfo();
  const policy = usePolicy();
  return (
    <Page title={t("nav.settings")} actions={<Button variant="ghost" onClick={reopenOnboarding}>{t("onb.reopen")}</Button>}>
      <QueryErrors sources={[{ label: t("src.policy"), ...policy }, { label: t("src.contractInfo"), ...info }]} />
      <Tabs label={t("nav.settings")} value={tab} onChange={(v) => setParams(v === "limits" ? {} : { tab: v }, { replace: true })} items={[{ value: "limits", label: t("set.limits") }, { value: "advanced", label: t("set.advanced") }]} />
      {tab === "limits" ? (
        <PolicyCard policy={policy.data} />
      ) : (
        <>
          <TrustAnchors info={info.data} />
          <OwnerAdmin info={info.data} />
          <SurplusAction />
          {info.data && (
            <p className="m-0 text-xs break-all text-ink-subtle">
              {t("page.owner")} <a href={explorerAddressUrl(info.data.owner_id)} target="_blank" rel="noreferrer">{info.data.owner_id}</a> · {t("page.token")} {info.data.treasury_token} · v{info.data.version}
            </p>
          )}
        </>
      )}
    </Page>
  );
}
