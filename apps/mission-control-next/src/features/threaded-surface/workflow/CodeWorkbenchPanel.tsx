/* eslint-disable max-lines */
import { ChevronDown, ChevronRight, PanelRightOpen, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  CodeModeRunArtifactKind,
  CodeModeRunArtifactPreview,
  CodeModeRunComparisonRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeRunRecord,
} from "@goatcitadel/contracts";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import {
  compareCodeModeRuns,
  fetchCodeModeExecutionBackends,
  fetchCodeModeRun,
  fetchCodeModeRunArtifact,
  fetchCodeModeRuns,
} from "@goatcitadel/mission-control-shared/api/capabilities";
import { AgenticRuntimeVisibilityPanel } from "@goatcitadel/mission-control-shared/components/AgenticRuntimeVisibilityPanel";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { MonacoDiffEditor } from "@goatcitadel/mission-control-shared/components/MonacoDiffEditor";
import { StatusChip } from "../../native-routes/primitives";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { useOptionalStableHandler, useStableHandler } from "../useStableHandler";
import { WorkbenchFileActionForm } from "./WorkbenchFileActionForm";
import { WorkbenchFilePicker } from "./WorkbenchFilePicker";
import { DEFAULT_VALIDATION_COMMAND, WorkbenchValidationControls } from "./WorkbenchValidationControls";
import { WorkbenchFileTree } from "@goatcitadel/mission-control-shared/components/WorkbenchFileTree";
import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import {
  getValidationCommandPresets,
  type CodeModeRunLedgerItem,
  type WorkbenchPaneId,
  extractCodeBlocks,
  formatArtifactPath,
  formatOriginSurface,
  formatExecutionBackend,
  formatRunPermissionProfile,
  formatRunTimestamp,
  formatSandboxPosture,
  formatShortHash,
  isPendingPatchBlock,
  shortId,
  validationStatusTone,
} from "./format";

type CodePanelType = Extract<MissionThreadedWorkflowPanel, { kind: "code" }>;

const CODE_WORKBENCH_LAYOUT_STORAGE_KEY = "goatcitadel.code-workbench.layout.v1";
const CODE_WORKBENCH_INSPECTOR_STORAGE_KEY = "goatcitadel.code-workbench.inspector.v1";
const DEFAULT_FILE_PANE_PERCENT = 28;
const EMPTY_CHANGED_FILES: string[] = [];
const CODE_MODE_ARTIFACT_KINDS: Array<{ kind: CodeModeRunArtifactKind; label: string }> = [
  { kind: "source", label: "Source" },
  { kind: "wrapper_manifest", label: "Wrapper" },
  { kind: "policy_snapshot", label: "Policy" },
  { kind: "stdout", label: "Stdout" },
  { kind: "stderr", label: "Stderr" },
  { kind: "aider_request", label: "Aider request" },
  { kind: "aider_invocation_plan", label: "Aider plan" },
  { kind: "aider_result_envelope", label: "Aider result" },
  { kind: "aider_patch", label: "Aider patch" },
  { kind: "aider_stdout", label: "Aider stdout" },
  { kind: "aider_stderr", label: "Aider stderr" },
];

function readStoredFilePanePercent(): number {
  if (typeof window === "undefined") {
    return DEFAULT_FILE_PANE_PERCENT;
  }
  const parsed = Number(window.localStorage.getItem(CODE_WORKBENCH_LAYOUT_STORAGE_KEY));
  return Number.isFinite(parsed) && parsed >= 18 && parsed <= 42 ? parsed : DEFAULT_FILE_PANE_PERCENT;
}

type CodeSourceTabId = "existing" | "local" | "github";
type CodeInspectorSectionId =
  | "progress"
  | "environment"
  | "changes"
  | "local"
  | "actions"
  | "browser"
  | "sources"
  | "ledger"
  | "runtime";

interface CodeInspectorRow {
  label: string;
  value: string;
  tone?: "good" | "warning" | "danger" | "muted";
  title?: string;
}

interface CodeInspectorSection {
  id: CodeInspectorSectionId;
  label: string;
  summary: string;
  rows: CodeInspectorRow[];
  extra?: ReactNode;
}

const CODE_SOURCE_TAB_DEFS: ReadonlyArray<{ id: CodeSourceTabId; label: string }> = [
  { id: "existing", label: "Existing project" },
  { id: "local", label: "Local folder" },
  { id: "github", label: "GitHub repo" },
];

