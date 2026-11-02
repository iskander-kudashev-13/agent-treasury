import { useT } from "@/i18n";
import { Link } from "react-router-dom";
import { Button, Callout, Chip, Icons } from "@/kit";
import { AI_ENABLED } from "@/lib/config";
import { baseOfPair, buildExamples, buildTemplates, MIN_ORDER_USDC, type HardLimits } from "@/lib/tradingGuide";
import { useAssistantPanel } from "@/features/layout/AssistantContext";

const CAN = ["coin", "when", "do", "often", "limits", "count"] as const;
const CANT = ["perps", "indicators", "times", "size", "caps", "money", "manual"] as const;

/**
 * Compact rules help for the Trading page: template chips in one row (they fill the assistant's input) and a link to the full
 * guide. Sizes and the pair come from the worker's limits, so every template stays inside them.
 */
export function RulesHelp({ pair, hard }: { pair: string; hard: HardLimits }) {
  const t = useT();
  const { openWith } = useAssistantPanel();
  const templates = buildTemplates(pair, hard);
  return (
    <div id="trading-rules-help" className="flex flex-col gap-2">
      {!AI_ENABLED && <Callout accent="neutral">{t("trading.rules.aiOff")}</Callout>}
      {templates ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-muted">{t("trading.help.templatesShort")}</span>
          {templates.map((x) => (
            <Chip key={x.id} icon={<Icons.Sparkles size={13} />} onClick={AI_ENABLED ? () => openWith(x.prompt) : undefined}>
              {x.label}
            </Chip>
          ))}
        </div>
      ) : (
        <Callout accent="warn">{t("trading.help.capsTooLow", { min: MIN_ORDER_USDC })}</Callout>
      )}
      <Link to="/trading/guide#rules" className="text-sm">{t("trading.guide.linkRules")} →</Link>
    </div>
  );
}

/**
 * The full "how to write rules" content (the "#rules" section of the guide page): template chips and example prompts that fill the assistant input (the owner edits the numbers, reads the
 * rules the dashboard renders back, then signs), plus what the bot can and cannot be told. Sizes and the pair come from the
 * worker's limits, so every example stays inside them.
 */
export function RulesGuide({ pair, hard }: { pair: string; hard: HardLimits }) {
  const t = useT();
  const { openWith } = useAssistantPanel();
  const templates = buildTemplates(pair, hard);
  const examples = buildExamples(pair, hard);
  const base = baseOfPair(pair);
  return (
    <div className="flex flex-col gap-4">
      {!AI_ENABLED && <Callout accent="neutral">{t("trading.rules.aiOff")}</Callout>}
      <p className="m-0 text-sm text-ink-secondary">{t("trading.help.how")}</p>

      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-ink-muted">{t("trading.help.templates", { pair })}</div>
        {templates ? (
          <div className="flex flex-wrap gap-2">
            {templates.map((x) => (
              <Chip key={x.id} icon={<Icons.Sparkles size={13} />} onClick={AI_ENABLED ? () => openWith(x.prompt) : undefined}>
                {x.label}
              </Chip>
            ))}
          </div>
        ) : (
          <Callout accent="warn">{t("trading.help.capsTooLow", { min: MIN_ORDER_USDC })}</Callout>
        )}
      </div>

      {examples && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-ink-muted">{t("trading.help.examples")}</div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {examples.map((ex) => (
              <li key={ex} className="flex items-start gap-2 text-[13px] text-ink-secondary">
                <span className="grow">“{ex}”</span>
                {AI_ENABLED && (
                  <Button size="sm" variant="ghost" onClick={() => openWith(ex)}>
                    {t("trading.help.use")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="m-0 text-xs text-ink-muted">{t("trading.help.size", { min: MIN_ORDER_USDC, max: hard.maxOrder, pos: hard.maxPosition })}</p>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5">
          <h4 className="m-0 mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-ok">
            <Icons.Check size={14} strokeWidth={3} /> {t("trading.help.canTitle")}
          </h4>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-secondary">
            {CAN.map((k) => (
              <li key={k}>{t(`trading.help.can.${k}`, { base, pair, order: hard.maxOrder, pos: hard.maxPosition, loss: hard.lossStop })}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5">
          <h4 className="m-0 mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-danger-text">
            <Icons.X size={14} /> {t("trading.help.cantTitle")}
          </h4>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-secondary">
            {CANT.map((k) => (
              <li key={k}>{t(`trading.help.cant.${k}`, { base, pair, min: MIN_ORDER_USDC, order: hard.maxOrder, pos: hard.maxPosition, loss: hard.lossStop })}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
