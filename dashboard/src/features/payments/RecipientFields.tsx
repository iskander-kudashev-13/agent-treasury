import { useT, rich } from "@/i18n";
import { Field, Hash, Input, Select } from "@/kit";
import { useUsdcAsset } from "@/lib/oneclickTokens";
import { buildRecipientInput, RECIPIENT_CHAINS, validateRecipientDraft, type RecipientDraft } from "@/lib/recipientForm";
import type { RecipientInput, RecipientView } from "@/lib/types";

/** Validation + 1Click asset resolution for a recipient draft. `input` is non-null only when everything is valid and resolved. */
export function useRecipientDraft(draft: RecipientDraft, existing: RecipientView[], editingId: number | null = null) {
  const check = validateRecipientDraft(draft, existing.map((r) => ({ id: r.id, label: r.label, destination_chain: r.destination_chain, destination_address: r.destination_address })), editingId);
  const chainOk = RECIPIENT_CHAINS.some((c) => c.id === draft.chain && c.kind !== "tron");
  const asset = useUsdcAsset(chainOk ? draft.chain : "");
  const input: RecipientInput | null = check.address && asset.asset ? buildRecipientInput(draft, check.address, asset.asset) : null;
  return { check, asset, input };
}

/** Name, chain, address. The asset id is shown, resolved from 1Click, and cannot be edited. */
export function RecipientFields({
  draft,
  onChange,
  draftState,
  disabled,
}: {
  draft: RecipientDraft;
  onChange: (patch: Partial<RecipientDraft>) => void;
  draftState: ReturnType<typeof useRecipientDraft>;
  disabled?: boolean;
}) {
  const t = useT();
  const { check, asset } = draftState;
  // Do not shout at fields the user has not touched yet.
  const e = (k: keyof RecipientDraft): string | undefined => (draft[k].trim() === "" && k !== "chain" ? undefined : check.errors[k]);
  return (
    <div className="flex flex-col gap-3">
      <Field label={t("pay.fldName")} error={e("label")}>
        {(a) => <Input {...a} value={draft.label} maxLength={64} disabled={disabled} state={e("label") ? "error" : "default"} onChange={(ev) => onChange({ label: ev.target.value })} />}
      </Field>
      <Field label={t("pay.fldChain")} error={draft.chain ? check.errors.chain : undefined}>
        {(a) => (
          <Select {...a} value={draft.chain} disabled={disabled} state={draft.chain && check.errors.chain ? "error" : "default"} onChange={(ev) => onChange({ chain: ev.target.value })}>
            <option value="">{t("pay.selectChain")}</option>
            {RECIPIENT_CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t("pay.fldAddress")} error={e("address")} hint={draft.chain === "sol" ? t("pay.solHint") : draft.chain ? t("pay.evmHint") : undefined}>
        {(a) => <Input {...a} mono value={draft.address} disabled={disabled} spellCheck={false} autoComplete="off" state={e("address") ? "error" : "default"} onChange={(ev) => onChange({ address: ev.target.value })} />}
      </Field>
      {draft.chain && !check.errors.chain && (
        <p className="m-0 text-xs text-ink-subtle" aria-live="polite">
          {asset.loading ? (
            t("pay.lookingUsdc")
          ) : asset.asset ? (
            <>
              {rich("pay.paysUsdc", { asset: <Hash value={asset.asset} copy={false} className="align-middle" /> })}
            </>
          ) : (
            <span className="text-danger-text">{asset.error ?? t("pay.assetUnresolved")}</span>
          )}
        </p>
      )}
    </div>
  );
}
