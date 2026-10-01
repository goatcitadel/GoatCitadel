import type { Dispatch, SetStateAction } from "react";
import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";
import { MonacoDiffEditor } from "@goatcitadel/mission-control-shared/components/MonacoDiffEditor";
import type { CodeWorkbenchPaneProps, CodePanelType } from "./code-workbench-model";
import type { useCodeWorkbenchReviewPacket } from "./useCodeWorkbenchReviewPacket";
import { shortId } from "./format";

export function CodeWorkbenchEditorPanes({
  panel,
  selectedRunApprovalId,
  activePane,
  paneMounted,
  buildWorkbenchTabId,
  buildWorkbenchPanelId,
  activeDraft,
  currentLanguage,
  diffViewMode,
  setDiffViewMode,
  openQuickFilePicker,
  openWorkbenchCommandPalette,
  reviewPacket,
}: CodeWorkbenchPaneProps & {
  panel: CodePanelType;
  selectedRunApprovalId?: string;
  activeDraft: string;
  currentLanguage: string;
  diffViewMode: "side-by-side" | "unified";
  setDiffViewMode: Dispatch<SetStateAction<"side-by-side" | "unified">>;
  openQuickFilePicker: () => void;
  openWorkbenchCommandPalette: () => void;
  reviewPacket: ReturnType<typeof useCodeWorkbenchReviewPacket>;
}) {
  const { selectedFile, selectedFileDiff, hasDirtyDraft, diff, onDraftChange, onSaveFile } = panel.props;
  return (
    <>
      {paneMounted("files") ? (
        <div
          role="tabpanel"
          hidden={activePane !== "files"}
          id={buildWorkbenchPanelId("files")}
          aria-labelledby={buildWorkbenchTabId("files")}
        >
          {selectedFile ? (
            <div className="mc-next-workbench-pane">
              <div className="mc-next-panel-list-head">
                <strong>{selectedFile.path}</strong>
                <span>{selectedFile.language}</span>
              </div>
              <WorkbenchMonacoEditor
                value={activeDraft}
                language={selectedFile.language}
                height={520}
                onChange={onDraftChange}
                onSave={onSaveFile}
                onQuickOpen={openQuickFilePicker}
                onCommandPalette={openWorkbenchCommandPalette}
              />
            </div>
          ) : (
            <div className="mc-next-workbench-empty">Pick a file in the tree to start editing it.</div>
          )}
        </div>
      ) : null}

      {paneMounted("selected-diff") ? (
        <div
          role="tabpanel"
          hidden={activePane !== "selected-diff"}
          id={buildWorkbenchPanelId("selected-diff")}
          aria-labelledby={buildWorkbenchTabId("selected-diff")}
        >
          {selectedFile && selectedFileDiff ? (
            <div className="mc-next-workbench-pane">
              <div className="mc-next-panel-list-head">
                <strong>Selected-file diff</strong>
                <div className="mc-next-workbench-view-toggle" role="group" aria-label="Diff view mode">
                  <span>{selectedFile.path}</span>
                  <button
                    type="button"
                    className={`mc-next-panel-button${diffViewMode === "side-by-side" ? " active" : ""}`}
                    onClick={() => setDiffViewMode("side-by-side")}
                  >
                    Side by side
                  </button>
                  <button
                    type="button"
                    className={`mc-next-panel-button${diffViewMode === "unified" ? " active" : ""}`}
                    onClick={() => setDiffViewMode("unified")}
                  >
                    Unified
                  </button>
                </div>
              </div>
              <MonacoDiffEditor
                language={currentLanguage}
                original={selectedFileDiff.originalContent ?? selectedFile.content ?? ""}
                modified={
                  hasDirtyDraft ? activeDraft : (selectedFileDiff.modifiedContent ?? selectedFile.content ?? "")
                }
                height={520}
                renderSideBySide={diffViewMode === "side-by-side"}
              />
            </div>
          ) : (
            <div className="mc-next-workbench-empty">
              Choose a repo file to compare the editor against the current git base.
            </div>
          )}
        </div>
      ) : null}

      {paneMounted("repo-diff") ? (
        <div
          role="tabpanel"
          hidden={activePane !== "repo-diff"}
          id={buildWorkbenchPanelId("repo-diff")}
          aria-labelledby={buildWorkbenchTabId("repo-diff")}
        >
          {diff ? (
            <div className="mc-next-workbench-pane">
              <div className="mc-next-panel-list-head">
                <strong>Repo diff</strong>
                <span>
                  {diff.summary.changedFiles} files · +{diff.summary.additions} / -{diff.summary.deletions}
                </span>
              </div>
              <WorkbenchMonacoEditor value={diff.diff || "No diff yet."} language="diff" readOnly height={520} />
            </div>
          ) : (
            <div className="mc-next-workbench-empty">
              Create a worktree or refresh the session to populate repo changes.
            </div>
          )}
        </div>
      ) : null}

      {paneMounted("review-packet") ? (
        <div
          className="mc-next-workbench-pane mc-next-workbench-review-packet"
          role="tabpanel"
          hidden={activePane !== "review-packet"}
          id={buildWorkbenchPanelId("review-packet")}
          aria-labelledby={buildWorkbenchTabId("review-packet")}
        >
          <div className="mc-next-panel-list-head">
            <strong>Review packet</strong>
            <span>{reviewPacket.checklist.filter((item) => item.tone === "good").length} ready checks</span>
          </div>
          <div className="mc-next-code-review-packet-grid">
            {reviewPacket.metrics.map((item) => (
              <article key={item.label} className="mc-next-code-review-packet-card" data-tone={item.tone}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
          <section className="mc-next-code-review-packet-section">
            <div className="mc-next-panel-list-head">
              <strong>Validation evidence</strong>
              <span>{reviewPacket.validation.command}</span>
            </div>
            <div className="mc-next-code-review-packet-grid is-compact">
              <article className="mc-next-code-review-packet-card" data-tone={reviewPacket.validation.tone}>
                <span>Status</span>
                <strong>{reviewPacket.validation.status}</strong>
                <p>{reviewPacket.validation.detail}</p>
              </article>
              <article className="mc-next-code-review-packet-card" data-tone="muted">
                <span>Skipped</span>
                <strong>Disclosure</strong>
                <p>{reviewPacket.validation.skipped}</p>
              </article>
            </div>
          </section>
          <section className="mc-next-code-review-packet-section">
            <div className="mc-next-panel-list-head">
              <strong>Artifacts and approvals</strong>
              <span>
                {selectedRunApprovalId ? `approval ${shortId(selectedRunApprovalId)}` : "approval not linked"}
              </span>
            </div>
            <div className="mc-next-code-review-artifact-list">
              {reviewPacket.artifactRows.map((row) => (
                <div key={row.label}>
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="mc-next-code-review-packet-section">
            <div className="mc-next-panel-list-head">
              <strong>Ready to publish checklist</strong>
              <span>{reviewPacket.risk}</span>
            </div>
            <ul className="mc-next-code-review-checklist">
              {reviewPacket.checklist.map((item) => (
                <li key={item.label} data-tone={item.tone}>
                  <strong>{item.label}</strong>
                  <span>{item.status}</span>
                  <p>{item.detail}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </>
  );
}
