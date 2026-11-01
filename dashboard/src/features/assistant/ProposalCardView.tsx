import { Button, Icons, ProposalActions, ProposalCard } from "@/kit";
import { explorerTxUrl } from "@/lib/config";
import { proposalRows, type RowLookups } from "@/lib/proposals";
import { effectiveProposal, type ProposalItem } from "./model";

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
  if (item.status === "discarded") return <p className="m-0 px-1 text-xs text-ink-subtle">Discarded: {item.proposal.title}</p>;
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
      {...(item.edited ? { ok: "Edited by you in the form" } : {})}
      actions={
        item.status === "draft" ? (
          urgent ? (
            <>
              <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>
                Discard
              </Button>
              <Button size="sm" variant="secondary" onClick={onQueue} disabled={blocked || busy}>
                Add to batch
              </Button>
              <Button size="sm" variant="danger-fill" icon={<Icons.Pause size={14} />} disabled={blocked || !canSign || busy} loading={busy} onClick={onPauseNow}>
                Pause now
              </Button>
            </>
          ) : blocked ? (
            <>
              {EDITABLE.has(item.proposal.type) && (
                <Button size="sm" variant="ghost" onClick={onEdit}>
                  Edit in form
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={onDiscard}>
                Discard
              </Button>
            </>
          ) : (
            <ProposalActions {...(EDITABLE.has(item.proposal.type) ? { onEdit } : {})} onDiscard={onDiscard} onQueue={onQueue} />
          )
        ) : item.status === "queued" ? (
          <Button size="sm" variant="ghost" onClick={onUnqueue}>
            Remove from batch
          </Button>
        ) : item.hash ? (
          <a href={explorerTxUrl(item.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs">
            View transaction <Icons.ExternalLink size={12} />
          </a>
        ) : undefined
      }
    />
  );
}
