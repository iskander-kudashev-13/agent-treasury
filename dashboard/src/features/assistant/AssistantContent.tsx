import { Link } from "react-router-dom";
import { useT } from "@/i18n";
import { useMemo, useState, type FormEvent, type RefObject } from "react";
import { AssistantFooter, BatchBar, Button, EmptyState, Icons, SuggestionChip } from "@/kit";
import { WORKER_URL } from "@/lib/config";
import { flattenBatch, orderBatch, proposalToCall, type RowLookups } from "@/lib/proposals";
import { inputToForm } from "@/lib/scheduleForm";
import { useNow } from "@/lib/useNow";
import type { ScheduleInput } from "@/lib/types";
import { useAgents, useContractInfo, useRecipients, useSchedules } from "@/lib/useVault";
import { useOwner } from "@/features/owner/OwnerProvider";
import { RecipientDrawer } from "@/features/payments/RecipientDrawer";
import { ScheduleDrawer, type PendingRecipient } from "@/features/payments/ScheduleDrawer";
import { useOwnerTx } from "@/features/payments/useOwnerTx";
import { useWallet } from "@/features/wallet/WalletProvider";
import { isProposalItem, signedIds, toBatchItems, type ProposalItem } from "./model";
import { MessageList } from "./MessageList";
import { ReviewSignModal } from "./ReviewSignModal";
import type { Assistant } from "./useAssistant";

const SUGGESTION_KEYS = ["as.sug1", "as.sug2", "as.sug3", "as.sug4"] as const;

type Editing = { item: ProposalItem } | null;