function readStoredInspectorSections(): Set<CodeInspectorSectionId> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CODE_WORKBENCH_INSPECTOR_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((value): value is CodeInspectorSectionId =>
        ["progress", "environment", "changes", "local", "actions", "browser", "sources", "ledger", "runtime"].includes(
          value,
        ),
      ),
    );
  } catch {
    return new Set();
  }
}

function formatOptionalText(value: unknown, fallback = "not recorded"): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function formatAvailability(
  blockedReason: string | null | undefined,
  unavailableReason?: string,
): Omit<CodeInspectorRow, "label"> {
  if (unavailableReason) {
    return { value: unavailableReason, tone: "muted" };
  }
  return blockedReason ? { value: blockedReason, tone: "warning" } : { value: "Available", tone: "good" };
}

function formatProviderModelSummaryFromTurn(selectedTurn: CodePanelType["props"]["selectedTurn"]): string {
  const trace = selectedTurn?.trace as { model?: unknown; routing?: Record<string, unknown> } | undefined;
  const routing = trace?.routing;
  const provider = formatOptionalText(
    routing?.effectiveProviderId ?? routing?.primaryProviderId ?? routing?.requestedProviderId,
    "",
  );
  const model = formatOptionalText(
    routing?.effectiveModel ?? trace?.model ?? routing?.primaryModel ?? routing?.requestedModel,
    "",
  );
  if (provider && model) {
    return `${provider} / ${model}`;
  }
  return provider || model || "provider/model pending";
}

type CodeWorkbenchPaneDef = { id: WorkbenchPaneId; label: string };

function buildWorkbenchPaneDefs(includeArtifact: boolean): ReadonlyArray<CodeWorkbenchPaneDef> {
  const base: CodeWorkbenchPaneDef[] = [
    { id: "files", label: "Files" },
    { id: "selected-diff", label: "Selected diff" },
    { id: "repo-diff", label: "Repo diff" },
    { id: "review-packet", label: "Review packet" },
    { id: "output", label: "Run log" },
    { id: "snippets", label: "Snippets" },
  ];
  if (includeArtifact) {
    base.push({ id: "artifact", label: "Artifact" });
  }
  return base;
}

