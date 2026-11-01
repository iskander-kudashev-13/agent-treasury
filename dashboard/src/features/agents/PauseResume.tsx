import { useState } from "react";
import { Button, Icons, Modal, SigningHint } from "@/kit";
import type { AgentView } from "@/lib/types";
import { useAgentTx } from "./useAgentTx";

/** Pause (confirm sheet, no deposit) or Resume (1 yocto) for one agent. Hidden for revoked agents. */
export function PauseResume({ agent, vaultPaused, size = "sm" }: { agent: AgentView; vaultPaused?: boolean; size?: "sm" | "md" }) {
  const { canAct, busy, call } = useAgentTx();
  const [confirm, setConfirm] = useState(false);
  if (agent.status === "Revoked") return null;
  const disabled = !canAct || busy || vaultPaused;
  const title = !canAct ? "Only the vault owner can do this" : vaultPaused ? "The vault is paused" : undefined;
  if (agent.status === "Paused") {
    return (
      <Button size={size} icon={<Icons.Play size={13} />} disabled={disabled} title={title} onClick={() => void call("resume_agent", { agent_id: agent.id })}>
        Resume
      </Button>
    );
  }
  return (
    <>
      <Button size={size} icon={<Icons.Pause size={13} />} disabled={disabled} title={title} onClick={() => setConfirm(true)}>
        Pause
      </Button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Pause ${agent.name}?`}
        footer={
          <>
            {busy && <SigningHint />}
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="approve"
              disabled={busy}
              onClick={() =>
                void call("pause_agent", { agent_id: agent.id }).then((ok) => {
                  if (ok) setConfirm(false);
                })
              }
            >
              Pause {agent.name}
            </Button>
          </>
        }
      >
        {agent.name} can&apos;t request payments until you resume it. Other agents keep working.
      </Modal>
    </>
  );
}
