import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWorkspaces, listCitadels } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceEditor } from "../../../features/native-routes/settings/use-workspace-editor";
import { hasWorkspaceBinding } from "../../../features/native-routes/settings/workspace-editor-state";
import { useDirectoryLifecycle } from "../../../features/native-routes/settings/use-directory-lifecycle";
import type { DirectoryLifecycleReview as LifecycleReview } from "../../../features/native-routes/settings/directory-lifecycle-binding";
import { DirectoryLifecycleReview } from "./DirectoryLifecycleReview";
import { CitadelDirectory } from "./CitadelDirectory";
import { Button } from "../../ui/Button";

const PAGE_SIZE = 20;
const inputClass = "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg";
export interface WorkspaceSettingsProps {
  citadelId: string;
  citadelName?: string;
  activeWorkspaceId?: string;
}

export function WorkspaceSettings(props: WorkspaceSettingsProps) {
  return (
    <>
      <WorkspaceDirectory key={`workspaces:${props.citadelId}`} {...props} />
      <CitadelDirectory key={`citadels:${props.citadelId}`} activeCitadelId={props.citadelId} />
    </>
  );
}

function WorkspaceDirectory({ citadelId, citadelName, activeWorkspaceId }: WorkspaceSettingsProps) {
  const { setActiveWorkspaceId } = useUiPreferences();
  const workspaces = useQuery({
    queryKey: ["settings", "workspaces", citadelId],
    queryFn: () => fetchWorkspaces("all", 500, citadelId),
    enabled: Boolean(citadelId),
  });
  const citadels = useQuery({ queryKey: ["settings", "workspace-citadels"], queryFn: () => listCitadels("all", 500) });
  const [selectedId, setSelectedId] = useState("");
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const records = workspaces.data?.items;
  const ready = Boolean(
    citadelId &&
    !workspaces.isError &&
    Array.isArray(records) &&
    (!workspaces.data?.citadelId || workspaces.data.citadelId === citadelId) &&
    records?.every((item) => hasWorkspaceBinding(item, citadelId)) &&
    new Set(records?.map((item) => item.workspaceId)).size === records?.length,
  );
  const items = ready ? records! : [];
  const selected = items.find((item) => item.workspaceId === selectedId) ?? null;
  const parent =
    !citadels.isError && Array.isArray(citadels.data?.items)
      ? citadels.data.items.find((item) => item.citadelId === citadelId)
      : undefined;
  const available = ready && !workspaces.isFetching && !citadels.isFetching && parent?.lifecycleStatus === "active";
  const lifecycle = useDirectoryLifecycle({
    ownerKey: citadelId,
    available,
    reload: () => workspaces.refetch(),
    onConfirmed: (review) => {
      if (review.kind === "workspace" && review.record.workspaceId === selectedId) setMode(null);
    },
  });
  const action = useWorkspaceEditor({
    citadelId,
    citadelName,
    selected,
    selectedId,
    mode,
    available,
    metadataOnly: true,
    reload: () => workspaces.refetch(),
    onCreated: (created) => {
      setSelectedId(created.workspaceId);
      setMode("edit");
    },
  });
  const draft = mode === "create" ? action.createDraft : action.editDraft;
  const filtered = items.filter((item) =>
    [item.name, item.description, item.slug].join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section
      id="workspace-directory"
      aria-label="Workspace directory"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Workspaces</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Organize work in {citadelName ?? citadelId}. Create, edit, archive, or restore workspace records.
        </p>
        <p className="mt-1 break-words text-xs text-fg-muted">
          Citadel: <span className="break-all font-mono">{citadelId || "Unavailable"}</span>. Workspace selection and
          governance stay as saved.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!available || action.locked} onClick={() => setMode("create")}>
          New workspace
        </Button>
        <Button
          size="sm"
          disabled={workspaces.isFetching || citadels.isFetching || action.pending}
          onClick={() => {
            void workspaces.refetch();
            void citadels.refetch();
          }}
        >
          Refresh workspaces
        </Button>
      </div>
      {workspaces.isLoading || citadels.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading workspace directory…
        </p>
      ) : null}
      {workspaces.isError || citadels.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Workspace directory unavailable: {describeApiError(workspaces.error ?? citadels.error).summary}
        </p>
      ) : null}
      {!workspaces.isLoading && !workspaces.isError && !ready ? (
        <p role="alert" className="text-sm text-status-failed">
          Workspace scope evidence is unavailable. Refresh the directory before editing.
        </p>
      ) : null}
      {!citadels.isLoading && !citadels.isError && parent?.lifecycleStatus !== "active" ? (
        <p role="status" className="text-sm text-status-waiting">
          This Citadel is unavailable or archived. Workspace editing is disabled.
        </p>
      ) : null}
      {mode ? (
        <div className="space-y-3 rounded-md border border-line bg-sunken p-3">
          <h4 className="font-medium text-fg">{mode === "create" ? "New workspace" : "Edit workspace metadata"}</h4>
          {mode === "edit" ? (
            <details className="text-xs text-fg-muted">
              <summary className="cursor-pointer text-fg-secondary">Workspace details</summary>
              <dl className="mt-2 space-y-1">
                <dt>Workspace ID</dt>
                <dd className="break-all font-mono">{selectedId}</dd>
                <dt>Revision</dt>
                <dd className="font-mono">{selected?.revision ?? "Unavailable"}</dd>
                <dt>Slug</dt>
                <dd className="break-all font-mono">{selected?.slug ?? "Unavailable"}</dd>
              </dl>
            </details>
          ) : null}
          {mode === "edit" && draft.hasRemoteChanges ? (
            <div role="status" className="space-y-2 text-sm text-status-waiting">
              <p>
                The workspace changed. Current saved name: {selected?.name}. Current description:{" "}
                {selected?.description || "None"}.
              </p>
              <Button size="sm" disabled={!available || action.locked} onClick={() => draft.rebaseToCurrent()}>
                Apply draft to current workspace
              </Button>
            </div>
          ) : null}
          <label className="block text-sm text-fg-secondary">
            {mode === "create" ? "New workspace name" : "Workspace name"}
            <input
              className={inputClass}
              value={draft.value.name}
              disabled={action.locked}
              onChange={(event) => draft.setValue((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="block text-sm text-fg-secondary">
            Workspace description
            <textarea
              className={inputClass}
              rows={3}
              value={draft.value.description}
              disabled={action.locked}
              onChange={(event) => draft.setValue((current) => ({ ...current, description: event.target.value }))}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={
                !available ||
                action.locked ||
                !draft.value.name.trim() ||
                draft.hasRemoteChanges ||
                (mode === "edit" && (!selected || !draft.isDirty))
              }
              onClick={() => void (mode === "create" ? action.create() : action.save())}
            >
              {mode === "create" ? "Create workspace" : "Save workspace metadata"}
            </Button>
            <Button onClick={() => setMode(null)}>Close editor{draft.isDirty ? " and keep draft" : ""}</Button>
          </div>
          <p className="text-xs text-fg-muted">Drafts are retained while this app stays open.</p>
        </div>
      ) : null}
      {action.notice ? (
        <p role={action.uncertain ? "alert" : "status"} className="text-sm text-fg-secondary">
          {action.notice}
        </p>
      ) : null}
      {action.pending ? (
        <p role="status" className="text-sm text-fg-muted">
          Waiting for the Gateway workspace owner…
        </p>
      ) : null}
      {lifecycle.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {lifecycle.notice}
        </p>
      ) : null}
      {ready ? (
        <>
          <label className="block text-sm text-fg-secondary">
            Search workspaces
            <input
              type="search"
              className={inputClass}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </label>
          <p className="text-xs text-fg-muted">
            Showing {Math.min(limit, filtered.length)} of {filtered.length} loaded workspaces
            {items.length === 500 ? " · Directory limited to 500 records" : ""}.
          </p>
          <ul className="space-y-2">
            {filtered.slice(0, limit).map((item) => {
              const target: LifecycleReview = {
                kind: "workspace",
                scope: citadelId,
                record: item,
                action: item.lifecycleStatus === "active" ? "archive" : "restore",
              };
              const locked = lifecycle.locked(target),
                attempt = lifecycle.attempt(target);
              return (
                <li key={item.workspaceId} className="rounded-md border border-line-subtle bg-sunken p-3">
                  <div className="flex flex-col items-start justify-between gap-2 sm:flex-row">
                    <div className="min-w-0 flex-1">
                      <h4 className="break-words text-sm font-semibold text-fg">{item.name}</h4>
                      <p className="mt-1 text-xs text-fg-muted">
                        {item.lifecycleStatus === "active" ? "Active" : "Archived"}
                        {item.workspaceId === activeWorkspaceId ? " · Current workspace" : ""}
                      </p>
                      <p className="mt-1 break-words text-sm text-fg-secondary">
                        {item.description || "No description"}
                      </p>
                    </div>
                    <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                      <Button
                        size="sm"
                        disabled={!available || locked || action.pending}
                        aria-label={`Edit workspace ${item.name}`}
                        onClick={() => {
                          setSelectedId(item.workspaceId);
                          setMode("edit");
                        }}
                      >
                        Edit metadata
                      </Button>
                      <Button
                        size="sm"
                        variant={target.action === "archive" ? "danger" : "secondary"}
                        disabled={
                          !available || locked || (item.workspaceId === "default" && target.action === "archive")
                        }
                        aria-label={`${target.action === "archive" ? "Archive" : "Restore"} workspace ${item.name}`}
                        onClick={() => lifecycle.request(target)}
                      >
                        {target.action === "archive" ? "Archive" : "Restore"}
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          !available ||
                          locked ||
                          item.lifecycleStatus !== "active" ||
                          item.workspaceId === activeWorkspaceId
                        }
                        aria-label={`Make active workspace ${item.name}`}
                        onClick={() => setActiveWorkspaceId(item.workspaceId)}
                      >
                        Make active
                      </Button>
                    </div>
                  </div>
                  {attempt.message && ["checking", "saving", "uncertain"].includes(attempt.phase) ? (
                    <p
                      role={attempt.phase === "uncertain" ? "alert" : "status"}
                      className="mt-2 text-sm text-status-waiting"
                    >
                      {attempt.message}
                    </p>
                  ) : null}
                  {item.workspaceId === "default" ? (
                    <p className="mt-2 text-xs text-fg-muted">The default workspace cannot be archived.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!filtered.length ? <p className="text-sm text-fg-muted">No workspaces match this view.</p> : null}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show more workspaces
            </Button>
          ) : null}
        </>
      ) : null}
      <DirectoryLifecycleReview lifecycle={lifecycle} />
    </section>
  );
}
