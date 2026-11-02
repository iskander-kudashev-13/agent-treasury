import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { useState } from "react";
import { Button, Card, CardHeader, ChainBadge, EmptyState, Hash, Modal, SigningHint, Table, Td, Th, Tr } from "@/kit";
import { relativeTime } from "@/lib/relativeTime";
import type { RecipientView } from "@/lib/types";
import { useOwnerTx } from "./useOwnerTx";

/** Address book (UI_UPDATES §4.3). Names are untrusted text. Remove needs 1 yocto and is blocked while schedules reference it. */
export function RecipientsTable({ recipients, now, onAdd, onEdit }: { recipients: RecipientView[]; now: number; onAdd: () => void; onEdit: (r: RecipientView) => void }) {
  const t = useT();
  const { send, busy, canAct } = useOwnerTx();
  const [removing, setRemoving] = useState<RecipientView | null>(null);
  const dis = !canAct || busy;
  return (
    <Card padding="none" aria-labelledby="recipients-title">
      <CardHeader
        className="px-5 py-4"
        id="recipients-title"
        title={t("pay.recipients")}
        actions={
          <Button size="sm" variant="primary" disabled={!canAct} onClick={onAdd}>
            {t("pay.addRecipientBtn")}
          </Button>
        }
      />
      {recipients.length === 0 ? (
        <EmptyState title={t("pay.noRecipients")}>{t("pay.noRecipientsHint")}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("pay.colName")}</Th>
              <Th>{t("pay.colChain")}</Th>
              <Th>{t("pay.colAddress")}</Th>
              <Th>{t("pay.colSchedules")}</Th>
              <Th>{t("pay.colLastPaid")}</Th>
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
                      {t("pay.activeN", { n: r.active_schedules })}
                    </Link>
                  ) : (
                    <span className="text-ink-subtle">{t("pay.none")}</span>
                  )}
                </Td>
                <Td className="text-ink-secondary">{r.last_paid_at_ms ? relativeTime(Number(r.last_paid_at_ms), now) : t("common.never")}</Td>
                <Td align="right" className="whitespace-nowrap">
                  <Button size="sm" variant="ghost" disabled={dis} onClick={() => onEdit(r)}>
                    {t("pay.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={dis || r.active_schedules > 0}
                    title={r.active_schedules > 0 ? t("pay.endFirst", { count: r.active_schedules }) : undefined}
                    onClick={() => setRemoving(r)}
                  >
                    {t("pay.remove")}
                  </Button>
                  {r.active_schedules > 0 && <span className="ml-1 text-xs text-ink-subtle">{t("pay.endFirst", { count: r.active_schedules })}</span>}
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
        title={t("pay.removeTitle")}
        footer={
          <>
            {busy && <SigningHint />}
            <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger-fill"
              loading={busy}
              disabled={!canAct}
              onClick={() => {
                if (removing) void send([{ method: "remove_recipient", args: { recipient_id: removing.id } }], t("pay.removeRecipientLbl")).then((x) => x.ok && setRemoving(null));
              }}
            >
              {t("pay.remove")}
            </Button>
          </>
        }
      >
        <p className="m-0">{t("pay.removeBody", { label: removing?.label ?? "" })}</p>
      </Modal>
    </Card>
  );
}
