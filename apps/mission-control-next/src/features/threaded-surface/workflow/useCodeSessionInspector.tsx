import { useMemo } from "react";
import { AgenticRuntimeVisibilityPanel } from "@goatcitadel/mission-control-shared/components/AgenticRuntimeVisibilityPanel";
import {
  formatArtifactPath,
  formatRunPermissionProfile,
  formatSandboxPosture,
  shortId,
  validationStatusTone,
  type WorkbenchPaneId,
} from "./format";
import {
  formatAvailability,
  formatProviderModelSummaryFromTurn,
  type CodePanelType,
  type CodeInspectorSection,
  type CodeInspectorRow,
  type CodeWorkbenchPaneDef,
} from "./code-workbench-model";
import type { useCodeRunLedger } from "./useCodeRunLedger";

export interface CodeWorkbenchBlockedActions {
  validationBlockedReason: string | null;
  applyBlockedReason: string | null;
  exportBlockedReason: string | null;
  selectedRevertBlockedReason: string | null;
  allRevertBlockedReason: string | null;
}
export function useCodeSessionInspector(
  props: CodePanelType["props"],
  ledger: ReturnType<typeof useCodeRunLedger>,
  view: CodeWorkbenchBlockedActions & {
    activePane: WorkbenchPaneId;
    workbenchPaneDefs: ReadonlyArray<CodeWorkbenchPaneDef>;
    changedFiles: string[];
    codeBlocks: unknown[];
  },
) {
  const {
    saving,
    busy,
    loading,
    workbenchState,
    selectedTurn,
    diff,
    onRunValidationCommand,
    onApplyPatch,
    onExportPatch,
    onRevertFile,
    onRevertAll,
    hasDirtyDraft,
    selectedFile,
    projectName,
    workspaceId,
    generatedArtifact,
  } = props;
  const {
    selectedRunSummary,
    selectedRunDetail,
    selectedRunApprovalId,
    runListLoading,
    runListError,
    visibleRunItems,
  } = ledger;
  const {
    activePane,
    workbenchPaneDefs,
    changedFiles,
    codeBlocks,
    validationBlockedReason,
    applyBlockedReason,
    exportBlockedReason,
    selectedRevertBlockedReason,
    allRevertBlockedReason,
  } = view;
  const providerModelSummary = formatProviderModelSummaryFromTurn(selectedTurn);
  const actionStatus = (blockedReason: string | null | undefined, unavailableReason?: string) =>
    formatAvailability(blockedReason, unavailableReason);
  const inspectorSections = useMemo<CodeInspectorSection[]>(() => {
    const activity = saving ? "Saving" : busy ? "Working" : loading ? "Refreshing" : "Idle";
    const validation = workbenchState?.validationStatus ?? "idle";
    const selectedTurnId = selectedTurn?.turnId ? shortId(selectedTurn.turnId) : "no turn selected";
    const latestRun = selectedRunSummary;
    const selectedRun = selectedRunDetail ?? selectedRunSummary;
    const sandboxSummary = selectedRunDetail?.sandbox
      ? formatSandboxPosture(selectedRunDetail.sandbox)
      : "not recorded";
    const permissionProfile = selectedRunDetail ? formatRunPermissionProfile(selectedRunDetail) : "not recorded";
    const changedSummary = diff?.summary
      ? `${diff.summary.changedFiles} files · +${diff.summary.additions} / -${diff.summary.deletions}`
      : `${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`;
    const attachmentsCount =
      (selectedTurn?.userMessage as { attachments?: unknown[] } | undefined)?.attachments?.length ?? 0;
    const knowledgeCount =
      (selectedTurn as { knowledgeAttachments?: unknown[] } | null | undefined)?.knowledgeAttachments?.length ?? 0;
    const actionRows: CodeInspectorRow[] = [
      {
        label: "Test",
        ...actionStatus(validationBlockedReason, !onRunValidationCommand ? "backend unavailable" : undefined),
      },
      { label: "Apply", ...actionStatus(applyBlockedReason, !onApplyPatch ? "backend unavailable" : undefined) },
      { label: "Export", ...actionStatus(exportBlockedReason, !onExportPatch ? "backend unavailable" : undefined) },
      {
        label: "Revert file",
        ...actionStatus(selectedRevertBlockedReason, !onRevertFile ? "backend unavailable" : undefined),
      },
      {
        label: "Revert all",
        ...actionStatus(allRevertBlockedReason, !onRevertAll ? "backend unavailable" : undefined),
      },
      { label: "Commit", value: "Not wired in Build workbench v1", tone: "muted" },
      { label: "Pull request", value: "Not wired in Build workbench v1", tone: "muted" },
    ];

    return [
      {
        id: "progress",
        label: "Progress",
        summary: `${activity} · ${validation}`,
        rows: [
          { label: "Pane", value: workbenchPaneDefs.find((pane) => pane.id === activePane)?.label ?? activePane },
          {
            label: "Validation",
            value: validation,
            tone: validationStatusTone(validation) === "success" ? "good" : "warning",
          },
          {
            label: "Run",
            value: latestRun?.status ?? "no run selected",
            tone: latestRun?.status === "completed" ? "good" : "muted",
          },
          { label: "Selected turn", value: selectedTurnId },
          { label: "Activity", value: activity, tone: activity === "Idle" ? "muted" : "warning" },
        ],
      },
      {
        id: "environment",
        label: "Environment",
        summary: providerModelSummary,
        rows: [
          { label: "Provider/model", value: providerModelSummary },
          { label: "Permission", value: permissionProfile },
          { label: "Sandbox", value: sandboxSummary, title: sandboxSummary },
          { label: "Gateway", value: "session-bound runtime", tone: "muted" },
        ],
      },
      {
        id: "changes",
        label: "Changes",
        summary: changedSummary,
        rows: [
          {
            label: "Changed files",
            value: String(changedFiles.length),
            tone: changedFiles.length > 0 ? "warning" : "muted",
          },
          { label: "Diff summary", value: changedSummary },
          {
            label: "Draft",
            value: hasDirtyDraft ? "Unsaved changes" : "clean",
            tone: hasDirtyDraft ? "warning" : "good",
          },
          { label: "Selected file", value: selectedFile?.path ?? "none" },
        ],
      },
      {
        id: "local",
        label: "Local",
        summary: workbenchState?.worktreeStatus ?? "uninitialized",
        rows: [
          { label: "Project", value: projectName ?? "unbound" },
          { label: "Workspace", value: workspaceId },
          { label: "Base ref", value: workbenchState?.baseRef ?? "not recorded" },
          {
            label: "Worktree",
            value: workbenchState?.worktreePath ?? "not created",
            title: workbenchState?.worktreePath,
          },
        ],
      },
      {
        id: "actions",
        label: "Actions",
        summary: actionRows.some((row) => row.value === "Available") ? "review ready" : "blocked or unavailable",
        rows: actionRows,
      },
      {
        id: "browser",
        label: "Browser",
        summary: generatedArtifact ? "artifact available" : "not connected",
        rows: [
          {
            label: "Preview",
            value: generatedArtifact ? generatedArtifact.title : "No live preview URL in Build workbench v1",
          },
          {
            label: "Browser",
            value: "Use rendered proof outside this panel until browser control is wired",
            tone: "muted",
          },
        ],
      },
      {
        id: "sources",
        label: "Sources",
        summary: selectedFile?.path ?? `${attachmentsCount + knowledgeCount} attached`,
        rows: [
          { label: "Selected file", value: selectedFile?.path ?? "none" },
          { label: "User attachments", value: String(attachmentsCount) },
          { label: "Knowledge", value: String(knowledgeCount) },
          { label: "Snippets", value: String(codeBlocks.length) },
        ],
      },
      {
        id: "ledger",
        label: "Code Mode ledger",
        summary: runListLoading ? "loading" : `${visibleRunItems.length} runs`,
        rows: [
          { label: "Selected run", value: selectedRun?.runId ? shortId(selectedRun.runId) : "none" },
          { label: "Status", value: selectedRun?.status ?? "not recorded" },
          { label: "Approval", value: selectedRunApprovalId ? shortId(selectedRunApprovalId) : "not linked" },
          {
            label: "Artifact",
            value: selectedRunDetail ? formatArtifactPath(selectedRunDetail.codeArtifact) : "not loaded",
          },
        ],
        extra: runListError ? (
          <div className="mc-next-panel-banner warning">{runListError}</div>
        ) : visibleRunItems.length ? (
          <ul className="mc-next-code-session-inspector-run-list">
            {visibleRunItems.slice(0, 5).map((run) => (
              <li key={run.runId}>
                <strong>{shortId(run.runId)}</strong>
                <span>
                  {run.language ?? "Code Mode"} · {run.status ?? "recorded"}
                </span>
              </li>
            ))}
          </ul>
        ) : null,
      },
      {
        id: "runtime",
        label: "Runtime",
        summary: "capabilities",
        rows: [{ label: "Visibility", value: "Expand for retained runtime signals" }],
        extra: (
          <AgenticRuntimeVisibilityPanel surface="code" className="mc-next-code-inspector-runtime" deliveryLimit={3} />
        ),
      },
    ];
  }, [
    activePane,
    allRevertBlockedReason,
    applyBlockedReason,
    busy,
    changedFiles.length,
    codeBlocks.length,
    diff?.summary,
    exportBlockedReason,
    generatedArtifact,
    hasDirtyDraft,
    loading,
    onApplyPatch,
    onExportPatch,
    onRevertAll,
    onRevertFile,
    onRunValidationCommand,
    projectName,
    providerModelSummary,
    runListError,
    runListLoading,
    saving,
    selectedFile?.path,
    selectedRunApprovalId,
    selectedRunDetail,
    selectedRunSummary,
    selectedRevertBlockedReason,
    selectedTurn,
    validationBlockedReason,
    visibleRunItems,
    workbenchPaneDefs,
    workbenchState,
    workspaceId,
  ]);
  return inspectorSections;
}
