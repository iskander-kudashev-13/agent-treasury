import { useT } from "@/i18n";
import { STATUS_FILTER_LABEL_KEY, type PayoutFilter, type SourceFilter, type StatusFilter } from "@/lib/payoutView";
import type { AgentView } from "@/lib/types";
import { Field, Select } from "@/kit";

/** Status / agent / source filters (UI_UPDATES §5.3, DESIGN_AGENTS §4). */
export function PayoutFilters({ value, onChange, agents }: { value: PayoutFilter; onChange: (f: PayoutFilter) => void; agents: AgentView[] }) {
  const t = useT();
  return (
    <div className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-3">
      <Field label={t("po.filterStatus")}>
        {(a) => (
          <Select {...a} value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as StatusFilter })}>
            {(Object.keys(STATUS_FILTER_LABEL_KEY) as StatusFilter[]).map((k) => (
              <option key={k} value={k}>
                {t(STATUS_FILTER_LABEL_KEY[k])}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t("po.filterAgent")}>
        {(a) => (
          <Select {...a} value={value.agent} onChange={(e) => onChange({ ...value, agent: e.target.value })}>
            <option value="all">{t("po.allAgents")}</option>
            {agents.map((ag) => (
              <option key={ag.id} value={ag.id}>
                {ag.name}
              </option>
            ))}
            {value.agent !== "all" && !agents.some((ag) => ag.id === value.agent) && <option value={value.agent}>{value.agent}</option>}
          </Select>
        )}
      </Field>
      <Field label={t("po.filterSource")}>
        {(a) => (
          <Select {...a} value={value.source} onChange={(e) => onChange({ ...value, source: e.target.value as SourceFilter })}>
            <option value="all">{t("po.allSources")}</option>
            <option value="scheduled">{t("po.sScheduled")}</option>
            <option value="on-demand">{t("po.sOnDemand")}</option>
          </Select>
        )}
      </Field>
    </div>
  );
}
