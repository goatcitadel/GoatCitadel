import { CodeWorkbenchToolbar } from "./CodeWorkbenchToolbar";
import { CodeWorkbenchRunLog } from "./CodeWorkbenchRunLog";
import { CodeWorkbenchEditorPanes } from "./CodeWorkbenchEditorPanes";
import { useCodeWorkbenchReviewPacket } from "./useCodeWorkbenchReviewPacket";
import { useCodeSessionInspector } from "./useCodeSessionInspector";
import {
  type CodePanelType,
  CODE_WORKBENCH_LAYOUT_STORAGE_KEY,
  CODE_WORKBENCH_INSPECTOR_STORAGE_KEY,
  EMPTY_CHANGED_FILES,
  readStoredFilePanePercent,
  type CodeInspectorSectionId,
  readStoredInspectorSections,
  type CodeWorkbenchPaneDef,
  buildWorkbenchPaneDefs,
} from "./code-workbench-model";
import { CodeSourceChooser } from "./CodeSourceChooser";
import { CodeSessionInspector } from "./CodeSessionInspector";
import { useCodeRunLedger } from "./useCodeRunLedger";
import { useCodeRunArtifacts } from "./useCodeRunArtifacts";
export { summarizeCapabilitySnapshotProfile } from "./code-workbench-evidence";
export type { CapabilitySnapshotProfileSummary } from "./code-workbench-evidence";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { DetailInspector } from "../../../components/DetailInspector";
import { useDraftLeave } from "../../native-routes/library/DraftLeaveDialog";
import { useFormDirty } from "../../native-routes/library/use-form-dirty";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";

import { useOptionalStableHandler, useStableHandler } from "../useStableHandler";
import { WorkbenchFileActionForm } from "./WorkbenchFileActionForm";
import { WorkbenchFilePicker } from "./WorkbenchFilePicker";
import { DEFAULT_VALIDATION_COMMAND } from "./WorkbenchValidationControls";
import { WorkbenchFileTree } from "@goatcitadel/mission-control-shared/components/WorkbenchFileTree";
import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { getValidationCommandPresets, type WorkbenchPaneId, extractCodeBlocks, isPendingPatchBlock } from "./format";

