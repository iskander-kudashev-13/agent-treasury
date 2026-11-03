import { useT } from "@/i18n";
import { useEffect } from "react";
import { AI_ENABLED } from "@/lib/config";
import { IconButton, Icons } from "@/kit";
import { AssistantContent } from "@/features/assistant/AssistantContent";
import { AssistantPrivacyBadge } from "@/features/assistant/PrivacyBadge";
import { useBots } from "@/features/trading/useBots";
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
  const t = useT();
  const { open, setOpen, inputRef, prefill, clearPrefill, tradingBot, clearTradingBot } = useAssistantPanel();
  const { data: bots } = useBots();
  const botName = tradingBot === null ? null : tradingBot === "new" ? t("as.rulesNewShort") : (bots?.bots.find((b) => b.id === tradingBot)?.name ?? tradingBot);
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
      aria-label={t("assistant.title")}
      className="fixed inset-0 z-40 flex flex-col bg-surface-sunken md:sticky md:inset-auto md:top-[65px] md:z-auto md:h-[calc(100dvh-65px)] md:w-[400px] md:shrink-0 md:border-l md:border-line"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Icons.Sparkles size={16} />
        <h2 className="m-0 text-[15px] font-semibold">{t("assistant.title")}</h2>
        <AssistantPrivacyBadge />
        <div className="grow" />
        <IconButton
          label={t("assistant.new")}
          disabled={assistant.items.length === 0}
          onClick={() => {
            const queued = assistant.items.some((i) => i.kind === "proposal" && i.status === "queued");
            if (!queued || window.confirm(t("assistant.confirmReset"))) assistant.reset();
          }}
        >
          <Icons.Loader size={16} />
        </IconButton>
        <IconButton label={t("assistant.closePanel")} onClick={() => setOpen(false)}>
          <Icons.X size={16} />
        </IconButton>
      </div>
      {botName !== null && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-line-strong bg-surface px-2.5 py-0.5 text-xs">
            <Icons.TrendingUp size={12} />
            <span className="truncate">{t("as.agentChip", { name: botName })}</span>
            <button type="button" aria-label={t("as.agentChipClear")} className="inline-flex cursor-pointer border-0 bg-transparent p-0 text-ink-muted hover:text-ink" onClick={clearTradingBot}>
              <Icons.X size={12} />
            </button>
          </span>
        </div>
      )}
      <AssistantContent assistant={assistant} inputRef={inputRef} />
    </aside>
  );
}
