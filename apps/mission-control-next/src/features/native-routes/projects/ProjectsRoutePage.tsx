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
import type { ChatMode, ChatProjectRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  archiveChatProject,
  createChatSession,
  createChatProject,
  fetchChatProjects,
  fetchChatSessions,
  updateChatProject,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { ModeBar } from "../primitives";
import { readRouteDiagnosticNow, recordRouteAction, recordRouteDataLoad } from "../route-diagnostics";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

type ProjectsState = {
  loading: boolean;
  error: string | null;
  projects: ChatProjectRecord[];
  sessions: ChatSessionRecord[];
};

type ProjectCounts = Record<ChatMode, number>;
type ProjectReadinessStatus = "ready" | "attention";

type ProjectReadinessItem = {
  id: string;
  label: string;
  detail: string;
  status: ProjectReadinessStatus;
};

type ProjectHome = {
  latestByMode: Record<ChatMode, ChatSessionRecord | null>;
  recentSessions: ChatSessionRecord[];
  readiness: ProjectReadinessItem[];
  activeCount: number;
  artifactCount: number;
  lastActivityLabel: string;
  healthLabel: string;
  healthDetail: string;
};

const EMPTY_COUNTS: ProjectCounts = {
  chat: 0,
  cowork: 0,
  code: 0,
};

const SURFACES: Array<{ mode: ChatMode; label: string; action: string }> = [
  { mode: "chat", label: "Chat", action: "New Chat" },
  { mode: "cowork", label: "Cowork", action: "New Cowork" },
  { mode: "code", label: "Code", action: "New Code" },
];

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
    projects: [],
    sessions: [],
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
        itemCount: nextData.projects.length + nextData.sessions.length,
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
        itemCount: nextData.projects.length + nextData.sessions.length,
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
    () => (selectedProject ? deriveProjectHome(selectedProject, selectedSessions) : null),
    [selectedProject, selectedSessions],
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
                const counts = countsByProject.get(project.projectId) ?? EMPTY_COUNTS;
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
              selectedProject ? (countsByProject.get(selectedProject.projectId) ?? EMPTY_COUNTS)[surface.mode] : 0,
            ),
          }))}
        >
          {actionError ? <div className="mc-next-settings-notice error">{actionError}</div> : null}
          {selectedProject && projectHome ? (
            <ProjectHomeBasePanel
              home={projectHome}
              pendingApprovals={pendingApprovals}
              onContinue={(mode) => void handleContinueSession(mode)}
              onOpenLibrary={() => navigate({ area: "library", section: "memory", theme: route.theme })}
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
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, workspacePath: event.target.value }))
                  }
                  placeholder="Local project path"
                />
              </label>
              <label className="mc-next-settings-field">
                <span>Description</span>
                <textarea
                  className="mc-next-settings-textarea"
                  value={createDraft.description}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, description: event.target.value }))
                  }
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
  onOpenLibrary,
}: {
  home: ProjectHome;
  pendingApprovals: number;
  onContinue: (mode: ChatMode) => void;
  onOpenLibrary: () => void;
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
        <ProjectHomeMetric label="Active threads" value={String(home.activeCount)} detail="Chat, Cowork, and Code work still in motion." />
        <ProjectHomeMetric label="Artifacts" value={String(home.artifactCount)} detail="Generated outputs attached to project threads." />
        <ProjectHomeMetric label="Approvals" value={String(pendingApprovals)} detail="Workspace-wide approval queue." />
        <ProjectHomeMetric label="Last activity" value={home.lastActivityLabel} detail="Most recent project thread update." />
      </div>

      <div className="mc-next-project-continue-row">
        {SURFACES.map((surface) => (
          <button
            key={surface.mode}
            type="button"
            className="mc-next-button"
            onClick={() => onContinue(surface.mode)}
          >
            <MessageSquarePlus className="h-4 w-4" />
            {home.latestByMode[surface.mode] ? `Continue ${surface.label}` : `Start ${surface.label}`}
          </button>
        ))}
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
                {formatDateTime(session.lastActivityAt)} · {countArtifacts(session)} artifacts
              </p>
            </div>
          ))
        ) : (
          <p className="mc-next-directory-empty">No recent project threads yet.</p>
        )}
      </div>

      <button type="button" className="mc-next-settings-filter" onClick={onOpenLibrary}>
        Review memory and provenance in Library
      </button>
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

