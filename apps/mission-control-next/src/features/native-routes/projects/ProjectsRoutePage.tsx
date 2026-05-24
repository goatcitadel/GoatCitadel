import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Save,
} from "lucide-react";
import type {
  ChatGeneratedArtifactRecord,
  ChatMode,
  ChatProjectRecord,
  ChatSessionRecord,
} from "@goatcitadel/contracts";
import {
  archiveChatProject,
  createChatSession,
  createChatProject,
  fetchChatGeneratedArtifacts,
  fetchChatProjects,
  fetchChatSessions,
  updateChatProject,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { ModeBar } from "../primitives";
import { readRouteDiagnosticNow, recordRouteAction, recordRouteDataLoad } from "../route-diagnostics";
import type { NativeRoutePagesProps } from "../types";
import {
  SURFACES,
  countHomeArtifacts,
  createEmptyCounts,
  dateValue,
  deriveProjectHome,
  formatDateTime,
  getErrorMessage,
  labelForMode,
  normalizeMode,
  type ProjectCounts,
  type ProjectHome,
} from "./ProjectsRoutePage.helpers";
import "../native-routes.css";

export { deriveProjectHome } from "./ProjectsRoutePage.helpers";

type ProjectsState = {
  loading: boolean;
  error: string | null;
  artifactIssue: string | null;
  projects: ChatProjectRecord[];
  sessions: ChatSessionRecord[];
  artifacts: ChatGeneratedArtifactRecord[];
};

export function ProjectsRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  pendingApprovals,
  navigate,
}: NativeRoutePagesProps) {
  const [state, setState] = useState<ProjectsState>({
    loading: true,
    error: null,
    artifactIssue: null,
    projects: [],
    sessions: [],
    artifacts: [],
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState({ name: "", workspacePath: "", description: "" });
  const [editDraft, setEditDraft] = useState({ name: "", workspacePath: "", description: "" });

  const loadProjects = useCallback(async () => {
    const startedAt = readRouteDiagnosticNow();
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const nextData = await fetchProjectData(activeWorkspaceId);
      setState({ ...nextData, loading: false, error: null });
      recordRouteDataLoad({
        route: "projects",
        label: "Projects",
        startedAt,
        itemCount: nextData.projects.length + nextData.sessions.length + nextData.artifacts.length,
        issueCount: nextData.artifactIssue ? 1 : 0,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: getErrorMessage(error),
      }));
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const startedAt = readRouteDiagnosticNow();
      setState((current) => ({ ...current, loading: true, error: null }));
      const nextData = await fetchProjectData(activeWorkspaceId);
      if (cancelled) {
        return;
      }
      setState({
        ...nextData,
        loading: false,
        error: null,
      });
      recordRouteDataLoad({
        route: "projects",
        label: "Projects",
        startedAt,
        itemCount: nextData.projects.length + nextData.sessions.length + nextData.artifacts.length,
        issueCount: nextData.artifactIssue ? 1 : 0,
      });
    }
    void load().catch((error: Error) => {
      if (!cancelled) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error.message,
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const countsByProject = useMemo(() => {
    const next = new Map<string, ProjectCounts>();
    for (const project of state.projects) {
      next.set(project.projectId, createEmptyCounts());
    }
    for (const session of state.sessions) {
      if (!session.projectId) {
        continue;
      }
      const counts = next.get(session.projectId) ?? createEmptyCounts();
      counts[normalizeMode(session.mode)] += 1;
      next.set(session.projectId, counts);
    }
    return next;
  }, [state.projects, state.sessions]);

  const selectedProject =
    state.projects.find((project) => project.projectId === route.projectId) ?? state.projects[0] ?? null;

  useEffect(() => {
    if (route.projectId || !selectedProject) {
      return;
    }
    navigate({ area: "projects", projectId: selectedProject.projectId, theme: route.theme }, { replace: true });
  }, [navigate, route.projectId, route.theme, selectedProject]);

  const selectedSessions = useMemo(
    () =>
      selectedProject
        ? state.sessions
            .filter((session) => session.projectId === selectedProject.projectId)
            .sort((left, right) => dateValue(right.lastActivityAt) - dateValue(left.lastActivityAt))
        : [],
    [selectedProject, state.sessions],
  );

  const groupedSessions = useMemo(
    () => ({
      chat: selectedSessions.filter((session) => normalizeMode(session.mode) === "chat"),
      cowork: selectedSessions.filter((session) => normalizeMode(session.mode) === "cowork"),
      code: selectedSessions.filter((session) => normalizeMode(session.mode) === "code"),
    }),
    [selectedSessions],
  );

  useEffect(() => {
    setEditDraft({
      name: selectedProject?.name ?? "",
      workspacePath: selectedProject?.workspacePath ?? "",
      description: selectedProject?.description ?? "",
    });
  }, [selectedProject?.description, selectedProject?.name, selectedProject?.workspacePath]);

  const projectHome = useMemo(
    () => (selectedProject ? deriveProjectHome(selectedProject, selectedSessions, state.artifacts) : null),
    [selectedProject, selectedSessions, state.artifacts],
  );

  const handleNewSession = async (mode: ChatMode) => {
    if (!selectedProject) {
      return;
    }
    setActionError(null);
    try {
      const session = await createChatSession(
        {
          workspaceId: activeWorkspaceId,
          projectId: selectedProject.projectId,
          mode,
          origin: "operator",
          title: `${labelForMode(mode)} - ${selectedProject.name}`,
        },
        { originSurface: mode },
      );
      recordRouteAction("projects", "session.created", {
        mode,
        projectId: selectedProject.projectId,
        sessionId: session.sessionId,
      });
      navigate({
        area: mode,
        sessionId: session.sessionId,
        projectId: selectedProject.projectId,
        theme: route.theme,
      });
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const handleContinueSession = async (mode: ChatMode) => {
    if (!selectedProject) {
      return;
    }
    const latest = projectHome?.latestByMode[mode] ?? null;
    if (latest) {
      navigate({
        area: mode,
        sessionId: latest.sessionId,
        projectId: selectedProject.projectId,
        theme: route.theme,
      });
      return;
    }
    await handleNewSession(mode);
  };

  const handleCreateProject = async () => {
    const name = createDraft.name.trim();
    const workspacePath = createDraft.workspacePath.trim();
    if (!name || !workspacePath) {
      setActionError("Project name and workspace path are required.");
      return;
    }
    setActionError(null);
    setProjectActionBusy("create");
    try {
      const project = await createChatProject({
        workspaceId: activeWorkspaceId,
        name,
        workspacePath,
        description: createDraft.description.trim() || undefined,
      });
      setState((current) => ({
        ...current,
        projects: [project, ...current.projects.filter((item) => item.projectId !== project.projectId)],
      }));
      setCreateDraft({ name: "", workspacePath: "", description: "" });
      recordRouteAction("projects", "project.created", {
        projectId: project.projectId,
      });
      navigate({ area: "projects", projectId: project.projectId, theme: route.theme });
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setProjectActionBusy(null);
    }
  };

  const handleSaveProject = async () => {
    if (!selectedProject) {
      return;
    }
    const name = editDraft.name.trim();
    const workspacePath = editDraft.workspacePath.trim();
    if (!name || !workspacePath) {
      setActionError("Project name and workspace path are required.");
      return;
    }
    setActionError(null);
    setProjectActionBusy("save");
    try {
      const project = await updateChatProject(selectedProject.projectId, {
        workspaceId: activeWorkspaceId,
        name,
        workspacePath,
        description: editDraft.description.trim() || undefined,
      });
      setState((current) => ({
        ...current,
        projects: current.projects.map((item) => (item.projectId === project.projectId ? project : item)),
      }));
      recordRouteAction("projects", "project.updated", {
        projectId: project.projectId,
      });
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setProjectActionBusy(null);
    }
  };

  const handleArchiveProject = async () => {
    if (!selectedProject) {
      return;
    }
    setActionError(null);
    setProjectActionBusy("archive");
    try {
      const archived = await archiveChatProject(selectedProject.projectId);
      setState((current) => ({
        ...current,
        projects: current.projects.filter((project) => project.projectId !== archived.projectId),
      }));
      recordRouteAction("projects", "project.archived", {
        projectId: archived.projectId,
      });
      navigate({ area: "projects", theme: route.theme }, { replace: true });
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setProjectActionBusy(null);
    }
  };

  const totalProjectSessions = state.sessions.filter((session) => session.projectId).length;

  return (
    <NativePageFrame
      area="projects"
      kicker="Projects · Workspace"
      title="Project containers"
      description={`Cross-surface project threads for ${activeWorkspaceName}.`}
      loading={state.loading}
      error={state.error}
      metrics={[
        { label: "Projects", value: String(state.projects.length) },
        { label: "Project sessions", value: String(totalProjectSessions) },
      ]}
      actions={
        <>
          {SURFACES.map((surface) => (
            <NewSessionButton
              key={`head-${surface.mode}`}
              mode={surface.mode}
              label={surface.action}
              disabled={!selectedProject}
              onSelect={() => void handleNewSession(surface.mode)}
            />
          ))}
        </>
      }
    >
      <NativeGrid className="mc-next-native-projects-grid">
        <NativeCard
          title="Projects"
          subtitle="Containers that bind Chat, Cowork, and Code work together."
          density="compact"
          stats={[
            { label: "Projects", value: String(state.projects.length) },
            { label: "Sessions", value: String(totalProjectSessions) },
          ]}
          actions={
            <button type="button" className="mc-next-settings-filter" onClick={() => void loadProjects()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          }
        >
          <div
            className="mc-next-settings-selectable-list is-compact is-scrollable"
            data-native-scroll="true"
            style={{ maxHeight: "min(62vh, 38rem)" }}
          >
            {state.projects.length ? (
              state.projects.map((project) => {
                const counts = countsByProject.get(project.projectId) ?? createEmptyCounts();
                return (
                  <button
                    key={project.projectId}
                    type="button"
                    className={`mc-next-settings-selectable${
                      selectedProject?.projectId === project.projectId ? " active" : ""
                    }`}
                    onClick={() => navigate({ area: "projects", projectId: project.projectId, theme: route.theme })}
                  >
                    <div className="mc-next-settings-selectable-head">
                      <strong>{project.name}</strong>
                      <span>{counts.chat + counts.cowork + counts.code} threads</span>
                    </div>
                    <p>{project.description?.trim() || project.workspacePath}</p>
                    <ModeBar chat={counts.chat} cowork={counts.cowork} code={counts.code} />
                    <div className="mc-next-project-counts">
                      <span>Chat {counts.chat}</span>
                      <span>Cowork {counts.cowork}</span>
                      <span>Code {counts.code}</span>
                    </div>
                  </button>
                );
              })
            ) : (
              <p className="mc-next-directory-empty">No active projects found in this workspace.</p>
            )}
          </div>
        </NativeCard>

        <NativeCard
          title={selectedProject?.name ?? "Project detail"}
          subtitle={selectedProject?.workspacePath ?? "Select a project to inspect its threads."}
          density="compact"
          scrollBody
          bodyMaxHeight="min(70vh, 42rem)"
          stats={SURFACES.map((surface) => ({
            label: surface.label,
            value: String(
              selectedProject
                ? (countsByProject.get(selectedProject.projectId) ?? createEmptyCounts())[surface.mode]
                : 0,
            ),
          }))}
        >
          {actionError ? <div className="mc-next-settings-notice error">{actionError}</div> : null}
          {state.artifactIssue ? (
            <div className="mc-next-settings-notice warning">
              Project artifact records could not load: {state.artifactIssue}
            </div>
          ) : null}
          {selectedProject && projectHome ? (
            <ProjectHomeBasePanel
              home={projectHome}
              pendingApprovals={pendingApprovals}
              onContinue={(mode) => void handleContinueSession(mode)}
              onOpenMemory={() => navigate({ area: "library", section: "memory", theme: route.theme })}
              onOpenArtifacts={() =>
                navigate({
                  area: "library",
                  section: "artifacts",
                  projectId: selectedProject.projectId,
                  theme: route.theme,
                })
              }
            />
          ) : null}
          <div className="mc-next-settings-button-row">
            {SURFACES.map((surface) => (
              <button
                key={surface.mode}
                type="button"
                className="mc-next-button"
                disabled={!selectedProject}
                onClick={() => void handleNewSession(surface.mode)}
              >
                <MessageSquarePlus className="h-4 w-4" />
                {surface.action}
              </button>
            ))}
          </div>
          <div className="mc-next-project-thread-groups">
            {SURFACES.map((surface) => (
              <ProjectThreadGroup
                key={surface.mode}
                mode={surface.mode}
                label={surface.label}
                sessions={groupedSessions[surface.mode]}
                route={route}
                navigate={navigate}
              />
            ))}
          </div>
        </NativeCard>

        <NativeCard
          title="Project controls"
          subtitle="Create, update, or archive visible project containers."
          density="compact"
          scrollBody
          bodyMaxHeight="min(70vh, 42rem)"
        >
          <div className="mc-next-project-controls">
            <section className="mc-next-project-control-section">
              <div className="mc-next-project-control-heading">
                <FolderPlus className="h-4 w-4" />
                <strong>Create project</strong>
              </div>
              <label className="mc-next-settings-field">
                <span>Name</span>
                <input
                  className="mc-next-settings-input"
                  value={createDraft.name}
                  onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Release readiness"
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Workspace path</span>
                <input
                  className="mc-next-settings-input"
                  value={createDraft.workspacePath}
                  onChange={(event) => setCreateDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                  placeholder="Local project path"
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Description</span>
                <textarea
                  className="mc-next-settings-textarea"
                  value={createDraft.description}
                  onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder="What this project is for."
                />
              </label>
              <button
                type="button"
                className="mc-next-button"
                disabled={projectActionBusy === "create"}
                onClick={() => void handleCreateProject()}
              >
                <FolderPlus className="h-4 w-4" />
                {projectActionBusy === "create" ? "Creating..." : "Create project"}
              </button>
            </section>

            <section className="mc-next-project-control-section">
              <div className="mc-next-project-control-heading">
                <Pencil className="h-4 w-4" />
                <strong>Edit selected</strong>
              </div>
              <label className="mc-next-settings-field">
                <span>Name</span>
                <input
                  className="mc-next-settings-input"
                  value={editDraft.name}
                  disabled={!selectedProject}
                  onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Workspace path</span>
                <input
                  className="mc-next-settings-input"
                  value={editDraft.workspacePath}
                  disabled={!selectedProject}
                  onChange={(event) => setEditDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Description</span>
                <textarea
                  className="mc-next-settings-textarea"
                  value={editDraft.description}
                  disabled={!selectedProject}
                  onChange={(event) => setEditDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
              <div className="mc-next-settings-button-row">
                <button
                  type="button"
                  className="mc-next-button"
                  disabled={!selectedProject || projectActionBusy === "save"}
                  onClick={() => void handleSaveProject()}
                >
                  <Save className="h-4 w-4" />
                  {projectActionBusy === "save" ? "Saving..." : "Save project"}
                </button>
                <button
                  type="button"
                  className="mc-next-settings-filter"
                  disabled={!selectedProject || projectActionBusy === "archive"}
                  onClick={() => void handleArchiveProject()}
                >
                  <Archive className="h-4 w-4" />
                  {projectActionBusy === "archive" ? "Archiving..." : "Archive project"}
                </button>
              </div>
            </section>
          </div>
        </NativeCard>
      </NativeGrid>
    </NativePageFrame>
  );
}

function ProjectHomeBasePanel({
  home,
  pendingApprovals,
  onContinue,
  onOpenMemory,
  onOpenArtifacts,
}: {
  home: ProjectHome;
  pendingApprovals: number;
  onContinue: (mode: ChatMode) => void;
  onOpenMemory: () => void;
  onOpenArtifacts: () => void;
}) {
  return (
    <section className="mc-next-project-home-base" aria-label="Project overview">
      <div className="mc-next-project-home-head">
        <div>
          <span>Project overview</span>
          <strong>{home.healthLabel}</strong>
        </div>
        <p>{home.healthDetail}</p>
      </div>

      <div className="mc-next-project-home-metrics">
        <ProjectHomeMetric
          label="Active threads"
          value={String(home.activeCount)}
          detail="Chat, Cowork, and Code work still in motion."
        />
        <ProjectHomeMetric
          label="Artifacts"
          value={String(home.artifactCount)}
          detail={
            home.artifactCountSource === "records"
              ? "Generated outputs with project ownership recorded."
              : "Generated outputs referenced by project threads."
          }
        />
        <ProjectHomeMetric label="Approvals" value={String(pendingApprovals)} detail="Workspace-wide approval queue." />
        <ProjectHomeMetric
          label="Last activity"
          value={home.lastActivityLabel}
          detail="Most recent project thread update."
        />
      </div>

      <div className="mc-next-project-continue-row">
        {SURFACES.map((surface) => (
          <button key={surface.mode} type="button" className="mc-next-button" onClick={() => onContinue(surface.mode)}>
            <MessageSquarePlus className="h-4 w-4" />
            {home.latestByMode[surface.mode] ? `Continue ${surface.label}` : `Start ${surface.label}`}
          </button>
        ))}
      </div>

      <div className="mc-next-project-lane-resume-shell">
        <div className="mc-next-directory-lane-head">
          <strong>Latest continuation</strong>
          <span>Chat / Cowork / Code</span>
        </div>
        <div className="mc-next-project-lane-resume-list" aria-label="Latest project continuation points">
          {SURFACES.map((surface) => {
            const latest = home.latestByMode[surface.mode];
            return (
              <button
                key={`latest-${surface.mode}`}
                type="button"
                className={`mc-next-project-lane-resume is-${surface.mode}`}
                onClick={() => onContinue(surface.mode)}
              >
                <span>{surface.label}</span>
                <strong>{latest ? latest.title?.trim() || latest.sessionKey : `Start ${surface.label}`}</strong>
                <p>
                  {latest
                    ? `${formatDateTime(latest.lastActivityAt)} · ${latest.lifecycleStatus} · ${countHomeArtifacts(home, latest)} artifacts`
                    : "No continuation point yet."}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mc-next-project-readiness-list">
        {home.readiness.map((item) => (
          <div key={item.id} className={`mc-next-project-readiness-item is-${item.status}`}>
            {item.status === "ready" ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mc-next-project-recent-list">
        <div className="mc-next-directory-lane-head">
          <strong>Recent work</strong>
          <span>{home.recentSessions.length}</span>
        </div>
        {home.recentSessions.length ? (
          home.recentSessions.map((session) => (
            <div key={session.sessionId} className="mc-next-project-recent-item">
              <span>{labelForMode(normalizeMode(session.mode))}</span>
              <strong>{session.title?.trim() || session.sessionKey}</strong>
              <p>
                {formatDateTime(session.lastActivityAt)} · {countHomeArtifacts(home, session)} artifacts
              </p>
            </div>
          ))
        ) : (
          <p className="mc-next-directory-empty">No recent project threads yet.</p>
        )}
      </div>

      <div className="mc-next-settings-button-row">
        <button type="button" className="mc-next-settings-filter" onClick={onOpenMemory}>
          Review memory and provenance
        </button>
        <button type="button" className="mc-next-settings-filter" onClick={onOpenArtifacts}>
          Reopen project artifacts
        </button>
      </div>
    </section>
  );
}

function ProjectHomeMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="mc-next-settings-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function ProjectThreadGroup({
  mode,
  label,
  sessions,
  route,
  navigate,
}: {
  mode: ChatMode;
  label: string;
  sessions: ChatSessionRecord[];
  route: AppRoute;
  navigate: NativeRoutePagesProps["navigate"];
}) {
  return (
    <section className="mc-next-directory-lane">
      <div className="mc-next-directory-lane-head">
        <strong>{label}</strong>
        <span>{sessions.length}</span>
      </div>
      {sessions.length ? (
        <div className="mc-next-directory-lane-list">
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className="mc-next-directory-lane-item"
              onClick={() =>
                navigate({
                  area: mode,
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                  theme: route.theme,
                })
              }
            >
              <div className="mc-next-directory-lane-meta">
                <span>{session.lifecycleStatus}</span>
                <span>{formatDateTime(session.lastActivityAt)}</span>
              </div>
              <strong>{session.title?.trim() || session.sessionKey}</strong>
              <p>{session.tags?.length ? session.tags.join(", ") : "No tags yet."}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="mc-next-directory-empty">No {label.toLowerCase()} threads in this project.</p>
      )}
    </section>
  );
}

function NewSessionButton({
  mode,
  label,
  disabled,
  onSelect,
}: {
  mode: ChatMode;
  label: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="mc-next-new-session-button"
      data-mode={mode}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mc-next-new-session-button-swatch" aria-hidden="true" />
      <MessageSquarePlus className="h-4 w-4" />
      {label}
    </button>
  );
}

async function fetchProjectData(
  activeWorkspaceId: string,
): Promise<Pick<ProjectsState, "projects" | "sessions" | "artifacts" | "artifactIssue">> {
  const artifactsRequest = fetchChatGeneratedArtifacts({
    workspaceId: activeWorkspaceId,
    limit: 1000,
  })
    .then((response) => ({ items: response.items, issue: null as string | null }))
    .catch((error: unknown) => ({
      items: [] as ChatGeneratedArtifactRecord[],
      issue: getErrorMessage(error),
    }));
  const [projectsResponse, sessionsResponse, artifactsResponse] = await Promise.all([
    fetchChatProjects("active", 300, activeWorkspaceId),
    fetchChatSessions({
      workspaceId: activeWorkspaceId,
      scope: "all",
      view: "all",
      includeHidden: true,
      limit: 1000,
    }),
    artifactsRequest,
  ]);
  return {
    projects: projectsResponse.items,
    sessions: sessionsResponse.items,
    artifacts: artifactsResponse.items,
    artifactIssue: artifactsResponse.issue,
  };
}
