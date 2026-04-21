import { useEffect, useMemo, useState } from "react";
import type {
  ChatGeneratedArtifactRecord,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { ConfirmModal } from "./ConfirmModal";
import { MonacoDiffEditor } from "./MonacoDiffEditor";
import { StatusChip } from "./StatusChip";
import { WorkbenchFileTree } from "./WorkbenchFileTree";
import { WorkbenchMonacoEditor } from "./WorkbenchMonacoEditor";
import { GeneratedArtifactViewer } from "./chat/GeneratedArtifactViewer";

interface CodeBlockRecord {
  id: string;
  language: string;
  content: string;
}

function extractCodeBlocks(content: string): CodeBlockRecord[] {
  const matches = Array.from(content.matchAll(/```([\w.+-]*)\n([\s\S]*?)```/g));
  return matches
    .map((match, index) => ({
      id: `code-block-${index}`,
      language: match[1]?.trim() || "text",
      content: (match[2] ?? "").trim(),
    }))
    .filter((block) => block.content.length > 0);
}

function normalizeSnippetLanguage(language?: string): "javascript" | "typescript" {
  const normalized = language?.trim().toLowerCase();
  if (normalized === "js" || normalized === "jsx" || normalized === "javascript") {
    return "javascript";
  }
  return "typescript";
}

type WorkbenchPaneId = "file" | "selected-diff" | "repo-diff" | "output" | "snippets" | "artifact";

export function CodeWorkbenchPanel({
  selectedTurn,
  projectName,
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
  onCreateWorktree,
  onSelectFile,
  onDraftChange,
  onExpandedPathsChange,
  onRefresh,
  onSaveFile,
  onDiscardDraft,
  onRunHelperSnippet,
}: {
  selectedTurn: ChatThreadTurnRecord | null;
  projectName?: string;
  needsProjectBinding: boolean;
  workbenchState?: ChatSessionWorkbenchRecord | null;
  workbenchTree?: ChatSessionWorkbenchTreeResponse | null;
  selectedFile?: ChatSessionWorkbenchFileResponse | null;
  selectedFileDiff?: ChatSessionWorkbenchFileDiffResponse | null;
  draftContent?: string;
  expandedPaths?: string[];
  diff?: ChatSessionWorkbenchDiffResponse | null;
  output?: ChatSessionWorkbenchOutputResponse | null;
  loading: boolean;
  busy: boolean;
  saving: boolean;
  error?: string | null;
  hasDirtyDraft: boolean;
  generatedArtifact?: ChatGeneratedArtifactRecord | null;
  onCloseGeneratedArtifact?: () => void;
  onCreateWorktree: () => void;
  onSelectFile: (relativePath: string) => void;
  onDraftChange: (next: string) => void;
  onExpandedPathsChange: (nextPaths: string[]) => void;
  onRefresh: () => void;
  onSaveFile: () => void;
  onDiscardDraft: () => void;
  onRunHelperSnippet: (language: string, source: string) => void;
}) {
  const codeBlocks = useMemo(
    () => extractCodeBlocks(selectedTurn?.assistantMessage?.content ?? ""),
    [selectedTurn?.assistantMessage?.content],
  );
  const readyForRepoOps = workbenchState?.worktreeStatus === "ready";
  const boundProjectLabel = projectName ?? "bound project";
  const changedFiles = workbenchTree?.changedFiles ?? diff?.changedFiles ?? [];
  const helperRuns = output?.helperRuns ?? [];
  const [activePane, setActivePane] = useState<WorkbenchPaneId>("file");
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);

  useEffect(() => {
    setActiveBlockIndex(0);
  }, [codeBlocks.length, selectedTurn?.turnId]);

  useEffect(() => {
    if (generatedArtifact) {
      setActivePane("artifact");
      return;
    }
    if (needsProjectBinding) {
      setActivePane(codeBlocks.length > 0 ? "snippets" : "repo-diff");
      return;
    }
    if (hasDirtyDraft) {
      setActivePane("file");
      return;
    }
    if (selectedFile) {
      setActivePane("file");
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
  }, [
    codeBlocks.length,
    diff?.changedFiles.length,
    generatedArtifact,
    hasDirtyDraft,
    needsProjectBinding,
    output?.helperRuns.length,
    output?.output,
    selectedFile,
    selectedFileDiff,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedFile || !hasDirtyDraft) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSaveFile();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasDirtyDraft, onSaveFile, selectedFile]);

  const approvalBlocked = selectedTurn?.trace?.status === "waiting_for_approval";
  const userInputBlocked = selectedTurn?.trace?.status === "waiting_for_user_input";
  const activeDraft = draftContent ?? selectedFile?.content ?? "";
  const activeBlock = codeBlocks[activeBlockIndex] ?? null;
  const primaryPath = selectedFile?.path ?? changedFiles[0];
  const fileTreeItems = workbenchTree?.items ?? [];
  const effectiveSelectedFileDiffOriginal = selectedFileDiff?.originalContent ?? selectedFile?.content ?? "";
  const effectiveSelectedFileDiffModified =
    hasDirtyDraft && selectedFile ? activeDraft : (selectedFileDiff?.modifiedContent ?? selectedFile?.content ?? "");
  const currentLanguage = selectedFile?.language ?? selectedFileDiff?.language ?? "plaintext";

  const requestFileSelection = (relativePath: string) => {
    if (!relativePath || relativePath === selectedFile?.path) {
      return;
    }
    if (hasDirtyDraft) {
      setPendingFilePath(relativePath);
      return;
    }
    onSelectFile(relativePath);
  };

  return (
    <section className="chat-code-workbench chat-workspace-panel mission-dock-panel">
      <header className="chat-code-workbench-head">
        <div>
          <h4>Code Workbench</h4>
          <p>
            {needsProjectBinding
              ? "Bind a project before this session can open a repo-backed workbench."
              : readyForRepoOps
                ? `Repo-first implementation surface for ${boundProjectLabel}.`
                : `Project-bound workbench for ${boundProjectLabel}. Create a worktree to begin repo operations.`}
          </p>
        </div>
        <div className="chat-code-workbench-chips">
          <StatusChip tone={needsProjectBinding ? "warning" : "success"}>
            {needsProjectBinding ? "Unbound" : "Project ready"}
          </StatusChip>
          <StatusChip tone={readyForRepoOps ? "success" : "warning"}>
            {workbenchState?.worktreeStatus ?? "uninitialized"}
          </StatusChip>
          {userInputBlocked ? <StatusChip tone="warning">Answer needed</StatusChip> : null}
          {hasDirtyDraft ? <StatusChip tone="warning">Unsaved changes</StatusChip> : null}
          <StatusChip
            tone={
              workbenchState?.validationStatus === "passed"
                ? "success"
                : workbenchState?.validationStatus === "failed"
                  ? "critical"
                  : "warning"
            }
          >
            {workbenchState?.validationStatus ?? "idle"}
          </StatusChip>
        </div>
      </header>

      <div className="chat-code-workbench-posture-row">
        <div className="chat-code-workbench-meta">
          <span>Base ref: {workbenchState?.baseRef ?? "repo default"}</span>
          <span>Worktree: {workbenchState?.worktreePath ?? "not created"}</span>
          {primaryPath ? <span>Active file: {primaryPath}</span> : null}
          {selectedFile?.sizeBytes ? <span>{selectedFile.sizeBytes.toLocaleString()} bytes</span> : null}
        </div>
        <div className="chat-code-workbench-toolbar">
          <div className="chat-code-workbench-actions">
            <button type="button" className="gc-button" onClick={onRefresh} disabled={loading || busy}>
              Refresh
            </button>
            <button
              type="button"
              className="gc-button"
              onClick={onSaveFile}
              disabled={!selectedFile || !hasDirtyDraft || busy || saving}
            >
              {saving ? "Saving..." : "Save file"}
            </button>
            <button
              type="button"
              className="gc-button"
              onClick={onCreateWorktree}
              disabled={needsProjectBinding || readyForRepoOps || busy}
            >
              Create worktree
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="chat-code-workbench-banner tone-warning">
          <p>{error}</p>
        </div>
      ) : null}

      <div className="chat-code-workbench-shell">
        <section className="chat-code-workbench-sidebar">
          <div className="chat-code-workbench-section-head">
            <strong>Repo files</strong>
            <span>{changedFiles.length} changed</span>
          </div>
          {needsProjectBinding ? (
            <div className="chat-code-workbench-empty">
              <p>Project binding is required before repo operations can start.</p>
              <p>Draft snippets remain available as a secondary helper panel.</p>
            </div>
          ) : userInputBlocked ? (
            <div className="chat-code-workbench-empty">
              <p>The selected turn is waiting for your answer in the main thread.</p>
              <p>Reply there to continue this run.</p>
            </div>
          ) : !readyForRepoOps ? (
            <div className="chat-code-workbench-empty">
              <p>No worktree is active yet.</p>
              <p>Create one to unlock the file tree, diff viewer, and validation output.</p>
            </div>
          ) : fileTreeItems.length > 0 ? (
            <WorkbenchFileTree
              storageScopeKey={workbenchState?.sessionId ?? "workbench"}
              items={fileTreeItems}
              selectedPath={selectedFile?.path}
              expandedPaths={expandedPaths ?? []}
              onExpandedPathsChange={onExpandedPathsChange}
              onSelectFile={requestFileSelection}
            />
          ) : (
            <div className="chat-code-workbench-empty">
              <p>No repo files are ready to inspect yet.</p>
              <p>Run a coding step or refresh once the session writes into the worktree.</p>
            </div>
          )}
        </section>

        <section className="chat-code-workbench-main">
          <div className="chat-code-workbench-pane-tabs" aria-label="Workbench panes">
            {[
              ["file", "File"],
              ["selected-diff", "Selected diff"],
              ["repo-diff", "Repo diff"],
              ["output", "Output"],
              ["snippets", "Draft snippets"],
              ...(generatedArtifact ? [["artifact", "Artifact"]] : []),
            ].map(([paneId, label]) => (
              <button
                key={paneId}
                type="button"
                className={["gc-button", activePane === paneId ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setActivePane(paneId as WorkbenchPaneId)}
              >
                {label}
              </button>
            ))}
          </div>

          {activePane === "file" ? (
            <div className="chat-code-workbench-pane">
              {selectedFile ? (
                <>
                  <div className="chat-code-workbench-section-head">
                    <strong>{selectedFile.path}</strong>
                    <span>
                      {selectedFile.language} · {hasDirtyDraft ? "unsaved" : selectedFile.changed ? "changed" : "saved"}
                    </span>
                  </div>
                  <div className="chat-code-workbench-monaco-shell">
                    <WorkbenchMonacoEditor
                      className="chat-code-workbench-monaco"
                      value={activeDraft}
                      language={selectedFile.language}
                      height={520}
                      onChange={onDraftChange}
                    />
                  </div>
                </>
              ) : (
                <div className="chat-code-workbench-empty">
                  <p>No file is selected yet.</p>
                  <p>Pick a file in the tree to start editing it in Monaco.</p>
                </div>
              )}
            </div>
          ) : null}

          {activePane === "selected-diff" ? (
            <div className="chat-code-workbench-pane">
              {selectedFile && selectedFileDiff ? (
                <>
                  <div className="chat-code-workbench-section-head">
                    <strong>Selected-file diff</strong>
                    <span>{selectedFile.path}</span>
                  </div>
                  <div className="chat-code-workbench-monaco-shell">
                    <MonacoDiffEditor
                      className="chat-code-workbench-diff"
                      language={currentLanguage}
                      original={effectiveSelectedFileDiffOriginal}
                      modified={effectiveSelectedFileDiffModified}
                      height={520}
                    />
                  </div>
                </>
              ) : (
                <div className="chat-code-workbench-empty">
                  <p>No selected-file diff is ready yet.</p>
                  <p>Choose a repo file to compare the editor against the current git base.</p>
                </div>
              )}
            </div>
          ) : null}

          {activePane === "repo-diff" ? (
            <div className="chat-code-workbench-pane">
              {diff ? (
                <>
                  <div className="chat-code-workbench-section-head">
                    <strong>Repo diff</strong>
                    <span>
                      {diff.summary.changedFiles} files · +{diff.summary.additions} / -{diff.summary.deletions}
                    </span>
                  </div>
                  {diff.diff.trim().length > 0 ? (
                    <div className="chat-code-workbench-monaco-shell">
                      <WorkbenchMonacoEditor
                        className="chat-code-workbench-monaco"
                        value={diff.diff}
                        language="diff"
                        readOnly
                        height={520}
                      />
                    </div>
                  ) : (
                    <div className="chat-code-workbench-empty">
                      <p>No diff is available yet.</p>
                      <p>Once the session edits the worktree, this pane becomes the main repo review surface.</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="chat-code-workbench-empty">
                  <p>Diff data is not loaded yet.</p>
                  <p>Create a worktree or refresh the session to populate repo changes.</p>
                </div>
              )}
            </div>
          ) : null}

          {activePane === "output" ? (
            <div className="chat-code-workbench-pane">
              <div className="chat-code-workbench-section-head">
                <strong>Validation and helper output</strong>
                <span>
                  {helperRuns.length} helper run{helperRuns.length === 1 ? "" : "s"}
                </span>
              </div>
              {output?.output ? <pre className="chat-code-workbench-pre">{output.output}</pre> : null}
              {helperRuns.length > 0 ? (
                <ul className="chat-code-workbench-run-list">
                  {helperRuns.map((run) => (
                    <li key={run.runId}>
                      <div className="chat-code-workbench-step-row">
                        <strong>{run.language}</strong>
                        <StatusChip
                          tone={
                            run.status === "completed" ? "success" : run.status === "failed" ? "critical" : "warning"
                          }
                        >
                          {run.status}
                        </StatusChip>
                      </div>
                      <p>{run.requestedOutputIntent ?? "helper"}</p>
                      {run.stdoutPreview ? (
                        <pre className="chat-code-workbench-inline-pre">{run.stdoutPreview}</pre>
                      ) : null}
                      {run.stderrPreview ? (
                        <pre className="chat-code-workbench-inline-pre">{run.stderrPreview}</pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : !output?.output ? (
                <div className="chat-code-workbench-empty">
                  <p>No validation output has landed yet.</p>
                  <p>Helper runs from code-mode attach here as non-authoritative artifacts.</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {activePane === "snippets" ? (
            <div className="chat-code-workbench-pane">
              <div className="chat-code-workbench-section-head">
                <strong>Draft snippets</strong>
                <span>
                  {codeBlocks.length > 0
                    ? `${codeBlocks.length} extracted draft${codeBlocks.length === 1 ? "" : "s"}`
                    : "no extracted drafts"}
                </span>
              </div>
              {codeBlocks.length > 0 ? (
                <>
                  <div className="chat-code-workbench-tabs" aria-label="Draft snippets">
                    {codeBlocks.map((block, index) => (
                      <button
                        key={block.id}
                        type="button"
                        className={["gc-button", index === activeBlockIndex ? "active" : ""].filter(Boolean).join(" ")}
                        onClick={() => setActiveBlockIndex(index)}
                      >
                        {block.language || "snippet"} {index + 1}
                      </button>
                    ))}
                  </div>
                  <div className="chat-code-workbench-helper-row">
                    <label className="chat-code-workbench-select">
                      <span>Helper runtime</span>
                      <select value={normalizeSnippetLanguage(activeBlock?.language)} disabled>
                        <option value="typescript">TypeScript</option>
                        <option value="javascript">JavaScript</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="gc-button"
                      onClick={() =>
                        activeBlock
                          ? onRunHelperSnippet(normalizeSnippetLanguage(activeBlock.language), activeBlock.content)
                          : undefined
                      }
                      disabled={busy || !activeBlock}
                    >
                      Run helper
                    </button>
                  </div>
                  <div className="chat-code-workbench-monaco-shell">
                    <WorkbenchMonacoEditor
                      className="chat-code-workbench-monaco"
                      value={activeBlock?.content ?? ""}
                      language={activeBlock?.language ?? "plaintext"}
                      readOnly
                      height={420}
                    />
                  </div>
                </>
              ) : (
                <div className="chat-code-workbench-empty">
                  <p>No extracted helper snippets are available for this turn.</p>
                  <p>When the assistant emits fenced code blocks, they show up here as runnable scratch artifacts.</p>
                </div>
              )}
              <p className="chat-code-workbench-note">
                Helper snippets stay secondary. They are useful for transforms, parser checks, and quick validation, but
                they do not own the repo tree, diff, or main edit loop.
              </p>
            </div>
          ) : null}

          {activePane === "artifact" ? (
            <div className="chat-code-workbench-pane">
              {generatedArtifact ? (
                <>
                  <div className="chat-code-workbench-section-head">
                    <strong>Generated artifact</strong>
                    {onCloseGeneratedArtifact ? (
                      <button type="button" className="gc-button" onClick={onCloseGeneratedArtifact}>
                        Close artifact
                      </button>
                    ) : null}
                  </div>
                  <GeneratedArtifactViewer artifact={generatedArtifact} />
                </>
              ) : (
                <div className="chat-code-workbench-empty">
                  <p>No generated artifact is open.</p>
                  <p>Open one from the thread to inspect it inside the workbench.</p>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <aside className="chat-code-workbench-rail">
          <div className="chat-code-workbench-section-head">
            <strong>Support rail</strong>
            <span>{selectedTurn?.trace?.status ?? "idle"}</span>
          </div>
          <ul className="chat-code-workbench-run-list">
            <li>
              <div className="chat-code-workbench-step-row">
                <strong>Approval blockers</strong>
                <StatusChip tone={approvalBlocked ? "warning" : "success"}>
                  {approvalBlocked ? "waiting" : "clear"}
                </StatusChip>
              </div>
              <p>
                {approvalBlocked
                  ? "A human approval is required before the run can proceed."
                  : "No current approval blocker."}
              </p>
            </li>
            <li>
              <div className="chat-code-workbench-step-row">
                <strong>Changed files</strong>
                <StatusChip tone={changedFiles.length > 0 ? "warning" : "muted"}>{changedFiles.length}</StatusChip>
              </div>
              <p>{changedFiles.slice(0, 3).join(", ") || "No repo changes surfaced yet."}</p>
            </li>
            <li>
              <div className="chat-code-workbench-step-row">
                <strong>Tool activity</strong>
                <StatusChip tone={(selectedTurn?.toolRuns?.length ?? 0) > 0 ? "success" : "muted"}>
                  {selectedTurn?.toolRuns?.length ?? 0}
                </StatusChip>
              </div>
              <p>Policy-gated tool execution stays authoritative for file, git, and validation actions.</p>
            </li>
          </ul>
        </aside>
      </div>

      <ConfirmModal
        open={Boolean(pendingFilePath)}
        title="Discard unsaved file changes?"
        message="Switching files will discard the unsaved editor changes in the current workbench file."
        confirmLabel="Discard and switch"
        danger
        pending={saving}
        cancelDisabled={saving}
        disableDismiss={saving}
        onCancel={() => setPendingFilePath(null)}
        onConfirm={() => {
          if (!pendingFilePath) {
            return;
          }
          onDiscardDraft();
          onSelectFile(pendingFilePath);
          setPendingFilePath(null);
        }}
      />
    </section>
  );
}
