import { useEffect } from "react";
import { AI_ENABLED } from "@/lib/config";
import { IconButton, Icons } from "@/kit";
import { AssistantContent } from "@/features/assistant/AssistantContent";
import { AssistantPrivacyBadge } from "@/features/assistant/PrivacyBadge";
import { useAssistant } from "@/features/assistant/useAssistant";
import { useAssistantPanel } from "./AssistantContext";

/**
 * The chat panel (UI_UPDATES §6). The shell owns the frame: 400 px column that pushes content on desktop, full-screen sheet on
 * mobile, header with new-conversation and close, `/` focuses the input. `useAssistant` lives here, in the always-mounted
 * frame, so closing the panel keeps the conversation and the queued changes. Hidden when VITE_AI_ENABLED is not "true".
 */
export function AssistantPanel() {
  if (!AI_ENABLED) return null;
  return <Panel />;
}

function Panel() {
  const { open, setOpen, inputRef, prefill, clearPrefill } = useAssistantPanel();
  const assistant = useAssistant();

  useEffect(() => {
    if (open && prefill !== null) {
      if (inputRef.current) inputRef.current.value = prefill;
      inputRef.current?.focus();
      clearPrefill();
    }
  }, [open, prefill, inputRef, clearPrefill]);

  if (!open) return null;
  return (
    <aside
      aria-label="Assistant"
      className="fixed inset-0 z-40 flex flex-col bg-surface-sunken md:sticky md:inset-auto md:top-[65px] md:z-auto md:h-[calc(100dvh-65px)] md:w-[400px] md:shrink-0 md:border-l md:border-line"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Icons.Sparkles size={16} />
        <h2 className="m-0 text-[15px] font-semibold">Assistant</h2>
        <AssistantPrivacyBadge />
        <div className="grow" />
        <IconButton
          label="New conversation"
          disabled={assistant.items.length === 0}
          onClick={() => {
            const queued = assistant.items.some((i) => i.kind === "proposal" && i.status === "queued");
            if (!queued || window.confirm("Start over? Changes you queued but have not signed will be dropped.")) assistant.reset();
          }}
        >
          <Icons.Loader size={16} />
        </IconButton>
        <IconButton label="Close assistant" onClick={() => setOpen(false)}>
          <Icons.X size={16} />
        </IconButton>
      </div>
      <AssistantContent assistant={assistant} inputRef={inputRef} />
    </aside>
  );
}
