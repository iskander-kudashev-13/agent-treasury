import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Card, Icons, Modal, Timeline, type TimelineStep } from "@/kit";
import { useAgentTx } from "@/features/agents/useAgentTx";
import { useWallet } from "@/features/wallet/WalletProvider";
import { ensureSession, killTrading, rotateApiWallet, TRADER_AGENT_ID, type KillResult, type TradingStatus } from "@/lib/tradingClient";
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
      const session = await ensureSession(accountId, signMessage);
      const r = await killTrading(session.token, "dashboard kill switch");
      setKilled(r);
      const failed = [r.steps.cancel_all === "failed" && "cancel all orders", r.steps.schedule_cancel === "failed" && "dead-man timer", r.steps.state_saved === "failed" && "saving the halt (a restart could forget it; stop the worker and revoke its API wallet)"].filter(Boolean);
      kill = failed.length === 0 ? { state: "done", detail: `Halted. ${r.cancelled_orders} order${r.cancelled_orders === 1 ? "" : "s"} cancelled.` } : { state: "failed", detail: `Halted, but ${failed.join(" and ")} failed. Orders also auto-cancel within minutes (dead-man timer) and on the bot's next check.` };
    } catch (e) {
      kill = { state: "failed", detail: `${e instanceof Error ? e.message : String(e)}. Continuing: pausing the agent stops funding, and the bot cancels its orders on its next check.` };
    }
    setRun({ kill, pause: { state: "active" } });
    const ok = await call("pause_agent", { agent_id: TRADER_AGENT_ID });
    setRun({ kill, pause: ok ? { state: "done", detail: "The vault agent is paused: no more top-ups." } : { state: "failed", detail: "Not paused (cancelled in the wallet or failed). Try Pause on the Agents page." } });
    void qc.invalidateQueries({ queryKey: tradingKeys.all });
    setRunning(false);
  };

  const rotate = async () => {
    if (!accountId) return;
    setRotateErr(null);
    try {
      const s = await ensureSession(accountId, signMessage);
      setRotated(await rotateApiWallet(s.token));
      void qc.invalidateQueries({ queryKey: tradingKeys.all });
    } catch (e) {
      setRotateErr(e instanceof Error ? e.message : String(e));
    }
  };

  const steps: TimelineStep[] = run
    ? [
        { title: "Cancel orders and halt the bot", state: run.kill.state, ...(run.kill.detail ? { detail: run.kill.detail } : {}) },
        { title: "Pause the agent on the vault", state: run.pause.state, ...(run.pause.detail ? { detail: run.pause.detail } : {}) },
        {
          title: "Revoke the bot wallet on Hyperliquid",
          state: run.pause.state === "active" || run.pause.state === "todo" ? "todo" : "active",
          detail: (
            <>
              Open{" "}
              <a href={hlAppUrl(status.hl_network)} target="_blank" rel="noreferrer">
                the Hyperliquid API page
              </a>{" "}
              and remove the wallet, or{" "}
              <button type="button" className="cursor-pointer text-ok underline" onClick={() => void rotate()}>
                rotate it
              </button>{" "}
              to give the bot a new one that you must approve again.
              {rotated && <span className="mono mt-1 block text-xs break-all">New address: {rotated}</span>}
              {rotateErr && <span className="mt-1 block text-danger-text">{rotateErr}</span>}
            </>
          ),
        },
        {
          title: "Optional: bring the money back",
          state: "todo",
          detail: "On Hyperliquid, send USDC from your account to a 1Click deposit address whose recipient is the vault (refund to your Hyperliquid account), then run Sync surplus on the Treasury page.",
        },
      ]
    : [];

  return (
    <Card aria-labelledby="kill-switch" className="flex flex-wrap items-center gap-3 border-danger/40">
      <div className="min-w-[220px] flex-1">
        <h2 id="kill-switch" className="m-0 text-[15px] font-semibold">
          Kill switch
        </h2>
        <p className="m-0 mt-0.5 text-[13px] text-ink-muted">Cancels all orders, halts the bot and pauses its vault agent. Positions stay open until you close them.</p>
      </div>
      <Button variant="danger-fill" icon={<Icons.Pause size={14} />} disabled={!canAct || !accountId} title={canAct ? undefined : "Only the vault owner can do this"} onClick={() => setOpen(true)}>
        Stop trading
      </Button>
      <Modal
        open={open}
        danger
        onClose={() => !running && setOpen(false)}
        title={run ? "Stopping the trading agent" : "Stop trading now?"}
        footer={
          run ? (
            <Button variant="primary" disabled={running} onClick={() => { setOpen(false); setRun(null); }}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="danger-fill" onClick={() => void start()}>
                Stop trading
              </Button>
            </>
          )
        }
      >
        {run ? (
          <div className="flex flex-col gap-3">
            <Timeline steps={steps} />
            {killed && killed.state !== "halted" && <Callout accent="warn">The worker reports state: {killed.state}</Callout>}
          </div>
        ) : (
          <p className="m-0">
            The bot cancels every open order and stays halted until you confirm new rules. Then your wallet asks you to pause the agent on the vault. You will be asked to sign in once if you have not yet.
          </p>
        )}
      </Modal>
    </Card>
  );
}
