import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Castle,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
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
  restoreChatProject,
  updateChatProject,
} from "@goatcitadel/mission-control-shared/api/client";
import { RecentCrossProjectSessionsRow } from "./RecentCrossProjectSessionsRow";
import { NewSessionButton, ProjectGlyphButton, filterEmptyLabel } from "./ProjectsRoutePage.components";
import { ProjectHomeBasePanel } from "./ProjectHomeBasePanel";
import type { AppRoute } from "@next/app/route-model";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, FilterPillGroup, NativeButton, NativeSelectableList, NoticeBanner } from "../primitives";
import { readRouteDiagnosticNow, recordRouteAction, recordRouteDataLoad } from "../route-diagnostics";
import type { NativeRoutePagesProps } from "../types";
import {
  SURFACES,
  createEmptyCounts,
  dateValue,
  deriveProjectHome,
  formatDateTime,
  getErrorMessage,
  labelForMode,
  normalizeMode,
  type ProjectCounts,
  type ProjectIntakeMode,
  type ProjectIntakeModeId,
} from "./ProjectsRoutePage.helpers";
import { PROJECT_FILTER_VIEWS, useProjectPinController, type ProjectFilterView } from "./use-project-pin-archive";
import { useProjectRevisionConflict } from "./use-project-revision-conflict";
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

type ProjectSessionStartOptions = {
  title?: string;
  tags?: string[];
  intakeId?: ProjectIntakeModeId;
};

