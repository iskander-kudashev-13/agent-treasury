import { useT } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Callout, Icons } from "@/kit";
import { useWallet } from "@/features/wallet/WalletProvider";
import type { BotCtx } from "@/lib/tradingBots";
import { stopBot } from "@/lib/tradingBots";
import { withOwnerSession } from "@/lib/tradingClient";
import { tradingKeys } from "../useTrading";

/** Stop this agent: cancels its orders and halts it. Two clicks (the second confirms); the owner session is renewed inline. */
export function StopButton({ ctx, id, disabled }: { ctx: BotCtx; id: string; disabled: boolean }) {
  const t = useT();
  const { accountId, signMessage } = useWallet();
  const qc = useQueryClient();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    if (!accountId) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await withOwnerSession(accountId, signMessage, (token) => stopBot(ctx, id, token));
      const failed = r.steps.cancel === "failed" || r.steps.state_saved === "failed";
      setMsg({ ok: !failed, text: failed ? t("trading.bot.stopPartial") : t("trading.bot.stopped", { count: r.cancelled_orders }) });
      setAsk(false);
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-2">
      {ask ? (
        <div className="flex items-center gap-2">
          <Button variant="danger-fill" loading={busy} onClick={() => void run()}>
            {t("trading.bot.stopConfirm")}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setAsk(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : (
        <Button variant="danger" icon={<Icons.Pause size={14} />} disabled={disabled || !accountId} onClick={() => setAsk(true)}>
          {t("trading.bot.stop")}
        </Button>
      )}
      {msg && <Callout accent={msg.ok ? "ok" : "danger"}>{msg.text}</Callout>}
    </div>
  );
}
