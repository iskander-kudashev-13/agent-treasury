import { useCallback, useRef, useState } from "react";
import { AssistantHttpError, clearSession, loadSession, signInWithWallet, streamChat, type AiSession, type ChatEvent } from "@/lib/assistantClient";
import { VAULT_ID } from "@/lib/config";
import type { PlannedCall } from "@/lib/calls";
import { proposalToCall } from "@/lib/proposals";
import { useNow } from "@/lib/useNow";
import { useWallet } from "@/features/wallet/WalletProvider";
import { buildHistory, cardId, isProposalItem, isTradingRulesItem, type ChatItem } from "./model";

export type Phase = "idle" | "signing-in" | "streaming";

const newConversationId = (): string => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 48);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Chat state of the assistant panel: sign-in (NEP-413), the SSE stream, and the proposal cards. Lives in the always-mounted
 * panel so closing the panel neither loses the conversation nor the queued changes. Never signs a vault transaction.
 */
export function useAssistant() {
  const { accountId, signMessage } = useWallet();
  const now = useNow(60_000);
  const [items, setItems] = useState<ChatItem[]>([]);
  const itemsRef = useRef<ChatItem[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<AiSession | null>(() => loadSession(null));
  const [authError, setAuthError] = useState<string | null>(null);
  const seq = useRef(0);
  const turn = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const conversation = useRef(newConversationId());

  const active = session && accountId !== null && session.accountId === accountId && session.expiresAt - now > 30_000 ? session : null;

  const update = useCallback((fn: (cur: ChatItem[]) => ChatItem[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const nid = useCallback(() => `m${++seq.current}`, []);

  const signIn = useCallback(async (): Promise<AiSession | null> => {
    if (accountId === null) return null;
    setPhase("signing-in");
    setAuthError(null);
    try {
      const s = await signInWithWallet(signMessage, accountId);
      setSession(s);
      return s;
    } catch (e) {
      setAuthError(errText(e));
      return null;
    } finally {
      setPhase("idle");
    }
  }, [accountId, signMessage]);

  const apply = useCallback(
    (ev: ChatEvent, myTurn: number) => {
      const closeStreaming = (cur: ChatItem[]): ChatItem[] => cur.map((i) => (i.kind === "text" && i.streaming ? { ...i, streaming: false } : i));
      switch (ev.type) {
        case "text":
          update((cur) => {
            const last = cur[cur.length - 1];
            if (last?.kind === "text" && last.streaming) return [...cur.slice(0, -1), { ...last, text: last.text + ev.delta }];
            return [...cur, { kind: "text", id: nid(), text: ev.delta, streaming: true }];
          });
          return;
        case "proposal": {
          const id = cardId(myTurn, ev.proposal.id);
          update((cur) =>
            cur.some((i) => i.id === id)
              ? cur
              : [
                  ...closeStreaming(cur),
                  {
                    kind: "proposal",
                    id,
                    turn: myTurn,
                    proposal: ev.proposal,
                    calls: [proposalToCall(ev.proposal)],
                    status: "draft",
                    edited: false,
                    recipientId: ev.proposal.type === "AddRecipient" ? ev.proposal.predicted_recipient_id : null,
                    hash: null,
                  },
                ],
          );
          return;
        }
        case "trading_rules": {
          const id = cardId(myTurn, ev.proposal.id);
          update((cur) => (cur.some((i) => i.id === id) ? cur : [...closeStreaming(cur), { kind: "trading_rules", id, proposal: ev.proposal, status: "draft", confirmedAt: null }]));
          return;
        }
        case "malformed_proposal":
          update((cur) => [...closeStreaming(cur), { kind: "notice", id: nid(), text: "The assistant sent a change in a format I could not verify, so it was ignored.", tone: "error" }]);
          return;
        case "question":
          update((cur) => [...closeStreaming(cur), { kind: "question", id: nid(), text: ev.text, options: ev.options, answered: false }]);
          return;
        case "data":
          update((cur) => [...closeStreaming(cur), { kind: "data", id: nid(), dataKind: ev.kind, payload: ev.payload }]);
          return;
        case "error":
          update((cur) => [...closeStreaming(cur), { kind: "notice", id: nid(), text: ev.message, tone: "error" }]);
          return;
        case "done":
          update(closeStreaming);
          return;
      }
    },
    [update, nid],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      const t = text.trim();
      if (!t || phase !== "idle" || accountId === null) return;
      update((cur) => [...cur.map((i) => (i.kind === "question" && !i.answered ? { ...i, answered: true } : i)), { kind: "user", id: nid(), text: t }]);
      const myTurn = ++turn.current;
      let token = active?.token ?? (await signIn())?.token;
      if (!token) return;
      const ac = new AbortController();
      abortRef.current = ac;
      setPhase("streaming");
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const body = { conversation_id: conversation.current, messages: buildHistory(itemsRef.current), vault: VAULT_ID, owner_account: accountId };
            for await (const ev of streamChat(token, body, ac.signal)) apply(ev, myTurn);
            break;
          } catch (e) {
            if (e instanceof AssistantHttpError && e.status === 401 && attempt === 0) {
              // Session expired (1 h) or the worker restarted: ask the wallet for a fresh signature once.
              clearSession();
              setSession(null);
              const s = await signIn();
              if (!s) return;
              token = s.token;
              setPhase("streaming");
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) update((cur) => [...cur, { kind: "notice", id: nid(), text: errText(e), tone: "error" }]);
      } finally {
        update((cur) => cur.map((i) => (i.kind === "text" && i.streaming ? { ...i, streaming: false } : i)));
        abortRef.current = null;
        setPhase((p) => (p === "streaming" ? "idle" : p));
      }
    },
    [phase, accountId, active, signIn, update, apply, nid],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    conversation.current = newConversationId();
    update(() => []);
    setPhase("idle");
  }, [update]);

  const patchCard = useCallback((id: string, fn: (i: Extract<ChatItem, { kind: "proposal" }>) => Extract<ChatItem, { kind: "proposal" }>) => update((cur) => cur.map((i) => (isProposalItem(i) && i.id === id ? fn(i) : i))), [update]);

  return {
    items,
    phase,
    signedIn: active !== null,
    authError,
    accountId,
    signIn,
    send,
    stop,
    reset,
    /** Draft -> queued. Only cards whose validation passed can be queued. */
    queue: (id: string) => patchCard(id, (i) => (i.status === "draft" && (i.proposal.validation.ok || i.edited) ? { ...i, status: "queued" } : i)),
    unqueue: (id: string) => patchCard(id, (i) => (i.status === "queued" ? { ...i, status: "draft" } : i)),
    discard: (id: string) => patchCard(id, (i) => (i.status === "signed" ? i : { ...i, status: "discarded" })),
    /** The owner edited the card in the form: the new calls replace the proposal's call (back to draft, valid by form rules). */
    replaceCalls: (id: string, calls: PlannedCall[], recipientId: number | null) => patchCard(id, (i) => ({ ...i, calls, edited: true, status: "draft", recipientId: recipientId ?? i.recipientId })),
    /** Trading rules card: the worker accepted the NEP-413 confirmation. */
    markRulesConfirmed: (id: string, at: number) => update((cur) => cur.map((i) => (isTradingRulesItem(i) && i.id === id ? { ...i, status: "signed", confirmedAt: at } : i))),
    discardRules: (id: string) => update((cur) => cur.map((i) => (isTradingRulesItem(i) && i.id === id && i.status === "draft" ? { ...i, status: "discarded" } : i))),
    markSigned: (ids: string[], hash: string | null) => update((cur) => cur.map((i) => (isProposalItem(i) && ids.includes(i.id) ? { ...i, status: "signed", hash } : i))),
    notice: (text: string, tone: "error" | "info" = "info") => update((cur) => [...cur, { kind: "notice", id: nid(), text, tone }]),
  };
}

export type Assistant = ReturnType<typeof useAssistant>;
