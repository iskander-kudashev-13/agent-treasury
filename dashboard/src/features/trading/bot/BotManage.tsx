import { useT } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Callout, Field, Input, Modal } from "@/kit";
import { useWallet } from "@/features/wallet/WalletProvider";
import { TRADING_LIST_PATH } from "@/lib/agentKind";
import { archiveBot, renameBot, TradingHttpError, withOwnerSession } from "@/lib/tradingClient";
import { tradingKeys } from "../useTrading";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Rename and archive of one agent (ADR-0006 §8). Only for workers that have `/trading/bots/:id/*`. */
export function BotManage({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const t = useT();
  const { accountId, signMessage } = useWallet();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | "rename" | "archive">(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setDialog(null);
    setError(null);
  };
  const open = (d: "rename" | "archive") => {
    setDraft(name);
    setError(null);
    setDialog(d);
  };
  const clean = draft.trim();

  const rename = async () => {
    if (!accountId || clean === "") return;
    setBusy(true);
    setError(null);
    try {
      await withOwnerSession(accountId, signMessage, (token) => renameBot(token, id, clean));
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      setDialog(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      await withOwnerSession(accountId, signMessage, (token) => archiveBot(token, id));
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
      setDialog(null);
      navigate(TRADING_LIST_PATH);
    } catch (e) {
      setError(e instanceof TradingHttpError && e.code === "BOT_HOLDS_POSITION" ? t("trading.bot.archiveHolds") : errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2" role="group" aria-label={t("trading.bot.manage")}>
        <Button size="sm" variant="ghost" disabled={!accountId || archived} onClick={() => open("rename")}>
          {t("trading.bot.rename")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!accountId || archived} onClick={() => open("archive")}>
          {t("trading.bot.archive")}
        </Button>
      </div>
      <Modal
        open={dialog === "rename"}
        onClose={close}
        title={t("trading.bot.renameTitle")}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} disabled={clean === "" || clean === name} onClick={() => void rename()}>
              {t("trading.bot.renameSave")}
            </Button>
          </>
        }
      >
        <Field label={t("trading.bot.renameLabel")}>
          {(a) => <Input {...a} value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} />}
        </Field>
        {error && <Callout accent="danger">{error}</Callout>}
      </Modal>
      <Modal
        open={dialog === "archive"}
        onClose={close}
        danger
        title={t("trading.bot.archiveTitle")}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger-fill" loading={busy} onClick={() => void archive()}>
              {t("trading.bot.archiveConfirm")}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm text-ink-secondary">{t("trading.bot.archiveBody")}</p>
        {error && <Callout accent="danger">{error}</Callout>}
      </Modal>
    </>
  );
}
