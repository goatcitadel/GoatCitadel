import type { Dispatch, RefObject, SetStateAction } from "react";
import { PanelRightOpen } from "lucide-react";
import { StatusChip } from "../../native-routes/primitives";
import { WorkbenchValidationControls } from "./WorkbenchValidationControls";
import {
  validationStatusTone,
  type WorkbenchPaneId,
  type extractCodeBlocks,
  type getValidationCommandPresets,
} from "./format";
import type { CodePanelType } from "./code-workbench-model";
import type { CodeWorkbenchBlockedActions } from "./useCodeSessionInspector";

export function CodeWorkbenchToolbar({
  panel,
  blockedActions,
  readyForRepoOps,
  inspectorDrawerOpen,
  inspectorDrawerId,
  setInspectorDrawerOpen,
  requestFileSelection,
  activePatchBlock,
  setActivePane,
  validationPresets,
  handleValidationCommandChange,
  stableRunValidationCommandLine,
  moreMenuRef,
  moreMenuOpen,
  moreMenuId,
  setMoreMenuOpen,
  setConfirmRevertFilePath,
  setConfirmRevertAllOpen,
  filePanePercent,
  setFilePanePercent,
}: {
  panel: CodePanelType;
  blockedActions: CodeWorkbenchBlockedActions;
  readyForRepoOps: boolean;
  inspectorDrawerOpen: boolean;
  inspectorDrawerId: string;
  setInspectorDrawerOpen: Dispatch<SetStateAction<boolean>>;
  requestFileSelection: (path: string) => void;
  activePatchBlock: ReturnType<typeof extractCodeBlocks>[number] | null;
  setActivePane: Dispatch<SetStateAction<WorkbenchPaneId>>;
  validationPresets: ReturnType<typeof getValidationCommandPresets>;
  handleValidationCommandChange: (value: string) => void;
  stableRunValidationCommandLine: (value: string) => void;
  moreMenuRef: RefObject<HTMLDivElement | null>;
  moreMenuOpen: boolean;
  moreMenuId: string;
  setMoreMenuOpen: Dispatch<SetStateAction<boolean>>;
  setConfirmRevertFilePath: Dispatch<SetStateAction<string | null>>;
  setConfirmRevertAllOpen: Dispatch<SetStateAction<boolean>>;
  filePanePercent: number;
  setFilePanePercent: Dispatch<SetStateAction<number>>;
}) {
  const {
    needsProjectBinding,
    projectName,
    workbenchState,
    hasDirtyDraft,
    selectedFile,
    busy,
    saving,
    onSaveFile,
    onDiscardDraft,
    onRefresh,
    loading,
    onCreateWorktree,
    onApplyPatch,
    onExportPatch,
    onRunValidationCommand,
    onRevertFile,
    onRevertAll,
  } = panel.props;
  const {
    validationBlockedReason,
    applyBlockedReason,
    exportBlockedReason,
    selectedRevertBlockedReason,
    allRevertBlockedReason,
  } = blockedActions;
  return (
    <>
      <header className="mc-next-workbench-head">
        <div>
          <p className="mc-next-panel-kicker">Code</p>
          <h4>Build editor</h4>
          <p>
            {needsProjectBinding
              ? "Choose a project to edit its files."
              : readyForRepoOps
                ? (projectName ?? "Current project")
                : `${projectName ?? "Current project"} · Create a worktree to begin editing.`}
          </p>
        </div>
        <div className="mc-next-workbench-toolbar">
          <StatusChip tone={needsProjectBinding ? "warning" : "success"}>
            {needsProjectBinding ? "Unbound" : "Project ready"}
          </StatusChip>
          <StatusChip tone={readyForRepoOps ? "success" : "warning"}>
            {workbenchState?.worktreeStatus ?? "uninitialized"}
          </StatusChip>
          <StatusChip tone={validationStatusTone(workbenchState?.validationStatus)}>
            Validation: {workbenchState?.validationStatus ?? "idle"}
          </StatusChip>
          {hasDirtyDraft ? <StatusChip tone="warning">Unsaved changes</StatusChip> : null}
          <button
            type="button"
            className="mc-next-panel-button mc-next-code-inspector-open"
            aria-expanded={inspectorDrawerOpen}
            aria-controls={inspectorDrawerId}
            onClick={() => setInspectorDrawerOpen(true)}
          >
            <PanelRightOpen size={14} />
            <span>Inspector</span>
          </button>
        </div>
      </header>

      {panel.props.retainedDraftPaths?.length ? (
        <details className="mc-next-chat-evidence">
          <summary>Unsaved files ({panel.props.retainedDraftPaths.length})</summary>
          {panel.props.retainedDraftPaths.map((path) => (
            <button
              type="button"
              className="mc-next-panel-button"
              key={path}
              onClick={() => requestFileSelection(path)}
            >
              {path} · Unsaved
            </button>
          ))}
        </details>
      ) : null}
      {panel.props.hasRemoteChanges ? (
        <section>
          <p role="alert">This file changed since editing began. Your draft is preserved.</p>
          <details className="mc-next-chat-evidence">
            <summary>Review latest file</summary>
            <pre>{selectedFile?.content}</pre>
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={panel.props.onRebaseDraft}
              disabled={busy || saving}
            >
              Use this version and keep my draft
            </button>
          </details>
        </section>
      ) : null}
      <div className="mc-next-workbench-action-row">
        <div className="mc-next-workbench-action-cluster" data-cluster="draft">
          <button
            type="button"
            className="mc-next-panel-button"
            onClick={onSaveFile}
            disabled={!selectedFile || !hasDirtyDraft || busy || saving || panel.props.hasRemoteChanges}
          >
            {saving ? "Saving…" : "Save file"}
          </button>
          <button type="button" className="mc-next-panel-button" onClick={onDiscardDraft} disabled={!hasDirtyDraft}>
            Discard draft
          </button>
        </div>
        <span aria-hidden="true" className="mc-next-workbench-action-divider" />
        <details className="mc-next-workbench-tools">
          <summary className="mc-next-panel-button">Repo actions and checks</summary>
          <div className="mc-next-workbench-action-cluster" data-cluster="repo">
            <button type="button" className="mc-next-panel-button" onClick={onRefresh} disabled={loading || busy}>
              Refresh
            </button>
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={onCreateWorktree}
              disabled={needsProjectBinding || readyForRepoOps || busy}
            >
              Create worktree
            </button>
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={() => {
                if (activePatchBlock) {
                  onApplyPatch?.(activePatchBlock.content);
                  setActivePane("output");
                }
              }}
              disabled={busy || Boolean(applyBlockedReason) || !onApplyPatch}
              title={applyBlockedReason ?? (!onApplyPatch ? "Patch apply backend is unavailable." : undefined)}
            >
              Apply
            </button>
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={() => {
                onExportPatch?.();
                setActivePane("output");
              }}
              disabled={busy || Boolean(exportBlockedReason) || !onExportPatch}
              title={exportBlockedReason ?? (!onExportPatch ? "Patch export backend is unavailable." : undefined)}
            >
              Export
            </button>
            <WorkbenchValidationControls
              busy={busy}
              blockedReason={validationBlockedReason}
              available={Boolean(onRunValidationCommand)}
              presets={validationPresets}
              onCommandChange={handleValidationCommandChange}
              onRunCommandLine={stableRunValidationCommandLine}
            />
          </div>
        </details>
        <span aria-hidden="true" className="mc-next-workbench-action-divider" />
        <div className="mc-next-workbench-action-cluster" data-cluster="destructive" ref={moreMenuRef}>
          <button
            type="button"
            className="mc-next-panel-button"
            disabled={
              busy ||
              (Boolean(selectedRevertBlockedReason) && Boolean(allRevertBlockedReason)) ||
              (!onRevertFile && !onRevertAll)
            }
            aria-expanded={moreMenuOpen}
            aria-controls={moreMenuId}
            aria-haspopup="menu"
            aria-label="More workbench actions"
            onClick={() => setMoreMenuOpen((open) => !open)}
          >
            More ▾
          </button>
          {moreMenuOpen ? (
            <div id={moreMenuId} className="mc-next-workbench-more-popover" role="menu">
              <button
                type="button"
                role="menuitem"
                className="mc-next-panel-button"
                disabled={busy || Boolean(selectedRevertBlockedReason) || !onRevertFile}
                title={
                  selectedRevertBlockedReason ?? (!onRevertFile ? "File revert backend is unavailable." : undefined)
                }
                onClick={() => {
                  setMoreMenuOpen(false);
                  if (selectedFile?.path) {
                    setConfirmRevertFilePath(selectedFile.path);
                  }
                }}
              >
                Revert file
              </button>
              <button
                type="button"
                role="menuitem"
                className="mc-next-panel-button"
                disabled={busy || Boolean(allRevertBlockedReason) || !onRevertAll}
                title={allRevertBlockedReason ?? (!onRevertAll ? "Revert backend is unavailable." : undefined)}
                onClick={() => {
                  setMoreMenuOpen(false);
                  setConfirmRevertAllOpen(true);
                }}
              >
                Revert all
              </button>
            </div>
          ) : (
            <div id={moreMenuId} hidden aria-hidden="true" />
          )}
        </div>
        <span aria-hidden="true" className="mc-next-workbench-action-divider" />
        <details className="mc-next-workbench-layout-options">
          <summary className="mc-next-panel-button">Layout</summary>
          <label className="mc-next-workbench-layout-control">
            <span>Files pane</span>
            <input
              type="range"
              min={18}
              max={42}
              value={filePanePercent}
              onChange={(event) => setFilePanePercent(Number(event.target.value))}
            />
          </label>
        </details>
      </div>
    </>
  );
}