export function NextCodeWorkbenchPanel({ panel }: { panel: CodePanelType }) {
  const {
    selectedTurn,
    needsProjectBinding,
    workbenchState,
    workbenchTree,
    selectedFile,
    selectedFileDiff,
    draftContent,
    expandedPaths,
    diff,
    output,
    loading,
    busy,
    saving,
    error,
    hasDirtyDraft,
    generatedArtifact,
    onCloseGeneratedArtifact,
    availableProjects,
    selectedProjectCandidateId,
    sourceBindingBusy,
    onBindExistingProject,
    onImportProjectSource,
    onSelectFile,
    onExpandedPathsChange,
    onRefresh,
    onSaveFile,
    onFileOperationPreview,
    onFileOperation,
    onDiscardDraft,
    onRunValidationCommand,
    onRevertFile,
    onRevertAll,
    onOpenApprovals,
  } = panel.props;
  const codeBlocks = useMemo(
    () => extractCodeBlocks(selectedTurn?.assistantMessage?.content ?? ""),
    [selectedTurn?.assistantMessage?.content],
  );
  const readyForRepoOps = workbenchState?.worktreeStatus === "ready";
  const compactWorkbench = useMediaQuery("(max-width: 639px)");
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const changedFiles = workbenchTree?.changedFiles ?? diff?.changedFiles ?? EMPTY_CHANGED_FILES;
  const validationPresets = useMemo(
    () => getValidationCommandPresets(workbenchState?.packageManager),
    [workbenchState?.packageManager],
  );
  const [activePane, setActivePane] = useState<WorkbenchPaneId>("files");
  /*
   * Keep-alive for tab panes: a pane mounts on first visit and then stays
   * mounted (hidden) so its Monaco editors keep their instances, view state,
   * and scroll position across tab switches instead of cold-remounting.
   */
  const visitedPanesRef = useRef<Set<WorkbenchPaneId>>(new Set());
  visitedPanesRef.current.add(activePane);
  const paneMounted = (paneId: WorkbenchPaneId) => visitedPanesRef.current.has(paneId);
  const workbenchTabIdPrefix = useId();
  const workbenchDisclosureIdPrefix = useId();
  const inspectorDrawerId = `${workbenchDisclosureIdPrefix}-inspector-drawer`;
  const moreMenuId = `${workbenchDisclosureIdPrefix}-more-actions`;
  const workbenchTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const workbenchPaneDefs = useMemo(() => buildWorkbenchPaneDefs(Boolean(generatedArtifact)), [generatedArtifact]);
  const activeWorkbenchTabIndex = workbenchPaneDefs.findIndex((pane) => pane.id === activePane);
  const focusWorkbenchTabAt = useCallback((index: number, panes: ReadonlyArray<CodeWorkbenchPaneDef>) => {
    if (panes.length === 0) {
      return;
    }
    const wrapped = ((index % panes.length) + panes.length) % panes.length;
    const nextPane = panes[wrapped];
    if (!nextPane) {
      return;
    }
    setActivePane(nextPane.id);
    queueMicrotask(() => {
      workbenchTabRefs.current[wrapped]?.focus();
    });
  }, []);
  const handleWorkbenchTabKeyDown = useCallback(
    (index: number, panes: ReadonlyArray<CodeWorkbenchPaneDef>) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          focusWorkbenchTabAt(index + 1, panes);
          break;
        case "ArrowLeft":
          event.preventDefault();
          focusWorkbenchTabAt(index - 1, panes);
          break;
        case "Home":
          event.preventDefault();
          focusWorkbenchTabAt(0, panes);
          break;
        case "End":
          event.preventDefault();
          focusWorkbenchTabAt(panes.length - 1, panes);
          break;
        default:
          break;
      }
    },
    [focusWorkbenchTabAt],
  );
  const buildWorkbenchTabId = (paneId: WorkbenchPaneId) => `${workbenchTabIdPrefix}-workbench-tab-${paneId}`;
  const buildWorkbenchPanelId = (paneId: WorkbenchPaneId) => `${workbenchTabIdPrefix}-workbench-panel-${paneId}`;
  const [newArtifactPending, setNewArtifactPending] = useState(false);
  const prevTurnIdRef = useRef<string | null>(null);
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const validationCommandRef = useRef(DEFAULT_VALIDATION_COMMAND);
  const handleValidationCommandChange = useCallback((commandLine: string) => {
    validationCommandRef.current = commandLine;
  }, []);
  const [filePanePercent, setFilePanePercent] = useState(readStoredFilePanePercent);
  const fileLeave = useDraftLeave();
  const editorDraftKey = "chat-workbench:" + JSON.stringify([workbenchState?.sessionId, selectedFile?.path]);
  useFormDirty(editorDraftKey, hasDirtyDraft, {
    label: selectedFile?.path ?? "Build editor",
    keepDraft: true,
    onSave: panel.props.onSaveDraftForLeave,
    onDiscard: onDiscardDraft,
  });
  const [confirmRevertFilePath, setConfirmRevertFilePath] = useState<string | null>(null);
  const [confirmRevertAllOpen, setConfirmRevertAllOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [diffViewMode, setDiffViewMode] = useState<"side-by-side" | "unified">("side-by-side");
  const [runLogViewMode, setRunLogViewMode] = useState<"rendered" | "raw">("rendered");
  const [runLogCleared, setRunLogCleared] = useState(false);
  const [runLogCopyNotice, setRunLogCopyNotice] = useState<string | null>(null);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const closeInspectorDrawer = useCallback(() => {
    setInspectorDrawerOpen(false);
  }, []);
  const [expandedInspectorSections, setExpandedInspectorSections] = useState(readStoredInspectorSections);
  const stableOnFileOperationPreview = useOptionalStableHandler(onFileOperationPreview);
  const stableOnFileOperation = useOptionalStableHandler(onFileOperation);
  const hasPatchDiff = Boolean(diff?.diff.trim());
  const activeBlock = codeBlocks[activeBlockIndex] ?? null;
  const activePatchBlock = activeBlock && isPendingPatchBlock(activeBlock) ? activeBlock : null;
  const ledger = useCodeRunLedger(panel.props);
  const isMounted = ledger.isMounted;
  const { visibleRunItems, visibleRunIds, selectedRunDetail, selectedRunApprovalId, handleRunHelperSnippet } = ledger;
  const artifacts = useCodeRunArtifacts(ledger);

  const reviewPacket = useCodeWorkbenchReviewPacket(panel.props, ledger, changedFiles, readyForRepoOps);
  const draftConflictReason = hasDirtyDraft ? "Save or discard the file draft before running repo operations." : null;
  const worktreeBlockedReason = !readyForRepoOps ? "Create a ready worktree before running repo operations." : null;
  const applyBlockedReason =
    worktreeBlockedReason ??
    draftConflictReason ??
    (!activePatchBlock
      ? "Apply requires a separate pending patch. Select a diff or patch snippet before applying it."
      : null);
  const exportBlockedReason =
    worktreeBlockedReason ?? draftConflictReason ?? (!hasPatchDiff ? "No worktree diff is ready to export." : null);
  const validationBlockedReason = worktreeBlockedReason ?? draftConflictReason;
  const selectedRevertBlockedReason =
    worktreeBlockedReason ??
    draftConflictReason ??
    (!selectedFile ? "Select a changed file before reverting it." : null) ??
    (!selectedFile?.changed ? "The selected file has no worktree changes." : null);
  const allRevertBlockedReason =
    worktreeBlockedReason ??
    draftConflictReason ??
    (changedFiles.length === 0 ? "No worktree changes to revert." : null);
  const workbenchFileItems = useMemo(
    () => (workbenchTree?.items ?? []).filter((item) => item.kind === "file"),
    [workbenchTree?.items],
  );
  const runLogText = [
    output?.output,
    ...visibleRunItems.flatMap((run) => [run.stdoutPreview, run.stderrPreview]),
    selectedRunDetail?.stdoutPreview,
    selectedRunDetail?.stderrPreview,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  const workbenchBodyStyle = {
    "--mc-code-file-pane": `${filePanePercent}%`,
  } as CSSProperties;
  const blockedActions = {
    validationBlockedReason,
    applyBlockedReason,
    exportBlockedReason,
    selectedRevertBlockedReason,
    allRevertBlockedReason,
  };
  const inspectorSections = useCodeSessionInspector(panel.props, ledger, {
    ...blockedActions,
    activePane,
    workbenchPaneDefs,
    changedFiles,
    codeBlocks,
  });
  const handleToggleInspectorSection = useCallback((sectionId: CodeInspectorSectionId, open: boolean) => {
    setExpandedInspectorSections((current) => {
      const next = new Set(current);
      if (open) {
        next.add(sectionId);
      } else {
        next.delete(sectionId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setActiveBlockIndex(0);
  }, [codeBlocks.length, selectedTurn?.turnId]);

  useEffect(() => {
    if (!moreMenuOpen || typeof document === "undefined") {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreMenuOpen]);

  useEffect(() => {
    setRunLogCleared(false);
    setRunLogCopyNotice(null);
  }, [output?.output, selectedRunDetail?.runId, visibleRunIds]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CODE_WORKBENCH_LAYOUT_STORAGE_KEY, String(filePanePercent));
  }, [filePanePercent]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CODE_WORKBENCH_INSPECTOR_STORAGE_KEY, JSON.stringify([...expandedInspectorSections]));
  }, [expandedInspectorSections]);

  useEffect(() => {
    const currentTurnId = selectedTurn?.turnId ?? null;
    const isNewTurn = prevTurnIdRef.current !== currentTurnId;

    if (isNewTurn) {
      prevTurnIdRef.current = currentTurnId;
      setNewArtifactPending(false);

      if (generatedArtifact) {
        setActivePane("artifact");
        return;
      }
      if (hasDirtyDraft || selectedFile) {
        setActivePane("files");
        return;
      }
      if (selectedFileDiff) {
        setActivePane("selected-diff");
        return;
      }
      if (diff?.changedFiles.length) {
        setActivePane("repo-diff");
        return;
      }
      if (output?.helperRuns.length || output?.output) {
        setActivePane("output");
        return;
      }
      if (codeBlocks.length > 0) {
        setActivePane("snippets");
      }
      return;
    }

    if (generatedArtifact && activePane !== "artifact") {
      setNewArtifactPending(true);
    } else {
      setNewArtifactPending(false);
    }
  }, [
    activePane,
    codeBlocks.length,
    diff?.changedFiles.length,
    generatedArtifact,
    hasDirtyDraft,
    output?.helperRuns.length,
    output?.output,
    selectedFile,
    selectedFileDiff,
    selectedTurn?.turnId,
  ]);

  const activeDraft = draftContent ?? selectedFile?.content ?? "";
  const currentLanguage = selectedFile?.language ?? selectedFileDiff?.language ?? "plaintext";

  const requestFileSelection = (relativePath: string) => {
    if (!relativePath || relativePath === selectedFile?.path) {
      return;
    }
    fileLeave.request(() => onSelectFile(relativePath), [editorDraftKey]);
  };

  const runValidationCommandLine = (commandLine: string) => {
    if (!onRunValidationCommand || validationBlockedReason || busy) {
      return;
    }
    const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
    const [command, ...args] = tokens;
    if (!command) {
      return;
    }
    onRunValidationCommand({ command, args });
    setActivePane("output");
  };
  const stableRunValidationCommandLine = useStableHandler(runValidationCommandLine);
  const runValidationFromInput = () => runValidationCommandLine(validationCommandRef.current);
  const openQuickFilePicker = () => {
    setCommandPaletteOpen(false);
    setFilePickerOpen(true);
  };
  const handleFilePickerSelect = useStableHandler((relativePath: string) => {
    requestFileSelection(relativePath);
    setFilePickerOpen(false);
  });
  const handleFilePickerClose = useCallback(() => {
    setFilePickerOpen(false);
  }, []);
  const openWorkbenchCommandPalette = () => {
    setFilePickerOpen(false);
    setCommandPaletteOpen(true);
  };
  const copyRunLog = () => {
    if (!runLogText.trim()) {
      setRunLogCopyNotice("No run log text is available.");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(runLogText)
        .then(() => {
          if (isMounted()) {
            setRunLogCopyNotice("Run log copied.");
          }
        })
        .catch(() => {
          if (isMounted()) {
            setRunLogCopyNotice("Run log copy failed.");
          }
        });
      return;
    }
    setRunLogCopyNotice("Clipboard is not available in this environment.");
  };
  return (
    <section className="mc-next-workbench-panel">
      <CodeWorkbenchToolbar
        panel={panel}
        blockedActions={blockedActions}
        readyForRepoOps={readyForRepoOps}
        inspectorDrawerOpen={inspectorDrawerOpen}
        inspectorDrawerId={inspectorDrawerId}
        setInspectorDrawerOpen={setInspectorDrawerOpen}
        requestFileSelection={requestFileSelection}
        activePatchBlock={activePatchBlock}
        setActivePane={setActivePane}
        validationPresets={validationPresets}
        handleValidationCommandChange={handleValidationCommandChange}
        stableRunValidationCommandLine={stableRunValidationCommandLine}
        moreMenuRef={moreMenuRef}
        moreMenuOpen={moreMenuOpen}
        moreMenuId={moreMenuId}
        setMoreMenuOpen={setMoreMenuOpen}
        setConfirmRevertFilePath={setConfirmRevertFilePath}
        setConfirmRevertAllOpen={setConfirmRevertAllOpen}
        filePanePercent={filePanePercent}
        setFilePanePercent={setFilePanePercent}
      />
      {error ? <div className="mc-next-panel-banner warning">{error}</div> : null}

      <div className="mc-next-workbench-body" style={workbenchBodyStyle}>
        <aside className="mc-next-workbench-sidebar">
          <button
            type="button"
            className="mc-next-panel-button mc-next-workbench-files-toggle"
            aria-expanded={!compactWorkbench || fileBrowserOpen}
            onClick={() => setFileBrowserOpen((open) => !open)}
          >
            Browse files
          </button>
          <div className="mc-next-workbench-file-browser" hidden={compactWorkbench && !fileBrowserOpen}>
            <div className="mc-next-panel-list-head">
              <strong>Files</strong>
              <span>{changedFiles.length} changed</span>
            </div>
            {needsProjectBinding ? (
              <CodeSourceChooser
                availableProjects={availableProjects}
                selectedProjectCandidateId={selectedProjectCandidateId}
                sourceBindingBusy={sourceBindingBusy}
                onBindExistingProject={onBindExistingProject}
                onImportProjectSource={onImportProjectSource}
              />
            ) : !readyForRepoOps ? (
              <p className="mc-next-workbench-empty">No worktree is active yet. Create one to unlock the repo view.</p>
            ) : workbenchTree ? (
              <>
                <details className="mc-next-chat-evidence">
                  <summary>File actions</summary>
                  <WorkbenchFileActionForm
                    key={[workbenchState?.sessionId, workbenchState?.projectId, workbenchState?.worktreePath].join(":")}
                    busy={busy}
                    repoBlockedReason={worktreeBlockedReason ?? draftConflictReason}
                    selectedFilePath={selectedFile?.path}
                    onFileOperationPreview={stableOnFileOperationPreview}
                    onFileOperation={stableOnFileOperation}
                  />
                </details>
                {workbenchTree.items.length ? (
                  <WorkbenchFileTree
                    storageScopeKey={workbenchState?.sessionId ?? "workbench"}
                    items={workbenchTree.items}
                    selectedPath={selectedFile?.path}
                    expandedPaths={expandedPaths ?? []}
                    onExpandedPathsChange={onExpandedPathsChange}
                    onSelectFile={requestFileSelection}
                  />
                ) : (
                  <p className="mc-next-workbench-empty">No repo files are ready to inspect yet.</p>
                )}
              </>
            ) : (
              <p className="mc-next-workbench-empty">No repo files are ready to inspect yet.</p>
            )}
          </div>
        </aside>

        <section className="mc-next-workbench-main">
          <details className="mc-next-workbench-change-summary">
            <summary>Change summary</summary>
            <div className="mc-next-workbench-review-strip">
              <span>
                {changedFiles.length} changed ·{" "}
                {diff?.summary ? `+${diff.summary.additions} / -${diff.summary.deletions}` : "diff pending"}
              </span>
              <div>
                <button type="button" className="mc-next-panel-button" onClick={() => setActivePane("repo-diff")}>
                  Inspect repo diff
                </button>
                <button type="button" className="mc-next-panel-button" onClick={() => setActivePane("review-packet")}>
                  Review packet
                </button>
                <button type="button" className="mc-next-panel-button" onClick={() => setActivePane("output")}>
                  Run log
                </button>
              </div>
            </div>
          </details>
          <div className="mc-next-panel-tab-row" role="tablist" aria-label="Workbench panes">
            {workbenchPaneDefs.map((pane, index) => {
              const selected = activePane === pane.id;
              return (
                <button
                  key={pane.id}
                  ref={(node) => {
                    workbenchTabRefs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={buildWorkbenchTabId(pane.id)}
                  aria-selected={selected}
                  aria-controls={buildWorkbenchPanelId(pane.id)}
                  tabIndex={index === activeWorkbenchTabIndex ? 0 : -1}
                  className={`mc-next-panel-tab${selected ? " active" : ""}`}
                  onClick={() => setActivePane(pane.id)}
                  onKeyDown={handleWorkbenchTabKeyDown(index, workbenchPaneDefs)}
                >
                  {pane.label}
                </button>
              );
            })}
          </div>

          {newArtifactPending && generatedArtifact && activePane !== "artifact" ? (
            <button
              type="button"
              className="mc-next-workbench-new-artifact-callout"
              onClick={() => {
                setActivePane("artifact");
                setNewArtifactPending(false);
              }}
            >
              New artifact ready · View
            </button>
          ) : null}

          {filePickerOpen ? (
            <WorkbenchFilePicker
              items={workbenchFileItems}
              onSelect={handleFilePickerSelect}
              onClose={handleFilePickerClose}
            />
          ) : null}

          {commandPaletteOpen ? (
            <section className="mc-next-workbench-command-surface" aria-label="Workbench command palette">
              <div className="mc-next-panel-list-head">
                <strong>Workbench commands</strong>
                <button type="button" className="mc-next-panel-button" onClick={() => setCommandPaletteOpen(false)}>
                  Close
                </button>
              </div>
              <div className="mc-next-workbench-command-list">
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={!selectedFile || !hasDirtyDraft || busy || saving || panel.props.hasRemoteChanges}
                  onClick={() => {
                    onSaveFile();
                    setCommandPaletteOpen(false);
                  }}
                >
                  Save file
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={busy || Boolean(validationBlockedReason) || !onRunValidationCommand}
                  onClick={() => {
                    runValidationFromInput();
                    setCommandPaletteOpen(false);
                  }}
                >
                  Run validation
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() => {
                    setActivePane("output");
                    setCommandPaletteOpen(false);
                  }}
                >
                  Open run log
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={!hasPatchDiff}
                  onClick={() => {
                    setActivePane("repo-diff");
                    setCommandPaletteOpen(false);
                  }}
                >
                  Inspect repo diff
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() => {
                    setActivePane("review-packet");
                    setCommandPaletteOpen(false);
                  }}
                >
                  Open review packet
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={loading || busy}
                  onClick={() => {
                    onRefresh();
                    setCommandPaletteOpen(false);
                  }}
                >
                  Refresh workbench
                </button>
              </div>
            </section>
          ) : null}

          <CodeWorkbenchEditorPanes
            panel={panel}
            selectedRunApprovalId={selectedRunApprovalId}
            activePane={activePane}
            paneMounted={paneMounted}
            buildWorkbenchTabId={buildWorkbenchTabId}
            buildWorkbenchPanelId={buildWorkbenchPanelId}
            activeDraft={activeDraft}
            currentLanguage={currentLanguage}
            diffViewMode={diffViewMode}
            setDiffViewMode={setDiffViewMode}
            openQuickFilePicker={openQuickFilePicker}
            openWorkbenchCommandPalette={openWorkbenchCommandPalette}
            reviewPacket={reviewPacket}
          />

          <CodeWorkbenchRunLog
            ledger={ledger}
            artifacts={artifacts}
            output={output}
            onOpenApprovals={onOpenApprovals}
            activePane={activePane}
            paneMounted={paneMounted}
            buildWorkbenchTabId={buildWorkbenchTabId}
            buildWorkbenchPanelId={buildWorkbenchPanelId}
            runLogViewMode={runLogViewMode}
            setRunLogViewMode={setRunLogViewMode}
            runLogCleared={runLogCleared}
            setRunLogCleared={setRunLogCleared}
            runLogCopyNotice={runLogCopyNotice}
            copyRunLog={copyRunLog}
          />

          {paneMounted("snippets") ? (
            <div
              role="tabpanel"
              hidden={activePane !== "snippets"}
              id={buildWorkbenchPanelId("snippets")}
              aria-labelledby={buildWorkbenchTabId("snippets")}
            >
              {activeBlock ? (
                <div className="mc-next-workbench-pane">
                  <div className="mc-next-panel-list-head">
                    <strong>Snippet helper</strong>
                    <span>{activeBlock.language}</span>
                  </div>
                  <WorkbenchMonacoEditor
                    value={activeBlock.content}
                    language={activeBlock.language}
                    readOnly
                    height={320}
                  />
                  <div className="mc-next-workbench-action-row">
                    {codeBlocks.map((block, index) => (
                      <button
                        key={block.id}
                        type="button"
                        className={`mc-next-panel-button${activeBlockIndex === index ? " active" : ""}`}
                        onClick={() => setActiveBlockIndex(index)}
                      >
                        Snippet {index + 1}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="mc-next-panel-button primary"
                      onClick={() => void handleRunHelperSnippet(activeBlock.language, activeBlock.content)}
                    >
                      Run helper snippet
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mc-next-workbench-empty">
                  Code snippets from the latest assistant turn will appear here.
                </div>
              )}
            </div>
          ) : null}

          {paneMounted("artifact") ? (
            <div
              role="tabpanel"
              hidden={activePane !== "artifact"}
              id={buildWorkbenchPanelId("artifact")}
              aria-labelledby={buildWorkbenchTabId("artifact")}
            >
              {generatedArtifact ? (
                <div className="mc-next-workbench-pane">
                  <div className="mc-next-panel-list-head">
                    <strong>{generatedArtifact.title}</strong>
                    <button type="button" className="mc-next-panel-button" onClick={onCloseGeneratedArtifact}>
                      Close artifact
                    </button>
                  </div>
                  <GeneratedArtifactViewer artifact={generatedArtifact} />
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
      <div id={inspectorDrawerId}>
        <DetailInspector open={inspectorDrawerOpen} title="Code context" onClose={closeInspectorDrawer}>
          <CodeSessionInspector
            expandedSections={expandedInspectorSections}
            onToggleSection={handleToggleInspectorSection}
            sections={inspectorSections}
            variant="inline"
          />
        </DetailInspector>
      </div>
      {fileLeave.dialog}
      <ConfirmModal
        open={confirmRevertAllOpen}
        title="Revert all worktree changes?"
        message="This will discard every visible worktree change in this session. Review the repo diff before confirming."
        confirmLabel="Revert all changes"
        danger
        pending={busy}
        cancelDisabled={busy}
        disableDismiss={busy}
        onCancel={() => setConfirmRevertAllOpen(false)}
        onConfirm={() => {
          onRevertAll?.();
          setActivePane("output");
          setConfirmRevertAllOpen(false);
        }}
      />
      <ConfirmModal
        open={Boolean(confirmRevertFilePath)}
        title="Revert this file?"
        message="This will discard the selected file changes in this session. Review the file diff before confirming."
        confirmLabel="Revert file"
        danger
        pending={busy}
        cancelDisabled={busy}
        disableDismiss={busy}
        onCancel={() => setConfirmRevertFilePath(null)}
        onConfirm={() => {
          if (!confirmRevertFilePath) {
            return;
          }
          onRevertFile?.(confirmRevertFilePath);
          setActivePane("output");
          setConfirmRevertFilePath(null);
        }}
      />
    </section>
  );
}
