import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { Icons, Table, Td, Th, Tr } from "@/kit";
import type { DataKind } from "@/lib/assistantClient";
import { parseNumber, parseTable, parseUpcoming, SOURCE_ROUTE } from "./model";

const box = "rounded-tile border border-line bg-surface p-3";

/** Compact visuals inside an answer (UI_UPDATES §6.4): table (<= 5 rows), one number, upcoming list. All values are plain text. */
export function DataView({ kind, payload }: { kind: DataKind; payload: unknown }) {
  const tr = useT();
  if (kind === "table") {
    const t = parseTable(payload);
    if (!t) return null;
    return (
      <div className={box}>
        {t.title && <div className="mb-2 text-xs text-ink-muted">{t.title}</div>}
        <Table>
          <thead>
            <tr>
              {t.columns.map((c, i) => (
                <Th key={i} className="px-2 py-1.5">
                  {c}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <Tr key={i}>
                {t.columns.map((_, j) => (
                  <Td key={j} className="px-2 py-1.5">
                    {r[j] ?? ""}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    );
  }
  if (kind === "number") {
    const n = parseNumber(payload);
    if (!n) return null;
    const body = (
      <>
        <span className="mono text-2xl font-semibold">{n.value}</span>
        {n.unit && <span className="ml-1.5 text-xs text-ink-muted">{n.unit}</span>}
      </>
    );
    return (
      <div className={box}>
        <div className="text-xs text-ink-muted">{n.label}</div>
        <div className="mt-0.5">{n.source ? <Link to={SOURCE_ROUTE[n.source]}>{body}</Link> : body}</div>
        {n.delta && <div className="mt-0.5 text-xs text-ink-secondary">{n.delta}</div>}
      </div>
    );
  }
  const u = parseUpcoming(payload);
  if (!u) return null;
  return (
    <div className={box}>
      <div className="mb-2 flex items-baseline justify-between gap-2 text-xs text-ink-muted">
        <span>{tr("as.upcoming")}</span>
        <Link to={SOURCE_ROUTE.upcoming} className="mono text-[13px]">
          {u.total} USDC
        </Link>
      </div>
      {u.items.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-muted">{tr("as.noneInWindow")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
          {u.items.slice(0, 8).map((i, k) => (
            <li key={k} className="flex flex-wrap items-baseline gap-x-2">
              <span className="mono text-ink-muted">{i.due.slice(0, 10)}</span>
              <span className="min-w-0 flex-1 truncate">{i.label}</span>
              <span className="mono">{i.amount}</span>
              {i.approval && <span className="text-xs text-warn">{tr("as.needsApproval")}</span>}
            </li>
          ))}
          {u.items.length > 8 && <li className="text-xs text-ink-subtle">{tr("as.andMore", { n: u.items.length - 8 })}</li>}
        </ul>
      )}
      {u.shortfall && (
        <p className="m-0 mt-2 flex items-start gap-1.5 text-xs text-warn">
          <Icons.AlertTriangle size={13} className="mt-px shrink-0" />
          {tr("as.shortBy", { balance: u.balance, short: u.shortfall })}
        </p>
      )}
      {u.overLimit.map((d, k) => (
        <p key={k} className="m-0 mt-1 text-xs text-warn">
          {tr("as.overLimit", { date: d.date, total: d.total })}
        </p>
      ))}
    </div>
  );
}
