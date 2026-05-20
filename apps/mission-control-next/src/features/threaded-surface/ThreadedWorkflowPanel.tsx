/* eslint-disable max-lines */
import { useEffect, useMemo, useState } from "react";
import type { CodeModeRunRecord } from "@goatcitadel/contracts";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import { fetchCodeModeRun, fetchCodeModeRuns } from "@goatcitadel/mission-control-shared/api/capabilities";
import { AgenticRuntimeVisibilityPanel } from "@goatcitadel/mission-control-shared/components/AgenticRuntimeVisibilityPanel";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { MonacoDiffEditor } from "@goatcitadel/mission-control-shared/components/MonacoDiffEditor";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { WorkbenchFileTree } from "@goatcitadel/mission-control-shared/components/WorkbenchFileTree";
import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";

type WorkbenchPaneId = "files" | "selected-diff" | "repo-diff" | "output" | "snippets" | "artifact";

type AgenticControlItem = NonNullable<
  Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>["props"]["viewModel"]["agenticRuntime"]
>["controls"][number];

interface CodeModeRunLedgerItem {
  runId: string;
  status?: string;
  language?: string;
  approvalId?: string;
  originSurface?: CodeModeRunRecord["originSurface"];
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  requestedOutputIntent?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

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
              placeholder="%USERPROFILE%\\code\\my-project or .\\workspace\\demo"
            />
          </label>
          <label className="mc-next-code-source-field">
            <span>Project name (optional)</span>
            <input
              value={localName}
              onChange={(event) => setLocalName(event.target.value)}
              placeholder="Use folder name by default"
            />
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
            Local folders outside the managed workspace are copied in. If the folder is not already a git repo,
            GoatCitadel initializes one so the workbench can diff and branch safely.
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
            <input
              value={repoName}
              onChange={(event) => setRepoName(event.target.value)}
              placeholder="Use repo name by default"
            />
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
  const {
    viewModel,
    onRetryTurn,
    onStopTurn,
    onOpenTasks,
    onOpenDetails,
    onFocusComposer,
    onRefreshRunState,
    onAgenticControl,
    agenticControlPending,
    agenticControlStatus,
  } = panel.props;
  const [activeTab, setActiveTab] = useState<"plan" | "run-map" | "timeline" | "actions">("plan");
  const activeTrace = viewModel.raw.selectedTurn?.trace ?? viewModel.raw.activeTurn?.trace ?? null;
  const pendingApproval = activeTrace?.pendingApprovalSummary;
  const requestedModel =
    activeTrace?.routing.primaryModel ?? activeTrace?.routing.fallbackModel ?? activeTrace?.model ?? "not requested";
  const effectiveModel = activeTrace?.routing.effectiveModel ?? activeTrace?.model ?? "not resolved";
  const activeAgentSummary = viewModel.agenticRuntime
    ? `${viewModel.agenticRuntime.nodeCount} runtime nodes`
    : `${viewModel.roleItems.items.length}${viewModel.roleItems.overflow ? "+" : ""} visible roles`;

