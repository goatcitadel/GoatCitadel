import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { LibraryLinkedArtifact } from "./LibraryLinkedArtifact";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Sheet } from "../../ui/Sheet";
import { LibraryResourceDetail } from "./LibraryResourceDetail";
import { LibraryFileUpload } from "./LibraryFileUpload";
import { LibraryNotesWorkspace } from "./LibraryNotesWorkspace";
import { LibraryMemoryWorkspace } from "./LibraryMemoryWorkspace";
import {
  loadLibraryResources,
  resourceBinding,
  resourceDescription,
  resourceId,
  resourceTitle,
  type ResourceKind,
} from "./library-resources";

const TITLES = { memory: "Memory", notes: "Notes", files: "Files", artifacts: "Artifacts" } as const;
export function LibraryResources({
  kind, workspaceId, citadelId,
}: { kind: ResourceKind; workspaceId: string; citadelId: string }) {
  if (kind === "notes") return <LibraryNotesWorkspace key={workspaceId} workspaceId={workspaceId} />;
  if (kind === "memory") return <LibraryMemoryWorkspace key={workspaceId} workspaceId={workspaceId} citadelId={citadelId} />;
  return <LibraryResourceDirectory kind={kind} workspaceId={workspaceId} citadelId={citadelId} />;
}

function LibraryResourceDirectory({
  kind,
  workspaceId,
  citadelId,
}: {
  kind: ResourceKind;
  workspaceId: string;
  citadelId: string;
}) {
  const route = useCockpitRoute();
  const params = new URLSearchParams(route.search);
  const projectId = kind === "artifacts" ? params.get("projectId") ?? undefined : undefined;
  const artifactId = kind === "artifacts" ? params.get("artifactId") ?? undefined : undefined;
  const access = useProjectAccess(JSON.stringify([workspaceId, citadelId]));
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string>();
  const resourceQuery = useQuery({
    queryKey: ["library", "resources", kind, workspaceId, citadelId, access.identity, projectId, query, status, cursors.at(-1)],
    queryFn: () => loadLibraryResources({ kind, workspaceId, citadelId, projectId, query, status, cursor: cursors.at(-1) }),
    staleTime: 0,
  });
  // The last good directory window (and an open preview) stays while it is read again.
  const view = recordView(resourceQuery);
  const data = view.record;
  const lastVersion = lastVersionNote(view);
  const selection = data?.items.find((item) => resourceBinding(item) === selected);
  function reset() {
    setSelected(undefined);
    setCursors([undefined]);
  }
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-5" aria-label={`Library ${TITLES[kind]}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">{TITLES[kind]}</h1>
          <p className="mt-1 text-sm text-fg-secondary">
            {kind === "files"
              ? "Installation shared files. Workspace selection does not change this file root."
              : `Read-only ${TITLES[kind].toLowerCase()} inspection for the selected workspace.`}
          </p>
          {kind === "memory" ? (
            <p className="mt-1 text-xs text-fg-muted">
              The memory owner also includes globally visible records. Scope is labeled on each item.
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          disabled={resourceQuery.isFetching}
          onClick={() => {
            reset();
            void resourceQuery.refetch();
          }}
        >
          Refresh {TITLES[kind].toLowerCase()}
        </Button>
      </header>
      {artifactId ? <LibraryLinkedArtifact key={JSON.stringify([access.identity, projectId, artifactId])} artifactId={artifactId} projectId={projectId} workspaceId={workspaceId} citadelId={citadelId} /> : null}
      {projectId ? <p className="break-all text-sm">Project artifact scope: {projectId}</p> : null}
      {kind === "files" ? <LibraryFileUpload workspaceId={workspaceId} citadelId={citadelId} /> : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          reset();
          setQuery(draftQuery.trim());
        }}
      >
        <label className="min-w-0 flex-1 text-sm text-fg-secondary">
          Filter {TITLES[kind].toLowerCase()}
          <input
            className="mt-1 block min-h-10 w-full rounded-md border border-line bg-raised px-3 text-fg"
            maxLength={200}
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
          />
        </label>
        {kind === "memory" || kind === "notes" ? (
          <label className="text-sm text-fg-secondary">
            Status
            <select
              className="mt-1 block min-h-10 rounded-md border border-line bg-raised px-2 text-fg"
              value={status}
              onChange={(event) => {
                reset();
                setStatus(event.target.value);
              }}
            >
              <option value="active">Active</option>
              <option value={kind === "notes" ? "archived" : "forgotten"}>
                {kind === "notes" ? "Archived" : "Forgotten"}
              </option>
              <option value="all">All statuses</option>
            </select>
          </label>
        ) : null}
        <Button type="submit">Apply filter</Button>
      </form>
      {view.phase === "loading" ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading {TITLES[kind].toLowerCase()}…
        </p>
      ) : view.phase === "checking" ? (
        <p role="status" className="text-sm text-fg-muted">
          {CHECKING_FOR_CHANGES}
        </p>
      ) : null}
      {resourceQuery.isError && data ? (
        <p role="alert" className="text-sm text-status-failed">
          {describeApiError(resourceQuery.error).summary} {lastVersion}
        </p>
      ) : null}
      {resourceQuery.isError && !data ? (
        <EmptyState
          title={`${TITLES[kind]} unavailable`}
          description={describeApiError(resourceQuery.error).summary}
          action={
            <Button
              onClick={() => {
                reset();
                void resourceQuery.refetch();
              }}
            >
              Reload directory
            </Button>
          }
        />
      ) : null}
      {data ? (
        <>
          <p className="text-xs text-fg-muted">{data.coverage}</p>
          {data.items.length ? (
            <ul className="grid gap-2">
              {data.items.map((resource) => (
                <li key={resourceId(resource)} className="rounded-lg border border-line bg-raised p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words text-sm font-semibold text-fg">{resourceTitle(resource)}</h2>
                      <p className="mt-1 text-xs text-fg-muted">{resourceDescription(resource)}</p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setSelected(resourceBinding(resource))}
                      aria-label={`Inspect ${resourceTitle(resource)}`}
                    >
                      Inspect
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title={`No ${TITLES[kind].toLowerCase()} returned`}
              description="No matching records were returned in this directory window."
            />
          )}
          {kind === "memory" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={cursors.length < 2}
                onClick={() => {
                  setSelected(undefined);
                  setCursors((current) => current.slice(0, -1));
                }}
              >
                Previous memory page
              </Button>
              <Button
                size="sm"
                disabled={!data.nextCursor}
                onClick={() => {
                  setSelected(undefined);
                  setCursors((current) => [...current, data.nextCursor]);
                }}
              >
                Next memory page
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <ClassicOwnerLink
        className="text-sm font-medium text-accent hover:underline"
        href={`/library/${kind}?shell=classic`}
        scope={JSON.stringify([workspaceId, citadelId, kind])}
        label={`Open ${TITLES[kind].toLowerCase()} management`}
      />
      <Sheet
        open={Boolean(selection)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={`${TITLES[kind]} preview`}
        sideOnDesktop
      >
        {selection ? (
          <LibraryResourceDetail key={selected} resource={selection} workspaceId={workspaceId} citadelId={citadelId} />
        ) : null}
      </Sheet>
    </section>
  );
}
