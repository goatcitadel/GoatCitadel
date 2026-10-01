import { formatShortRunId, formatOptionalUsd } from "./runtime-formatters";
import type {
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportResponse,
} from "@goatcitadel/contracts";
import { NativeMetricGrid as MetricGrid, StatusChip } from "../primitives";
import { NativeList } from "../NativeRoutePageLayout";
import { formatWorkflowTemplateExportProofItems } from "./runtime-schedule-model";

export function RuntimeAutomationPreview({
  automationPreview,
  handleExportActivepiecesTemplate,
  automationTemplateExporting,
  handleExportN8nTemplate,
  automationN8nTemplateExporting,
  automationTemplateExport,
  automationN8nTemplateExport,
}: {
  automationPreview: AutomationRecipeDraftResponse | null;
  handleExportActivepiecesTemplate: () => Promise<void>;
  automationTemplateExporting: boolean;
  handleExportN8nTemplate: () => Promise<void>;
  automationN8nTemplateExporting: boolean;
  automationTemplateExport: WorkflowRecipeActivepiecesTemplateExportResponse | null;
  automationN8nTemplateExport: WorkflowRecipeN8nTemplateExportResponse | null;
}) {
  return automationPreview ? (
    <div className="mc-next-settings-code-block">
      <span>{automationPreview.recipe.name}</span>
      <p>{automationPreview.recipe.goal}</p>
      <ul className="mc-next-approvals-compact-list">
        {automationPreview.proofChecklist.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <MetricGrid
        items={[
          {
            label: "Plan",
            value: formatShortRunId(automationPreview.plan.planId),
            meta: "Reviewable orchestration plan",
          },
          {
            label: "Schedule intent",
            value: automationPreview.recipe.scheduleIntent ?? "none",
            meta: "Preview only; no cron job created",
          },
          {
            label: "Limits",
            value: `${automationPreview.estimatedLimits.maxRuntimeMinutes}m`,
            meta: `${automationPreview.estimatedLimits.maxIterations} iterations · ${formatOptionalUsd(
              automationPreview.estimatedLimits.maxCostUsd,
            )}`,
          },
        ]}
      />
      <div className="mc-next-runtime-actions">
        <button
          type="button"
          className="mc-next-directory-action"
          onClick={() => void handleExportActivepiecesTemplate()}
          disabled={automationTemplateExporting}
        >
          <span>{automationTemplateExporting ? "Exporting..." : "Copy Activepieces template"}</span>
        </button>
        <button
          type="button"
          className="mc-next-directory-action"
          onClick={() => void handleExportN8nTemplate()}
          disabled={automationN8nTemplateExporting}
        >
          <span>{automationN8nTemplateExporting ? "Exporting..." : "Copy n8n template"}</span>
        </button>
      </div>
      {automationTemplateExport || automationN8nTemplateExport ? (
        <div className="mc-next-approvals-chip-row">
          <StatusChip tone="success">Read-only export</StatusChip>
          {automationTemplateExport ? (
            <StatusChip
              tone={
                automationTemplateExport.validation.status === "blocked"
                  ? "critical"
                  : automationTemplateExport.validation.checks.some((check) => check.status === "warning")
                    ? "warning"
                    : "success"
              }
            >
              Activepieces {automationTemplateExport.validation.status}
            </StatusChip>
          ) : null}
          {automationN8nTemplateExport ? (
            <StatusChip
              tone={
                automationN8nTemplateExport.validation.status === "blocked"
                  ? "critical"
                  : automationN8nTemplateExport.validation.checks.some((check) => check.status === "warning")
                    ? "warning"
                    : "success"
              }
            >
              n8n {automationN8nTemplateExport.validation.status}
            </StatusChip>
          ) : null}
          <StatusChip tone="muted">No webhook trigger</StatusChip>
          <StatusChip tone="warning">Operator import required</StatusChip>
          {automationTemplateExport ? (
            <StatusChip tone="warning">
              Activepieces native import{" "}
              {automationTemplateExport.validation.nativeImportCompatibility.replace("_", " ")}
            </StatusChip>
          ) : null}
          {automationN8nTemplateExport ? (
            <StatusChip tone="warning">
              n8n native import {automationN8nTemplateExport.validation.nativeImportCompatibility.replace("_", " ")}
            </StatusChip>
          ) : null}
        </div>
      ) : null}
      {automationTemplateExport || automationN8nTemplateExport ? (
        <NativeList
          density="compact"
          items={[
            ...formatWorkflowTemplateExportProofItems("Activepieces", automationTemplateExport),
            ...formatWorkflowTemplateExportProofItems("n8n", automationN8nTemplateExport),
          ]}
          emptyLabel="No template export proof has been copied yet."
          ariaLabel="Automation template export proof"
        />
      ) : null}
    </div>
  ) : null;
}
