import { useEffect, useRef } from "react";
import { Callout, Chip, Message, TypingDots } from "@/kit";
import type { RowLookups } from "@/lib/proposals";
import { DataView } from "./DataViews";
import type { ChatItem, ProposalItem } from "./model";
import { ProposalCardView } from "./ProposalCardView";

export interface CardHandlers {
  onQueue: (id: string) => void;
  onUnqueue: (id: string) => void;
  onDiscard: (id: string) => void;
  onEdit: (item: ProposalItem) => void;
  onPauseNow: (item: ProposalItem) => void;
}

/**
 * Conversation view. Everything the model or the chain produced is rendered as plain text (React escapes it; no markdown,
 * no links, no HTML). Only typed proposals become cards.
 */
export function MessageList({
  items,
  thinking,
  now,
  look,
  canSign,
  busy,
  handlers,
  onAnswer,
}: {
  items: ChatItem[];
  thinking: boolean;
  now: number;
  look: RowLookups;
  canSign: boolean;
  busy: boolean;
  handlers: CardHandlers;
  onAnswer: (text: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [items, thinking]);

  const last = items[items.length - 1];
  const showDots = thinking && !(last?.kind === "text" && last.streaming);
  return (
    <div className="flex flex-col gap-3 px-4 py-4" role="log" aria-live="polite" aria-label="Conversation">
      {items.map((i) => {
        switch (i.kind) {
          case "user":
            return (
              <Message key={i.id} from="user">
                <span className="whitespace-pre-wrap break-words">{i.text}</span>
              </Message>
            );
          case "text":
            return (
              <Message key={i.id} from="assistant" streaming={i.streaming}>
                <span className="whitespace-pre-wrap break-words">{i.text}</span>
              </Message>
            );
          case "question":
            return (
              <div key={i.id} className="flex flex-col gap-2">
                <Message from="assistant">
                  <span className="whitespace-pre-wrap break-words">{i.text}</span>
                </Message>
                {i.options.length > 0 && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Quick replies">
                    {i.options.map((o) => (
                      <Chip key={o} size="sm" selected={false} onClick={() => !i.answered && onAnswer(o)}>
                        {o}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            );
          case "data":
            return <DataView key={i.id} kind={i.dataKind} payload={i.payload} />;
          case "proposal":
            return (
              <ProposalCardView
                key={i.id}
                item={i}
                now={now}
                look={look}
                canSign={canSign}
                busy={busy}
                onQueue={() => handlers.onQueue(i.id)}
                onUnqueue={() => handlers.onUnqueue(i.id)}
                onDiscard={() => handlers.onDiscard(i.id)}
                onEdit={() => handlers.onEdit(i)}
                onPauseNow={() => handlers.onPauseNow(i)}
              />
            );
          case "notice":
            return (
              <Callout key={i.id} accent={i.tone === "error" ? "danger" : "info"}>
                {i.text}
              </Callout>
            );
        }
      })}
      {showDots && (
        <div className="px-1">
          <TypingDots />
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
