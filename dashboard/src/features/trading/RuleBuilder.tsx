import { useT } from "@/i18n";
import { Button, Chip, Field, Input, Select, Spinner, Textarea } from "@/kit";
import { AI_ENABLED } from "@/lib/config";
import { COOLDOWNS, EVERIES, WINDOWS, type Cooldown, type Every, type Window } from "@/lib/tradingRules";
import { ruleSentence } from "@/lib/tradingSentences";
import {
  buildRule,
  defaultFields,
  fieldIssues,
  issueMessage,
  MAX_RULES,
  nextRuleId,
  WIZ_TEMPLATES,
  type DraftRule,
  type Issue,
  type TemplateFields,
  type WizTemplate,
} from "@/lib/tradingWizard";
import { Sentence } from "./Sentence";

const TPL_LABEL = { dca: "trading.wiz.tpl.dca", dip: "trading.tpl.dip.label", tp: "trading.tpl.tp.label", sl: "trading.wiz.tpl.sl" } as const;
const cap = (s: string) => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** Number input with a unit and the issue line under it. */
function NumField({ label, hint, value, unit, issue, onChange }: { label: string; hint?: string; value: string; unit: string; issue: Issue | undefined; onChange: (v: string) => void }) {
  return (
    <Field label={label} {...(hint ? { hint } : {})} error={issue ? issueMessage(issue) : null}>
      {(a11y) => <Input {...a11y} mono inputMode="decimal" suffix={unit} value={value} state={issue ? "error" : "default"} onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))} />}
    </Field>
  );
}

function DurSelect<T extends string>({ label, value, options, ctx, onChange }: { label: string; value: T; options: readonly T[]; ctx: "plain" | "every"; onChange: (v: T) => void }) {
  const t = useT();
  return (
    <Field label={label}>
      {(a11y) => (
        <Select {...a11y} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {cap(t(`trading.dur.${ctx}.${o}` as Parameters<typeof t>[0]))}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** The fields of one template. `maxOrder`: the order cap a buy is checked against. */
function TemplateEditor({ fields, maxOrder, onChange }: { fields: TemplateFields; maxOrder: number; onChange: (f: TemplateFields) => void }) {
  const t = useT();
  const is = fieldIssues(fields, maxOrder);
  const f = fields;
  switch (f.kind) {
    case "dca":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label={t("trading.wiz.f.amount")} unit="USDC" value={f.usdc} issue={is.usdc} onChange={(usdc) => onChange({ ...f, usdc })} />
          <DurSelect<Every> label={t("trading.wiz.f.every")} value={f.every} options={EVERIES} ctx="every" onChange={(every) => onChange({ ...f, every })} />
        </div>
      );
    case "dip":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label={t("trading.wiz.f.drop")} unit="%" value={f.dropPct} issue={is.dropPct} onChange={(dropPct) => onChange({ ...f, dropPct })} />
          <DurSelect<Window> label={t("trading.wiz.f.window")} value={f.window} options={WINDOWS} ctx="plain" onChange={(window) => onChange({ ...f, window })} />
          <NumField label={t("trading.wiz.f.amount")} unit="USDC" value={f.usdc} issue={is.usdc} onChange={(usdc) => onChange({ ...f, usdc })} />
          <DurSelect<Cooldown> label={t("trading.wiz.f.cooldown")} value={f.cooldown} options={COOLDOWNS} ctx="plain" onChange={(cooldown) => onChange({ ...f, cooldown })} />
        </div>
      );
    case "tp":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label={t("trading.wiz.f.up")} unit="%" value={f.upPct} issue={is.upPct} onChange={(upPct) => onChange({ ...f, upPct })} />
          <NumField label={t("trading.wiz.f.sell")} hint={t("trading.wiz.f.sellHint")} unit="%" value={f.sellPct} issue={is.sellPct} onChange={(sellPct) => onChange({ ...f, sellPct })} />
          <DurSelect<Cooldown> label={t("trading.wiz.f.cooldown")} value={f.cooldown} options={COOLDOWNS} ctx="plain" onChange={(cooldown) => onChange({ ...f, cooldown })} />
        </div>
      );
    case "sl":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label={t("trading.wiz.f.down")} unit="%" value={f.downPct} issue={is.downPct} onChange={(downPct) => onChange({ ...f, downPct })} />
          <NumField label={t("trading.wiz.f.sell")} hint={t("trading.wiz.f.sellHint")} unit="%" value={f.sellPct} issue={is.sellPct} onChange={(sellPct) => onChange({ ...f, sellPct })} />
        </div>
      );
  }
}

