import { RuntimeAutomationPreview } from "./RuntimeAutomationPreview";
import { OpsNeedsAttentionCard } from "./RuntimeOverviewPanels";
import { buildNeedsAttentionItems } from "./runtime-overview-model";
import { formatDateTime } from "./runtime-formatters";
import { ScheduleTimingFields } from "./ScheduleTimingFields";
import { FocusedDetail } from "../shared/FocusedDetail";
import type {
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportResponse,
} from "@goatcitadel/contracts";
import { NativeButton, NoticeBanner } from "../primitives";
import { NativeCard, NativeGrid, NativeList } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import { CRON_ACTION_OPTIONS, type CronActionOption, formatSchedulerReviewItem } from "./runtime-schedule-model";
import type {
  RuntimePanelSetter,
  RuntimeScheduleEditor,
  RuntimeScheduleDraft,
  RuntimeAutomationDraft,
  RuntimeOpenInspection,
} from "./runtime-panel-types";

export function RuntimeSchedulesPanel({
  scheduleEditor,
  scheduleEditorEpoch,
  setScheduleEditor,
  scheduleForm,
  automationForm,
  scheduleNotice,
  navigate,
  data,
  route,
  pendingApprovals,
  openInspection,
  closeScheduleEditor,
  scheduleDraft,
  setScheduleDraft,
  handleCreateSchedule,
  scheduleCreating,
  scheduleCreateLocked,
  automationNotice,
  automationDraft,
  setAutomationDraft,
  handleDraftAutomation,
  automationBusy,
  automationPreview,
  handleExportActivepiecesTemplate,
  automationTemplateExporting,
  handleExportN8nTemplate,
  automationN8nTemplateExporting,
  automationTemplateExport,
  automationN8nTemplateExport,
}: {
  scheduleEditor: RuntimeScheduleEditor;
  scheduleEditorEpoch: { current: number };
  setScheduleEditor: RuntimePanelSetter<RuntimeScheduleEditor>;
  scheduleForm: { isDirty: boolean };
  automationForm: { isDirty: boolean };
  scheduleNotice: { tone: "info" | "success" | "error"; message: string } | null;
  navigate: NativeRoutePagesProps["navigate"];
  data: OpsRuntimeData;
  route: NativeRoutePagesProps["route"];
  pendingApprovals: number;
  openInspection: RuntimeOpenInspection;
  closeScheduleEditor: () => void;
  scheduleDraft: RuntimeScheduleDraft;
  setScheduleDraft: RuntimePanelSetter<RuntimeScheduleDraft>;
  handleCreateSchedule: () => Promise<boolean>;
  scheduleCreating: boolean;
  scheduleCreateLocked: boolean;
  automationNotice: string | null;
  automationDraft: RuntimeAutomationDraft;
  setAutomationDraft: RuntimePanelSetter<RuntimeAutomationDraft>;
  handleDraftAutomation: () => Promise<void>;
  automationBusy: boolean;
  automationPreview: AutomationRecipeDraftResponse | null;
  handleExportActivepiecesTemplate: () => Promise<void>;
  automationTemplateExporting: boolean;
  handleExportN8nTemplate: () => Promise<void>;
  automationN8nTemplateExporting: boolean;
  automationTemplateExport: WorkflowRecipeActivepiecesTemplateExportResponse | null;
  automationN8nTemplateExport: WorkflowRecipeN8nTemplateExportResponse | null;
}) {
  const needsAttentionItems = buildNeedsAttentionItems(data, pendingApprovals, route.theme);

  return (
    <NativeGrid className="mc-next-ops-schedules-grid">
      {scheduleEditor === null ? (
        <>
          <div className="mc-next-runtime-actions">
            <NativeButton
              onClick={() => {
                scheduleEditorEpoch.current += 1;
                setScheduleEditor("create");
              }}
            >
              New schedule{scheduleForm.isDirty ? " · Unsaved" : ""}
            </NativeButton>
            <NativeButton
              variant="outline"
              onClick={() => {
                scheduleEditorEpoch.current += 1;
                setScheduleEditor("designer");
              }}
            >
              Automation Designer{automationForm.isDirty ? " · Unsaved" : ""}
            </NativeButton>
          </div>
          {scheduleNotice ? <NoticeBanner tone={scheduleNotice.tone} message={scheduleNotice.message} /> : null}
          <OpsNeedsAttentionCard items={needsAttentionItems} navigate={navigate} />
          <NativeCard
            title="Scheduled jobs"
            subtitle="Current cadence and next-run posture for scheduled operator work."
            density="compact"
            stats={[
              { label: "Jobs", value: String(data.timeline?.scheduler?.jobs?.length ?? 0) },
              { label: "Review queue", value: String(data.timeline?.scheduler?.reviewQueue?.length ?? 0) },
            ]}
          >
            <NativeList
              items={(data.timeline?.scheduler?.jobs ?? []).map((item) => ({
                title: item.name,
                meta: item.enabled ? "enabled" : "disabled",
                body: [
                  item.action,
                  item.nextRunAt ? formatDateTime(item.nextRunAt) : "No next run",
                  item.lastRunStatus ? `last run ${item.lastRunStatus}` : undefined,
                  item.lastRunEvidenceEnvelopeId ? `evidence ${item.lastRunEvidenceEnvelopeId.slice(0, 8)}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
                actions: (
                  <NativeButton
                    variant="outline"
                    aria-label={`Inspect schedule ${item.name}`}
                    onClick={() => openInspection("schedule", item.jobId)}
                  >
                    Details
                  </NativeButton>
                ),
              }))}
              emptyLabel="No scheduled jobs."
              density="compact"
              maxHeight="min(46vh, 26rem)"
              ariaLabel="Scheduled jobs"
            />
          </NativeCard>
        </>
      ) : null}
      {scheduleEditor === "create" ? (
        <FocusedDetail title="New schedule" onClose={closeScheduleEditor}>
          <NativeCard
            title="Add schedule"
            subtitle="Create a cron-backed job without leaving the schedules route."
            density="compact"
          >
            {scheduleNotice ? <NoticeBanner tone={scheduleNotice.tone} message={scheduleNotice.message} /> : null}
            <div className="mc-next-settings-field-grid">
              <label className="mc-next-settings-field">
                <span>Name</span>
                <input
                  className="mc-next-settings-input"
                  value={scheduleDraft.name}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Daily workspace review"
                />
              </label>
              <ScheduleTimingFields
                value={scheduleDraft.schedule}
                onChange={(schedule) => setScheduleDraft((current) => ({ ...current, schedule }))}
              />
              <label className="mc-next-settings-field span-2">
                <span>Action</span>
                <select
                  className="mc-next-settings-input"
                  aria-label="Schedule action"
                  value={scheduleDraft.action}
                  onChange={(event) =>
                    setScheduleDraft((current) => ({
                      ...current,
                      action: event.target.value as CronActionOption,
                    }))
                  }
                >
                  {CRON_ACTION_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mc-next-runtime-actions">
              <NativeButton
                variant="outline"
                onClick={() => void handleCreateSchedule()}
                disabled={scheduleCreateLocked}
              >
                {scheduleCreating ? "Creating..." : "Create schedule"}
              </NativeButton>
            </div>
          </NativeCard>
        </FocusedDetail>
      ) : null}
      {scheduleEditor === "designer" ? (
        <FocusedDetail title="Automation Designer" onClose={closeScheduleEditor}>
          <NativeCard
            title="Automation Designer"
            subtitle="Draft a reviewable recipe from intent. Schedule intent is previewed, not activated."
            density="compact"
            stats={[
              { label: "Mode", value: "Advisory" },
              { label: "Cron created", value: "No" },
            ]}
          >
            {automationNotice ? <NoticeBanner tone="info" message={automationNotice} /> : null}
            <div className="mc-next-settings-field-grid">
              <label className="mc-next-settings-field span-2">
                <span>Task description</span>
                <textarea
                  className="mc-next-settings-textarea"
                  value={automationDraft.taskDescription}
                  onChange={(event) =>
                    setAutomationDraft((current) => ({ ...current, taskDescription: event.target.value }))
                  }
                  placeholder="Review new provider spend every weekday and prepare a concise operator note."
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Trigger</span>
                <input
                  className="mc-next-settings-input"
                  value={automationDraft.trigger}
                  onChange={(event) => setAutomationDraft((current) => ({ ...current, trigger: event.target.value }))}
                  placeholder="manual review"
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Frequency</span>
                <input
                  className="mc-next-settings-input"
                  value={automationDraft.frequency}
                  onChange={(event) => setAutomationDraft((current) => ({ ...current, frequency: event.target.value }))}
                  placeholder="weekdays at 9"
                />
              </label>
              <label className="mc-next-settings-field span-2">
                <span>Success criteria</span>
                <input
                  className="mc-next-settings-input"
                  value={automationDraft.successCriteria}
                  onChange={(event) =>
                    setAutomationDraft((current) => ({ ...current, successCriteria: event.target.value }))
                  }
                  placeholder="comma-separated criteria"
                />
              </label>
              <label className="mc-next-settings-field span-2">
                <span>Constraints</span>
                <input
                  className="mc-next-settings-input"
                  value={automationDraft.constraints}
                  onChange={(event) =>
                    setAutomationDraft((current) => ({ ...current, constraints: event.target.value }))
                  }
                  placeholder="comma-separated constraints"
                />
              </label>
            </div>
            <div className="mc-next-runtime-actions">
              <NativeButton variant="outline" onClick={() => void handleDraftAutomation()} disabled={automationBusy}>
                {automationBusy ? "Drafting..." : "Preview recipe"}
              </NativeButton>
            </div>
            <RuntimeAutomationPreview
              automationPreview={automationPreview}
              handleExportActivepiecesTemplate={handleExportActivepiecesTemplate}
              automationTemplateExporting={automationTemplateExporting}
              handleExportN8nTemplate={handleExportN8nTemplate}
              automationN8nTemplateExporting={automationN8nTemplateExporting}
              automationTemplateExport={automationTemplateExport}
              automationN8nTemplateExport={automationN8nTemplateExport}
            />
          </NativeCard>
        </FocusedDetail>
      ) : null}
      {scheduleEditor === null ? (
        <NativeCard
          title="Scheduler review"
          subtitle="Review items waiting on schedule, approvals, or follow-on operator attention."
          density="compact"
        >
          <NativeList
            items={(data.timeline?.scheduler?.reviewQueue ?? []).map(formatSchedulerReviewItem)}
            emptyLabel="No scheduler review items."
            density="compact"
            maxHeight="min(38vh, 22rem)"
            ariaLabel="Scheduler review"
          />
        </NativeCard>
      ) : null}
    </NativeGrid>
  );
}
