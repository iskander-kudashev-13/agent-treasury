import { useT, rich, t } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, Callout, cx, Hash, Icons, ProposalActions, ProposalCard, SigningHint } from "@/kit";
import { explorerTxUrl } from "@/lib/config";
import { proposalRows, type RowLookups } from "@/lib/proposals";
import { confirmTradingRules } from "@/lib/tradingClient";
import { hashRuleSet } from "@/lib/tradingRules";
import { RulesView } from "@/features/trading/RulesView";
import { AccountTrustCallout } from "@/features/trading/AccountTrust";
import { tradingKeys, useAccountTrust, useTradingStatus } from "@/features/trading/useTrading";
import { useWallet } from "@/features/wallet/WalletProvider";
import { effectiveProposal, type ProposalItem, type TradingRulesItem } from "./model";

const EDITABLE = new Set(["AddRecipient", "AddSchedule", "UpdateSchedule"]);

/** One typed proposal as a card (UI_UPDATES §6.3). Text comes from the model/chain: plain text only. */
export function ProposalCardView({
  item,
  now,
  look,
  canSign,
  busy,
  onQueue,
  onUnqueue,
  onDiscard,
  onEdit,
  onPauseNow,
}: {
  item: ProposalItem;
  now: number;
  look: RowLookups;
  canSign: boolean;
  busy: boolean;
  onQueue: () => void;
  onUnqueue: () => void;
  onDiscard: () => void;
  onEdit: () => void;
  onPauseNow: () => void;
}) {
  if (item.status === "discarded") return <p className="m-0 px-1 text-xs text-ink-subtle">{t("as.discarded", { title: item.proposal.title })}</p>;
  const p = effectiveProposal(item, now);
  const { errors, warnings } = p.validation;
  const blocked = !p.validation.ok;
  const urgent = item.proposal.urgent && item.status === "draft";
  const note = (
    <>
      {errors.map((e, i) => (
        <span key={`e${i}`} className="block text-danger-text">
          {e}
        </span>
      ))}
      {warnings.map((w, i) => (
        <span key={`w${i}`} className="block">
          {w}
        </span>
      ))}
    </>
  );
  const hasNote = errors.length + warnings.length > 0;
  return (
    <ProposalCard
      title={p.title}
      status={item.status === "queued" ? "queued" : item.status === "signed" ? "signed" : "draft"}
      rows={proposalRows(p, look)}
      danger={urgent || blocked}
      {...(hasNote ? { warning: note } : {})}
      {...(item.edited ? { ok: t("as.editedByYou") } : {})}
      actions={
        item.status === "draft" ? (
          urgent ? (
            <>
              <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>
                {t("kit.discard")}
              </Button>
              <Button size="sm" variant="secondary" onClick={onQueue} disabled={blocked || busy}>
                {t("kit.addToBatch")}
              </Button>
              <Button size="sm" variant="danger-fill" icon={<Icons.Pause size={14} />} disabled={blocked || !canSign || busy} loading={busy} onClick={onPauseNow}>
                {t("as.pauseNow")}
              </Button>
            </>
          ) : blocked ? (
            <>
              {EDITABLE.has(item.proposal.type) && (
                <Button size="sm" variant="ghost" onClick={onEdit}>
                  {t("kit.editInForm")}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={onDiscard}>
                {t("kit.discard")}
              </Button>
            </>
          ) : (
            <ProposalActions {...(EDITABLE.has(item.proposal.type) ? { onEdit } : {})} onDiscard={onDiscard} onQueue={onQueue} />
          )
        ) : item.status === "queued" ? (
          <Button size="sm" variant="ghost" onClick={onUnqueue}>
            {t("as.removeFromBatch")}
          </Button>
        ) : item.hash ? (
          <a href={explorerTxUrl(item.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs">
            {t("as.viewTx")} <Icons.ExternalLink size={12} />
          </a>
        ) : undefined
      }
    />
  );
}

/**
 * Trading rules proposed by the assistant (ADR-0005). The card shows the rules rendered by the dashboard from the JSON, not the
 * model's words, and recomputes the hash itself. "Confirm rules" asks the wallet for a NEP-413 signature over the exact message
 * the dashboard built (see `confirmTradingRules`), so it is refused if the worker's hash or message differ.
 */
export function TradingRulesCardView({ item, canSign, onConfirmed, onDiscard }: { item: TradingRulesItem; canSign: boolean; onConfirmed: (at: number) => void; onDiscard: () => void }) {
  const { accountId, signMessage } = useWallet();
  const tr = useT();
  const qc = useQueryClient();
  const { status } = useTradingStatus();
  const liveStatus = status?.enabled ? status : null;
  const { trust, trusted } = useAccountTrust(liveStatus);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = item.proposal;

  useEffect(() => {
    let live = true;
    void hashRuleSet(p.rules).then((h) => live && setLocalHash(h));
    return () => {
      live = false;
    };
  }, [p.rules]);

  if (item.status === "discarded") return <p className="m-0 px-1 text-xs text-ink-subtle">{tr("as.rulesDiscarded", { name: p.rules.name })}</p>;

  const mismatch = localHash !== null && localHash !== p.hash;
  const live = status?.enabled ? status : null;
  const signed = item.status === "signed";
  const blocked = !p.validation.ok || mismatch || localHash === null || live === null || trust?.kind !== "ok" || !canSign || accountId === null;

  const confirm = async () => {
    if (accountId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await confirmTradingRules(p.rules, { accountId, signMessage, trustedHlAccount: trusted });
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      onConfirmed(r.active?.confirmed_at_ms ?? Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={cx("card-in flex flex-col gap-3 rounded-card border bg-surface p-4", mismatch || !p.validation.ok ? "border-danger/60" : "border-line", signed && "just-signed")}>
      <header className="flex items-center gap-2">
        <h3 className="m-0 flex-1 text-sm font-semibold">{tr("as.rulesTitle")}</h3>
        <span className={cx("inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px]", signed ? "border-ok/50 bg-ok-tint text-ok" : "border-line-strong text-ink-muted")}>
          {signed && <Icons.Check size={11} strokeWidth={3} />}
          {signed ? tr("as.rulesActive") : tr("kit.propDraft")}
        </span>
      </header>
      <RulesView rules={p.rules} hash={localHash ?? undefined} />
      <p className="m-0 text-xs text-ink-subtle">{tr("as.rulesShown")}</p>
      {mismatch && <Callout accent="danger">{tr("as.rulesMismatch")}</Callout>}
      {p.validation.errors.map((e, i) => (
        <Callout key={`e${i}`} accent="danger">
          {e}
        </Callout>
      ))}
      {p.validation.warnings.map((w, i) => (
        <Callout key={`w${i}`} accent="warn">
          {w}
        </Callout>
      ))}
      {!signed && live && (
        <p className="m-0 text-xs text-ink-muted">
          {rich("as.rulesAuthorize", { network: <strong>{live.hl_network}</strong>, account: <Hash value={live.hl_account} short={false} copy={false} className="align-bottom" /> })}
          {live.api_wallet.address && rich("as.rulesThrough", { wallet: <Hash value={live.api_wallet.address} short={false} copy={false} className="align-bottom" /> })}
          {tr("as.rulesRunsUntil")}
        </p>
      )}
      {!signed && live && <AccountTrustCallout trust={trust} />}
      {!signed && status !== null && !status.enabled && <Callout accent="warn">{tr("as.rulesOff")}</Callout>}
      {!signed && !canSign && <Callout accent="neutral">{tr("as.rulesOwnerOnly")}</Callout>}
      {error && <Callout accent="danger">{error}</Callout>}
      {signed ? (
        <p className="m-0 flex items-center gap-1.5 text-xs text-ok">
          <Icons.Check size={13} /> {tr("as.rulesConfirmed")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {busy && <SigningHint />}
          <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>
            {tr("kit.discard")}
          </Button>
          <Button size="sm" variant="approve" icon={<Icons.ShieldCheck size={14} />} loading={busy} disabled={blocked || busy} onClick={() => void confirm()}>
            {tr("as.confirmRules")}
          </Button>
        </div>
      )}
    </article>
  );
}