  return (
    <section className={`mc-next-cowork-panel${viewModel.empty ? " is-empty" : ""}`}>
      <header className="mc-next-cowork-head">
        <div>
          <p className="mc-next-panel-kicker">Cowork</p>
          <h4>{viewModel.headerTitle}</h4>
          <p>{viewModel.headerSummary}</p>
        </div>
        <div className="mc-next-cowork-toolbar">
          {onOpenDetails ? (
            <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
              Run details
            </button>
          ) : null}
          {onStopTurn ? (
            <button type="button" className="mc-next-panel-button" onClick={onStopTurn}>
              Stop run
            </button>
          ) : null}
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

      <section className="mc-next-cowork-mission-brief" aria-label="Cowork mission brief">
        <div>
          <p className="mc-next-panel-kicker">Mission brief</p>
          <h5>{viewModel.runMap.objective || viewModel.headerTitle}</h5>
          <p>{viewModel.runMap.currentState || viewModel.now.summary}</p>
        </div>
        <dl>
          <div>
            <dt>Phase</dt>
            <dd>{viewModel.now.title}</dd>
          </div>
          <div>
            <dt>Active agents</dt>
            <dd>{activeAgentSummary}</dd>
          </div>
          <div>
            <dt>Blockers</dt>
            <dd>{viewModel.blockers.length || "None"}</dd>
          </div>
          <div>
            <dt>Approvals</dt>
            <dd>
              {pendingApproval ? (pendingApproval.description ?? pendingApproval.kind ?? "Pending") : "None pending"}
            </dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>{viewModel.evidenceSummary.detail}</dd>
          </div>
          <div>
            <dt>Requested model</dt>
            <dd>{requestedModel}</dd>
          </div>
          <div>
            <dt>Effective model</dt>
            <dd>{effectiveModel}</dd>
          </div>
          <div>
            <dt>Next action</dt>
            <dd>{viewModel.nextAction?.label ?? viewModel.runMap.nextAction}</dd>
          </div>
        </dl>
      </section>

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
            {!["retry_turn", "refresh_run_state", "open_tasks", "focus_composer"].includes(viewModel.nextAction.kind) &&
            onOpenDetails ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onOpenDetails}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="mc-next-panel-tab-row">
        {["plan", "run-map", "timeline", "actions"].map((tab) => (
          <button
            key={tab}
            type="button"
            className={`mc-next-panel-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab as typeof activeTab)}
          >
            {tab === "plan"
              ? "Plan"
              : tab === "run-map"
                ? "Run Map"
                : tab === "timeline"
                  ? "Timeline"
                  : "Operator actions"}
          </button>
        ))}
      </div>

      {activeTab === "plan" ? (
        <div className="mc-next-cowork-grid">
          <PanelList
            title="Plan"
            items={viewModel.planItems.items}
            emptyCopy="Cowork has not attached a visible plan yet."
          />
          <PanelList
            title="Roles / steps"
            items={viewModel.roleItems.items}
            emptyCopy="Role activity will land here when the run fans out."
          />
          <PanelList
            title="Outputs / tasks"
            items={viewModel.outputItems.items}
            emptyCopy="Outputs and attached tasks will appear here as the run produces them."
          />
        </div>
      ) : null}

      {activeTab === "run-map" ? <RunMapPanel viewModel={viewModel} onOpenDetails={onOpenDetails} /> : null}

      {activeTab === "timeline" ? (
        <PanelList
          title="Recent timeline"
          items={viewModel.timelineItems.items}
          emptyCopy="Recent checkpoints will appear here once the run starts moving."
        />
      ) : null}

      {activeTab === "actions" ? (
        <PanelList
          title="Operator actions"
          items={viewModel.operatorActionItems.items}
          emptyCopy="Operator actions will collect here when Cowork needs follow-up work."
        />
      ) : null}

      {viewModel.blockers.length > 0 ? (
        <section className="mc-next-cowork-blockers">
          <p className="mc-next-panel-kicker">Blockers</p>
          {viewModel.blockers.map((blocker) => (
            <article key={blocker.id} className="mc-next-cowork-blocker">
              <div className="mc-next-cowork-blocker-head">
                <strong>{blocker.title}</strong>
                {onOpenDetails ? (
                  <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
                    Details
                  </button>
                ) : null}
              </div>
              <p>{blocker.summary}</p>
            </article>
          ))}
        </section>
      ) : null}

      {viewModel.agenticRuntime ? (
        <AgenticRuntimePanel
          viewModel={viewModel}
          onAgenticControl={onAgenticControl}
          agenticControlPending={agenticControlPending}
          agenticControlStatus={agenticControlStatus}
        />
      ) : null}
    </section>
  );
}

function RunMapPanel({
  viewModel,
  onOpenDetails,
}: {
  viewModel: Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>["props"]["viewModel"];
  onOpenDetails?: () => void;
}) {
  const gate = viewModel.continuationGate;
  return (
    <section className="mc-next-cowork-run-map">
      <div className="mc-next-cowork-run-map-head">
        <div>
          <p className="mc-next-panel-kicker">Run map</p>
          <h5>{viewModel.runMap.objective}</h5>
          <p>{viewModel.runMap.currentState}</p>
        </div>
        <StatusChip
          tone={gate.decision === "continue" ? "success" : gate.decision === "checkpoint" ? "warning" : "critical"}
        >
          Gate: {gate.decision}
        </StatusChip>
      </div>

      <div className="mc-next-cowork-run-map-grid">
        <section>
          <p className="mc-next-panel-kicker">Current state</p>
          <strong>{viewModel.runMap.currentState}</strong>
          <span>{gate.summary}</span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">Next action</p>
          <strong>{viewModel.runMap.nextAction}</strong>
          <span>{gate.recommendedAction}</span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">State gaps</p>
          <strong>{viewModel.stateGaps.length ? `${viewModel.stateGaps.length} open` : "None"}</strong>
          <span>{viewModel.stateGaps.join(" · ") || "No state gaps detected in the current view."}</span>
        </section>
      </div>

      <div className="mc-next-cowork-run-map-graph" aria-label="Cowork plan graph">
        {viewModel.runMap.planNodes.map((node, index) => (
          <div key={node.id} className="mc-next-cowork-run-map-node-wrap">
            <article className="mc-next-cowork-run-map-node">
              <span>{node.status}</span>
              <strong>{node.label}</strong>
              {node.meta ? <p>{node.meta}</p> : null}
            </article>
            {index < viewModel.runMap.planNodes.length - 1 ? <span className="mc-next-cowork-run-map-link" /> : null}
          </div>
        ))}
      </div>

      <div className="mc-next-cowork-run-map-footer">
        <section>
          <p className="mc-next-panel-kicker">{viewModel.evidenceSummary.label}</p>
          <strong>{viewModel.evidenceSummary.detail}</strong>
          <span>
            Tool calls {gate.metrics.toolRunCount} · failures {gate.metrics.failedToolRunCount} · gaps{" "}
            {gate.metrics.evidenceGapCount}
          </span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">Checkpoint timeline</p>
          <strong>{viewModel.runMap.checkpoints.length} retained</strong>
          <span>{viewModel.runMap.checkpoints.map((item) => item.title).join(" -> ") || "No checkpoints yet."}</span>
        </section>
        {onOpenDetails ? (
          <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
            Inspect evidence
          </button>
        ) : null}
      </div>
    </section>
  );
}

function AgenticRuntimePanel({
  viewModel,
  onAgenticControl,
  agenticControlPending,
  agenticControlStatus,
}: {
  viewModel: Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>["props"]["viewModel"];
  onAgenticControl?: Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>["props"]["onAgenticControl"];
  agenticControlPending?: string | null;
  agenticControlStatus?: string | null;
}) {
  const runtime = viewModel.agenticRuntime;
  if (!runtime) {
    return null;
  }
  return (
    <section className="mc-next-cowork-run-map">
      <div className="mc-next-cowork-run-map-head">
        <div>
          <p className="mc-next-panel-kicker">Agentic runtime</p>
          <h5>{runtime.nodeCount} runtime nodes</h5>
          <p>
            Run {runtime.runId} · {runtime.edgeCount} links · generated {runtime.generatedAt}
          </p>
        </div>
      </div>
      <div className="mc-next-cowork-run-map-grid">
        <PanelList
          title="Run tree"
          items={runtime.treeNodes.map((node) => ({
            id: node.id,
            title: node.label,
            status: node.status,
            meta: node.meta,
          }))}
          emptyCopy="No runtime tree nodes are loaded."
        />
        <PanelList title="Diagnostics" items={runtime.diagnostics} emptyCopy="No diagnostics are active." />
        <AgenticRuntimeVisibilityPanel surface="cowork" className="mc-next-panel-list" deliveryLimit={8} />
        <section className="mc-next-panel-list">
          <p className="mc-next-panel-kicker">Controls</p>
          <p>
            State-only controls record durable operator intent. They do not live-pause or terminate an executor unless a
            running executor separately honors that recorded intent.
          </p>
          {agenticControlStatus ? <p>{agenticControlStatus}</p> : null}
          {runtime.controls.length > 0 ? (
            <ul>
              {runtime.controls.map((control) => {
                const controlCopy = describeAgenticControlCopy(control);
                return (
                  <li key={control.id}>
                    <div className="mc-next-panel-list-head">
                      <strong>{control.title}</strong>
                      {control.status ? <span>{control.status}</span> : null}
                    </div>
                    {control.meta ? <p>{control.meta}</p> : null}
                    {control.note ? <p>{control.note}</p> : null}
                    {controlCopy.intentNote ? <p>{controlCopy.intentNote}</p> : null}
                    {onAgenticControl ? (
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        disabled={!control.enabled || agenticControlPending === control.action}
                        onClick={() => onAgenticControl(control)}
                      >
                        {agenticControlPending === control.action ? "Recording..." : controlCopy.buttonLabel}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No runtime controls are available.</p>
          )}
        </section>
      </div>
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

export function extractCodeBlocks(content: string): Array<{ id: string; language: string; content: string }> {
  return Array.from(content.matchAll(/```([\w.+-]*)\n([\s\S]*?)```/g))
    .map((match, index) => ({
      id: `code-block-${index}`,
      language: match[1]?.trim() || "text",
      content: (match[2] ?? "").trim(),
    }))
    .filter((block) => block.content.length > 0);
}

export function isPendingPatchBlock(block: { language: string; content: string }): boolean {
  const language = block.language.trim().toLowerCase();
  const content = block.content.trim();
  return (
    (language === "diff" || language === "patch") &&
    (content.startsWith("diff --git ") || /^---\s+\S+/m.test(content)) &&
    /^\+\+\+\s+\S+/m.test(content)
  );
}

export function validationStatusTone(status?: string | null): "success" | "warning" | "critical" {
  if (status === "passed") {
    return "success";
  }
  if (status === "failed") {
    return "critical";
  }
  return "warning";
}

export function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatShortHash(value?: string): string {
  return value ? shortId(value) : "missing";
}

function formatOriginSurface(value?: CodeModeRunRecord["originSurface"]): string {
  if (value === "code") {
    return "Code";
  }
  if (value === "cowork") {
    return "Cowork";
  }
  if (value === "chat") {
    return "Chat";
  }
  return "not recorded";
}

function formatRunTimestamp(value?: string): string {
  if (!value) {
    return "not recorded";
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function formatSandboxPosture(value?: CodeModeRunRecord["sandbox"]): string {
  if (!value) {
    return "not recorded";
  }
  const failed = value.checksFailed.length ? ` · failed: ${value.checksFailed.join(", ")}` : "";
  const failClosed = value.failClosedReason ? ` · fail-closed: ${value.failClosedReason}` : "";
  const advisory = value.advisoryUnsandboxedReason ? ` · advisory: ${value.advisoryUnsandboxedReason}` : "";
  return `${value.isolationProfile} on ${value.platform} · ${
    value.required ? "required" : "not required"
  } · ${value.available ? "available" : "unavailable"}${failed}${failClosed}${advisory}`;
}

function formatRunPermissionProfile(value: CodeModeRunRecord): string {
  const label = value.permissionProfileLabel?.trim();
  const id = value.permissionProfileId?.trim();
  if (label && id && label !== id) {
    return `${label} (${shortId(id)})`;
  }
  return label || id || "not recorded";
}

function formatArtifactPath(value?: CodeModeRunRecord["codeArtifact"]): string {
  if (!value) {
    return "not recorded";
  }
  return `${value.relPath} · ${formatShortHash(value.sha256)}`;
}

const VALIDATION_COMMAND_PRESETS = [
  { label: "Typecheck", command: "pnpm typecheck" },
  { label: "Test", command: "pnpm test" },
  { label: "Lint", command: "pnpm lint" },
  { label: "Fast verify", command: "pnpm verify:fast" },
];

export function describeAgenticControlCopy(control: AgenticControlItem): { buttonLabel: string; intentNote?: string } {
  if (control.runtimeEffect !== "state_only") {
    return { buttonLabel: control.title };
  }
  const actionLabel =
    control.action === "pause"
      ? "Record pause intent"
      : control.action === "kill_child"
        ? "Record kill intent"
        : `Record ${control.title.toLowerCase()} intent`;
  return {
    buttonLabel: actionLabel,
    intentNote: "State-only: records intent in GoatCitadel state; it is not a live pause or kill signal by itself.",
  };
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
    onRunValidationCommand,
    onApplyPatch,
    onExportPatch,
    onRevertFile,
    onRevertAll,
    onRunHelperSnippet,
    onOpenApprovals,
    workspaceId,
  } = panel.props;
  const codeBlocks = useMemo(
    () => extractCodeBlocks(selectedTurn?.assistantMessage?.content ?? ""),
    [selectedTurn?.assistantMessage?.content],
  );
  const readyForRepoOps = workbenchState?.worktreeStatus === "ready";
  const changedFiles = workbenchTree?.changedFiles ?? diff?.changedFiles ?? [];
  const [activePane, setActivePane] = useState<WorkbenchPaneId>("files");
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const [validationCommand, setValidationCommand] = useState("pnpm test");
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [confirmRevertFilePath, setConfirmRevertFilePath] = useState<string | null>(null);
  const [confirmRevertAllOpen, setConfirmRevertAllOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runList, setRunList] = useState<CodeModeRunRecord[]>([]);
  const [runListLoading, setRunListLoading] = useState(false);
  const [runListError, setRunListError] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<CodeModeRunRecord | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const hasPatchDiff = Boolean(diff?.diff.trim());
  const activeBlock = codeBlocks[activeBlockIndex] ?? null;
  const activePatchBlock = activeBlock && isPendingPatchBlock(activeBlock) ? activeBlock : null;
  const codeLedgerSessionId = workbenchState?.sessionId ?? selectedTurn?.trace.sessionId ?? null;
  const codeLedgerTurnId = selectedTurn?.turnId ?? null;
  const codeLedgerWorkspaceId = workspaceId ?? null;
  const visibleRunItems = useMemo<CodeModeRunLedgerItem[]>(() => {
    const byId = new Map<string, CodeModeRunLedgerItem>();
    for (const run of runList) {
      if (codeLedgerTurnId && run.turnId && run.turnId !== codeLedgerTurnId) {
        continue;
      }
      byId.set(run.runId, run);
    }
    for (const helperRun of output?.helperRuns ?? []) {
      const helperRunTurnId =
        "turnId" in helperRun && typeof helperRun.turnId === "string" ? helperRun.turnId : undefined;
      if (codeLedgerTurnId && helperRunTurnId && helperRunTurnId !== codeLedgerTurnId) {
        continue;
      }
      const existing = byId.get(helperRun.runId);
      byId.set(helperRun.runId, { ...existing, ...helperRun });
    }
    return [...byId.values()].sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });
  }, [codeLedgerTurnId, output?.helperRuns, runList]);
  const visibleRunIds = useMemo(() => visibleRunItems.map((run) => run.runId).join("|"), [visibleRunItems]);
  const selectedRunSummary = useMemo(
    () => visibleRunItems.find((run) => run.runId === selectedRunId) ?? visibleRunItems[0] ?? null,
    [selectedRunId, visibleRunItems],
  );
  const selectedRunDetail = runDetail?.runId === selectedRunSummary?.runId ? runDetail : null;
  const selectedRunApprovalId = selectedRunDetail?.approvalId ?? selectedRunSummary?.approvalId;
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

  useEffect(() => {
    setActiveBlockIndex(0);
  }, [codeBlocks.length, selectedTurn?.turnId]);

  useEffect(() => {
    const runIds = visibleRunIds ? visibleRunIds.split("|").filter(Boolean) : [];
    if (runIds.length === 0) {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId((current) => (current && runIds.includes(current) ? current : runIds[0]!));
  }, [visibleRunIds]);

  useEffect(() => {
    if (!codeLedgerSessionId) {
      setRunList([]);
      setRunListError(null);
      setRunListLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRunListLoading(true);
    setRunListError(null);
    fetchCodeModeRuns({
      sessionId: codeLedgerSessionId,
      ...(codeLedgerWorkspaceId ? { workspaceId: codeLedgerWorkspaceId } : {}),
      ...(codeLedgerTurnId ? { turnId: codeLedgerTurnId } : {}),
      limit: 25,
    })
      .then((response) => {
        if (!cancelled) {
          setRunList(response.items);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunList([]);
          setRunListError(error instanceof Error ? error.message : "Unable to load Code Mode run ledger.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunListLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [codeLedgerSessionId, codeLedgerTurnId, codeLedgerWorkspaceId]);

  useEffect(() => {
    if (!selectedRunSummary?.runId) {
      setRunDetail(null);
      setRunDetailError(null);
      setRunDetailLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRunDetailLoading(true);
    setRunDetailError(null);
    setRunDetail(null);
    const detailFilters = {
      ...((selectedRunSummary.sessionId ?? codeLedgerSessionId)
        ? { sessionId: selectedRunSummary.sessionId ?? codeLedgerSessionId ?? undefined }
        : {}),
      ...(selectedRunSummary.turnId ? { turnId: selectedRunSummary.turnId } : {}),
      ...((selectedRunSummary.workspaceId ?? codeLedgerWorkspaceId)
        ? { workspaceId: selectedRunSummary.workspaceId ?? codeLedgerWorkspaceId ?? undefined }
        : {}),
    };
    fetchCodeModeRun(selectedRunSummary.runId, detailFilters)
      .then((detail) => {
        if (!cancelled) {
          setRunDetail(detail);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunDetail(null);
          setRunDetailError(error instanceof Error ? error.message : "Unable to load Code Mode run detail.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunSummary?.runId, codeLedgerSessionId, codeLedgerTurnId, codeLedgerWorkspaceId]);

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
  }, [
    codeBlocks.length,
    diff?.changedFiles.length,
    generatedArtifact,
    hasDirtyDraft,
    output?.helperRuns.length,
    output?.output,
    selectedFile,
    selectedFileDiff,
  ]);

  const activeDraft = draftContent ?? selectedFile?.content ?? "";
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
  const runValidationFromInput = () => runValidationCommandLine(validationCommand);

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
          <StatusChip tone={validationStatusTone(workbenchState?.validationStatus)}>
            Validation: {workbenchState?.validationStatus ?? "idle"}
          </StatusChip>
          {hasDirtyDraft ? <StatusChip tone="warning">Unsaved changes</StatusChip> : null}
        </div>
      </header>

      <div className="mc-next-workbench-action-row">
        <button type="button" className="mc-next-panel-button" onClick={onRefresh} disabled={loading || busy}>
          Refresh
        </button>
        <button
          type="button"
          className="mc-next-panel-button"
          onClick={onSaveFile}
          disabled={!selectedFile || !hasDirtyDraft || busy || saving}
        >
          {saving ? "Saving…" : "Save file"}
        </button>
        <button type="button" className="mc-next-panel-button" onClick={onDiscardDraft} disabled={!hasDirtyDraft}>
          Discard draft
        </button>
        <button
          type="button"
          className="mc-next-panel-button"
          onClick={onCreateWorktree}
          disabled={needsProjectBinding || readyForRepoOps || busy}
        >
          Create worktree
        </button>
        <input
          className="mc-next-workbench-command-input"
          value={validationCommand}
          onChange={(event) => setValidationCommand(event.target.value)}
          disabled={busy}
          aria-label="Validation command"
        />
        {VALIDATION_COMMAND_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="mc-next-panel-button"
            disabled={busy || Boolean(validationBlockedReason) || !onRunValidationCommand}
            title={validationBlockedReason ?? preset.command}
            onClick={() => {
              setValidationCommand(preset.command);
              runValidationCommandLine(preset.command);
            }}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          className="mc-next-panel-button"
          onClick={runValidationFromInput}
          disabled={busy || Boolean(validationBlockedReason) || !onRunValidationCommand}
          title={
            validationBlockedReason ?? (!onRunValidationCommand ? "Validation backend is unavailable." : undefined)
          }
        >
          Test
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
        <button
          type="button"
          className="mc-next-panel-button"
          onClick={() => {
            if (selectedFile?.path) {
              setConfirmRevertFilePath(selectedFile.path);
            }
          }}
          disabled={busy || Boolean(selectedRevertBlockedReason) || !onRevertFile}
          title={selectedRevertBlockedReason ?? (!onRevertFile ? "File revert backend is unavailable." : undefined)}
        >
          Revert file
        </button>
        <button
          type="button"
          className="mc-next-panel-button"
          onClick={() => setConfirmRevertAllOpen(true)}
          disabled={busy || Boolean(allRevertBlockedReason) || !onRevertAll}
          title={allRevertBlockedReason ?? (!onRevertAll ? "Revert backend is unavailable." : undefined)}
        >
          Revert all
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
              onSelectFile={requestFileSelection}
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
              ["output", "Run log"],
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
                <WorkbenchMonacoEditor
                  value={activeDraft}
                  language={selectedFile.language}
                  height={520}
                  onChange={onDraftChange}
                />
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
                  modified={
                    hasDirtyDraft ? activeDraft : (selectedFileDiff.modifiedContent ?? selectedFile.content ?? "")
                  }
                  height={520}
                />
              </div>
            ) : (
              <div className="mc-next-workbench-empty">
                Choose a repo file to compare the editor against the current git base.
              </div>
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
              <div className="mc-next-workbench-empty">
                Create a worktree or refresh the session to populate repo changes.
              </div>
            )
          ) : null}

          {activePane === "output" ? (
            <div className="mc-next-workbench-pane">
              <div className="mc-next-panel-list-head">
                <strong>Run log</strong>
                <span>{visibleRunItems.length} Code Mode runs</span>
              </div>
              {output?.output ? (
                <WorkbenchMonacoEditor value={output.output} language="markdown" readOnly height={240} />
              ) : (
                <p>No run log or helper output yet.</p>
              )}
              {visibleRunItems.length ? (
                <ul className="mc-next-workbench-helper-list">
                  {visibleRunItems.map((run) => (
                    <li key={run.runId}>
                      <div className="mc-next-panel-list-head">
                        <strong>{run.language ?? "Code Mode"}</strong>
                        <span>{run.status ?? "recorded"}</span>
                      </div>
                      <p>
                        {shortId(run.runId)}
                        {run.requestedOutputIntent ? ` · ${run.requestedOutputIntent}` : ""}
                      </p>
                      {run.stdoutPreview ? <p>{run.stdoutPreview}</p> : null}
                      {run.stderrPreview ? <p>{run.stderrPreview}</p> : null}
                      <button
                        type="button"
                        className={`mc-next-panel-button${selectedRunSummary?.runId === run.runId ? " active" : ""}`}
                        onClick={() => setSelectedRunId(run.runId)}
                      >
                        Inspect run
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {selectedRunSummary ? (
                <section className="mc-next-workbench-run-detail">
                  <div className="mc-next-panel-list-head">
                    <strong>Code Mode run detail</strong>
                    <span>{shortId(selectedRunSummary.runId)}</span>
                  </div>
                  {runDetailLoading ? <p>Loading run detail...</p> : null}
                  {runDetailError ? <div className="mc-next-panel-banner warning">{runDetailError}</div> : null}
                  {!selectedRunDetail && selectedRunApprovalId ? (
                    <ul className="mc-next-context-list">
                      <li>
                        <strong>Approval</strong>
                        <p>{selectedRunApprovalId}</p>
                        {onOpenApprovals ? (
                          <button
                            type="button"
                            className="mc-next-panel-button"
                            onClick={() => onOpenApprovals(selectedRunApprovalId)}
                          >
                            Open approval queue
                          </button>
                        ) : null}
                      </li>
                    </ul>
                  ) : null}
                  {selectedRunDetail ? (
                    <>
                      <ul className="mc-next-context-list">
                        <li>
                          <strong>Status</strong>
                          <p>{selectedRunDetail.status}</p>
                        </li>
                        <li>
                          <strong>Approval</strong>
                          <p>{selectedRunApprovalId ?? "not linked"}</p>
                          {selectedRunApprovalId && onOpenApprovals ? (
                            <button
                              type="button"
                              className="mc-next-panel-button"
                              onClick={() => onOpenApprovals(selectedRunApprovalId)}
                            >
                              Open approval queue
                            </button>
                          ) : null}
                        </li>
                        <li>
                          <strong>Permission profile</strong>
                          <p>{formatRunPermissionProfile(selectedRunDetail)}</p>
                        </li>
                        <li>
                          <strong>Local Operator Override</strong>
                          <p>{selectedRunDetail.localOperatorOverrideId ?? "not recorded"}</p>
                        </li>
                        <li>
                          <strong>Surface</strong>
                          <p>{formatOriginSurface(selectedRunDetail.originSurface)}</p>
                        </li>
                        <li>
                          <strong>Created</strong>
                          <p>{formatRunTimestamp(selectedRunDetail.createdAt)}</p>
                        </li>
                        <li>
                          <strong>Started</strong>
                          <p>{formatRunTimestamp(selectedRunDetail.startedAt)}</p>
                        </li>
                        <li>
                          <strong>Finished</strong>
                          <p>{formatRunTimestamp(selectedRunDetail.finishedAt)}</p>
                        </li>
                        <li>
                          <strong>Sandbox posture</strong>
                          <p>{formatSandboxPosture(selectedRunDetail.sandbox)}</p>
                        </li>
                        <li>
                          <strong>Source hash</strong>
                          <p>{formatShortHash(selectedRunDetail.codeHash)}</p>
                        </li>
                        <li>
                          <strong>Input hash</strong>
                          <p>{formatShortHash(selectedRunDetail.codeModeInputHash)}</p>
                        </li>
                        <li>
                          <strong>Wrapper hash</strong>
                          <p>{formatShortHash(selectedRunDetail.wrapperManifestHash)}</p>
                        </li>
                        <li>
                          <strong>Policy hash</strong>
                          <p>{formatShortHash(selectedRunDetail.policySnapshotHash)}</p>
                        </li>
                        <li>
                          <strong>Source artifact</strong>
                          <p>{formatArtifactPath(selectedRunDetail.codeArtifact)}</p>
                        </li>
                        <li>
                          <strong>Wrapper artifact</strong>
                          <p>{formatArtifactPath(selectedRunDetail.wrapperManifestArtifact)}</p>
                        </li>
                        <li>
                          <strong>Policy artifact</strong>
                          <p>{formatArtifactPath(selectedRunDetail.policySnapshotArtifact)}</p>
                        </li>
                        <li>
                          <strong>Stdout artifact</strong>
                          <p>{formatArtifactPath(selectedRunDetail.stdoutArtifact)}</p>
                        </li>
                        <li>
                          <strong>Stderr artifact</strong>
                          <p>{formatArtifactPath(selectedRunDetail.stderrArtifact)}</p>
                        </li>
                      </ul>
                      {selectedRunDetail.stdoutPreview ? (
                        <div className="mc-next-workbench-output-preview">
                          <strong>Stdout preview{selectedRunDetail.stdoutTruncated ? " (truncated)" : ""}</strong>
                          <WorkbenchMonacoEditor
                            value={selectedRunDetail.stdoutPreview}
                            language="text"
                            readOnly
                            height={120}
                          />
                        </div>
                      ) : null}
                      {selectedRunDetail.stderrPreview ? (
                        <div className="mc-next-workbench-output-preview">
                          <strong>Stderr preview{selectedRunDetail.stderrTruncated ? " (truncated)" : ""}</strong>
                          <WorkbenchMonacoEditor
                            value={selectedRunDetail.stderrPreview}
                            language="text"
                            readOnly
                            height={120}
                          />
                        </div>
                      ) : null}
                      {selectedRunDetail.result ? (
                        <WorkbenchMonacoEditor
                          value={JSON.stringify(selectedRunDetail.result, null, 2)}
                          language="json"
                          readOnly
                          height={180}
                        />
                      ) : null}
                      {selectedRunDetail.errorCode ? (
                        <div className="mc-next-panel-banner warning">
                          {selectedRunDetail.errorCode}
                          {selectedRunDetail.errorDetails ? ` · ${JSON.stringify(selectedRunDetail.errorDetails)}` : ""}
                        </div>
                      ) : null}
                      {selectedRunDetail.error ? (
                        <div className="mc-next-panel-banner warning">{selectedRunDetail.error}</div>
                      ) : null}
                    </>
                  ) : null}
                </section>
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
                    onClick={() => onRunHelperSnippet(activeBlock.language, activeBlock.content)}
                  >
                    Run helper snippet
                  </button>
                </div>
              </div>
            ) : (
              <div className="mc-next-workbench-empty">
                Code snippets from the latest assistant turn will appear here.
              </div>
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
        <aside className="mc-next-workbench-sidebar">
          <section className="mc-next-panel-list">
            <div className="mc-next-panel-list-head">
              <strong>Task traceability</strong>
              <span>{selectedTurn?.turnId ? shortId(selectedTurn.turnId) : "no turn"}</span>
            </div>
            <ul>
              <li>
                <strong>Session</strong>
                <p>{workbenchState?.sessionId ?? selectedTurn?.trace.sessionId ?? "not linked"}</p>
              </li>
              <li>
                <strong>Worktree</strong>
                <p>{workbenchState?.worktreePath ?? "not created"}</p>
              </li>
              <li>
                <strong>Validation</strong>
                <p>{workbenchState?.validationStatus ?? "idle"}</p>
              </li>
              <li>
                <strong>Result</strong>
                <p>
                  {changedFiles.length} changed files · {output?.helperRuns.length ?? 0} command records
                </p>
              </li>
            </ul>
          </section>
          <section className="mc-next-panel-list">
            <div className="mc-next-panel-list-head">
              <strong>Code Mode ledger</strong>
              <span>{runListLoading ? "loading" : `${visibleRunItems.length} runs`}</span>
            </div>
            {runListError ? <div className="mc-next-panel-banner warning">{runListError}</div> : null}
            {visibleRunItems.length ? (
              <ul>
                {visibleRunItems.slice(0, 5).map((run) => (
                  <li key={run.runId}>
                    <strong>{shortId(run.runId)}</strong>
                    <p>
                      {run.language ?? "Code Mode"} · {run.status ?? "recorded"}
                      {run.createdAt ? ` · ${new Date(run.createdAt).toLocaleTimeString()}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No Code Mode runs have been captured yet.</p>
            )}
          </section>
          <AgenticRuntimeVisibilityPanel surface="code" className="mc-next-panel-list" deliveryLimit={3} />
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

export function ThreadedWorkflowPanel({ panel }: { panel: MissionThreadedWorkflowPanel }) {
  if (!panel) {
    return null;
  }
  return panel.kind === "cowork" ? <NextCoworkPanel panel={panel} /> : <NextCodeWorkbenchPanel panel={panel} />;
}
