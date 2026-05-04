import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderKanban, MessageSquarePlus, RefreshCw } from "lucide-react";
import type { ChatMode, ChatProjectRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  createChatSession,
  fetchChatProjects,
  fetchChatSessions,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

type ProjectsState = {
  loading: boolean;
  error: string | null;
  projects: ChatProjectRecord[];
  sessions: ChatSessionRecord[];
};

type ProjectCounts = Record<ChatMode, number>;

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

export function ProjectsRoutePage({ route, activeWorkspaceId, activeWorkspaceName, navigate }: NativeRoutePagesProps) {
  const [state, setState] = useState<ProjectsState>({
    loading: true,
    error: null,
    projects: [],
    sessions: [],
  });
  const [actionError, setActionError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      setState({ ...(await fetchProjectData(activeWorkspaceId)), loading: false, error: null });
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

  return (
    <NativePageFrame
      icon={FolderKanban}
      kicker="Projects"
      title="Project containers"
      description={`Cross-surface project threads for ${activeWorkspaceName}.`}
      loading={state.loading}
      error={state.error}
    >
      <NativeGrid>
        <NativeCard
          title="Projects"
          subtitle="Containers that bind Chat, Cowork, and Code work together."
          stats={[
            { label: "Projects", value: String(state.projects.length) },
            { label: "Sessions", value: String(state.sessions.filter((session) => session.projectId).length) },
          ]}
        >
          <div className="mc-next-settings-selectable-list">
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
          <div className="mc-next-settings-button-row">
            <button type="button" className="mc-next-settings-filter" onClick={() => void loadProjects()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </NativeCard>

        <NativeCard
          title={selectedProject?.name ?? "Project detail"}
          subtitle={selectedProject?.workspacePath ?? "Select a project to inspect its threads."}
          stats={SURFACES.map((surface) => ({
            label: surface.label,
            value: String(
              selectedProject ? (countsByProject.get(selectedProject.projectId) ?? EMPTY_COUNTS)[surface.mode] : 0,
            ),
          }))}
        >
          {actionError ? <div className="mc-next-settings-notice error">{actionError}</div> : null}
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
      </NativeGrid>
    </NativePageFrame>
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

function normalizeMode(mode?: ChatMode): ChatMode {
  return mode === "cowork" || mode === "code" ? mode : "chat";
}

function createEmptyCounts(): ProjectCounts {
  return { ...EMPTY_COUNTS };
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
