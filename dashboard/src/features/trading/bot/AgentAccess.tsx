import { useT } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Callout, Modal } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { formatTime } from "@/lib/format";
import { relativeTime } from "@/lib/relativeTime";
import { confirmTradingRules, revokeAgentToken, withOwnerSession, type AgentTokenIssued, type BotDetail, type TradingStatus } from "@/lib/tradingClient";
import { signErrorText } from "@/lib/tradingWizard";
import { useNow } from "@/lib/useNow";
import { tradingKeys, useAccountTrust } from "../useTrading";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * ADR-0007 §7: the AI agent's access on the bot page. "Revoke access" cuts the agent off at once (owner session, toward safety).
 * "Resume" (while stopped) / "New key" re-signs the SAME signed limits with the wallet; the worker then issues a new key, which is
 * shown once (old key stops working) by the parent, which keeps it in React state only until the owner closes the Connect card.
 */
export function AgentAccess({ detail, status, onIssued }: { detail: BotDetail; status: TradingStatus; onIssued: (k: AgentTokenIssued) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const now = useNow(30_000);
  const { canAct } = useOwner();
  const { accountId, signMessage } = useWallet();
  const { trust, trusted } = useAccountTrust(status);
  const [busy, setBusy] = useState<null | "sign" | "revoke">(null);
  const [ask, setAsk] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const bot = detail.bot;
  const a = detail.agent;
  const archived = bot.state === "archived";
  const expired = a?.expires_at_ms != null && a.expires_at_ms <= now;
  const connected = a?.connected === true && !expired;
  const halted = bot.state === "halted";

  const resign = async () => {
    if (!accountId || !detail.rules) return;
    setBusy("sign");
    setMsg(null);
    try {
      const r = await confirmTradingRules(detail.rules.rules, { accountId, signMessage, trustedHlAccount: trusted, botId: bot.id, expectNew: false });
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      if (r.agent_token) onIssued(r.agent_token);
    } catch (e) {
      setMsg({ ok: false, text: signErrorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const revoke = async () => {
    if (!accountId) return;
    setBusy("revoke");
    setMsg(null);
    try {
      await withOwnerSession(accountId, signMessage, (token) => revokeAgentToken(token, bot.id));
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      setAsk(false);
      setMsg({ ok: true, text: t("trading.agent.revoked") });
    } catch (e) {
      setAsk(false);
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const line = connected
    ? `${t("trading.agent.connected", { id: a?.token_id ?? "", date: formatTime(a?.expires_at_ms ?? 0) })} · ${a?.last_used_ms != null ? t("trading.agent.lastUsed", { when: relativeTime(a.last_used_ms, now) }) : t("trading.agent.neverUsed")}`
    : expired
      ? t("trading.agent.expired", { date: formatTime(a?.expires_at_ms ?? 0) })
      : t("trading.agent.notConnected");
  const canSign = canAct && accountId !== null && detail.rules !== null && trust?.kind === "ok" && !archived && busy === null;

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="m-0 text-sm text-ink-secondary">{line}</p>
      {!archived && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={halted || !connected ? "primary" : "secondary"} loading={busy === "sign"} disabled={!canSign} onClick={() => void resign()}>
            {t(halted ? "trading.agent.resume" : "trading.agent.newKey")}
          </Button>
          {connected && (
            <Button size="sm" variant="danger" disabled={!accountId || busy !== null} onClick={() => setAsk(true)}>
              {t("trading.agent.revoke")}
            </Button>
          )}
        </div>
      )}
      {!archived && <p className="m-0 text-xs text-ink-muted">{t("trading.agent.resignHint")}</p>}
      {msg && <Callout accent={msg.ok ? "ok" : "danger"}>{msg.text}</Callout>}
      <Modal
        open={ask}
        onClose={() => busy === null && setAsk(false)}
        danger
        title={t("trading.agent.revokeTitle")}
        footer={
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setAsk(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger-fill" loading={busy === "revoke"} onClick={() => void revoke()}>
              {t("trading.agent.revokeConfirm")}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm text-ink-secondary">{t("trading.agent.revokeBody")}</p>
      </Modal>
    </div>
  );
}
