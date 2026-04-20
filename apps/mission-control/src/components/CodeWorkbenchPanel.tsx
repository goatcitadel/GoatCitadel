import { useEffect, useMemo, useState } from "react";
import type {
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { StatusChip } from "./StatusChip";

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

export function CodeWorkbenchPanel({
  selectedTurn,
  projectName,
  needsProjectBinding,
  workbenchState,
  workbenchTree,
  selectedFile,
  diff,
  output,
  loading,
  busy,
  error,
  onCreateWorktree,
  onSelectFile,
  onRefresh,
  onRunHelperSnippet,
}: {
  selectedTurn: ChatThreadTurnRecord | null;
  projectName?: string;
  needsProjectBinding: boolean;
  workbenchState?: ChatSessionWorkbenchRecord | null;
  workbenchTree?: ChatSessionWorkbenchTreeResponse | null;
  selectedFile?: ChatSessionWorkbenchFileResponse | null;
  diff?: ChatSessionWorkbenchDiffResponse | null;
  output?: ChatSessionWorkbenchOutputResponse | null;
  loading: boolean;
  busy: boolean;
  error?: string | null;
  onCreateWorktree: () => void;
  onSelectFile: (relativePath: string) => void;
  onRefresh: () => void;
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
  const [activePane, setActivePane] = useState<"file" | "diff" | "output" | "snippets">("diff");
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [helperLanguage, setHelperLanguage] = useState<"javascript" | "typescript">("typescript");

  useEffect(() => {
    setActiveBlockIndex(0);
    if (codeBlocks.length > 0) {
      setDrafts(codeBlocks.map((block) => block.content));
      setHelperLanguage(normalizeSnippetLanguage(codeBlocks[0]?.language));
      return;
    }
    setDrafts([""]);
    setHelperLanguage("typescript");
  }, [codeBlocks, selectedTurn?.turnId]);

  useEffect(() => {
    if (needsProjectBinding) {
      setActivePane(codeBlocks.length > 0 ? "snippets" : "diff");
      return;
    }
    if (diff?.changedFiles.length) {
      setActivePane("diff");
      return;
    }
    if (output?.helperRuns.length || output?.output) {
      setActivePane("output");
      return;
    }
    if (selectedFile) {
      setActivePane("file");
      return;
    }
    if (codeBlocks.length > 0) {
      setActivePane("snippets");
      return;
    }
    if (!needsProjectBinding) {
      setActivePane("output");
    }
  }, [
    codeBlocks.length,
    diff?.changedFiles.length,
    needsProjectBinding,
    output?.helperRuns.length,
    output?.output,
    selectedFile,
  ]);

  const activeDraft = drafts[activeBlockIndex] ?? "";
  const approvalBlocked = selectedTurn?.trace?.status === "waiting_for_approval";
  const userInputBlocked = selectedTurn?.trace?.status === "waiting_for_user_input";
  const primaryPath = selectedFile?.path ?? changedFiles[0];
  const fileList = workbenchTree?.items.filter((item) => item.kind === "file") ?? [];

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
        </div>
        <div className="chat-code-workbench-toolbar">
          <div className="chat-code-workbench-actions">
            <button type="button" className="gc-button" onClick={onRefresh} disabled={loading || busy}>
              Refresh
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
          ) : fileList.length > 0 ? (
            <ul className="chat-code-workbench-tree" aria-label="Workbench file tree">
              {fileList.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    className={[
                      "gc-button",
                      "chat-code-workbench-tree-button",
                      selectedFile?.path === item.path ? "active" : "",
                    ].join(" ")}
                    onClick={() => onSelectFile(item.path)}
                  >
                    <span>{item.name}</span>
                    {item.changed ? <StatusChip tone="warning">changed</StatusChip> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="chat-code-workbench-empty">
              <p>No repo files are ready to inspect yet.</p>
              <p>Run a coding step or refresh once the session writes into the worktree.</p>
            </div>
          )}
        </section>

        <section className="chat-code-workbench-main">
          <div className="chat-code-workbench-pane-tabs" role="tablist" aria-label="Workbench panes">
            {[
              ["diff", "Diff"],
              ["output", "Output"],
              ["file", "Files"],
              ["snippets", "Draft snippets"],
            ].map(([paneId, label]) => (
              <button
                key={paneId}
                type="button"
                className={["gc-button", activePane === paneId ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setActivePane(paneId as "file" | "diff" | "output" | "snippets")}
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
                      {selectedFile.language} · {selectedFile.sizeBytes} bytes
                    </span>
                  </div>
                  <pre className="chat-code-workbench-pre">{selectedFile.content}</pre>
                </>
              ) : (
                <div className="chat-code-workbench-empty">
                  <p>No file is selected yet.</p>
                  <p>Pick a changed file or the first repo file in the worktree to inspect it here.</p>
                </div>
              )}
            </div>
          ) : null}

          {activePane === "diff" ? (
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
                    <pre className="chat-code-workbench-pre">{diff.diff}</pre>
                  ) : (
                    <div className="chat-code-workbench-empty">
                      <p>No diff is available yet.</p>
                      <p>Once the session edits the worktree, this pane becomes the main review surface.</p>
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
                    : "manual draft"}
                </span>
              </div>
              {codeBlocks.length > 0 ? (
                <div className="chat-code-workbench-tabs" role="tablist" aria-label="Draft snippets">
                  {codeBlocks.map((block, index) => (
                    <button
                      key={block.id}
                      type="button"
                      className={["gc-button", index === activeBlockIndex ? "active" : ""].filter(Boolean).join(" ")}
                      onClick={() => {
                        setActiveBlockIndex(index);
                        setHelperLanguage(normalizeSnippetLanguage(block.language));
                      }}
                    >
                      {block.language || "snippet"} {index + 1}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="chat-code-workbench-helper-row">
                <label className="chat-code-workbench-select">
                  <span>Helper runtime</span>
                  <select
                    value={helperLanguage}
                    onChange={(event) => setHelperLanguage(event.target.value as "javascript" | "typescript")}
                  >
                    <option value="typescript">TypeScript</option>
                    <option value="javascript">JavaScript</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => onRunHelperSnippet(helperLanguage, activeDraft)}
                  disabled={busy || activeDraft.trim().length === 0}
                >
                  Run helper
                </button>
              </div>
              <textarea
                className="chat-code-workbench-editor"
                value={activeDraft}
                onChange={(event) => {
                  const next = [...drafts];
                  next[activeBlockIndex] = event.target.value;
                  setDrafts(next);
                }}
                spellCheck={false}
                aria-label="Draft snippet editor"
              />
              <p className="chat-code-workbench-note">
                Draft snippets stay secondary. They are useful for transforms, parser checks, and quick validation, but
                they do not own the repo tree, diff, or main edit loop.
              </p>
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
    </section>
  );
}
