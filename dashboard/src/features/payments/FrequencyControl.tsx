import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n";
import { Field, Input, Select } from "@/kit";
import type { FreqKind, ScheduleFormState } from "@/lib/scheduleForm";

// Monday first, like the design.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Recurring frequencies only: one-time payments have their own form ("Pay once"). */
const OPTIONS: Array<{ value: FreqKind; label: MessageKey }> = [
  { value: "Monthly", label: "pay.fMonthly" },
  { value: "Weekly", label: "pay.fWeekly" },
  { value: "EveryNDays", label: "pay.fEveryN" },
];

/** Frequency radio group with the inline parameter of the selected option (UI_UPDATES §4.2). */
export function FrequencyControl({
  value,
  onChange,
  errors,
  disabled,
}: {
  value: ScheduleFormState;
  onChange: (patch: Partial<ScheduleFormState>) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium text-ink-secondary">{t("pay.frequency")}</legend>
      {OPTIONS.map((o) => {
        const on = value.freq === o.value;
        return (
          <div key={o.value} className="flex min-h-10 flex-wrap items-center gap-3">
            <label className="flex w-36 cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="frequency" className="accent-[var(--color-ok)]" checked={on} disabled={disabled} onChange={() => onChange({ freq: o.value })} />
              {t(o.label)}
            </label>
            {on && o.value === "Monthly" && (
              <Field label={t("pay.dayOfMonth")} error={errors.day} hint={t("pay.dayHint")} className="w-44">
                {(a) => <Input {...a} type="number" inputMode="numeric" min={1} max={28} value={value.day} disabled={disabled} state={errors.day ? "error" : "default"} onChange={(e) => onChange({ day: e.target.value })} />}
              </Field>
            )}
            {on && o.value === "Weekly" && (
              <Field label={t("pay.weekdayUtc")} error={errors.weekday} className="w-44">
                {(a) => (
                  <Select {...a} value={value.weekday} disabled={disabled} onChange={(e) => onChange({ weekday: e.target.value })}>
                    {WEEKDAY_ORDER.map((d) => (
                      <option key={d} value={String(d)}>
                        {t(`weekday.${d as 0 | 1 | 2 | 3 | 4 | 5 | 6}` as const)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {on && o.value === "EveryNDays" && (
              <Field label={t("pay.days")} error={errors.everyN} className="w-44">
                {(a) => <Input {...a} type="number" inputMode="numeric" min={1} max={365} value={value.everyN} disabled={disabled} state={errors.everyN ? "error" : "default"} onChange={(e) => onChange({ everyN: e.target.value })} />}
              </Field>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
