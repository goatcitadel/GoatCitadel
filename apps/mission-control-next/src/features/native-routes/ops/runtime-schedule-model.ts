import { formatDateTime, formatShortRunId } from "./runtime-formatters";
import type {
  CronReviewItem,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportResponse,
} from "@goatcitadel/contracts";

export const CRON_ACTION_OPTIONS = [
  "task",
  "improvement",
  "backup",
  "memory_flush",
  "cost_report",
  "update_review",
  "watchdog",
] as const;
export type CronActionOption = (typeof CRON_ACTION_OPTIONS)[number];

export function formatWorkflowTemplateExportProofItems(
  label: string,
  exportResult: WorkflowRecipeActivepiecesTemplateExportResponse | WorkflowRecipeN8nTemplateExportResponse | null,
): Array<{ title: string; meta?: string; body?: string }> {
  if (!exportResult) {
    return [];
  }
  const warningChecks = exportResult.validation.checks.filter((check) => check.status !== "passed");
  return [
    {
      title: `${label} copied artifact`,
      meta: `${exportResult.contentType} · ${formatShortRunId(exportResult.contentSha256)}`,
      body: `${exportResult.filename} · plan ${exportResult.evidence.planId} · ${exportResult.evidence.status}`,
    },
    {
      title: `${label} validation`,
      meta: `${exportResult.validation.status} · native import ${exportResult.validation.nativeImportCompatibility.replace(
        "_",
        " ",
      )}`,
      body:
        warningChecks.map((check) => `${check.label}: ${check.detail}`).join(" · ") ||
        "All validation checks passed for operator import review.",
    },
    {
      title: `${label} next action`,
      meta: exportResult.posture.execution,
      body: exportResult.evidence.actionNeeded,
    },
  ];
}

export function formatSchedulerReviewItem(item: CronReviewItem): { title: string; meta?: string; body?: string } {
  const summary = item.summary ?? {};
  const trigger = readSummaryString(summary.trigger);
  const childDurableRunId = readSummaryString(summary.childDurableRunId) ?? readSummaryString(summary.durableRunId);
  const childStatus = readSummaryString(summary.childDurableStatus);
  const childTurnId = readSummaryString(summary.childTurnId) ?? readSummaryString(summary.turnId);
  const profilePosture = readSummaryString(summary.profilePosture);
  const warning = readSummaryString(summary.warning) ?? readSummaryString(summary.profileWarning);
  const body = [
    `Cron ${item.status} · ${formatDateTime(item.updatedAt)}`,
    childDurableRunId
      ? `Child ${childStatus ?? "accepted"} · ${formatShortRunId(childDurableRunId)}${
          childTurnId ? ` · ${formatShortRunId(childTurnId)}` : ""
        }`
      : undefined,
    profilePosture ? `Profile ${profilePosture.replace(/_/g, " ")}` : undefined,
    warning,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return {
    title: trigger ? `${item.jobId} · ${trigger.replace(/_/g, " ")}` : item.jobId,
    meta: `${item.severity} · cron ${formatShortRunId(item.runId)}`,
    body,
  };
}

function readSummaryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function optionalDraftText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function splitDraftList(value: string): string[] | undefined {
  const items = value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : undefined;
}
