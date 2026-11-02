import { useT } from "@/i18n";
import { useState } from "react";
import { Button, Icons, Modal, SigningHint } from "@/kit";
import type { AgentView } from "@/lib/types";
import { useAgentTx } from "./useAgentTx";

/** Pause (confirm sheet, no deposit) or Resume (1 yocto) for one agent. Hidden for revoked agents. */
export function PauseResume({ agent, vaultPaused, size = "sm" }: { agent: AgentView; vaultPaused?: boolean; size?: "sm" | "md" }) {
  const t = useT();
  const { canAct, busy, call } = useAgentTx();
  const [confirm, setConfirm] = useState(false);
  if (agent.status === "Revoked") return null;
  const disabled = !canAct || busy || vaultPaused;
  const title = !canAct ? t("common.ownerOnly") : vaultPaused ? t("ag.vaultIsPaused") : undefined;
  if (agent.status === "Paused") {
    return (
      <Button size={size} icon={<Icons.Play size={13} />} disabled={disabled} title={title} onClick={() => void call("resume_agent", { agent_id: agent.id })}>
        {t("ag.resume")}
      </Button>
    );
  }
  return (
    <>
      <Button size={size} icon={<Icons.Pause size={13} />} disabled={disabled} title={title} onClick={() => setConfirm(true)}>
        {t("ag.pause")}
      </Button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("ag.pauseTitle", { name: agent.name })}
        footer={
          <>
            {busy && <SigningHint />}
            <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            <Button
              variant="approve"
              disabled={busy}
              onClick={() =>
                void call("pause_agent", { agent_id: agent.id }).then((ok) => {
                  if (ok) setConfirm(false);
                })
              }
            >
              {t("ag.pauseBtn", { name: agent.name })}
            </Button>
          </>
        }
      >
        {t("ag.pauseBody", { name: agent.name })}
      </Modal>
    </>
  );
}
