import { useT, rich } from "@/i18n";
import { Card, CardHeader, Callout, Dot, Hash, Overline, Pill, SpendBar, Stat, Tile } from "@/kit";
import { formatTime } from "@/lib/format";
import { relativeTime } from "@/lib/relativeTime";
import type { LogEntry, TradingStatus } from "@/lib/tradingClient";
import { fmtDec, fmtSigned, pnlAccent, reasonText, stateInfo } from "@/lib/tradingView";
import { useNow } from "@/lib/useNow";

const usd = (v: string) => fmtDec(v, 2);

/** Balance, P&L vs funded, what is left of each limit, open orders and the bot's last decisions. */
export function StatusCard({ status, log, logLoading, logHint }: { status: TradingStatus; log: LogEntry[]; logLoading: boolean; logHint: React.ReactNode }) {
  const t = useT();
  const now = useNow(15_000);
  const info = stateInfo(status.state);
  const why = reasonText(status.state_reason, status.state_detail);
  const l = status.limits;
  const v = l.vault;
  return (
    <Card aria-labelledby="trading-status" className="flex flex-col gap-4">
      <CardHeader
        id="trading-status"
        title={t("trading.status.title")}
        badge={
          <span className="inline-flex items-center gap-2 text-[13px] font-medium">
            <Dot accent={info.accent} live={status.state === "running"} />
            {info.label}
          </span>
        }
        actions={
          <Pill accent={status.hl_network === "mainnet" ? "warn" : "neutral"} title={t("trading.status.network")}>
            {status.hl_network}
          </Pill>
        }
      />
      <p className="m-0 text-[13px] text-ink-muted">{info.hint}</p>
      {why && (
        <Callout accent={status.state === "halted" || status.state === "error" ? "danger" : "warn"}>{why}</Callout>
      )}
      {!status.perp_check.ok && <Callout accent="danger">{t("trading.status.perp")}</Callout>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={t("trading.status.onHl")} value={usd(status.balances.equity_usdc)} sub={t("trading.status.freeUsdc", { amount: usd(status.balances.usdc_free) })} />
        <Stat label={t("trading.status.pnl")} value={fmtSigned(status.pnl.total_usdc)} accent={pnlAccent(status.pnl.total_usdc)} sub={t("trading.status.sentTotal", { amount: usd(status.pnl.net_funded_usdc) })} />
        <Stat label={t("trading.status.today")} value={fmtSigned(status.pnl.today_usdc)} accent={pnlAccent(status.pnl.today_usdc)} sub={t("trading.status.fromEquity", { amount: usd(status.pnl.day_start_equity_usdc) })} />
        <Stat label={t("trading.status.openOrders")} value={status.open_orders.length} sub={status.balances.positions.length ? status.balances.positions.map((p) => `${fmtDec(p.size, 4)} ${p.base}`).join(", ") : t("trading.status.noPositions")} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Tile className="flex flex-col gap-3">
          <Overline>{t("trading.status.vaultLimits")}</Overline>
          <SpendBar
            label={t("trading.status.topupsToday")}
            spent={v.payments_today}
            limit={Math.max(1, v.max_payments_per_day)}
            spentText={String(v.payments_today)}
            limitText={String(v.max_payments_per_day)}
            scope="agent"
          />
          <p className="m-0 text-xs text-ink-muted">
            {rich("trading.status.leftToSend", { left: <span className="mono text-ink">{usd(v.remaining_today_usdc)} USDC</span>, max: usd(v.per_tx_limit_usdc) })}{" "}
            {v.status && v.status !== "Active" ? <strong>{t("trading.status.vaultAgent", { status: v.status === "Paused" || v.status === "Revoked" ? t(`agentStatus.${v.status}`) : v.status })}</strong> : null}{" "}
            {v.expires_at_ms ? t("trading.status.mandateExpires", { when: relativeTime(v.expires_at_ms, now) }) : ""}
          </p>
        </Tile>
        <Tile className="flex flex-col gap-3">
          <Overline>{t("trading.status.tradingLimits")}</Overline>
          <SpendBar label={t("trading.status.lossToday")} spent={Number(l.today.loss_usdc) || 0} limit={Number(l.effective.daily_loss_stop_usdc) || 0} spentText={usd(l.today.loss_usdc)} limitText={`${usd(l.effective.daily_loss_stop_usdc)} USDC`} scope="agent" />
          <SpendBar label={t("trading.status.position")} spent={Number(l.position_usdc) || 0} limit={Number(l.effective.max_position_usdc) || 0} spentText={usd(l.position_usdc)} limitText={`${usd(l.effective.max_position_usdc)} USDC`} scope="agent" />
          <SpendBar label={t("trading.status.ordersToday")} spent={l.today.orders} limit={l.effective.max_orders_per_day} spentText={String(l.today.orders)} limitText={String(l.effective.max_orders_per_day)} scope="agent" />
        </Tile>
      </div>

      {status.open_orders.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Overline>{t("trading.status.openOrders")}</Overline>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            {status.open_orders.map((o) => (
              <li key={o.oid} className="flex flex-wrap items-baseline gap-x-2">
                <span className={o.side === "buy" ? "text-ok" : "text-danger-text"}>{o.side === "buy" ? t("trading.status.side.buy") : t("trading.status.side.sell")}</span>
                <span className="mono">
                  {fmtDec(o.size, 4)} {o.pair.split("/")[0]} @ {fmtDec(o.price, 4)}
                </span>
                <span className="text-xs text-ink-muted">
                  {o.rule_id ? t("trading.status.rule", { id: o.rule_id }) : ""}
                  {relativeTime(o.placed_at_ms, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Overline>{t("trading.status.lastDecisions")}</Overline>
        {log.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-muted">{logLoading ? t("trading.status.loading") : logHint}</p>
        ) : (
          <ul className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-auto p-0 text-[13px]">
            {log.slice(0, 20).map((e, i) => (
              <li key={`${e.at_ms}-${i}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-2">
                <span className="mono text-xs text-ink-subtle" title={formatTime(e.at_ms)}>
                  {new Date(e.at_ms).toISOString().slice(11, 16)}
                </span>
                <span className="text-xs text-ink-muted uppercase">{e.kind}</span>
                <span className="break-words">
                  {e.rule_id ? <span className="mono text-xs text-ink-muted">[{e.rule_id}] </span> : null}
                  {e.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {status.warnings.map((w, i) => (
        <Callout key={i} accent="warn">
          {w}
        </Callout>
      ))}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-subtle">
        <span>{t("trading.status.lastCheck", { when: status.last_tick_ms ? relativeTime(status.last_tick_ms, now) : t("common.never") })}</span>
        <span>{status.dead_man.cancel_at_ms ? t("trading.status.autoCancel", { when: relativeTime(status.dead_man.cancel_at_ms, now) }) : t("trading.status.noDeadMan")}</span>
        <span className="inline-flex items-center gap-1">
          {t("trading.status.account")} <Hash value={status.hl_account} />
        </span>
      </div>
      <p className="m-0 text-xs text-ink-muted">{t("trading.status.risk")}</p>
    </Card>
  );
}
