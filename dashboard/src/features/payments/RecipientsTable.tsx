import { Link } from "react-router-dom";
import { useState } from "react";
import { Button, Card, CardHeader, ChainBadge, EmptyState, Hash, Modal, SigningHint, Table, Td, Th, Tr } from "@/kit";
import { relativeTime } from "@/lib/relativeTime";
import type { RecipientView } from "@/lib/types";
import { useOwnerTx } from "./useOwnerTx";

/** Address book (UI_UPDATES §4.3). Names are untrusted text. Remove needs 1 yocto and is blocked while schedules reference it. */
export function RecipientsTable({ recipients, now, onAdd, onEdit }: { recipients: RecipientView[]; now: number; onAdd: () => void; onEdit: (r: RecipientView) => void }) {
  const { send, busy, canAct } = useOwnerTx();
  const [removing, setRemoving] = useState<RecipientView | null>(null);
  const dis = !canAct || busy;
  return (
    <Card padding="none" aria-labelledby="recipients-title">
      <CardHeader
        className="px-5 py-4"
        id="recipients-title"
        title="Recipients"
        actions={
          <Button size="sm" variant="primary" disabled={!canAct} onClick={onAdd}>
            + Recipient
          </Button>
        }
      />
      {recipients.length === 0 ? (
        <EmptyState title="No recipients yet">The address book of people and services you pay. Scheduled payments and agents refer to it.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Chain</Th>
              <Th>Address</Th>
              <Th>Schedules</Th>
              <Th>Last paid</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {recipients.map((r) => (
              <Tr key={r.id}>
                <Td>
                  {r.label} <span className="text-xs text-ink-subtle">#{r.id}</span>
                </Td>
                <Td>
                  <ChainBadge chain={r.destination_chain} />
                </Td>
                <Td>
                  <Hash value={r.destination_address} />
                </Td>
                <Td>
                  {r.active_schedules > 0 ? (
                    <Link to={`/payments?tab=scheduled&recipient=${r.id}`}>
                      {r.active_schedules} active
                    </Link>
                  ) : (
                    <span className="text-ink-subtle">none</span>
                  )}
                </Td>
                <Td className="text-ink-secondary">{r.last_paid_at_ms ? relativeTime(Number(r.last_paid_at_ms), now) : "never"}</Td>
                <Td align="right" className="whitespace-nowrap">
                  <Button size="sm" variant="ghost" disabled={dis} onClick={() => onEdit(r)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={dis || r.active_schedules > 0}
                    title={r.active_schedules > 0 ? `End its ${r.active_schedules} ${r.active_schedules === 1 ? "schedule" : "schedules"} first` : undefined}
                    onClick={() => setRemoving(r)}
                  >
                    Remove
                  </Button>
                  {r.active_schedules > 0 && <span className="ml-1 text-xs text-ink-subtle">End its {r.active_schedules} {r.active_schedules === 1 ? "schedule" : "schedules"} first</span>}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal
        open={removing !== null}
        onClose={() => !busy && setRemoving(null)}
        danger
        title="Remove recipient?"
        footer={
          <>
            {busy && <SigningHint />}
            <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger-fill"
              loading={busy}
              disabled={!canAct}
              onClick={() => {
                if (removing) void send([{ method: "remove_recipient", args: { recipient_id: removing.id } }], "Remove recipient").then((x) => x.ok && setRemoving(null));
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="m-0">{removing?.label} is removed from the address book. Past payments stay in Payouts. Requires 1 yoctoNEAR.</p>
      </Modal>
    </Card>
  );
}
