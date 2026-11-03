import { useT, rich } from "@/i18n";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Card, Icons, Modal, Timeline, type TimelineStep } from "@/kit";
import { useAgentTx } from "@/features/agents/useAgentTx";
import { useWallet } from "@/features/wallet/WalletProvider";
import { killTrading, rotateApiWallet, withOwnerSession, TRADER_AGENT_ID, type KillResult, type TradingStatus } from "@/lib/tradingClient";
import { hlAppUrl } from "@/lib/tradingView";
import { tradingKeys } from "./useTrading";

type Step = { state: TimelineStep["state"]; detail?: string };
interface Run {
  kill: Step;
  pause: Step;
}
const TODO: Step = { state: "todo" };

/**
 * Kill switch (ADR-0005 "Dashboard kill switch"): 1. worker cancels all orders and halts, 2. the vault agent is paused so no
 * more top-ups can be requested, 3. the owner revokes the API wallet on Hyperliquid, 4. optionally returns profits. Step 2 runs
 * even if step 1 failed (the bot also cancels on its next tick when the vault says paused). Each result is shown.
 */
export function KillSwitch({ status }: { status: TradingStatus }) {
  const t = useT();
  const { canAct, call } = useAgentTx();
  const { accountId, signMessage } = useWallet();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [killed, setKilled] = useState<KillResult | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [rotateErr, setRotateErr] = useState<string | null>(null);

  const start = async () => {
    if (!accountId || running) return;
    setRunning(true);
    setKilled(null);
    setRun({ kill: { state: "active" }, pause: TODO });
    let kill: Step;
    try {
      // An expired owner session (1 h) is renewed inline: one extra wallet prompt, then the kill is retried once.
      const r = await withOwnerSession(accountId, signMessage, (token) => killTrading(token, "dashboard kill switch"));
      setKilled(r);
      const failed = [r.steps.cancel_all === "failed" && t("trading.kill.noCancel"), // The dead-man timer is only a backstop: HL refuses it on accounts with < $1M traded volume (DEADMAN_VOLUME_GATED,
      // IOC-only), and once cancel_all succeeded every order is already gone. Only a lone timer failure is worth a red step.
      r.steps.schedule_cancel === "failed" && r.steps.cancel_all !== "ok" && t("trading.kill.noTimer"), r.steps.state_saved === "failed" && t("trading.kill.noSave")].filter(Boolean);
      kill = failed.length === 0 ? { state: "done", detail: t("trading.kill.haltedCancelled", { count: r.cancelled_orders }) } : { state: "failed", detail: t("trading.kill.haltedButFailed", { what: failed.join(t("trading.kill.and")) }) };
    } catch (e) {
      kill = { state: "failed", detail: t("trading.kill.errContinue", { error: e instanceof Error ? e.message : String(e) }) };
    }
    setRun({ kill, pause: { state: "active" } });
    const ok = await call("pause_agent", { agent_id: TRADER_AGENT_ID });
    setRun({ kill, pause: ok ? { state: "done", detail: t("trading.kill.pausedDetail") } : { state: "failed", detail: t("trading.kill.notPaused") } });
    void qc.invalidateQueries({ queryKey: tradingKeys.all });
    setRunning(false);
  };

  const rotate = async () => {
    if (!accountId) return;
    setRotateErr(null);
    try {
      setRotated(await withOwnerSession(accountId, signMessage, (token) => rotateApiWallet(token)));
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
    } catch (e) {
      setRotateErr(e instanceof Error ? e.message : String(e));
    }
  };

  const steps: TimelineStep[] = run
    ? [
        { title: t("trading.kill.step1"), state: run.kill.state, ...(run.kill.detail ? { detail: run.kill.detail } : {}) },
        { title: t("trading.kill.step2"), state: run.pause.state, ...(run.pause.detail ? { detail: run.pause.detail } : {}) },
        {
          title: t("trading.kill.step3"),
          state: run.pause.state === "active" || run.pause.state === "todo" ? "todo" : "active",
          detail: (
            <>
              {rich("trading.kill.step3Detail", {
                link: (
                  <a href={hlAppUrl(status.hl_network)} target="_blank" rel="noreferrer">
                    {t("trading.kill.apiPage")}
                  </a>
                ),
                rotate: (
                  <button type="button" className="cursor-pointer text-ok underline" onClick={() => void rotate()}>
                    {t("trading.kill.rotateIt")}
                  </button>
                ),
              })}
              {rotated && <span className="mono mt-1 block text-xs break-all">{t("trading.kill.newAddress", { address: rotated })}</span>}
              {rotateErr && <span className="mt-1 block text-danger-text">{rotateErr}</span>}
            </>
          ),
        },
        {
          title: t("trading.kill.step4"),
          state: "todo",
          detail: t("trading.kill.step4Detail"),
        },
      ]
    : [];

  return (
    <Card aria-labelledby="kill-switch" className="flex flex-wrap items-center gap-3 border-danger/40">
      <div className="min-w-[220px] flex-1">
        <h2 id="kill-switch" className="m-0 text-[15px] font-semibold">
          {t("trading.kill.title")}
        </h2>
        <p className="m-0 mt-0.5 text-[13px] text-ink-muted">{t("trading.kill.desc")}</p>
      </div>
      <Button variant="danger-fill" icon={<Icons.Pause size={14} />} disabled={!canAct || !accountId} title={canAct ? undefined : t("common.ownerOnly")} onClick={() => setOpen(true)}>
        {t("trading.kill.stop")}
      </Button>
      <Modal
        open={open}
        danger
        onClose={() => !running && setOpen(false)}
        title={run ? t("trading.kill.modalRunning") : t("trading.kill.modalAsk")}
        footer={
          run ? (
            <Button variant="primary" disabled={running} onClick={() => { setOpen(false); setRun(null); }}>
              {t("trading.kill.done")}
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="danger-fill" onClick={() => void start()}>
                {t("trading.kill.stop")}
              </Button>
            </>
          )
        }
      >
        {run ? (
          <div className="flex flex-col gap-3">
            <Timeline steps={steps} />
            {killed && killed.state !== "halted" && <Callout accent="warn">{t("trading.kill.workerState", { state: killed.state })}</Callout>}
          </div>
        ) : (
          <p className="m-0">
            {t("trading.kill.confirmBody")}
          </p>
        )}
      </Modal>
    </Card>
  );
}
