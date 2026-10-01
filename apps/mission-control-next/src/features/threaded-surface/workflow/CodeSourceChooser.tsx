import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CodeSourceTabId } from "./code-workbench-model";

const CODE_SOURCE_TAB_DEFS: ReadonlyArray<{ id: CodeSourceTabId; label: string }> = [
  { id: "existing", label: "Existing project" },
  { id: "local", label: "Local folder" },
  { id: "github", label: "GitHub repo" },
];

export function CodeSourceChooser({
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
