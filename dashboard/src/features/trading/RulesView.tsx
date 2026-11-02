import { Hash } from "@/kit";
import { describeBlocks, type RuleSetV1 } from "@/lib/tradingRules";

/**
 * A rule set in plain English, produced by the dashboard's own renderer from the JSON (never from model text).
 * Everything is rendered as text; React escapes it.
 */
export function RulesView({ rules, hash }: { rules: RuleSetV1; hash?: string }) {
  const b = describeBlocks(rules);
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div>
        <div className="text-[15px] font-semibold break-words">{b.name}</div>
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-ink-secondary">
          {b.summary.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {b.rules.map((r) => (
          <li key={r.title} className="rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5">
            <div className="mono text-xs text-ink-muted break-words">{r.title}</div>
            <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
              {r.lines.map((l) => (
                <li key={l} className="break-words">
                  {l}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {hash && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <span>Hash</span>
          <Hash value={hash} />
        </div>
      )}
    </div>
  );
}