export function deriveProjectHome(project: ChatProjectRecord, sessions: ChatSessionRecord[]): ProjectHome {
  const sortedSessions = [...sessions].sort((left, right) => dateValue(right.lastActivityAt) - dateValue(left.lastActivityAt));
  const latestByMode = createEmptyLatestByMode();
  for (const session of sortedSessions) {
    const mode = normalizeMode(session.mode);
    if (!latestByMode[mode]) {
      latestByMode[mode] = session;
    }
  }
  const artifactCount = sortedSessions.reduce((total, session) => total + countArtifacts(session), 0);
  const activeCount = sortedSessions.filter((session) => session.lifecycleStatus !== "archived").length;
  const hasSourcePath = Boolean(project.workspacePath?.trim());
  const hasChat = Boolean(latestByMode.chat);
  const hasCowork = Boolean(latestByMode.cowork);
  const hasCode = Boolean(latestByMode.code);
  const hasArtifacts = artifactCount > 0;

  const readiness: ProjectReadinessItem[] = [
    {
      id: "source",
      label: "Project source",
      status: hasSourcePath ? "ready" : "attention",
      detail: hasSourcePath
        ? `Bound to ${project.workspacePath}.`
        : "Add a workspace path before Code can become a practical workbench.",
    },
    {
      id: "chat",
      label: "Chat continuity",
      status: hasChat ? "ready" : "attention",
      detail: hasChat ? "A project chat is ready to continue." : "Start a project chat for fast context and drafting.",
    },
    {
      id: "cowork",
      label: "Cowork run",
      status: hasCowork ? "ready" : "attention",
      detail: hasCowork
        ? "A supervised run is available from this project."
        : "Start Cowork when this project needs a durable plan and approval loop.",
    },
    {
      id: "code",
      label: "Code workbench",
      status: hasCode ? "ready" : "attention",
      detail: hasCode
        ? "A Code thread is available for implementation work."
        : "Open Code when this project needs edits, validation, or patch artifacts.",
    },
    {
      id: "artifacts",
      label: "Proof artifacts",
      status: hasArtifacts ? "ready" : "attention",
      detail: hasArtifacts
        ? `${artifactCount} generated artifacts are attached to project threads.`
        : "No validation or output artifacts are attached yet.",
    },
    {
      id: "knowledge",
      label: "Knowledge and provenance",
      status: "attention",
      detail: "Project-scoped memory review still lives in Library; inspect or remove knowledge there.",
    },
  ];

  const health = deriveProjectHealth({ hasSourcePath, hasChat, hasCowork, hasCode, hasArtifacts, sessionCount: sessions.length });

  return {
    latestByMode,
    recentSessions: sortedSessions.slice(0, 4),
    readiness,
    activeCount,
    artifactCount,
    lastActivityLabel: sortedSessions[0] ? formatDateTime(sortedSessions[0].lastActivityAt) : "None",
    ...health,
  };
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

function normalizeMode(mode?: ChatMode): ChatMode {
  return mode === "cowork" || mode === "code" ? mode : "chat";
}

function createEmptyCounts(): ProjectCounts {
  return { ...EMPTY_COUNTS };
}

function createEmptyLatestByMode(): Record<ChatMode, ChatSessionRecord | null> {
  return {
    chat: null,
    cowork: null,
    code: null,
  };
}

function countArtifacts(session: ChatSessionRecord): number {
  return session.generatedArtifacts?.length ?? 0;
}

function deriveProjectHealth(input: {
  hasSourcePath: boolean;
  hasChat: boolean;
  hasCowork: boolean;
  hasCode: boolean;
  hasArtifacts: boolean;
  sessionCount: number;
}): Pick<ProjectHome, "healthLabel" | "healthDetail"> {
  if (!input.hasSourcePath) {
    return {
      healthLabel: "Needs source",
      healthDetail: "Add a workspace path before this project can anchor Code and evidence.",
    };
  }
  if (input.sessionCount === 0) {
    return {
      healthLabel: "Ready for first thread",
      healthDetail: "The project exists; start Chat, Cowork, or Code to create a continuation point.",
    };
  }
  if (!input.hasCowork || !input.hasCode) {
    return {
      healthLabel: "Needs work lanes",
      healthDetail: "Add Cowork or Code when this project needs durable execution or implementation proof.",
    };
  }
  if (!input.hasArtifacts) {
    return {
      healthLabel: "Needs proof",
      healthDetail: "Run validation or produce artifacts so future sessions have evidence to inspect.",
    };
  }
  if (!input.hasChat) {
    return {
      healthLabel: "Needs chat lane",
      healthDetail: "Add a lightweight Chat thread for fast project questions and drafting.",
    };
  }
  return {
    healthLabel: "Ready to continue",
    healthDetail: "Chat, Cowork, Code, and evidence are all represented for this project.",
  };
}

function labelForMode(mode: ChatMode): string {
  return mode === "cowork" ? "Cowork" : mode === "code" ? "Code" : "Chat";
}

function dateValue(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}

async function fetchProjectData(activeWorkspaceId: string): Promise<Pick<ProjectsState, "projects" | "sessions">> {
  const [projectsResponse, sessionsResponse] = await Promise.all([
    fetchChatProjects("active", 300, activeWorkspaceId),
    fetchChatSessions({
      workspaceId: activeWorkspaceId,
      scope: "all",
      view: "all",
      includeHidden: true,
      limit: 1000,
    }),
  ]);
  return {
    projects: projectsResponse.items,
    sessions: sessionsResponse.items,
  };
}
