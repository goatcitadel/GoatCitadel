import type { RefObject } from "react";
import {
  isChatTurnActiveStatus,
  type ChatSessionRecord,
  type ChatThreadTurnRecord,
  type ChatGeneratedArtifactRecord,
} from "@goatcitadel/contracts";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import type { CoworkRunViewModel, CoworkAgenticControlItem } from "../cowork-view-model";
import type {
  MissionThreadedWorkflowPanel,
  MissionThreadedCodeWorkflowPanelProps,
} from "../MissionThreadedControllerHost.types";
import type { useChatDockWorkbenchController } from "./useChatDockWorkbenchController";
import type { useChatSessionControls } from "./useChatSessionControls";

type Input = {
  workspaceId: string;
  selectedSession: ChatSessionRecord | null;
  isCoworkSurface: boolean;
  isCodeSurface: boolean;
  isChatSurface: boolean;
  coworkViewModel: CoworkRunViewModel;
  blockHistoricalMutation: () => boolean;
  handleRetryTurn: (turnId: string) => Promise<void>;
  handleStopActiveTurn: () => Promise<void>;
  onOpenTasks: () => void;
  handleRevealActiveTurnDetails: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  historicalModeActive: boolean;
  handleAgenticControl: (control: CoworkAgenticControlItem) => Promise<void>;
  agenticControlPending: string | null;
  agenticControlStatus: string | null;
  selectedTurn: ChatThreadTurnRecord | null;
  selectedProject: { name: string } | null;
  codeModeNeedsProjectBinding: boolean;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  handleCloseGeneratedArtifact: () => void;
  activeCodeProjects: MissionThreadedCodeWorkflowPanelProps["availableProjects"];
  selectedProjectBindingCandidateId: string | undefined;
  sessionControlPending: ReturnType<typeof useChatSessionControls>["sessionControlPending"];
  handleAssignProject: ReturnType<typeof useChatSessionControls>["handleAssignProject"];
  handleImportCodeProject: ReturnType<typeof useChatSessionControls>["handleImportCodeProject"];
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
  handleRunCodeHelper: (language: string, source: string) => Promise<void>;
  onOpenApprovals: (approvalId?: string) => void;
  workbenchController: ReturnType<typeof useChatDockWorkbenchController>;
};

