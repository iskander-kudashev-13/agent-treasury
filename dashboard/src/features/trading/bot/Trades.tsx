import { intlLocale, useT } from "@/i18n";
import { Button, Callout, Card, CardHeader, Pill, Skeleton, Table, Td, Th, Tr } from "@/kit";
import { formatTime } from "@/lib/format";
import type { BotFill } from "@/lib/tradingClient";
import { fmtLocalTime, fmtMoney, fmtPrice, fmtSize } from "@/lib/tradingMetrics";
import { PnlValue } from "../BotRows";
import { AgentNote } from "./AgentActivity";

/** Trades newest first, 50 per page ("Show more" loads the next cursor). */
export function Trades({ fills, loading, more, loadingMore, loadMore, error }: { fills: readonly BotFill[]; loading: boolean; more: boolean; loadingMore: boolean; loadMore: () => void; error: string | null }) {
  const t = useT();
  const loc = intlLocale();
  return (
    <Card padding="none" aria-labelledby="bot-trades" className="flex flex-col">
      <div className="p-5 pb-3">
        <CardHeader id="bot-trades" title={t("trading.bot.tradesTitle")} />
      </div>
      {error && <div className="px-5 pb-3"><Callout accent="danger">{error}</Callout></div>}
      {loading && fills.length === 0 ? (
        <div className="px-5 pb-5"><Skeleton className="h-24" /></div>
      ) : fills.length === 0 ? (
        <p className="m-0 px-5 pb-5 text-sm text-ink-muted">{t("trading.bot.noTrades")}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("trading.bot.colTime")}</Th>
              <Th>{t("trading.bot.colSide")}</Th>
              <Th>{t("trading.bot.colPair")}</Th>
              <Th align="right">{t("trading.bot.colPrice")}</Th>
              <Th align="right">{t("trading.bot.colSize")}</Th>
              <Th align="right">{t("trading.bot.colFee")}</Th>
              <Th align="right">{t("trading.bot.colResult")}</Th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <Tr key={`${f.tid ?? f.oid}-${f.time_ms}-${f.cloid ?? ""}`}>
                <Td className="whitespace-nowrap text-ink-secondary"><span title={formatTime(f.time_ms)}>{fmtLocalTime(f.time_ms, loc)}</span></Td>
                <Td>
                  <Pill accent={f.side === "buy" ? "ok" : "danger"}>{f.side === "buy" ? "▲ " : "▼ "}{t(f.side === "buy" ? "trading.bot.buy" : "trading.bot.sell")}</Pill>
                  {f.note !== null && <AgentNote note={f.note} />}
                </Td>
                <Td mono>{f.pair}</Td>
                <Td align="right" mono>{fmtPrice(f.price)}</Td>
                <Td align="right" mono>{fmtSize(f.size)}</Td>
                <Td align="right" mono className="text-ink-muted">{fmtMoney(f.fee_usdc)}</Td>
                <Td align="right">{f.side === "sell" ? <PnlValue value={f.realized_usdc} className="text-[13px]" /> : <span className="cursor-help text-ink-subtle" title={t("trading.bot.resultOnSell")}>—</span>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {more && (
        <div className="p-4">
          <Button size="sm" loading={loadingMore} onClick={loadMore}>
            {t("trading.bot.showMore")}
          </Button>
        </div>
      )}
    </Card>
  );
}
