import { useEffect, useState } from "react";
import { secondsLeft, type TwoPhaseState } from "@/lib/twoPhase";
import { Button, Callout } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import type { OwnerMethod } from "@/lib/calls";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Guides the owner through a two-phase owner call (credit_refund / sync_surplus).
 * Step 1 records a probe; after 60 s the SAME call credits. Success is verified by reading chain state (`isCredited`),
 * not the transaction outcome, because redirect wallets do not return it.
 */
export function TwoPhaseAction({
  method,
  args,
  startLabel,
  confirmLabel,
  title,
  snapshot,
  isCredited,
  doneText,
  notCreditedText,
  disabled,
}: {
  method: Extract<OwnerMethod, "credit_refund" | "sync_surplus">;
  args: Record<string, unknown>;
  startLabel: string;
  confirmLabel: string;
  title: string;
  /** Fresh read of the state that changes when the credit happens. */
  snapshot: () => Promise<unknown>;
  isCredited: (before: unknown, after: unknown) => boolean;
  doneText: string;
  notCreditedText: string;
  disabled?: boolean;
}) {
  const { canAct, busy, act } = useOwner();
  const [st, setSt] = useState<TwoPhaseState>({ phase: "idle" });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (st.phase !== "waiting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [st.phase]);

  const left = st.phase === "waiting" ? secondsLeft(st.startedAt, now) : 0;
  const off = !canAct || busy || disabled;

  const start = async () => {
    if (await act(method, args)) {
      setNow(Date.now());
      setSt({ phase: "waiting", startedAt: Date.now() });
    }
  };
  const confirm = async () => {
    let before: unknown;
    try {
      before = await snapshot();
    } catch {
      before = undefined;
    }
    if (!(await act(method, args))) return;
    setSt({ phase: "verifying" });
    for (const wait of [5000, 5000, 6000]) {
      await sleep(wait);
      try {
        if (isCredited(before, await snapshot())) {
          setSt({ phase: "done" });
          return;
        }
      } catch {
        /* RPC hiccup: try again */
      }
    }
    setSt({ phase: "not_credited" });
  };

  return (
    <div className="flex flex-col gap-2">
      {st.phase === "idle" && (
        <Button size="sm" disabled={off} onClick={() => void start()} title="Step 1 of 2: records a balance probe (1 yocto)">
          {startLabel}
        </Button>
      )}
      {st.phase === "waiting" && (
        <Callout
          accent="info"
          action={
            <Button size="sm" variant="primary" disabled={off || left > 0} onClick={() => void confirm()} title="Step 2 of 2 (1 yocto)">
              {left > 0 ? `${confirmLabel} (${left}s)` : confirmLabel}
            </Button>
          }
        >
          <strong>Step 1 of 2 done.</strong> {title}: confirm in {left > 0 ? `${left} s` : "the wallet now"}. The contract compares two balance reads taken at least 60 s apart.
        </Callout>
      )}
      {st.phase === "verifying" && <Callout accent="neutral">Checking the result on chain…</Callout>}
      {st.phase === "done" && <Callout accent="ok">{doneText}</Callout>}
      {st.phase === "not_credited" && (
        <Callout
          accent="warn"
          action={
            <Button size="sm" onClick={() => setSt({ phase: "idle" })}>
              Start over
            </Button>
          }
        >
          {notCreditedText}
        </Callout>
      )}
    </div>
  );
}
