import { Button, Modal, SigningHint } from "@/kit";
import { chunkCalls, describeCall, type PlannedCall } from "@/lib/calls";
import { flattenBatch, type OrderedBatch } from "@/lib/proposals";

/**
 * Plain-language list of everything that will be signed, in signing order, then one wallet request (one transaction with
 * several FunctionCall actions; more than 9 actions become consecutive transactions).
 */
export function ReviewSignModal({
  open,
  onClose,
  batch,
  names,
  busy,
  canSign,
  onSign,
}: {
  open: boolean;
  onClose: () => void;
  batch: OrderedBatch;
  names: { agent: (id: string) => string; recipient: (id: number) => string };
  busy: boolean;
  canSign: boolean;
  onSign: (calls: PlannedCall[]) => void;
}) {
  const calls = flattenBatch(batch.ordered);
  const txs = chunkCalls(calls).length;
  const blocked = batch.problems.length > 0 || calls.length === 0 || !canSign;
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={`Review ${calls.length} ${calls.length === 1 ? "action" : "actions"}`}
      width={520}
      footer={
        <>
          {busy && <SigningHint />}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={blocked} loading={busy} onClick={() => onSign(calls)}>
            Sign {txs > 1 ? `${txs} transactions` : "in wallet"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="m-0 text-ink-muted">
          {txs > 1 ? `${calls.length} actions, signed in ${txs} consecutive transactions.` : `Signed as one transaction with ${calls.length} ${calls.length === 1 ? "action" : "actions"}, in this order. Either all of it happens or none.`}
        </p>
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {batch.ordered.map((it) => (
            <li key={it.id} className="rounded-tile border border-line bg-surface-sunken px-3 py-2">
              <div className="font-medium text-ink">{it.title}</div>
              <ul className="m-0 mt-1 list-disc pl-5 text-ink-secondary">
                {it.calls.map((c, i) => (
                  <li key={i}>{describeCall(c, names)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        {batch.problems.map((p, i) => (
          <p key={i} role="alert" className="m-0 text-danger-text">
            {p}
          </p>
        ))}
        {!canSign && <p className="m-0 text-ink-subtle">Connect the vault owner&apos;s wallet to sign.</p>}
        <p className="m-0 text-ink-subtle">Each action attaches 1 yoctoNEAR where the contract requires it. No funds move from your wallet.</p>
      </div>
    </Modal>
  );
}
