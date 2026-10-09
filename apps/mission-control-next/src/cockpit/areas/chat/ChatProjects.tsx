import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ProjectRecents } from "./ProjectRecents";
import { ProjectImport } from "./ProjectImport";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { fetchChatProjects } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  useProjectPinController,
  PROJECT_FILTER_VIEWS,
  type ProjectFilterView,
} from "../../../features/native-routes/projects/use-project-pin-archive";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { ProjectEditor } from "./ProjectEditor";
import { ProjectDetail } from "./ProjectDetail";

export function ChatProjects() {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const access = useProjectAccess(JSON.stringify([activeCitadelId, activeWorkspaceId]));
  return (
    <ProjectsWorkspace key={access.identity} workspaceId={activeWorkspaceId ?? "default"} citadelId={activeCitadelId} />
  );
}
function ProjectsWorkspace({ workspaceId, citadelId }: { workspaceId: string; citadelId?: string }) {
  const route = useCockpitRoute(),
    leave = useDraftLeave();
  const access = useProjectAccess(JSON.stringify([citadelId, workspaceId]));
  const pins = useProjectPinController(workspaceId, access.presentationScope);
  const [query, setQuery] = useSessionViewState(`projects:${access.presentationScope}:query`, "");
  const [filter, setFilter] = useSessionViewState<ProjectFilterView>(
    `projects:${access.presentationScope}:filter`,
    "active",
  );
  const [creating, setCreating] = useState(false);
  const projects = useQuery({
    queryKey: ["chat-projects", access.identity],
    queryFn: ({ signal }) => fetchChatProjects("all", 300, workspaceId, citadelId, { signal }),
    staleTime: 30_000,
  });
  let projectId: string | undefined;
  try {
    projectId = route.rest[1] ? decodeURIComponent(route.rest[1]) : undefined;
  } catch {
    projectId = route.rest[1];
  }
  useEffect(() => {
    setCreating(false);
  }, [projectId]);
  const scoped = projects.data?.items.filter((project) => project.workspaceId === workspaceId) ?? [];
  const selected = scoped.find((project) => project.projectId === projectId);
  const visible = scoped.filter(
    (project) =>
      (filter === "all" ||
        (filter === "pinned" ? pins.isPinned(project.projectId) : project.lifecycleStatus === filter)) &&
      `${project.name} ${project.description ?? ""} ${project.workspacePath}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const refresh = () => projects.refetch();
  const href = (id?: string) => `/chat/projects${id ? `/${encodeURIComponent(id)}` : ""}`;
  return (
    <section aria-label="Projects in Chat" className="mx-auto grid w-full max-w-6xl min-w-0 gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Projects</h1>
          <p className="text-sm text-fg-secondary">Organize Chat context in workspace {workspaceId}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => route.navigate("/chat")}>Conversations</Button>
          <Button onClick={() => leave.request(() => setCreating(true))}>New project</Button>
          <Button disabled={projects.isFetching} onClick={() => void refresh()}>
            Refresh projects
          </Button>
        </div>
      </header>
      <nav aria-label="Project governance" className="flex flex-wrap gap-3"><NativeOwnerLink href="/library/citadel-overview" scope={access.identity}>Open Citadels</NativeOwnerLink><NativeOwnerLink href="/library/citadel" scope={access.identity}>Use Mason</NativeOwnerLink><NativeOwnerLink href="/settings/onboarding" scope={access.identity}>Start here</NativeOwnerLink></nav>
      <ProjectRecents key={access.identity} workspaceId={workspaceId} />
      <ProjectImport key={access.identity} workspaceId={workspaceId} citadelId={citadelId} refresh={refresh} />
      <ClassicOwnerLink
        href={`/projects${projectId ? `/${encodeURIComponent(projectId)}` : ""}?workspaceId=${encodeURIComponent(workspaceId)}${citadelId ? `&citadelId=${encodeURIComponent(citadelId)}` : ""}`}
        scope={access.identity}
        label="Open project home, intake and artifacts in Classic"
      />
      <ClassicOwnerLink
        href={`/chat?workspaceId=${encodeURIComponent(workspaceId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`}
        scope={access.identity}
        label="Open local-folder and GitHub import in Classic Chat"
      />
      <p className="text-sm text-fg-muted">
        Native import, project overview and intake are available below. Classic remains available while full action parity is verified.
      </p>
      {projects.isPending ? <p role="status">Reading projects…</p> : null}
      {projects.error ? (
        <Callout tone="error">
          {describeApiError(projects.error).summary} Projects could not be refreshed. Retained details may be stale;
          writes are unavailable until a successful refresh.
        </Callout>
      ) : null}
      {creating ? (
        <ProjectEditor
          workspaceId={workspaceId}
          citadelId={citadelId}
          available={!projects.isPending && !projects.error}
          refresh={refresh}
          onClose={() => setCreating(false)}
          onSaved={(project) => {
            setCreating(false);
            route.navigate(href(project.projectId));
          }}
        />
      ) : null}
      {projectId ? (
        <>
          <Button className="justify-self-start" onClick={() => route.navigate(href())}>
            All projects
          </Button>
          {selected ? (
            <ProjectDetail
              key={selected.projectId}
              project={selected}
              workspaceId={workspaceId}
              citadelId={citadelId}
              available={!projects.error && !projects.isFetching}
              refresh={refresh}
              pinned={pins.isPinned(selected.projectId)}
              togglePin={() => pins.togglePinned(selected.projectId)}
            />
          ) : !projects.isPending && !projects.error ? (
            <Callout tone="warning">
              Project unavailable in this scope. It may be missing, unauthorized, or outside the loaded list. Refresh or
              return to all projects; the requested URL is preserved.
            </Callout>
          ) : null}
        </>
      ) : (
        <>
          <label className="grid gap-1 text-sm">
            Search projects
            <input
              aria-label="Search projects"
              className="min-w-0 rounded-md border border-line bg-raised p-2"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div aria-label="Project views" className="flex flex-wrap gap-2">
            {PROJECT_FILTER_VIEWS.map((view) => (
              <Button
                key={view.id}
                aria-pressed={filter === view.id}
                variant={filter === view.id ? "primary" : "secondary"}
                onClick={() => setFilter(view.id)}
              >
                {view.label}
              </Button>
            ))}
          </div>
          {!projects.isPending && !projects.error && !visible.length ? <p>No projects match this view.</p> : null}
          <WindowedRecordList items={visible} itemKey={(project) => project.projectId} label="Projects" threshold={50}>
            {(project) => (
              <article className="mb-2 grid min-w-0 gap-2 rounded-lg border border-line bg-raised p-3">
                <button
                  type="button"
                  className="w-full min-w-0 rounded-md p-2 text-left hover:bg-sunken"
                  onClick={() => route.navigate(href(project.projectId))}
                >
                  <span className="block break-words font-medium text-fg">{project.name}</span>
                  <span className="block break-words text-sm text-fg-secondary">
                    {project.description || project.workspacePath}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {project.lifecycleStatus === "archived" ? "Archived" : "Active"}
                    {pins.isPinned(project.projectId) ? " · Pinned" : ""}
                  </span>
                </button>
                <TechnicalDetails>
                  <p>Revision {project.revision}</p>
                </TechnicalDetails>
                <Button
                  className="justify-self-start"
                  aria-label={`${pins.isPinned(project.projectId) ? "Unpin" : "Pin"} ${project.name}`}
                  onClick={() => pins.togglePinned(project.projectId)}
                >
                  {pins.isPinned(project.projectId) ? "Unpin" : "Pin"}
                </Button>
              </article>
            )}
          </WindowedRecordList>
          <p className="text-xs text-fg-muted">
            Showing up to 300 projects in this scope. Pins are stored as local presentation preferences.
          </p>
        </>
      )}
      {leave.dialog}
    </section>
  );
}
