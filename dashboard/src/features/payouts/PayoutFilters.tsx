import { STATUS_FILTER_LABEL, type PayoutFilter, type SourceFilter, type StatusFilter } from "@/lib/payoutView";
import type { AgentView } from "@/lib/types";
import { Field, Select } from "@/kit";

/** Status / agent / source filters (UI_UPDATES §5.3, DESIGN_AGENTS §4). */
export function PayoutFilters({ value, onChange, agents }: { value: PayoutFilter; onChange: (f: PayoutFilter) => void; agents: AgentView[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-3">
      <Field label="Status">
        {(a) => (
          <Select {...a} value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as StatusFilter })}>
            {(Object.keys(STATUS_FILTER_LABEL) as StatusFilter[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_FILTER_LABEL[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Agent">
        {(a) => (
          <Select {...a} value={value.agent} onChange={(e) => onChange({ ...value, agent: e.target.value })}>
            <option value="all">All agents</option>
            {agents.map((ag) => (
              <option key={ag.id} value={ag.id}>
                {ag.name}
              </option>
            ))}
            {value.agent !== "all" && !agents.some((ag) => ag.id === value.agent) && <option value={value.agent}>{value.agent}</option>}
          </Select>
        )}
      </Field>
      <Field label="Source">
        {(a) => (
          <Select {...a} value={value.source} onChange={(e) => onChange({ ...value, source: e.target.value as SourceFilter })}>
            <option value="all">All sources</option>
            <option value="scheduled">Scheduled</option>
            <option value="on-demand">On demand</option>
          </Select>
        )}
      </Field>
    </div>
  );
}
