import { useT } from "@/i18n";
import { Hash } from "@/kit";
import { fireNow, midsOf } from "@/lib/tradingGuide";
import { alwaysSentence, ruleSentences } from "@/lib/tradingSentences";
import { describeBlocks, type RuleSetV1 } from "@/lib/tradingRules";
import { fmtDec } from "@/lib/tradingView";
import { Sentence } from "./Sentence";

/**
 * A rule set in plain words, produced by the dashboard's own renderer from the JSON (never from model text): one sentence per
 * rule with the numbers in bold, then the limits that always apply. The technical lines stay available below.
 * `mids`: mid prices of the pairs the account holds (from the status); they feed the "would it fire right now?" line.
 * Everything is rendered as text; React escapes it.
 */
export function RulesView({ rules, hash, mids }: { rules: RuleSetV1; hash?: string; mids?: Readonly<Record<string, string>> }) {
  const t = useT();
  const b = describeBlocks(rules);
  const sentences = ruleSentences(rules);
  const known = mids ?? midsOf(null);
  const fires = rules.rules.map((r) => (mids ? fireNow(r, known) : null));
  const unknown = mids !== undefined && fires.some((x) => x === null);
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="text-[15px] font-semibold break-words">{rules.name}</div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {sentences.map((s, i) => {
          const now = fires[i] ?? null;
          return (
            <li key={s.id} className="rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5">
              <div className="text-xs text-ink-muted">
                {t("trading.sent.ruleLabel", { n: s.index })} · <span className="mono break-words">{s.id}</span>
              </div>
              <p className="m-0 mt-1 text-sm leading-relaxed text-ink-secondary">
                <Sentence segs={s.segs} />
              </p>
              {now?.kind === "interval" && <p className="m-0 mt-1 text-xs text-ink-muted">{t("trading.now.interval")}</p>}
              {now?.kind === "price" && <p className="m-0 mt-1 text-xs text-ink-muted">{t(now.fires ? "trading.now.priceYes" : "trading.now.priceNo", { pair: now.pair, mid: fmtDec(now.mid, 4) })}</p>}
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-sm leading-relaxed text-ink-secondary">
        <span className="font-semibold text-ink">{t("trading.sent.alwaysLabel")}</span> <Sentence segs={alwaysSentence(rules)} />
      </p>
      {unknown && <p className="m-0 text-xs text-ink-subtle">{t("trading.now.cannot")}</p>}
      <details className="text-xs text-ink-muted">
        <summary className="cursor-pointer">{t("trading.sent.technical")}</summary>
        <ul className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0">
          {b.summary.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {b.rules.map((r) => (
            <li key={r.title}>
              <div className="mono break-words">{r.title}</div>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {r.lines.map((l) => (
                  <li key={l} className="break-words">
                    {l}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </details>
      {hash && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <span>{t("trading.rules.hash")}</span>
          <Hash value={hash} />
        </div>
      )}
    </div>
  );
}