/** Everything below the panel header: sign-in step, suggestions, conversation, batch bar, input. */
export function AssistantContent({ assistant, inputRef }: { assistant: Assistant; inputRef: RefObject<HTMLInputElement | null> }) {
  const t = useT();
  const { accountId, signIn: connectWallet } = useWallet();
  const { canAct, ownerId } = useOwner();
  const { send: signCalls, busy: signing } = useOwnerTx();
  const { data: recipients } = useRecipients();
  const { data: agents } = useAgents();
  const { data: schedules } = useSchedules();
  const { data: info } = useContractInfo();
  const now = useNow(60_000);
  const [review, setReview] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const { items } = assistant;

  const pending: PendingRecipient[] = useMemo(
    () =>
      items.filter(isProposalItem).flatMap((i): PendingRecipient[] => {
        if (i.proposal.type !== "AddRecipient" || i.status === "discarded" || i.status === "signed" || i.recipientId === null) return [];
        const r = i.calls.find((c) => c.method === "add_recipient")?.args.recipient as { label?: string; destination_chain?: string; destination_address?: string } | undefined;
        return r ? [{ id: i.recipientId, label: String(r.label ?? ""), chain: String(r.destination_chain ?? ""), address: String(r.destination_address ?? "") }] : [];
      }),
    [items],
  );

  const look: RowLookups = {
    recipient: (id) => recipients.find((r) => r.id === id)?.label ?? pending.find((p) => p.id === id)?.label ?? t("as.recipientN", { id }),
    agent: (id) => agents.find((a) => a.id === id)?.name ?? id,
  };

  const queued = toBatchItems(items);
  const batch = orderBatch(queued, signedIds(items), info?.next_recipient_id ?? null);

  const doSign = async () => {
    const calls = flattenBatch(batch.ordered);
    const r = await signCalls(calls, t("owner.changes", { count: calls.length }));
    if (r.ok) {
      assistant.markSigned(batch.ordered.map((b) => b.id), r.hash);
      assistant.notice(t("as.signedActions", { count: calls.length }));
      setReview(false);
    }
  };

  const pauseNow = async (item: ProposalItem) => {
    const r = await signCalls([proposalToCall(item.proposal)], item.proposal.title || t("as.pauseLabel"));
    if (r.ok) {
      assistant.markSigned([item.id], r.hash);
      assistant.notice(t("as.donePaused", { title: item.proposal.title || t("as.donePausedFallback") }));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const el = inputRef.current;
    if (!el) return;
    const text = el.value;
    el.value = "";
    void assistant.send(text);
  };

  const editCard = (item: ProposalItem) => setEditing({ item });

  const ready = WORKER_URL !== "" && accountId !== null && canAct && assistant.signedIn;
  const names = { agent: look.agent, recipient: look.recipient };

  let top: React.ReactNode;
  if (WORKER_URL === "") {
    top = <EmptyState title={t("as.workerNotConfigured")}>{t("as.setWorkerUrl")}</EmptyState>;
  } else if (accountId === null) {
    top = (
      <EmptyState title={t("as.connectOwner")} action={<Button variant="primary" onClick={connectWallet}>{t("common.connectWallet")}</Button>}>
        {t("as.connectOwnerBody")}
      </EmptyState>
    );
  } else if (!canAct) {
    top = (
      <EmptyState title={t("as.ownerOnly")}>
        {ownerId ? t("as.ownerOnlyBody", { owner: ownerId, account: accountId }) : t("as.loadingOwner")}
      </EmptyState>
    );
  } else if (!assistant.signedIn) {
    top = (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <Icons.Lock size={22} />
        <div className="text-[15px] font-semibold">{t("as.signInTitle")}</div>
        <p className="m-0 max-w-sm text-[13px] text-ink-muted">
          {t("as.signInBody")}
        </p>
        {assistant.authError && (
          <p role="alert" className="m-0 max-w-sm text-[13px] text-danger-text">
            {assistant.authError}
          </p>
        )}
        <Button variant="primary" loading={assistant.phase === "signing-in"} onClick={() => void assistant.signIn()}>
          {assistant.phase === "signing-in" ? t("common.confirmInWallet") : t("as.signInBtn")}
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    top = (
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="m-0 text-[13px] text-ink-muted">{t("as.intro")}</p>
        <p className="m-0 text-xs text-ink-subtle">
          <Link to="/trading">{t("as.tradingHelp")}</Link>
        </p>
        <div className="flex flex-wrap gap-2">
          {SUGGESTION_KEYS.map((k) => (
            <SuggestionChip key={k} onClick={() => void assistant.send(t(k))}>
              {t(k)}
            </SuggestionChip>
          ))}
        </div>
      </div>
    );
  } else {
    top = (
      <MessageList
        items={items}
        thinking={assistant.phase === "streaming"}
        now={now}
        look={look}
        canSign={canAct}
        busy={signing}
        handlers={{ onQueue: assistant.queue, onUnqueue: assistant.unqueue, onDiscard: assistant.discard, onEdit: editCard, onPauseNow: (i) => void pauseNow(i), onRulesConfirmed: assistant.markRulesConfirmed, onRulesDiscard: assistant.discardRules }}
        onAnswer={(text) => void assistant.send(text)}
      />
    );
  }

  // Edit in form: the drawers hand the calls back; the card is replaced, nothing is signed there.
  const e = editing?.item;
  const args = e?.calls.find((c) => c.method !== "update_mandate" && c.method !== "add_recipient")?.args ?? e?.calls[0]?.args;
  const rcpt = e?.calls.find((c) => c.method === "add_recipient")?.args.recipient as { label: string; destination_chain: string; destination_address: string } | undefined;
  const sched = args?.schedule as ScheduleInput | undefined;
  const existingSchedule = e?.proposal.type === "UpdateSchedule" ? schedules.find((s) => s.id === Number(e.calls[e.calls.length - 1]?.args.schedule_id)) : undefined;
  const isRecipientEdit = e?.proposal.type === "AddRecipient";
  const others = (id: string): PendingRecipient[] => pending.filter((p) => items.find((i) => isProposalItem(i) && i.recipientId === p.id && i.id !== id));

  return (
    <>
      <div className="flex-1 overflow-y-auto">{top}</div>
      <div className="flex flex-col gap-2 border-t border-line p-4">
        <BatchBar count={queued.length} onReview={() => setReview(true)} />
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            ref={inputRef}
            placeholder={t("as.placeholder")}
            aria-label={t("as.inputAria")}
            disabled={!ready || assistant.phase !== "idle"}
            maxLength={2000}
            autoComplete="off"
            className="h-10 w-full min-w-0 rounded-input border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-ok disabled:opacity-40"
          />
          {assistant.phase === "streaming" ? (
            <Button type="button" size="md" onClick={assistant.stop} aria-label={t("as.stop")}>
              {t("as.stop")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="md" disabled={!ready || assistant.phase !== "idle"} aria-label={t("as.send")}>
              <Icons.Send size={16} />
            </Button>
          )}
        </form>
        <AssistantFooter />
      </div>

      <ReviewSignModal open={review && queued.length > 0} onClose={() => setReview(false)} batch={batch} names={names} busy={signing} canSign={canAct} onSign={() => void doSign()} />

      {e && isRecipientEdit && (
        <RecipientDrawer
          open
          onClose={() => setEditing(null)}
          prefill={rcpt ? { label: rcpt.label, chain: rcpt.destination_chain, address: rcpt.destination_address } : undefined}
          onPlan={(calls) => assistant.replaceCalls(e.id, calls, null)}
        />
      )}
      {e && (e.proposal.type === "AddSchedule" || e.proposal.type === "UpdateSchedule") && sched && (
        <ScheduleDrawer
          open
          onClose={() => setEditing(null)}
          schedule={existingSchedule}
          prefill={inputToForm(sched, now)}
          pendingRecipients={others(e.id)}
          onPlan={(calls, i) => assistant.replaceCalls(e.id, calls, i.newRecipientId)}
        />
      )}
    </>
  );
}