export interface AiState {
  text: string;
  busy: boolean;
  /** One line under the button: the result or the error. */
  note: { kind: "ok" | "error"; text: string } | null;
}

/**
 * Step 2 of `/trading/new`: the rule list, the template chips with their fields, and (when the AI is on) the "own words" box.
 * `editing`: the open template editor (`index` null = a new rule).
 */
export function RuleBuilder({
  rules,
  pair,
  maxOrder,
  editing,
  setEditing,
  onChange,
  ai,
  setAiText,
  onPropose,
}: {
  rules: DraftRule[];
  pair: string;
  maxOrder: number;
  editing: { index: number | null; fields: TemplateFields } | null;
  setEditing: (e: { index: number | null; fields: TemplateFields } | null) => void;
  onChange: (rules: DraftRule[]) => void;
  ai: AiState;
  setAiText: (s: string) => void;
  onPropose: () => void;
}) {
  const t = useT();
  const full = rules.length >= MAX_RULES;
  const draft = editing ? buildRule(editing.fields, pair, "x", maxOrder) : null;

  const save = () => {
    if (!editing || !draft) return;
    const others = rules.filter((_, i) => i !== editing.index).map((d) => d.rule.id);
    const keepId = editing.index !== null ? rules[editing.index]?.rule.id : undefined;
    const id = keepId ?? nextRuleId(editing.fields.kind, others);
    const rule = buildRule(editing.fields, pair, id, maxOrder);
    if (!rule) return;
    const item: DraftRule = { rule, fields: editing.fields };
    onChange(editing.index === null ? [...rules, item] : rules.map((d, i) => (i === editing.index ? item : d)));
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {rules.length === 0 ? (
        <p className="m-0 text-sm text-ink-muted">{t("trading.wiz.rulesEmpty")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {rules.map((d, i) => (
            <li key={d.rule.id} className="flex flex-wrap items-center gap-2 rounded-tile border border-tile-line bg-surface-sunken px-3 py-2.5">
              <p className="m-0 min-w-0 flex-1 text-sm leading-relaxed text-ink-secondary">
                <Sentence segs={ruleSentence({ ...d.rule, pair })} />
              </p>
              {d.fields && (
                <Button size="sm" variant="ghost" disabled={editing !== null} onClick={() => setEditing({ index: i, fields: d.fields! })}>
                  {t("trading.wiz.edit")}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={editing !== null} onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                {t("trading.wiz.remove")}
              </Button>
            </li>
          ))}
        </ol>
      )}

      {editing ? (
        <div className="flex flex-col gap-4 rounded-card border border-line-strong p-4">
          <div className="text-sm font-semibold text-ink">{t(TPL_LABEL[editing.fields.kind])}</div>
          <TemplateEditor fields={editing.fields} maxOrder={maxOrder} onChange={(fields) => setEditing({ ...editing, fields })} />
          {draft && (
            <p className="m-0 text-sm text-ink-secondary">
              <Sentence segs={ruleSentence(draft)} />
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" variant="primary" disabled={!draft} onClick={save}>
              {editing.index === null ? t("trading.wiz.add") : t("common.save")}
            </Button>
          </div>
        </div>
      ) : full ? (
        <p className="m-0 text-xs text-ink-muted">{t("trading.wiz.rulesFull", { n: MAX_RULES })}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-medium text-ink-secondary">{t("trading.wiz.addFromTemplate")}</div>
          <div className="flex flex-wrap gap-2">
            {WIZ_TEMPLATES.map((k: WizTemplate) => (
              <Chip key={k} onClick={() => setEditing({ index: null, fields: defaultFields(k, maxOrder) })}>
                {t(TPL_LABEL[k])}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {AI_ENABLED && !editing && !full && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <Field label={t("trading.wiz.ai.title")}>
            {(a11y) => <Textarea {...a11y} value={ai.text} maxLength={2000} placeholder={t("trading.wiz.ai.placeholder")} disabled={ai.busy} onChange={(e) => setAiText(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="assistant" disabled={ai.busy || ai.text.trim() === ""} onClick={onPropose}>
              {t("trading.wiz.ai.button")}
            </Button>
            {ai.busy && (
              <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                <Spinner size={14} /> {t("trading.wiz.ai.wait")}
              </span>
            )}
            {!ai.busy && ai.note && <span className={ai.note.kind === "error" ? "text-xs text-danger-text" : "text-xs text-ok"}>{ai.note.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
