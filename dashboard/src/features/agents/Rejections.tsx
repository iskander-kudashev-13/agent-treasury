import { formatUsdc } from "@/lib/amount";
import { formatTime } from "@/lib/format";
import { refusedTitle } from "@/lib/reasonCodes";
import { shortId } from "@/kit/tokens";
import type { Rejection } from "@/lib/types";
import { Card, CardHeader, ChainBadge, EmptyState, ReasonChip, Table, Td, Th, Tr } from "@/kit";

/** Refusals are normal operation (DESIGN_AGENTS §1.3): neutral reason chips, never red. */
export function Rejections({ rejections }: { rejections: Rejection[] }) {
  return (
    <Card padding="none" aria-labelledby="rejections-title">
      <CardHeader className="px-5 py-4" id="rejections-title" title={`Rejections (${rejections.length})`} />
      {rejections.length === 0 ? (
        <EmptyState title="No rejected requests" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Agent</Th>
                <Th>Reason</Th>
                <Th align="right">Amount</Th>
                <Th>Destination</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {rejections.map((r, i) => (
                <Tr key={`${r.at}-${i}`} className="align-top">
                  <Td className="text-xs">{formatTime(r.at)}</Td>
                  <Td mono className="text-xs">
                    {r.agent_id}
                  </Td>
                  <Td>
                    <span title={refusedTitle(r.reason)}>
                      <ReasonChip code={r.reason} />
                    </span>
                  </Td>
                  <Td align="right" mono>
                    {formatUsdc(r.amount)}
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5" title={r.address}>
                      <ChainBadge chain={r.chain} />
                      <span className="mono text-xs">{shortId(r.address, 8, 6)}</span>
                    </span>
                  </Td>
                  <Td className="text-xs text-ink-secondary">{r.detail}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
