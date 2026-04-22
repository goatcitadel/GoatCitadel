import { useEffect, useMemo, useState } from "react";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import { MonacoDiffEditor } from "@goatcitadel/mission-control-shared/components/MonacoDiffEditor";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { WorkbenchFileTree } from "@goatcitadel/mission-control-shared/components/WorkbenchFileTree";
import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";

type WorkbenchPaneId = "files" | "selected-diff" | "repo-diff" | "output" | "snippets" | "artifact";

function CodeSourceChooser({
  availableProjects,
  selectedProjectCandidateId,
  sourceBindingBusy,
  onBindExistingProject,
  onImportProjectSource,
}: {
  availableProjects?: Array<{ projectId: string; name: string; workspacePath: string }>;
  selectedProjectCandidateId?: string;
  sourceBindingBusy?: boolean;
  onBindExistingProject?: (projectId: string) => Promise<unknown>;
  onImportProjectSource?: (input: {
    sourceType: "local_folder" | "github_repo";
    name?: string;
    sourcePath?: string;
    repoUrl?: string;
    ref?: string;
  }) => Promise<unknown>;
}) {
  const [activeTab, setActiveTab] = useState<"existing" | "local" | "github">(
    availableProjects?.length ? "existing" : "local",
  );
  const [existingProjectId, setExistingProjectId] = useState(
    selectedProjectCandidateId ?? availableProjects?.[0]?.projectId ?? "",
  );
  const [localPath, setLocalPath] = useState("");
  const [localName, setLocalName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [repoName, setRepoName] = useState("");

  useEffect(() => {
    if (selectedProjectCandidateId) {
      setExistingProjectId(selectedProjectCandidateId);
      return;
    }
    if (!existingProjectId && availableProjects?.[0]?.projectId) {
      setExistingProjectId(availableProjects[0].projectId);
    }
  }, [availableProjects, existingProjectId, selectedProjectCandidateId]);

  return (
    <section className="mc-next-code-source-picker">
      <div className="mc-next-panel-list-head">
        <strong>Choose a code source</strong>
        <span>{sourceBindingBusy ? "working…" : "required once per session"}</span>
      </div>
      <p className="mc-next-workbench-empty">
        Pick an existing project, import a local folder, or clone a GitHub repo into the workspace before opening the
        repo-backed workbench.
      </p>

      <div className="mc-next-panel-tab-row">
        {[
          ["existing", "Existing project"],
          ["local", "Local folder"],
          ["github", "GitHub repo"],
        ].map(([tabId, label]) => (
          <button
            key={tabId}
            type="button"
            className={`mc-next-panel-tab${activeTab === tabId ? " active" : ""}`}
            onClick={() => setActiveTab(tabId as typeof activeTab)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "existing" ? (
        <div className="mc-next-code-source-form">
          <label className="mc-next-code-source-field">
            <span>Project</span>
            <select value={existingProjectId} onChange={(event) => setExistingProjectId(event.target.value)}>
              <option value="">Select a project</option>
              {(availableProjects ?? []).map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name} · {project.workspacePath}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mc-next-panel-button primary"
            disabled={!existingProjectId || !onBindExistingProject || sourceBindingBusy}
            onClick={() => {
              if (!existingProjectId || !onBindExistingProject) {
                return;
              }
              void onBindExistingProject(existingProjectId).catch(() => undefined);
            }}
          >
            {sourceBindingBusy ? "Binding…" : "Bind project"}
          </button>
        </div>
      ) : null}

      {activeTab === "local" ? (
        <div className="mc-next-code-source-form">
          <label className="mc-next-code-source-field">
            <span>Folder path</span>
            <input
              value={localPath}
              onChange={(event) => setLocalPath(event.target.value)}
              placeholder="F:\\code\\my-project or .\\workspace\\demo"
            />
          </label>
          <label className="mc-next-code-source-field">
            <span>Project name (optional)</span>
            <input value={localName} onChange={(event) => setLocalName(event.target.value)} placeholder="Use folder name by default" />
          </label>
          <button
            type="button"
            className="mc-next-panel-button primary"
            disabled={!localPath.trim() || !onImportProjectSource || sourceBindingBusy}
            onClick={() => {
              if (!localPath.trim() || !onImportProjectSource) {
                return;
              }
              void onImportProjectSource({
                sourceType: "local_folder",
                sourcePath: localPath.trim(),
                name: localName.trim() || undefined,
              }).catch(() => undefined);
            }}
          >
            {sourceBindingBusy ? "Importing…" : "Import folder"}
          </button>
          <p className="mc-next-workbench-empty">
            Local folders outside the managed workspace are copied in. If the folder is not already a git repo, GoatCitadel
            initializes one so the workbench can diff and branch safely.
          </p>
        </div>
      ) : null}

      {activeTab === "github" ? (
        <div className="mc-next-code-source-form">
          <label className="mc-next-code-source-field">
            <span>Repo URL</span>
            <input
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git"
            />
          </label>
          <label className="mc-next-code-source-field">
            <span>Branch / ref (optional)</span>
            <input value={repoRef} onChange={(event) => setRepoRef(event.target.value)} placeholder="main" />
          </label>
          <label className="mc-next-code-source-field">
            <span>Project name (optional)</span>
            <input value={repoName} onChange={(event) => setRepoName(event.target.value)} placeholder="Use repo name by default" />
          </label>
          <button
            type="button"
            className="mc-next-panel-button primary"
            disabled={!repoUrl.trim() || !onImportProjectSource || sourceBindingBusy}
            onClick={() => {
              if (!repoUrl.trim() || !onImportProjectSource) {
                return;
              }
              void onImportProjectSource({
                sourceType: "github_repo",
                repoUrl: repoUrl.trim(),
                ref: repoRef.trim() || undefined,
                name: repoName.trim() || undefined,
              }).catch(() => undefined);
            }}
          >
            {sourceBindingBusy ? "Cloning…" : "Clone repo"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function NextCoworkPanel({ panel }: { panel: Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }> }) {
  const { viewModel, onRetryTurn, onStopTurn, onOpenTasks, onOpenDetails, onFocusComposer, onRefreshRunState } =
    panel.props;
  const [activeTab, setActiveTab] = useState<"plan" | "timeline" | "actions">("plan");

  return (
    <section className={`mc-next-cowork-panel${viewModel.empty ? " is-empty" : ""}`}>
      <header className="mc-next-cowork-head">
        <div>
          <p className="mc-next-panel-kicker">Cowork</p>
          <h4>{viewModel.headerTitle}</h4>
          <p>{viewModel.headerSummary}</p>
        </div>
        <div className="mc-next-cowork-toolbar">
          {onOpenDetails ? <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>Run details</button> : null}
          {onStopTurn ? <button type="button" className="mc-next-panel-button" onClick={onStopTurn}>Stop run</button> : null}
        </div>
      </header>

      <div className="mc-next-cowork-stage-strip">
        {viewModel.stageCards.map((item) => (
          <div key={`${item.label}-${item.value}`} className="mc-next-cowork-stage-card">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      <section className="mc-next-cowork-now">
        <p className="mc-next-panel-kicker">{viewModel.now.label}</p>
        <h5>{viewModel.now.title}</h5>
        <p>{viewModel.now.summary}</p>
        {viewModel.now.facts.length > 0 ? (
          <dl className="mc-next-cowork-facts">
            {viewModel.now.facts.map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      {viewModel.nextAction ? (
        <section className="mc-next-cowork-action-callout">
          <p className="mc-next-panel-kicker">Next operator action</p>
          <h5>{viewModel.nextAction.label}</h5>
          <p>{viewModel.nextAction.note}</p>
          <div className="mc-next-cowork-toolbar">
            {viewModel.nextAction.kind === "retry_turn" && onRetryTurn ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onRetryTurn}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {viewModel.nextAction.kind === "refresh_run_state" && onRefreshRunState ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onRefreshRunState}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {viewModel.nextAction.kind === "open_tasks" && onOpenTasks ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onOpenTasks}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {viewModel.nextAction.kind === "focus_composer" && onFocusComposer ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onFocusComposer}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {!["retry_turn", "refresh_run_state", "open_tasks", "focus_composer"].includes(viewModel.nextAction.kind) && onOpenDetails ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onOpenDetails}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="mc-next-panel-tab-row">
        {["plan", "timeline", "actions"].map((tab) => (
          <button
            key={tab}
            type="button"
            className={`mc-next-panel-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab as typeof activeTab)}
          >
            {tab === "plan" ? "Plan" : tab === "timeline" ? "Timeline" : "Operator actions"}
          </button>
        ))}
      </div>

      {activeTab === "plan" ? (
        <div className="mc-next-cowork-grid">
          <PanelList title="Plan" items={viewModel.planItems.items} emptyCopy="Cowork has not attached a visible plan yet." />
          <PanelList title="Roles / steps" items={viewModel.roleItems.items} emptyCopy="Role activity will land here when the run fans out." />
          <PanelList title="Outputs / tasks" items={viewModel.outputItems.items} emptyCopy="Outputs and attached tasks will appear here as the run produces them." />
        </div>
      ) : null}

      {activeTab === "timeline" ? (
        <PanelList title="Recent timeline" items={viewModel.timelineItems.items} emptyCopy="Recent checkpoints will appear here once the run starts moving." />
      ) : null}

      {activeTab === "actions" ? (
        <PanelList title="Operator actions" items={viewModel.operatorActionItems.items} emptyCopy="Operator actions will collect here when Cowork needs follow-up work." />
      ) : null}

      {viewModel.blockers.length > 0 ? (
        <section className="mc-next-cowork-blockers">
          <p className="mc-next-panel-kicker">Blockers</p>
          {viewModel.blockers.map((blocker) => (
            <article key={blocker.id} className="mc-next-cowork-blocker">
              <div className="mc-next-cowork-blocker-head">
                <strong>{blocker.title}</strong>
                {onOpenDetails ? <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>Details</button> : null}
              </div>
              <p>{blocker.summary}</p>
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}

function PanelList({
  title,
  items,
  emptyCopy,
}: {
  title: string;
  items: Array<{ id: string; title: string; status?: string | null; meta?: string | null; note?: string | null }>;
  emptyCopy: string;
}) {
  return (
    <section className="mc-next-panel-list">
      <p className="mc-next-panel-kicker">{title}</p>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <div className="mc-next-panel-list-head">
                <strong>{item.title}</strong>
                {item.status ? <span>{item.status}</span> : null}
              </div>
              {item.meta ? <p>{item.meta}</p> : null}
              {item.note ? <p>{item.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{emptyCopy}</p>
      )}
    </section>
  );
}

function extractCodeBlocks(content: string): Array<{ id: string; language: string; content: string }> {
  return Array.from(content.matchAll(/```([\w.+-]*)\n([\s\S]*?)```/g))
    .map((match, index) => ({
      id: `code-block-${index}`,
      language: match[1]?.trim() || "text",
      content: (match[2] ?? "").trim(),
    }))
    .filter((block) => block.content.length > 0);
}

function NextCodeWorkbenchPanel({ panel }: { panel: Extract<MissionThreadedWorkflowPanel, { kind: "code" }> }) {
  const {
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
    availableProjects,
    selectedProjectCandidateId,
    sourceBindingBusy,
    onBindExistingProject,
    onImportProjectSource,
    onCreateWorktree,
    onSelectFile,
    onDraftChange,
    onExpandedPathsChange,
    onRefresh,
    onSaveFile,
    onDiscardDraft,
    onRunHelperSnippet,
  } = panel.props;
  const codeBlocks = useMemo(() => extractCodeBlocks(selectedTurn?.assistantMessage?.content ?? ""), [selectedTurn?.assistantMessage?.content]);
  const readyForRepoOps = workbenchState?.worktreeStatus === "ready";
  const changedFiles = workbenchTree?.changedFiles ?? diff?.changedFiles ?? [];
  const [activePane, setActivePane] = useState<WorkbenchPaneId>("files");
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);

  useEffect(() => {
    setActiveBlockIndex(0);
  }, [codeBlocks.length, selectedTurn?.turnId]);

  useEffect(() => {
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
  }, [codeBlocks.length, diff?.changedFiles.length, generatedArtifact, hasDirtyDraft, output?.helperRuns.length, output?.output, selectedFile, selectedFileDiff]);

  const activeDraft = draftContent ?? selectedFile?.content ?? "";
  const currentLanguage = selectedFile?.language ?? selectedFileDiff?.language ?? "plaintext";
  const activeBlock = codeBlocks[activeBlockIndex] ?? null;

  return (
    <section className="mc-next-workbench-panel">
      <header className="mc-next-workbench-head">
        <div>
          <p className="mc-next-panel-kicker">Code</p>
          <h4>Workbench</h4>
          <p>
            {needsProjectBinding
              ? "Bind a project before this session can open a repo-backed workbench."
              : readyForRepoOps
                ? `Repo-first implementation surface for ${projectName ?? "bound project"}.`
                : `Project-bound workbench for ${projectName ?? "bound project"}. Create a worktree to begin repo operations.`}
          </p>
        </div>
        <div className="mc-next-workbench-toolbar">
          <StatusChip tone={needsProjectBinding ? "warning" : "success"}>
            {needsProjectBinding ? "Unbound" : "Project ready"}
          </StatusChip>
          <StatusChip tone={readyForRepoOps ? "success" : "warning"}>
            {workbenchState?.worktreeStatus ?? "uninitialized"}
          </StatusChip>
          {hasDirtyDraft ? <StatusChip tone="warning">Unsaved changes</StatusChip> : null}
        </div>
      </header>

      <div className="mc-next-workbench-action-row">
        <button type="button" className="mc-next-panel-button" onClick={onRefresh} disabled={loading || busy}>
          Refresh
        </button>
        <button type="button" className="mc-next-panel-button" onClick={onSaveFile} disabled={!selectedFile || !hasDirtyDraft || busy || saving}>
          {saving ? "Saving…" : "Save file"}
        </button>
        <button type="button" className="mc-next-panel-button" onClick={onDiscardDraft} disabled={!hasDirtyDraft}>
          Discard draft
        </button>
        <button type="button" className="mc-next-panel-button" onClick={onCreateWorktree} disabled={needsProjectBinding || readyForRepoOps || busy}>
          Create worktree
        </button>
      </div>

      {error ? <div className="mc-next-panel-banner warning">{error}</div> : null}

      <div className="mc-next-workbench-body">
        <aside className="mc-next-workbench-sidebar">
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
          ) : workbenchTree?.items?.length ? (
            <WorkbenchFileTree
              storageScopeKey={workbenchState?.sessionId ?? "workbench"}
              items={workbenchTree.items}
              selectedPath={selectedFile?.path}
              expandedPaths={expandedPaths ?? []}
              onExpandedPathsChange={onExpandedPathsChange}
              onSelectFile={onSelectFile}
            />
          ) : (
            <p className="mc-next-workbench-empty">No repo files are ready to inspect yet.</p>
          )}
        </aside>

        <section className="mc-next-workbench-main">
          <div className="mc-next-panel-tab-row">
            {[
              ["files", "Files"],
              ["selected-diff", "Selected diff"],
              ["repo-diff", "Repo diff"],
              ["output", "Output"],
              ["snippets", "Snippets"],
              ...(generatedArtifact ? [["artifact", "Artifact"]] : []),
            ].map(([paneId, label]) => (
              <button
                key={paneId}
                type="button"
                className={`mc-next-panel-tab${activePane === paneId ? " active" : ""}`}
                onClick={() => setActivePane(paneId as WorkbenchPaneId)}
              >
                {label}
              </button>
            ))}
          </div>

          {activePane === "files" ? (
            selectedFile ? (
              <div className="mc-next-workbench-pane">
                <div className="mc-next-panel-list-head">
                  <strong>{selectedFile.path}</strong>
                  <span>{selectedFile.language}</span>
                </div>
                <WorkbenchMonacoEditor value={activeDraft} language={selectedFile.language} height={520} onChange={onDraftChange} />
              </div>
            ) : (
              <div className="mc-next-workbench-empty">Pick a file in the tree to start editing it.</div>
            )
          ) : null}

          {activePane === "selected-diff" ? (
            selectedFile && selectedFileDiff ? (
              <div className="mc-next-workbench-pane">
                <div className="mc-next-panel-list-head">
                  <strong>Selected-file diff</strong>
                  <span>{selectedFile.path}</span>
                </div>
                <MonacoDiffEditor
                  language={currentLanguage}
                  original={selectedFileDiff.originalContent ?? selectedFile.content ?? ""}
                  modified={hasDirtyDraft ? activeDraft : (selectedFileDiff.modifiedContent ?? selectedFile.content ?? "")}
                  height={520}
                />
              </div>
            ) : (
              <div className="mc-next-workbench-empty">Choose a repo file to compare the editor against the current git base.</div>
            )
          ) : null}

          {activePane === "repo-diff" ? (
            diff ? (
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
              <div className="mc-next-workbench-empty">Create a worktree or refresh the session to populate repo changes.</div>
            )
          ) : null}

          {activePane === "output" ? (
            <div className="mc-next-workbench-pane">
              <div className="mc-next-panel-list-head">
                <strong>Output</strong>
                <span>{output?.helperRuns.length ?? 0} helper runs</span>
              </div>
              {output?.output ? <WorkbenchMonacoEditor value={output.output} language="markdown" readOnly height={240} /> : <p>No stdout or helper output yet.</p>}
              {output?.helperRuns.length ? (
                <ul className="mc-next-workbench-helper-list">
                  {output.helperRuns.map((run) => (
                    <li key={run.runId}>
                      <div className="mc-next-panel-list-head">
                        <strong>{run.language}</strong>
                        <span>{run.status}</span>
                      </div>
                      {run.stdoutPreview ? <p>{run.stdoutPreview}</p> : null}
                      {run.stderrPreview ? <p>{run.stderrPreview}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {activePane === "snippets" ? (
            activeBlock ? (
              <div className="mc-next-workbench-pane">
                <div className="mc-next-panel-list-head">
                  <strong>Snippet helper</strong>
                  <span>{activeBlock.language}</span>
                </div>
                <WorkbenchMonacoEditor value={activeBlock.content} language={activeBlock.language} readOnly height={320} />
                <div className="mc-next-workbench-action-row">
                  {codeBlocks.map((block, index) => (
                    <button key={block.id} type="button" className={`mc-next-panel-button${activeBlockIndex === index ? " active" : ""}`} onClick={() => setActiveBlockIndex(index)}>
                      Snippet {index + 1}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="mc-next-panel-button primary"
                    onClick={() => onRunHelperSnippet(activeBlock.language, activeBlock.content)}
                  >
                    Run helper snippet
                  </button>
                </div>
              </div>
            ) : (
              <div className="mc-next-workbench-empty">Code snippets from the latest assistant turn will appear here.</div>
            )
          ) : null}

          {activePane === "artifact" ? (
            generatedArtifact ? (
              <div className="mc-next-workbench-pane">
                <div className="mc-next-panel-list-head">
                  <strong>{generatedArtifact.title}</strong>
                  <button type="button" className="mc-next-panel-button" onClick={onCloseGeneratedArtifact}>
                    Close artifact
                  </button>
                </div>
                <GeneratedArtifactViewer artifact={generatedArtifact} />
              </div>
            ) : null
          ) : null}
        </section>
      </div>
    </section>
  );
}

export function ThreadedWorkflowPanel({ panel }: { panel: MissionThreadedWorkflowPanel }) {
  if (!panel) {
    return null;
  }
  return panel.kind === "cowork" ? <NextCoworkPanel panel={panel} /> : <NextCodeWorkbenchPanel panel={panel} />;
}
