import { useT } from "@/i18n";
import { nextOccurrences, shortDate } from "@/lib/frequency";
import { localTimeInput, previewFirst } from "@/lib/scheduleForm";
import type { ScheduleInput } from "@/lib/types";

/** "Next payments: 1 Dec · 1 Jan · 1 Feb", recomputed on every keystroke from the same function the contract rules are tested against. */
export function NextPaymentsPreview({ input, now, paidCount = 0, floor = 0 }: { input: ScheduleInput | null; now: number; paidCount?: number; floor?: number }) {
  const t = useT();
  if (!input) return <p className="m-0 text-[13px] text-ink-subtle">{t("np.fill")}</p>;
  const first = previewFirst(input, now, floor);
  const dates = nextOccurrences({ frequency: input.frequency, start_at: input.start_at, end: input.end, next_due_at: first, paid_count: paidCount }, 3);
  if (dates.length === 0) return <p className="m-0 text-[13px] text-warn">{t("np.none")}</p>;
  const first0 = dates[0] as number;
  const time = t("np.at", { time: localTimeInput(first0), utc: new Date(first0).toISOString().slice(11, 16) });
  return (
    <p className="m-0 text-[13px] text-ink-secondary" aria-live="polite">
      <span className="text-ink-muted">{dates.length === 1 ? t("np.payment") : t("np.next")}</span> <span className="mono">{dates.map(shortDate).join(" · ")}</span> <span className="text-ink-subtle">{t("np.atTime", { time })}</span>
    </p>
  );
}