/** Compose the existing workbench owner into its surface contract; callbacks remain render-local. */
export function createThreadedWorkflowPanel({
  workspaceId,
  selectedSession,
  isCoworkSurface,
  isCodeSurface,
  isChatSurface,
  coworkViewModel,
  blockHistoricalMutation,
  handleRetryTurn,
  handleStopActiveTurn,
  onOpenTasks,
  handleRevealActiveTurnDetails,
  composerRef,
  historicalModeActive,
  handleAgenticControl,
  agenticControlPending,
  agenticControlStatus,
  selectedTurn,
  selectedProject,
  codeModeNeedsProjectBinding,
  activeGeneratedArtifact,
  handleCloseGeneratedArtifact,
  activeCodeProjects,
  selectedProjectBindingCandidateId,
  sessionControlPending,
  handleAssignProject,
  handleImportCodeProject,
  pushLocalNotice,
  handleRunCodeHelper,
  onOpenApprovals,
  workbenchController,
}: Input): MissionThreadedWorkflowPanel {
  const {
    activeWorkflowTurn,
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    selectedWorkbenchFileDiff,
    workbenchDraftContent,
    workbenchExpandedPaths,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchSaving,
    workbenchError,
    hasDirtyWorkbenchDraft,
    workbenchHasRemoteChanges,
    workbenchDraftPaths,
    rebaseWorkbenchDraft,
    setWorkbenchDraftContent,
    setWorkbenchExpandedPaths,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    saveWorkbenchFile,
    previewWorkbenchFileOperation,
    runWorkbenchFileOperation,
    discardWorkbenchDraft,
    runWorkbenchValidationCommand,
    applyWorkbenchPatch,
    exportWorkbenchPatch,
    revertWorkbenchFile,
    revertWorkbenchAll,
    refreshOrchestrationRun,
  } = workbenchController;
  const workflowPanel: MissionThreadedWorkflowPanel =
    selectedSession && isCoworkSurface
      ? {
          kind: "cowork",
          props: {
            viewModel: coworkViewModel,
            onRetryTurn: activeWorkflowTurn
              ? () => {
                  if (!blockHistoricalMutation()) void handleRetryTurn(activeWorkflowTurn.turnId);
                }
              : undefined,
            onStopTurn:
              activeWorkflowTurn && isChatTurnActiveStatus(activeWorkflowTurn.trace.status)
                ? () => void handleStopActiveTurn()
                : undefined,
            onOpenTasks,
            onOpenDetails: () => handleRevealActiveTurnDetails(),
            onFocusComposer: () => composerRef.current?.focus(),
            onRefreshRunState: () => void refreshOrchestrationRun(),
            onAgenticControl: (control) => {
              if (historicalModeActive && control.action !== "cancel") {
                blockHistoricalMutation();
                return;
              }
              void handleAgenticControl(control);
            },
            agenticControlPending,
            agenticControlStatus,
          },
        }
      : // Code capability stays composed inside the canonical Chat surface. The
        // renderer keeps its workbench closed until the operator chooses Build
        // editor; legacy code-mode inputs remain compatible without a second UI.
        selectedSession && (isCodeSurface || isChatSurface)
        ? {
            kind: "code",
            props: {
              workspaceId,
              selectedTurn,
              projectName: selectedProject?.name ?? undefined,
              needsProjectBinding: codeModeNeedsProjectBinding,
              workbenchState,
              workbenchTree,
              selectedFile: selectedWorkbenchFile,
              selectedFileDiff: selectedWorkbenchFileDiff,
              draftContent: workbenchDraftContent,
              expandedPaths: workbenchExpandedPaths,
              diff: workbenchDiff,
              output: workbenchOutput,
              loading: workbenchLoading,
              busy: workbenchBusy,
              saving: workbenchSaving,
              error: workbenchError,
              hasDirtyDraft: hasDirtyWorkbenchDraft,
              hasRemoteChanges: workbenchHasRemoteChanges,
              retainedDraftPaths: workbenchDraftPaths,
              onRebaseDraft: rebaseWorkbenchDraft,
              onSaveDraftForLeave: async () => !blockHistoricalMutation() && (await saveWorkbenchFile()),
              generatedArtifact: activeGeneratedArtifact,
              onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
              availableProjects: activeCodeProjects,
              selectedProjectCandidateId: selectedProjectBindingCandidateId,
              sourceBindingBusy: sessionControlPending === "project" || sessionControlPending === "code_source",
              onBindExistingProject: async (projectId) => {
                if (!blockHistoricalMutation()) await handleAssignProject(projectId);
              },
              onImportProjectSource: async (input) => {
                if (!blockHistoricalMutation()) await handleImportCodeProject(input);
              },
              onCreateWorktree: () => {
                if (!blockHistoricalMutation()) void createWorkbenchWorktree(workbenchState?.baseRef);
              },
              onSelectFile: (relativePath) => void openWorkbenchFile(relativePath),
              onDraftChange: (nextValue) => {
                if (!blockHistoricalMutation()) setWorkbenchDraftContent(nextValue);
              },
              onExpandedPathsChange: (nextPaths) => setWorkbenchExpandedPaths(nextPaths),
              onRefresh: () => void refreshWorkbench(),
              onSaveFile: () => {
                if (!blockHistoricalMutation()) void saveWorkbenchFile();
              },
              onFileOperationPreview: async (input) => {
                if (blockHistoricalMutation()) return null;
                return previewWorkbenchFileOperation(input);
              },
              onFileOperation: async (input) => {
                if (blockHistoricalMutation()) return false;
                return runWorkbenchFileOperation(input);
              },
              onDiscardDraft: () => {
                if (!blockHistoricalMutation()) discardWorkbenchDraft();
              },
              onRunValidationCommand: (input) => {
                if (!blockHistoricalMutation()) void runWorkbenchValidationCommand(input);
              },
              onApplyPatch: (patch) => {
                if (!blockHistoricalMutation()) void applyWorkbenchPatch(patch);
              },
              onExportPatch: async () => {
                const response = await exportWorkbenchPatch();
                if (!response) {
                  return;
                }
                if (typeof window !== "undefined" && response.patch.trim()) {
                  const blob = new Blob([response.patch], { type: "text/x-diff" });
                  const url = window.URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${selectedSession.sessionId}-workbench-${response.generatedAt.replace(/[:.]/g, "-")}.patch`;
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                  window.URL.revokeObjectURL(url);
                }
                pushLocalNotice(
                  `Exported workbench patch for ${response.changedFiles.length} changed file${
                    response.changedFiles.length === 1 ? "" : "s"
                  }.`,
                  "success",
                );
              },
              onRevertFile: (relativePath) => {
                if (!blockHistoricalMutation()) void revertWorkbenchFile(relativePath);
              },
              onRevertAll: () => {
                if (!blockHistoricalMutation()) void revertWorkbenchAll();
              },
              onRunHelperSnippet: async (language, source) => {
                if (!blockHistoricalMutation()) await handleRunCodeHelper(language, source);
              },
              onOpenApprovals,
            },
          }
        : null;

  return workflowPanel;
}
