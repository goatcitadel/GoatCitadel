import { Field } from "../../ui/Field";
import { canonicalJsonString } from "@goatcitadel/contracts";
export const EMPTY_SCHEDULE_SETTINGS = { description: "", endAt: "", workdir: "", contextFrom: "", actionConfig: "" };
export type ScheduleSettingsDraft = typeof EMPTY_SCHEDULE_SETTINGS;
export function scheduleSettingsInput(draft: ScheduleSettingsDraft, action: string, preservedConfig?: Record<string, unknown>) {
  const fields: { description?: string; endAt?: string; workdir?: string; contextFrom?: string; actionConfig?: Record<string, unknown> } = {};
  for (const key of ["description", "endAt", "workdir", "contextFrom"] as const) if (draft[key].trim()) fields[key] = draft[key].trim();
  if (fields.endAt) {
    if (!Number.isFinite(Date.parse(fields.endAt))) throw new Error("End date must be a valid timestamp with timezone.");
    fields.endAt = new Date(fields.endAt).toISOString();
  }
  if (draft.actionConfig.trim()) {
    const parsed: unknown = JSON.parse(draft.actionConfig);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Action configuration must be a JSON object.");
    if (action !== "watchdog") {
      if (!["no_agent", "agent_turn"].includes(action)) throw new Error(`${action} does not support action configuration. Clear this field before saving; no request has been sent.`);
      if (!preservedConfig || canonicalJsonString(preservedConfig) !== canonicalJsonString(parsed)) throw new Error("This native editor preserves existing no_agent/agent_turn configuration. Changed configuration requires its full governed action owner; no request has been sent.");
    } else {
      const config = parsed as Record<string, unknown>;
      const watchdog = config.watchdog as Record<string, unknown> | undefined;
      if (Object.keys(config).length !== 1 || !watchdog || typeof watchdog !== "object" || Array.isArray(watchdog) || Object.keys(watchdog).length !== 3 || typeof watchdog.checkId !== "string" || !["runtime_health", "durable_dead_letters", "channel_delivery_queue", "mcp_posture"].includes(watchdog.checkId) || typeof watchdog.severityThreshold !== "string" || !["warning", "error"].includes(watchdog.severityThreshold) || typeof watchdog.notifyHomeChannel !== "boolean") throw new Error("Watchdog configuration must contain exactly watchdog.checkId, severityThreshold (warning/error), and notifyHomeChannel (true/false). Unsupported values are not silently dropped.");
    }
    fields.actionConfig = parsed as Record<string, unknown>;
  }
  return fields;
}
export function ScheduleAdvancedFields({ value, locked, onChange }: { value: ScheduleSettingsDraft; locked: boolean; onChange: (key: keyof ScheduleSettingsDraft, value: string) => void }) {
  const labels = { description: "Schedule description", endAt: "End date (ISO timestamp with timezone)", workdir: "Working directory", contextFrom: "Context source", actionConfig: "Action configuration (JSON object)" };
  return <details className="rounded-md border border-line p-3"><summary className="cursor-pointer text-sm font-medium text-accent">Advanced job settings</summary><p className="mt-2 text-sm text-fg-secondary">Optional Gateway-supported configuration. No credentials belong here. Paths, capabilities and approvals remain Gateway-governed. Task and other basic actions do not support action configuration. Watchdog accepts a canonical watchdog object with checkId, severityThreshold and notifyHomeChannel; existing no_agent/agent_turn configuration is preserved when unchanged.</p><div className="mt-3 grid gap-3">{(Object.keys(labels) as (keyof typeof labels)[]).map(key => <Field key={key} label={labels[key]}>{props => key === "actionConfig" ? <textarea {...props} rows={3} value={value[key]} disabled={locked} onChange={event => onChange(key, event.target.value)} className="w-full rounded-md border border-line bg-sunken p-2 text-fg" /> : <input {...props} value={value[key]} disabled={locked} onChange={event => onChange(key, event.target.value)} className="w-full rounded-md border border-line bg-sunken p-2 text-fg" />}</Field>)}</div></details>;
}