export function ProjectsRoutePage({
  route,
  activeCitadelId,
  activeCitadelName,
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
  const [cardActionBusy, setCardActionBusy] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState({ name: "", workspacePath: "", description: "" });
  const [editDraft, setEditDraft] = useState({ name: "", workspacePath: "", description: "" });
  const [filterView, setFilterView] = useState<ProjectFilterView>("all");
  const createProjectNameRef = useRef<HTMLInputElement | null>(null);
  const isMounted = useIsMounted();

  const replaceProjects = useCallback((projects: ChatProjectRecord[]) => {
    setState((current) => ({ ...current, projects }));
  }, []);
  const { revisionConflict, clearRevisionConflict, handleRevisionConflict } = useProjectRevisionConflict({
    activeCitadelId,
    activeWorkspaceId,
    isMounted,
    onProjectsRefreshed: replaceProjects,
  });

  const pinController = useProjectPinController(activeWorkspaceId);

  const handleFocusCreateProject = useCallback(() => {
    createProjectNameRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    createProjectNameRef.current?.focus();
  }, []);

  const handleOpenSurface = useCallback(
    (mode: ChatMode) => {
      void mode;
      navigate({ area: "chat", theme: route.theme });
    },
    [navigate, route.theme],
  );

  const handleOpenStartHere = useCallback(() => {
    navigate({ area: "settings", section: "onboarding", theme: route.theme });
  }, [navigate, route.theme]);

  const handleOpenCitadels = useCallback(() => {
    navigate({ area: "library", section: "citadel-overview", theme: route.theme });
  }, [navigate, route.theme]);

  const handleOpenMason = useCallback(() => {
    navigate({ area: "library", section: "citadel", theme: route.theme });
  }, [navigate, route.theme]);

  const loadProjects = useCallback(async () => {
    const startedAt = readRouteDiagnosticNow();
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const nextData = await fetchProjectData(activeWorkspaceId, activeCitadelId);
      if (!isMounted()) {
        return;
      }
      setState({ ...nextData, loading: false, error: null });
      recordRouteDataLoad({
        route: "projects",
        label: "Projects",
        startedAt,
        itemCount: nextData.projects.length + nextData.sessions.length + nextData.artifacts.length,
        issueCount: nextData.artifactIssue ? 1 : 0,
      });
    } catch (error) {
      if (!isMounted()) {
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        error: getErrorMessage(error),
      }));
    }
  }, [activeCitadelId, activeWorkspaceId, isMounted]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const startedAt = readRouteDiagnosticNow();
      setState((current) => ({ ...current, loading: true, error: null }));
      const nextData = await fetchProjectData(activeWorkspaceId, activeCitadelId);
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
  }, [activeCitadelId, activeWorkspaceId]);

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

  const filterCounts = useMemo(() => {
    const total = state.projects.length;
    let pinned = 0;
    let active = 0;
    let archived = 0;
    for (const project of state.projects) {
      if (project.lifecycleStatus === "archived") {
        archived += 1;
      } else {
        active += 1;
      }
      if (pinController.isPinned(project.projectId)) {
        pinned += 1;
      }
    }
    return { all: total, pinned, active, archived };
  }, [pinController, state.projects]);

  const visibleProjects = useMemo(() => {
    return state.projects.filter((project) => {
      switch (filterView) {
        case "pinned":
          return pinController.isPinned(project.projectId);
        case "active":
          return project.lifecycleStatus !== "archived";
        case "archived":
          return project.lifecycleStatus === "archived";
        default:
          return true;
      }
    });
  }, [filterView, pinController, state.projects]);

  const fallbackProject =
    visibleProjects.find((project) => project.lifecycleStatus !== "archived") ??
    visibleProjects[0] ??
    state.projects.find((project) => project.lifecycleStatus !== "archived") ??
    state.projects[0] ??
    null;
  const selectedProject = state.projects.find((project) => project.projectId === route.projectId) ?? fallbackProject;

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
      chat: selectedSessions,
      cowork: [] as ChatSessionRecord[],
      code: [] as ChatSessionRecord[],
    }),
    [selectedSessions],
  );

  useEffect(() => {
    if (revisionConflict?.preserveDraft && revisionConflict.projectId === selectedProject?.projectId) {
      return;
    }
    if (revisionConflict && revisionConflict.projectId !== selectedProject?.projectId) {
      clearRevisionConflict();
    }
    setEditDraft({
      name: selectedProject?.name ?? "",
      workspacePath: selectedProject?.workspacePath ?? "",
      description: selectedProject?.description ?? "",
    });
  }, [
    revisionConflict,
    clearRevisionConflict,
    selectedProject?.description,
    selectedProject?.name,
    selectedProject?.projectId,
    selectedProject?.workspacePath,
  ]);

  const projectHome = useMemo(
    () => (selectedProject ? deriveProjectHome(selectedProject, selectedSessions, state.artifacts) : null),
    [selectedProject, selectedSessions, state.artifacts],
  );

  const handleNewSession = async (mode: ChatMode, options: ProjectSessionStartOptions = {}) => {
    if (!selectedProject) {
      return;
    }
    const requestMode = normalizeMode(mode);
    setActionError(null);
    try {
      const session = await createChatSession(
        {
          citadelId: activeCitadelId,
          workspaceId: activeWorkspaceId,
          projectId: selectedProject.projectId,
          mode: requestMode,
          origin: "operator",
          title: options.title ?? `${labelForMode(requestMode)} - ${selectedProject.name}`,
          tags: options.tags,
        },
        { originSurface: requestMode },
      );
      recordRouteAction("projects", options.intakeId ? "session.intake.created" : "session.created", {
        mode: requestMode,
        intakeId: options.intakeId,
        projectId: selectedProject.projectId,
        sessionId: session.sessionId,
      });
      navigate({
        area: "chat",
        sessionId: session.sessionId,
        projectId: selectedProject.projectId,
        theme: route.theme,
      });
    } catch (error) {
      if (isMounted()) {
        setActionError(getErrorMessage(error));
      }
    }
  };

  const handleStartIntake = async (intent: ProjectIntakeMode) => {
    if (!selectedProject) {
      return;
    }
    await handleNewSession(intent.mode, {
      title: `${intent.titlePrefix} - ${selectedProject.name}`,
      tags: ["project-intake", intent.tag],
      intakeId: intent.id,
    });
  };

  const handleContinueSession = async (mode: ChatMode) => {
    if (!selectedProject) {
      return;
    }
    const latest = projectHome?.latestByMode[normalizeMode(mode)] ?? null;
    if (latest) {
      navigate({
        area: "chat",
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
        citadelId: activeCitadelId,
        workspaceId: activeWorkspaceId,
        name,
        workspacePath,
        description: createDraft.description.trim() || undefined,
      });
      if (!isMounted()) {
        return;
      }
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
      if (isMounted()) {
        setActionError(getErrorMessage(error));
      }
    } finally {
      if (isMounted()) {
        setProjectActionBusy(null);
      }
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
        expectedRevision: selectedProject.revision,
        citadelId: activeCitadelId,
        workspaceId: activeWorkspaceId,
        name,
        workspacePath,
        description: editDraft.description.trim() || undefined,
      });
      if (!isMounted()) {
        return;
      }
      setState((current) => ({
        ...current,
        projects: current.projects.map((item) => (item.projectId === project.projectId ? project : item)),
      }));
      clearRevisionConflict();
      recordRouteAction("projects", "project.updated", {
        projectId: project.projectId,
      });
    } catch (error) {
      if (isMounted()) {
        if (await handleRevisionConflict(error, selectedProject.projectId, true, "save")) {
          return;
        }
        setActionError(getErrorMessage(error));
      }
    } finally {
      if (isMounted()) {
        setProjectActionBusy(null);
      }
    }
  };

  const handleArchiveProject = async (project: ChatProjectRecord) => {
    setActionError(null);
    setCardActionBusy(`archive:${project.projectId}`);
    try {
      const archived = await archiveChatProject(project.projectId, project.revision);
      if (!isMounted()) {
        return;
      }
      setState((current) => ({
        ...current,
        projects: current.projects.map((item) => (item.projectId === archived.projectId ? archived : item)),
      }));
      clearRevisionConflict();
      recordRouteAction("projects", "project.archived", {
        projectId: archived.projectId,
      });
      if (selectedProject?.projectId === project.projectId) {
        navigate({ area: "projects", theme: route.theme }, { replace: true });
      }
    } catch (error) {
      if (isMounted()) {
        if (await handleRevisionConflict(error, project.projectId, false, "archive")) {
          return;
        }
        setActionError(getErrorMessage(error));
      }
    } finally {
      if (isMounted()) {
        setCardActionBusy(null);
      }
    }
  };

  const handleRestoreProject = async (project: ChatProjectRecord) => {
    setActionError(null);
    setCardActionBusy(`restore:${project.projectId}`);
    try {
      const restored = await restoreChatProject(project.projectId, project.revision);
      if (!isMounted()) {
        return;
      }
      setState((current) => ({
        ...current,
        projects: current.projects.map((item) => (item.projectId === restored.projectId ? restored : item)),
      }));
      clearRevisionConflict();
      recordRouteAction("projects", "project.restored", {
        projectId: restored.projectId,
      });
    } catch (error) {
      if (isMounted()) {
        if (await handleRevisionConflict(error, project.projectId, false, "restore")) {
          return;
        }
        setActionError(getErrorMessage(error));
      }
    } finally {
      if (isMounted()) {
        setCardActionBusy(null);
      }
    }
  };

  const handleTogglePin = (project: ChatProjectRecord) => {
    pinController.togglePinned(project.projectId);
    recordRouteAction("projects", "project.pin.toggled", {
      projectId: project.projectId,
      pinned: !pinController.isPinned(project.projectId),
    });
  };

  const totalProjectSessions = state.sessions.filter((session) => session.projectId).length;

  // WS-D2: "Continue where you left off" lead built from the already-selected
  // project and its derived home. The Open action reuses the most-recent session
  // (via the same navigate shape the thread groups use) or falls back to
  // continuing the project's freshest surface. Suppressed when no project exists
  // so the existing guided empty state leads instead.
  const recentLeadSession = projectHome?.recentSessions[0] ?? null;
  const projectContinuationLead =
    selectedProject && projectHome ? (
      <article className="mc-next-project-lead-card" aria-label="Continue where you left off">
        <div className="mc-next-settings-selectable-head">
          <strong>{selectedProject.name}</strong>
          <span>{projectHome.healthLabel}</span>
        </div>
        <p>
          {/* "No activity yet" reads as a full phrase; only real timestamps get the "Last activity" prefix. */}
          {`${projectHome.lastActivityLabel === "No activity yet" ? "" : "Last activity "}${projectHome.lastActivityLabel} · ${
            projectHome.activeCount
          } active ${projectHome.activeCount === 1 ? "thread" : "threads"} · ${
            selectedProject.description?.trim() || selectedProject.workspacePath
          }`}
        </p>
        <div className="mc-next-settings-button-row">
          <NativeButton
            onClick={() => {
              if (recentLeadSession) {
                navigate({
                  area: recentLeadSession.mode ?? "chat",
                  sessionId: recentLeadSession.sessionId,
                  projectId: selectedProject.projectId,
                  theme: route.theme,
                });
                return;
              }
              navigate({ area: "projects", projectId: selectedProject.projectId, theme: route.theme });
            }}
          >
            <MessageSquarePlus size={16} />
            {recentLeadSession ? "Open latest thread" : "Open project"}
          </NativeButton>
          <NativeButton variant="outline" onClick={handleOpenCitadels}>
            <Castle size={16} />
            Open Citadel
          </NativeButton>
        </div>
      </article>
    ) : null;
  const emptyProjectLead =
    state.projects.length === 0 ? (
      <article className="mc-next-project-empty-guide mc-next-project-empty-guide-promoted">
        <div>
          <span className="mc-next-project-lead-eyebrow">First project</span>
          <strong>Create a bounded home for the work</strong>
          <p>Start with a project, then open Chat or use the sample mission to shape its first run.</p>
        </div>
        <div className="mc-next-settings-button-row">
          <NativeButton onClick={handleFocusCreateProject}>
            <FolderPlus size={16} />
            Create project
          </NativeButton>
          <NativeButton variant="outline" onClick={() => handleOpenSurface("chat")}>
            <MessageSquarePlus size={16} />
            Start Chat
          </NativeButton>
          <NativeButton variant="outline" onClick={handleOpenStartHere}>
            Use sample mission
          </NativeButton>
        </div>
      </article>
    ) : null;
  const citadelLead = (
    <article className="mc-next-project-citadel-lead" aria-label="Default Citadels">
      <div>
        <span>Citadels</span>
        <strong>Personal and Company operating spaces ship by default.</strong>
        <p>
          Use Citadels to govern projects with a Charter, Chambers, Wards, and Gatehouse posture before work crosses
          sensitive boundaries.
        </p>
      </div>
      <div className="mc-next-project-citadel-defaults" aria-label="Default Citadel types">
        <div>
          <strong>Personal</strong>
          <span>Private goals, routines, notes, and approval-gated assistance.</span>
        </div>
        <div>
          <strong>Company</strong>
          <span>Shared work, business memory, roles, and governed operating posture.</span>
        </div>
      </div>
      <div className="mc-next-settings-button-row">
        <NativeButton onClick={handleOpenCitadels}>
          <Castle size={16} />
          Open Citadels
        </NativeButton>
        <NativeButton variant="outline" onClick={handleOpenMason}>
          <FolderPlus size={16} />
          Use Mason
        </NativeButton>
      </div>
    </article>
  );
  const leadContent = (
    <div className="mc-next-project-lead-stack">
      {projectContinuationLead}
      {emptyProjectLead}
      {state.projects.length === 0 ? (
        <NativeDisclosureCard
          id="projects-citadel-context"
          title="About Citadels"
          subtitle="How Personal and Company operating spaces govern projects."
        >
          {citadelLead}
        </NativeDisclosureCard>
      ) : (
        citadelLead
      )}
    </div>
  );

  return (
    <NativePageFrame
      area="projects"
      kicker="Projects · Containers"
      title="Project containers"
      description={`Project chat threads inside ${(activeCitadelName ?? activeCitadelId) || "the active Citadel"} > ${activeWorkspaceName}.`}
      loading={state.loading}
      error={state.error}
      lead={leadContent}
      metrics={[
        { label: "Projects", value: String(state.projects.length) },
        { label: "Project sessions", value: String(totalProjectSessions) },
        { label: "Citadel", value: activeCitadelId ?? "legacy" },
      ]}
      actions={
        state.projects.length === 0 ? (
          <NativeButton onClick={handleFocusCreateProject}>
            <FolderPlus size={16} />
            Create project
          </NativeButton>
        ) : (
          SURFACES.map((surface) => (
            <NewSessionButton
              key={`head-${surface.mode}`}
              mode={surface.mode}
              label={surface.action}
              disabled={!selectedProject}
              onSelect={() => void handleNewSession(surface.mode)}
            />
          ))
        )
      }
    >
      <NativeGrid className="mc-next-native-projects-grid">
        <NativeCard
          title="Projects"
          subtitle="Containers that bind Chat threads, files, and proof together."
          density="compact"
          stats={[
            { label: "Projects", value: String(state.projects.length) },
            { label: "Sessions", value: String(totalProjectSessions) },
          ]}
          actions={
            <button type="button" className="mc-next-settings-filter" onClick={() => void loadProjects()}>
              <RefreshCw size={16} />
              Refresh
            </button>
          }
        >
          <FilterPillGroup
            label="Filter projects by state"
            idPrefix="projects-filter"
            value={filterView}
            options={PROJECT_FILTER_VIEWS.map((entry) => ({
              value: entry.id,
              label: entry.label,
              count: filterCounts[entry.id],
              ariaLabel: `${entry.label} projects (${filterCounts[entry.id]})`,
            }))}
            onChange={(value) => setFilterView(value as ProjectFilterView)}
          />
          <NativeSelectableList density="compact" maxHeight="min(62vh, 38rem)">
            {visibleProjects.length ? (
              visibleProjects.map((project) => {
                const counts = countsByProject.get(project.projectId) ?? createEmptyCounts();
                const pinned = pinController.isPinned(project.projectId);
                const isArchived = project.lifecycleStatus === "archived";
                const isSelected = selectedProject?.projectId === project.projectId;
                return (
                  <div
                    key={project.projectId}
                    className={`mc-next-project-card${isSelected ? " is-selected" : ""}${
                      isArchived ? " is-archived" : ""
                    }${pinned ? " is-pinned" : ""}`}
                  >
                    <button
                      type="button"
                      className={`mc-next-settings-selectable mc-next-project-card-body${isSelected ? " active" : ""}`}
                      aria-pressed={isSelected}
                      onClick={() => navigate({ area: "projects", projectId: project.projectId, theme: route.theme })}
                    >
                      <div className="mc-next-settings-selectable-head">
                        <strong>{project.name}</strong>
                        <span>{counts.chat + counts.cowork + counts.code} threads</span>
                      </div>
                      <p>{project.description?.trim() || project.workspacePath}</p>
                      <div className="mc-next-project-counts">
                        <span>Chat {counts.chat + counts.cowork + counts.code}</span>
                      </div>
                    </button>
                    <div
                      className="mc-next-project-card-glyphs"
                      role="group"
                      aria-label={`Actions for ${project.name}`}
                    >
                      <ProjectGlyphButton
                        label={pinned ? `Unpin project ${project.name}` : `Pin project ${project.name}`}
                        pressed={pinned}
                        onClick={() => handleTogglePin(project)}
                      >
                        {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
                      </ProjectGlyphButton>
                      {isArchived ? (
                        <ProjectGlyphButton
                          label={`Unarchive project ${project.name}`}
                          pressed={false}
                          busy={cardActionBusy === `restore:${project.projectId}`}
                          onClick={() => void handleRestoreProject(project)}
                        >
                          <ArchiveRestore size={14} aria-hidden="true" />
                        </ProjectGlyphButton>
                      ) : (
                        <ProjectGlyphButton
                          label={`Archive project ${project.name}`}
                          pressed={false}
                          busy={cardActionBusy === `archive:${project.projectId}`}
                          onClick={() => void handleArchiveProject(project)}
                        >
                          <Archive size={14} aria-hidden="true" />
                        </ProjectGlyphButton>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <>
                <EmptyState
                  size="compact"
                  title={
                    state.projects.length === 0
                      ? "No active projects found in this workspace."
                      : filterEmptyLabel(filterView)
                  }
                />
              </>
            )}
          </NativeSelectableList>
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
          {revisionConflict ? <NoticeBanner tone="warning" message={revisionConflict.message} /> : null}
          {actionError ? <NoticeBanner tone="error" message={actionError} /> : null}
          {state.artifactIssue ? (
            <NoticeBanner tone="warning" message={`Project artifact records could not load: ${state.artifactIssue}`} />
          ) : null}
          {selectedProject && projectHome ? (
            <ProjectHomeBasePanel
              home={projectHome}
              pendingApprovals={pendingApprovals}
              projectName={selectedProject.name}
              onContinue={(mode) => void handleContinueSession(mode)}
              onStartIntake={(intent) => void handleStartIntake(intent)}
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
              <NativeButton
                key={surface.mode}
                disabled={!selectedProject}
                onClick={() => void handleNewSession(surface.mode)}
              >
                <MessageSquarePlus size={16} />
                {surface.action}
              </NativeButton>
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
          className="mc-next-project-controls-card"
          title="Project controls"
          subtitle={
            selectedProject
              ? "Create a new project or rename the selected one. Pin and archive live on each card."
              : "Create a new project. Select one to rename it; pin and archive live on each card."
          }
          density="compact"
          scrollBody
          bodyMaxHeight="min(70vh, 42rem)"
        >
          <div className="mc-next-project-controls">
            <section className="mc-next-project-control-section">
              <div className="mc-next-project-control-heading">
                <FolderPlus size={16} />
                <strong>Create project</strong>
              </div>
              <label className="mc-next-settings-field">
                <span>Name</span>
                <input
                  ref={createProjectNameRef}
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
              <NativeButton disabled={projectActionBusy === "create"} onClick={() => void handleCreateProject()}>
                <FolderPlus size={16} />
                {projectActionBusy === "create" ? "Creating..." : "Create project"}
              </NativeButton>
            </section>

            {selectedProject ? (
              <section className="mc-next-project-control-section">
                <div className="mc-next-project-control-heading">
                  <Pencil size={16} />
                  <strong>Edit selected</strong>
                </div>
                <label className="mc-next-settings-field">
                  <span>Name</span>
                  <input
                    className="mc-next-settings-input"
                    value={editDraft.name}
                    onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>Workspace path</span>
                  <input
                    className="mc-next-settings-input"
                    value={editDraft.workspacePath}
                    onChange={(event) => setEditDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>Description</span>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={editDraft.description}
                    onChange={(event) => setEditDraft((current) => ({ ...current, description: event.target.value }))}
                  />
                </label>
                <div className="mc-next-settings-button-row">
                  <NativeButton disabled={projectActionBusy === "save"} onClick={() => void handleSaveProject()}>
                    <Save size={16} />
                    {projectActionBusy === "save" ? "Saving..." : "Save project"}
                  </NativeButton>
                </div>
                <p className="mc-next-settings-field-note">
                  Revision {selectedProject.revision} fences concurrent edits. Pin or archive {selectedProject.name}{" "}
                  from the card glyphs in the projects list.
                </p>
              </section>
            ) : null}
          </div>
        </NativeCard>
      </NativeGrid>
      <RecentCrossProjectSessionsRow workspaceId={activeWorkspaceId} route={route} navigate={navigate} />
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
  void mode;
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
                  area: "chat",
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
        <EmptyState size="compact" title={`No ${label.toLowerCase()} threads in this project.`} />
      )}
    </section>
  );
}

async function fetchProjectData(
  activeWorkspaceId: string,
  activeCitadelId?: string,
): Promise<Pick<ProjectsState, "projects" | "sessions" | "artifacts" | "artifactIssue">> {
  const artifactsRequest = fetchChatGeneratedArtifacts({
    citadelId: activeCitadelId,
    workspaceId: activeWorkspaceId,
    limit: 1000,
  })
    .then((response) => ({ items: response.items, issue: null as string | null }))
    .catch((error: unknown) => ({
      items: [] as ChatGeneratedArtifactRecord[],
      issue: getErrorMessage(error),
    }));
  const [projectsResponse, sessionsResponse, artifactsResponse] = await Promise.all([
    fetchChatProjects("all", 300, activeWorkspaceId, activeCitadelId),
    fetchChatSessions({
      citadelId: activeCitadelId,
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