function CodeSessionInspector({
  expandedSections,
  onClose,
  onToggleSection,
  sections,
  variant,
}: {
  expandedSections: Set<CodeInspectorSectionId>;
  onClose?: () => void;
  onToggleSection: (sectionId: CodeInspectorSectionId, open: boolean) => void;
  sections: CodeInspectorSection[];
  variant: "inline" | "drawer";
}) {
  return (
    <section className="mc-next-code-session-inspector" data-variant={variant} aria-label="Code session inspector">
      <header className="mc-next-code-session-inspector-head">
        <div>
          <p className="mc-next-panel-kicker">Session inspector</p>
          <h5>Code context</h5>
        </div>
        {onClose ? (
          <button type="button" className="mc-next-panel-button icon" aria-label="Close inspector" onClick={onClose}>
            <X size={14} />
          </button>
        ) : null}
      </header>
      <div className="mc-next-code-session-inspector-stack">
        {sections.map((section) => {
          const expanded = expandedSections.has(section.id);
          return (
            <details
              key={section.id}
              className="mc-next-code-session-inspector-section"
              open={expanded}
              onToggle={(event) => onToggleSection(section.id, event.currentTarget.open)}
            >
              <summary>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{section.label}</span>
                <em>{section.summary}</em>
              </summary>
              <div className="mc-next-code-session-inspector-rows">
                {section.rows.map((row) => (
                  <div key={`${section.id}-${row.label}`} className="mc-next-code-session-inspector-row">
                    <span>{row.label}</span>
                    <strong data-tone={row.tone ?? "muted"} title={row.title}>
                      {row.value}
                    </strong>
                  </div>
                ))}
                {section.extra ? <div className="mc-next-code-session-inspector-extra">{section.extra}</div> : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
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
  const [activeTab, setActiveTab] = useState<CodeSourceTabId>(availableProjects?.length ? "existing" : "local");
  const [existingProjectId, setExistingProjectId] = useState(
    selectedProjectCandidateId ?? availableProjects?.[0]?.projectId ?? "",
  );
  const [localPath, setLocalPath] = useState("");
  const [localName, setLocalName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [repoName, setRepoName] = useState("");
  const sourceTabIdPrefix = useId();
  const sourceTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeSourceTabIndex = CODE_SOURCE_TAB_DEFS.findIndex((tab) => tab.id === activeTab);
  const focusSourceTabAt = useCallback((index: number) => {
    const wrapped = ((index % CODE_SOURCE_TAB_DEFS.length) + CODE_SOURCE_TAB_DEFS.length) % CODE_SOURCE_TAB_DEFS.length;
    const nextTab = CODE_SOURCE_TAB_DEFS[wrapped];
    if (!nextTab) {
      return;
    }
    setActiveTab(nextTab.id);
    queueMicrotask(() => {
      sourceTabRefs.current[wrapped]?.focus();
    });
  }, []);
  const handleSourceTabKeyDown = useCallback(
    (index: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          focusSourceTabAt(index + 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          focusSourceTabAt(index - 1);
          break;
        case "Home":
          event.preventDefault();
          focusSourceTabAt(0);
          break;
        case "End":
          event.preventDefault();
          focusSourceTabAt(CODE_SOURCE_TAB_DEFS.length - 1);
          break;
        default:
          break;
      }
    },
    [focusSourceTabAt],
  );
  const buildSourceTabId = (tabId: CodeSourceTabId) => `${sourceTabIdPrefix}-code-source-tab-${tabId}`;
  const buildSourcePanelId = (tabId: CodeSourceTabId) => `${sourceTabIdPrefix}-code-source-panel-${tabId}`;

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

      <div className="mc-next-panel-tab-row" role="tablist" aria-label="Code source type">
        {CODE_SOURCE_TAB_DEFS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                sourceTabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={buildSourceTabId(tab.id)}
              aria-selected={selected}
              aria-controls={buildSourcePanelId(tab.id)}
              tabIndex={index === activeSourceTabIndex ? 0 : -1}
              className={`mc-next-panel-tab${selected ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={handleSourceTabKeyDown(index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "existing" ? (
        <div
          className="mc-next-code-source-form"
          role="tabpanel"
          id={buildSourcePanelId("existing")}
          aria-labelledby={buildSourceTabId("existing")}
        >
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
        <div
          className="mc-next-code-source-form"
          role="tabpanel"
          id={buildSourcePanelId("local")}
          aria-labelledby={buildSourceTabId("local")}
        >
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
        <div
          className="mc-next-code-source-form"
          role="tabpanel"
          id={buildSourcePanelId("github")}
          aria-labelledby={buildSourceTabId("github")}
        >
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

function isCodeModeArtifactAvailable(run: CodeModeRunRecord, artifactKind: CodeModeRunArtifactKind): boolean {
  if (artifactKind === "stdout") {
    return Boolean(run.stdoutArtifact);
  }
  if (artifactKind === "stderr") {
    return Boolean(run.stderrArtifact);
  }
  if (artifactKind.startsWith("aider_")) {
    return isAiderArtifactAvailable(run, artifactKind);
  }
  return true;
}

function isAiderArtifactAvailable(run: CodeModeRunRecord, artifactKind: CodeModeRunArtifactKind): boolean {
  const adapter = readAiderAdapterResult(run);
  if (!adapter) {
    return false;
  }
  if (artifactKind === "aider_request") {
    return isRecord(adapter.requestArtifact);
  }
  if (artifactKind === "aider_invocation_plan") {
    return isRecord(adapter.invocationPlanArtifact);
  }
  if (artifactKind === "aider_result_envelope") {
    return isRecord(adapter.resultEnvelopeArtifact);
  }
  const envelope = isRecord(adapter.envelope) ? adapter.envelope : undefined;
  if (!envelope) {
    return false;
  }
  if (artifactKind === "aider_patch") {
    const patch = envelope.patchArtifact;
    return isRecord(patch) && isRecord(patch.artifact);
  }
  if (artifactKind === "aider_stdout") {
    return isRecord(envelope.stdoutArtifact);
  }
  if (artifactKind === "aider_stderr") {
    return isRecord(envelope.stderrArtifact);
  }
  return false;
}

function readAiderAdapterResult(run: CodeModeRunRecord): Record<string, unknown> | undefined {
  const result = run.result;
  if (!isRecord(result)) {
    return undefined;
  }
  const adapter = result.aiderAdapter;
  return isRecord(adapter) ? adapter : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatCodeModeArtifactKind(artifactKind: CodeModeRunArtifactKind): string {
  return CODE_MODE_ARTIFACT_KINDS.find((item) => item.kind === artifactKind)?.label ?? artifactKind;
}

function codeModeArtifactLanguage(run: CodeModeRunRecord, artifactKind: CodeModeRunArtifactKind): string {
  if (artifactKind === "source") {
    return run.language === "javascript" ? "javascript" : "typescript";
  }
  if (artifactKind === "wrapper_manifest" || artifactKind === "policy_snapshot") {
    return "json";
  }
  if (artifactKind === "aider_request") {
    return "markdown";
  }
  if (artifactKind === "aider_invocation_plan" || artifactKind === "aider_result_envelope") {
    return "json";
  }
  if (artifactKind === "aider_patch") {
    return "diff";
  }
  return "text";
}

function codeModeComparisonRows(comparison: CodeModeRunComparisonRecord): Array<{ label: string; matched: boolean }> {
  return [
    { label: "Capability snapshot", matched: comparison.matches.capabilitySnapshot },
    { label: "Submitted source", matched: comparison.matches.source },
    { label: "Frozen input", matched: comparison.matches.input },
    { label: "Wrapper manifest", matched: comparison.matches.wrapperManifest },
    { label: "Policy snapshot", matched: comparison.matches.policySnapshot },
    { label: "Permission profile", matched: comparison.matches.permissionProfile },
    { label: "Local override", matched: comparison.matches.localOperatorOverride },
    { label: "Sandbox runner", matched: comparison.matches.sandboxRunner },
    { label: "Sandbox profile", matched: comparison.matches.sandboxProfile },
    { label: "Sandbox availability", matched: comparison.matches.sandboxAvailability },
  ];
}

function summarizeValidationForReview(
  validationStatus: string | undefined,
  output: CodePanelType["props"]["output"],
  helperRunCount: number,
): {
  status: string;
  command: string;
  skipped: string;
  detail: string;
  tone: "good" | "warning" | "danger" | "muted";
} {
  const validation = output?.validation;
  const status = validation?.status ?? validationStatus ?? "idle";
  const command =
    validation?.commandLabel ??
    (helperRunCount > 0
      ? `${helperRunCount} Code Mode helper run${helperRunCount === 1 ? "" : "s"} recorded`
      : "No validation command recorded");
  const skipped =
    validation?.status === "skipped"
      ? (validation.reason ?? "Validation was skipped.")
      : validation
        ? "No skipped validation recorded."
        : "Tests skipped or not yet recorded in this workbench.";
  const duration = validation?.durationMs ? ` · ${Math.round(validation.durationMs / 100) / 10}s` : "";
  const validationChangedFiles = validation?.changedFiles ?? EMPTY_CHANGED_FILES;
  const detail = validationChangedFiles.length
    ? `${validationChangedFiles.length} changed file${validationChangedFiles.length === 1 ? "" : "s"} covered${duration}`
    : validation
      ? `No changed-file coverage recorded${duration}`
      : "Run validation from this workbench to attach concrete proof.";
  return {
    status,
    command,
    skipped,
    detail,
    tone: status === "passed" ? "good" : status === "failed" ? "danger" : status === "idle" ? "muted" : "warning",
  };
}

function codeModeArtifactReviewRows(run: CodeModeRunRecord | null): Array<{ label: string; value: string }> {
  return [
    { label: "Source", value: formatArtifactPath(run?.codeArtifact) },
    { label: "Wrapper", value: formatArtifactPath(run?.wrapperManifestArtifact) },
    { label: "Policy", value: formatArtifactPath(run?.policySnapshotArtifact) },
    { label: "Stdout", value: formatArtifactPath(run?.stdoutArtifact) },
    { label: "Stderr", value: formatArtifactPath(run?.stderrArtifact) },
  ];
}

export function NextCodeWorkbenchPanel({ panel }: { panel: CodePanelType }) {
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
    onFileOperation,
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
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [confirmRevertFilePath, setConfirmRevertFilePath] = useState<string | null>(null);
  const [confirmRevertAllOpen, setConfirmRevertAllOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [runList, setRunList] = useState<CodeModeRunRecord[]>([]);
  const [runListLoading, setRunListLoading] = useState(false);
  const [runListError, setRunListError] = useState<string | null>(null);
  const [executionBackends, setExecutionBackends] = useState<CodeModeExecutionBackendsResponse | null>(null);
  const [executionBackendsError, setExecutionBackendsError] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<CodeModeRunRecord | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [selectedArtifactKind, setSelectedArtifactKind] = useState<CodeModeRunArtifactKind>("source");
  const [artifactPreview, setArtifactPreview] = useState<CodeModeRunArtifactPreview | null>(null);
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [compareBaselineRunId, setCompareBaselineRunId] = useState("");
  const [runComparison, setRunComparison] = useState<CodeModeRunComparisonRecord | null>(null);
  const [runComparisonLoading, setRunComparisonLoading] = useState(false);
  const [runComparisonError, setRunComparisonError] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [diffViewMode, setDiffViewMode] = useState<"side-by-side" | "unified">("side-by-side");
  const [runLogViewMode, setRunLogViewMode] = useState<"rendered" | "raw">("rendered");
  const [runLogCleared, setRunLogCleared] = useState(false);
  const [runLogCopyNotice, setRunLogCopyNotice] = useState<string | null>(null);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [expandedInspectorSections, setExpandedInspectorSections] = useState(readStoredInspectorSections);
  const isMounted = useIsMounted();
  const stableOnFileOperation = useOptionalStableHandler(onFileOperation);
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
  const reviewPacket = useMemo(() => {
    const validation = summarizeValidationForReview(workbenchState?.validationStatus, output, visibleRunItems.length);
    const intent =
      typeof selectedTurn?.userMessage?.content === "string" && selectedTurn.userMessage.content.trim()
        ? selectedTurn.userMessage.content.trim()
        : "No user intent captured for the selected turn.";
    const changedSummary = diff?.summary
      ? `${diff.summary.changedFiles} file${diff.summary.changedFiles === 1 ? "" : "s"} · +${
          diff.summary.additions
        } / -${diff.summary.deletions}`
      : `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`;
    const latestRun = selectedRunDetail ?? selectedRunSummary;
    const artifactRows = codeModeArtifactReviewRows(selectedRunDetail);
    const artifactReady = artifactRows.some((row) => row.value !== "not recorded");
    const publishCandidate = validation.status === "passed" && changedFiles.length > 0 && !hasDirtyDraft;

    return {
      intent,
      metrics: [
        {
          label: "Patch intent",
          value: selectedTurn?.turnId ? shortId(selectedTurn.turnId) : "no turn",
          detail: intent,
          tone: intent.startsWith("No user intent") ? "warning" : "good",
        },
        {
          label: "Changed files",
          value: changedSummary,
          detail: changedFiles.length ? changedFiles.slice(0, 5).join(", ") : "No worktree changes recorded.",
          tone: changedFiles.length ? "warning" : "muted",
        },
        {
          label: "Validation",
          value: validation.status,
          detail: `${validation.command} · ${validation.detail}`,
          tone: validation.tone,
        },
        {
          label: "Ledger run",
          value: latestRun?.runId ? shortId(latestRun.runId) : "none selected",
          detail: latestRun?.status ?? "No Code Mode ledger run selected.",
          tone: latestRun?.status === "completed" || latestRun?.status === "passed" ? "good" : "muted",
        },
      ],
      validation,
      artifactRows,
      checklist: [
        {
          label: "Diff review",
          status: changedFiles.length ? "Ready for review" : "No patch captured",
          detail: changedFiles.length
            ? "Inspect selected-file and repo diff before handoff."
            : "Create or refresh a worktree diff before packaging.",
          tone: changedFiles.length ? "good" : "warning",
        },
        {
          label: "Validation proof",
          status: validation.status,
          detail: validation.skipped,
          tone: validation.tone,
        },
        {
          label: "Approval linkage",
          status: selectedRunApprovalId ? `Linked ${shortId(selectedRunApprovalId)}` : "No approval linked",
          detail: selectedRunApprovalId
            ? "Approval evidence is visible from the Code Mode run."
            : "No approval was recorded for the selected run.",
          tone: selectedRunApprovalId ? "good" : "muted",
        },
        {
          label: "Artifact hashes",
          status: artifactReady ? "Recorded" : "Missing",
          detail: artifactReady
            ? "Source, wrapper, policy, stdout, or stderr artifact references are available below."
            : "Load a Code Mode run detail to inspect immutable artifacts.",
          tone: artifactReady ? "good" : "warning",
        },
        {
          label: "Ready to publish",
          status: publishCandidate ? "Candidate" : "Hold",
          detail: publishCandidate
            ? "Still verify branch state, untracked files, screenshots, and remote SHA before publishing."
            : "Needs passed validation, changed-file review, and no unsaved editor draft.",
          tone: publishCandidate ? "good" : "warning",
        },
      ],
      risk: hasDirtyDraft
        ? "Unsaved editor draft is still present."
        : readyForRepoOps
          ? "Remote branch parity, screenshots, and untracked artifacts are not recorded in this panel."
          : "Create a ready worktree before treating this as publish evidence.",
    };
  }, [
    changedFiles,
    diff?.summary,
    hasDirtyDraft,
    output,
    readyForRepoOps,
    selectedRunApprovalId,
    selectedRunDetail,
    selectedRunSummary,
    selectedTurn?.turnId,
    selectedTurn?.userMessage?.content,
    visibleRunItems.length,
    workbenchState?.validationStatus,
  ]);
  const selectedRunScope = useMemo(
    () => ({
      ...((selectedRunSummary?.sessionId ?? codeLedgerSessionId)
        ? { sessionId: selectedRunSummary?.sessionId ?? codeLedgerSessionId ?? undefined }
        : {}),
      ...(selectedRunSummary?.turnId ? { turnId: selectedRunSummary.turnId } : {}),
      ...((selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId)
        ? { workspaceId: selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId ?? undefined }
        : {}),
    }),
    [
      codeLedgerSessionId,
      codeLedgerWorkspaceId,
      selectedRunSummary?.sessionId,
      selectedRunSummary?.turnId,
      selectedRunSummary?.workspaceId,
    ],
  );
  const selectedRunComparisonScope = useMemo(
    () => ({
      ...((selectedRunSummary?.sessionId ?? codeLedgerSessionId)
        ? { sessionId: selectedRunSummary?.sessionId ?? codeLedgerSessionId ?? undefined }
        : {}),
      ...((selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId)
        ? { workspaceId: selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId ?? undefined }
        : {}),
    }),
    [codeLedgerSessionId, codeLedgerWorkspaceId, selectedRunSummary?.sessionId, selectedRunSummary?.workspaceId],
  );
  const comparisonCandidates = useMemo(
    () => visibleRunItems.filter((run) => run.runId !== selectedRunSummary?.runId),
    [selectedRunSummary?.runId, visibleRunItems],
  );
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
      { label: "Commit", value: "Not wired in Code workbench v1", tone: "muted" },
      { label: "Pull request", value: "Not wired in Code workbench v1", tone: "muted" },
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
            value: generatedArtifact ? generatedArtifact.title : "No live preview URL in Code workbench v1",
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
    const runIds = visibleRunIds ? visibleRunIds.split("|").filter(Boolean) : [];
    if (runIds.length === 0) {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId((current) => (current && runIds.includes(current) ? current : runIds[0]!));
  }, [visibleRunIds]);

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
    let cancelled = false;
    setExecutionBackendsError(null);
    fetchCodeModeExecutionBackends()
      .then((response) => {
        if (!cancelled) {
          setExecutionBackends(response);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setExecutionBackends(null);
          setExecutionBackendsError(
            error instanceof Error ? error.message : "Unable to load Code Mode execution backends.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    fetchCodeModeRun(selectedRunSummary.runId, selectedRunScope)
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
  }, [selectedRunScope, selectedRunSummary?.runId]);

  useEffect(() => {
    setCompareBaselineRunId((current) => {
      if (current && comparisonCandidates.some((run) => run.runId === current)) {
        return current;
      }
      return comparisonCandidates[0]?.runId ?? "";
    });
  }, [comparisonCandidates]);

  useEffect(() => {
    if (!selectedRunDetail) {
      setArtifactPreview(null);
      setArtifactPreviewError(null);
      setArtifactPreviewLoading(false);
      return undefined;
    }
    if (!isCodeModeArtifactAvailable(selectedRunDetail, selectedArtifactKind)) {
      setArtifactPreview(null);
      setArtifactPreviewError(
        `${formatCodeModeArtifactKind(selectedArtifactKind)} artifact is not recorded for this run.`,
      );
      setArtifactPreviewLoading(false);
      return undefined;
    }
    let cancelled = false;
    setArtifactPreviewLoading(true);
    setArtifactPreviewError(null);
    setArtifactPreview(null);
    fetchCodeModeRunArtifact(selectedRunDetail.runId, selectedArtifactKind, selectedRunScope)
      .then((preview) => {
        if (!cancelled) {
          setArtifactPreview(preview);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setArtifactPreview(null);
          setArtifactPreviewError(error instanceof Error ? error.message : "Unable to load Code Mode artifact.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setArtifactPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedArtifactKind, selectedRunDetail, selectedRunScope]);

  useEffect(() => {
    if (!selectedRunDetail || !compareBaselineRunId) {
      setRunComparison(null);
      setRunComparisonError(null);
      setRunComparisonLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRunComparisonLoading(true);
    setRunComparisonError(null);
    setRunComparison(null);
    compareCodeModeRuns(selectedRunDetail.runId, compareBaselineRunId, selectedRunComparisonScope)
      .then((comparison) => {
        if (!cancelled) {
          setRunComparison(comparison);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunComparison(null);
          setRunComparisonError(error instanceof Error ? error.message : "Unable to compare Code Mode runs.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunComparisonLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compareBaselineRunId, selectedRunComparisonScope, selectedRunDetail]);

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
          <button
            type="button"
            className="mc-next-panel-button mc-next-code-inspector-open"
            aria-expanded={inspectorDrawerOpen}
            onClick={() => setInspectorDrawerOpen(true)}
          >
            <PanelRightOpen size={14} />
            <span>Inspector</span>
          </button>
        </div>
      </header>

      <div className="mc-next-code-phase-strip" aria-label="Code workflow posture">
        <span data-active={activePane === "snippets" ? "true" : "false"}>Plan</span>
        <span data-active={activePane === "files" || activePane === "snippets" ? "true" : "false"}>Implement</span>
        <span
          data-active={
            activePane === "selected-diff" ||
            activePane === "repo-diff" ||
            activePane === "review-packet" ||
            activePane === "output"
              ? "true"
              : "false"
          }
        >
          Review
        </span>
      </div>

      <div className="mc-next-workbench-action-row">
        <div className="mc-next-workbench-action-cluster" data-cluster="draft">
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
        </div>
        <span aria-hidden="true" className="mc-next-workbench-action-divider" />
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
            aria-haspopup="menu"
            aria-label="More workbench actions"
            onClick={() => setMoreMenuOpen((open) => !open)}
          >
            More ▾
          </button>
          {moreMenuOpen ? (
            <div className="mc-next-workbench-more-popover" role="menu">
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
          ) : null}
        </div>
        <span aria-hidden="true" className="mc-next-workbench-action-divider" />
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
      </div>

      {error ? <div className="mc-next-panel-banner warning">{error}</div> : null}

      <div className="mc-next-workbench-body" style={workbenchBodyStyle}>
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
          ) : workbenchTree ? (
            <>
              <WorkbenchFileActionForm
                busy={busy}
                repoBlockedReason={worktreeBlockedReason ?? draftConflictReason}
                selectedFilePath={selectedFile?.path}
                onFileOperation={stableOnFileOperation}
              />
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
        </aside>

        <section className="mc-next-workbench-main">
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
                  disabled={!selectedFile || !hasDirtyDraft || busy || saving}
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

          {paneMounted("output") ? (
            <div
              className="mc-next-workbench-pane"
              role="tabpanel"
              hidden={activePane !== "output"}
              id={buildWorkbenchPanelId("output")}
              aria-labelledby={buildWorkbenchTabId("output")}
            >
              <div className="mc-next-panel-list-head">
                <strong>Run log</strong>
                <div className="mc-next-workbench-view-toggle" role="group" aria-label="Run log controls">
                  <span>{visibleRunItems.length} Code Mode runs</span>
                  <button
                    type="button"
                    className={`mc-next-panel-button${runLogViewMode === "rendered" ? " active" : ""}`}
                    onClick={() => setRunLogViewMode("rendered")}
                  >
                    Rendered
                  </button>
                  <button
                    type="button"
                    className={`mc-next-panel-button${runLogViewMode === "raw" ? " active" : ""}`}
                    onClick={() => setRunLogViewMode("raw")}
                  >
                    Raw
                  </button>
                  <button type="button" className="mc-next-panel-button" onClick={copyRunLog}>
                    Copy
                  </button>
                  <button type="button" className="mc-next-panel-button" onClick={() => setRunLogCleared(true)}>
                    Clear
                  </button>
                </div>
              </div>
              {runLogCopyNotice ? <p className="mc-next-workbench-empty">{runLogCopyNotice}</p> : null}
              {executionBackendsError ? (
                <div className="mc-next-panel-banner warning">{executionBackendsError}</div>
              ) : null}
              {executionBackends ? (
                <section className="mc-next-workbench-run-detail">
                  <div className="mc-next-panel-list-head">
                    <strong>Execution backends</strong>
                    <span>{executionBackends.items.length} visible</span>
                  </div>
                  <ul className="mc-next-context-list">
                    {executionBackends.items.map((backend) => (
                      <li key={backend.backendId}>
                        <strong>{backend.label}</strong>
                        <p>
                          {backend.kind} · {backend.status} · {backend.runtimeSupport}
                          {backend.default ? " · default" : ""}
                          {backend.evaluationOnly ? " · evaluation only" : ""}
                        </p>
                        <p>
                          {backend.callable
                            ? "Callable for approved Code Mode runs."
                            : (backend.blockers[0] ?? "Reference only; not callable.")}
                        </p>
                        {backend.evaluation ? (
                          <p>
                            Matrix: path {backend.evaluation.pathIsolation}, network{" "}
                            {backend.evaluation.networkControls}, artifacts {backend.evaluation.artifactCapture},
                            Windows {backend.evaluation.windowsSupport}. Proof:{" "}
                            {backend.evaluation.requiredProofLanes.join(", ")}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {output?.output && !runLogCleared ? (
                runLogViewMode === "raw" ? (
                  <pre className="mc-next-workbench-raw-output">{output.output}</pre>
                ) : (
                  <WorkbenchMonacoEditor value={output.output} language="markdown" readOnly height={240} />
                )
              ) : (
                <p>
                  {runLogCleared
                    ? "Run log hidden locally until the next command output arrives."
                    : "No run log or helper output yet."}
                </p>
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
                          <strong>Execution backend</strong>
                          <p>{formatExecutionBackend(selectedRunDetail.executionBackend)}</p>
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
                      <section className="mc-next-workbench-output-preview">
                        <div className="mc-next-panel-list-head">
                          <strong>Artifact inspect</strong>
                          <span>
                            {artifactPreviewLoading
                              ? "verifying"
                              : artifactPreview?.sha256
                                ? formatShortHash(artifactPreview.sha256)
                                : "idle"}
                          </span>
                        </div>
                        <div className="mc-next-workbench-action-row">
                          {CODE_MODE_ARTIFACT_KINDS.map((item) => (
                            <button
                              key={item.kind}
                              type="button"
                              className={`mc-next-panel-button${selectedArtifactKind === item.kind ? " active" : ""}`}
                              onClick={() => setSelectedArtifactKind(item.kind)}
                              disabled={!isCodeModeArtifactAvailable(selectedRunDetail, item.kind)}
                              title={
                                isCodeModeArtifactAvailable(selectedRunDetail, item.kind)
                                  ? undefined
                                  : `${item.label} artifact is not recorded for this run.`
                              }
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                        {artifactPreviewError ? (
                          <div className="mc-next-panel-banner warning">{artifactPreviewError}</div>
                        ) : null}
                        {artifactPreview ? (
                          <>
                            <p className="mc-next-workbench-empty">
                              {formatArtifactPath(artifactPreview.artifact)}
                              {artifactPreview.truncated ? " · truncated" : ""}
                            </p>
                            <WorkbenchMonacoEditor
                              value={artifactPreview.content}
                              language={codeModeArtifactLanguage(selectedRunDetail, artifactPreview.artifactKind)}
                              readOnly
                              height={260}
                            />
                          </>
                        ) : null}
                      </section>
                      {comparisonCandidates.length ? (
                        <section className="mc-next-workbench-output-preview">
                          <div className="mc-next-panel-list-head">
                            <strong>Run comparison</strong>
                            <label className="mc-next-code-source-field">
                              <span>Baseline</span>
                              <select
                                value={compareBaselineRunId}
                                onChange={(event) => setCompareBaselineRunId(event.target.value)}
                              >
                                {comparisonCandidates.map((run) => (
                                  <option key={run.runId} value={run.runId}>
                                    {shortId(run.runId)} · {run.status ?? "recorded"}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                          {runComparisonLoading ? (
                            <p className="mc-next-workbench-empty">Comparing run evidence...</p>
                          ) : null}
                          {runComparisonError ? (
                            <div className="mc-next-panel-banner warning">{runComparisonError}</div>
                          ) : null}
                          {runComparison ? (
                            <ul className="mc-next-context-list">
                              {codeModeComparisonRows(runComparison).map((row) => (
                                <li key={row.label}>
                                  <strong>{row.label}</strong>
                                  <p>{row.matched ? "same" : "changed"}</p>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </section>
                      ) : null}
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
        <aside className="mc-next-code-session-inspector-slot">
          <CodeSessionInspector
            expandedSections={expandedInspectorSections}
            onToggleSection={handleToggleInspectorSection}
            sections={inspectorSections}
            variant="inline"
          />
        </aside>
      </div>
      {inspectorDrawerOpen ? (
        <div
          className="mc-next-code-inspector-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Code session inspector"
        >
          <button
            type="button"
            className="mc-next-code-inspector-scrim"
            aria-label="Close inspector"
            onClick={() => setInspectorDrawerOpen(false)}
          />
          <div className="mc-next-code-inspector-sheet-body">
            <CodeSessionInspector
              expandedSections={expandedInspectorSections}
              onClose={() => setInspectorDrawerOpen(false)}
              onToggleSection={handleToggleInspectorSection}
              sections={inspectorSections}
              variant="drawer"
            />
          </div>
        </div>
      ) : null}
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
