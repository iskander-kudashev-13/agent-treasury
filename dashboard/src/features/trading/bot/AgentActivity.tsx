import { intlLocale, useT } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, Pill, Skeleton } from "@/kit";
import { POLL_MS } from "@/lib/config";
import { formatTime } from "@/lib/format";
import { fetchTradingLog } from "@/lib/tradingClient";
import { fmtLocalTime } from "@/lib/tradingMetrics";
import { agentCodeText, agentDecisions, type AgentDecision } from "@/lib/tradingSkips";
import { tradingKeys } from "../useTrading";

/**
 * The agent's note: untrusted text written by the AI agent (or by whoever holds its key). Rendered as a React text child
 * only (escaped): no HTML, no markdown, no links. One line, the full text in the tooltip.
 */
export function AgentNote({ note }: { note: string }) {
  const t = useT();
  return (
    <span className="mt-1 block max-w-[20rem] truncate text-xs text-ink-muted" title={note}>
      {t("trading.agent.noteLabel")} {note}
    </span>
  );
}

function Row({ d }: { d: AgentDecision }) {
  const t = useT();
  const loc = intlLocale();
  return (
    <li className="flex flex-col gap-0.5 border-b border-line py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="whitespace-nowrap text-ink-secondary" title={formatTime(d.at_ms)}>
          {fmtLocalTime(d.at_ms, loc)}
        </span>
        <Pill accent={d.placed ? "ok" : "warn"}>{t(d.placed ? "trading.agent.placed" : "trading.agent.refused")}</Pill>
        {!d.placed && (
          <span className="text-ink-secondary" title={d.code ?? undefined}>
            {agentCodeText(d.code)}
          </span>
        )}
      </div>
      {d.note !== null && <AgentNote note={d.note} />}
    </li>
  );
}

/** ADR-0007 §7: the AI agent's last decisions (placed / refused and why), from the owner-only log of this bot. */
export function AgentActivity({ token, botId }: { token: string; botId: string }) {
  const t = useT();
  const q = useQuery({
    queryKey: [...tradingKeys.all, "agent-log", botId, token],
    queryFn: ({ signal }) => fetchTradingLog(token, 20, signal, botId),
    refetchInterval: POLL_MS * 2,
    retry: false,
  });
  const list = agentDecisions(q.data ?? []);
  return (
    <Card aria-labelledby="bot-agent-activity" className="flex flex-col gap-2">
      <CardHeader id="bot-agent-activity" title={t("trading.agent.activityTitle")} />
      {q.isPending ? (
        <Skeleton className="h-16" />
      ) : q.error ? (
        <p className="m-0 text-sm text-ink-muted">{q.error instanceof Error ? q.error.message : String(q.error)}</p>
      ) : list.length === 0 ? (
        <p className="m-0 text-sm text-ink-muted">{t("trading.agent.activityEmpty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {list.map((d, i) => (
            <Row key={`${d.at_ms}-${i}`} d={d} />
          ))}
        </ul>
      )}
    </Card>
  );
}
