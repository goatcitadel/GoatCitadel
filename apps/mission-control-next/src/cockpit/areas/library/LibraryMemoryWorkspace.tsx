import { useLibraryOperation } from "./use-library-operation";
import { LibraryMemoryBatch } from "./LibraryMemoryBatch";
import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchTrustedMemoryLearnings } from "@goatcitadel/mission-control-shared/api/memory";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { FeatureOffNotice, listedFeatureFlag } from "../settings/FeatureOffNotice";
import { useRetryWhenSwitchTurnsOn } from "../settings/feature-switches";
import { Field } from "../../ui/Field";
import { loadLibraryResources } from "./library-resources";
import { LibraryMemoryEditor } from "./LibraryMemoryEditor";
import { LibraryMemoryProposals } from "./LibraryMemoryProposals";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import {
  KNOWN_MEMORY_NAMESPACES,
  memoryNamespaceLabel,
  memoryOwnerLabel,
  presentMemoryLifecycle,
} from "./library-vocabulary";
import { Sheet } from "../../ui/Sheet";
import { LIBRARY_SEARCH_DEBOUNCE_MS, LIBRARY_SECTION_LABELS } from "./library-sections";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { EmptyState } from "../../ui/EmptyState";
import { Section } from "../../ui/Section";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";

const Diagnostics = lazy(() =>
  import("./LibraryMemoryDiagnostics").then((module) => ({ default: module.LibraryMemoryDiagnostics })),
);
export function LibraryMemoryWorkspace(props: { workspaceId: string; citadelId: string }) {
  const access = useLibraryOperation(JSON.stringify(["memory-directory", props.workspaceId, props.citadelId]));
  return <MemoryWorkspace key={access.identity} {...props} />;
}
function MemoryWorkspace({ workspaceId, citadelId }: { workspaceId: string; citadelId: string }) {
  const access = useLibraryOperation(JSON.stringify(["memory-directory", workspaceId, citadelId]));
  const route = useCockpitRoute();
  const workspaceName = useWorkspaceNameLookup(citadelId);
  const [namespace, setNamespace] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState(false);
  const params = new URLSearchParams(route.search),
    itemId = params.get("itemId") ?? params.get("memoryItemId");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState(""),
    [status, setStatus] = useState("active");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  // One live search pattern: typing searches after a short pause; Enter searches at once.
  useEffect(() => {
    const next = filter.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => {
      setCursors([undefined]);
      setQuery(next);
    }, LIBRARY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filter, query]);
  const list = useQuery({
    queryKey: ["library", "memory", workspaceId, citadelId, query, status, namespace, cursors.at(-1), access.identity],
    queryFn: () =>
      loadLibraryResources({
        kind: "memory",
        workspaceId,
        citadelId,
        query,
        status,
        namespace,
        cursor: cursors.at(-1),
      }),
    staleTime: 0,
  });
  const learnings = useQuery({
    queryKey: ["library", "memory", workspaceId, "saved-lessons", access.identity],
    queryFn: () => fetchTrustedMemoryLearnings(workspaceId),
    staleTime: 0,
  });
  const savedLessons = learnings.isError
    ? []
    : (learnings.data?.items.filter((item) => item.workspaceId === workspaceId && item.status === "trusted") ?? []);
  const listFeatureOff = listedFeatureFlag(list.error);
  const learningsFeatureOff = listedFeatureFlag(learnings.error);
  const showLearningError = learnings.isError && (!learningsFeatureOff || learningsFeatureOff !== listFeatureOff);
  // Status and namespace are both filtered by the Gateway, so paging and counts match what is shown.
  const rows = list.data?.items.filter((resource) => resource.kind === "memory") ?? [];
  const namespaces = [
    ...new Set([
      ...KNOWN_MEMORY_NAMESPACES,
      ...rows.flatMap((resource) => (resource.kind === "memory" ? [resource.item.namespace] : [])),
      ...(namespace ? [namespace] : []),
    ]),
  ];
  const stalePage = Boolean(list.error && describeApiError(list.error).category === "conflict");
  const client = useQueryClient();
  function reloadDirectory() {
    // The proposals section may be hidden while it has no rows, so this button is also its refresh.
    void client.invalidateQueries({ queryKey: ["library", "memory-proposals", workspaceId] });
    void learnings.refetch();
    if (cursors.length > 1) setCursors([undefined]);
    else void list.refetch();
  }
  useRetryWhenSwitchTurnsOn(
    "memoryLifecycleAdminV1Enabled",
    listFeatureOff === "memoryLifecycleAdminV1Enabled" || learningsFeatureOff === "memoryLifecycleAdminV1Enabled",
    reloadDirectory,
  );
  function select(id?: string) {
    const next = new URLSearchParams(route.search);
    if (id) next.set("itemId", id);
    else next.delete("itemId");
    next.delete("memoryItemId");
    next.set("shell", "cockpit");
    route.navigate(`/library/memory?${next}`);
  }
  const listed = list.data?.items.length ?? 0;
  // An empty first page only proves absence when no record was withheld and no page remains.
  const noActiveMemoryItems = Boolean(
    list.data &&
    !listed &&
    !list.data.withheldCount &&
    !list.data.nextCursor &&
    !list.isError &&
    !query &&
    !namespace &&
    status === "active" &&
    cursors.length < 2,
  );
  const paged = cursors.length > 1 || Boolean(list.data?.nextCursor);
  const emptyItemActions = (
    <>
      <Button
        size="sm"
        onClick={() => {
          setStatus("all");
          setCursors([undefined]);
        }}
      >
        Show all statuses
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDiagnostics(true)}>
        Open memory diagnostics and maintenance
      </Button>
    </>
  );
  return (
    <section className={`${AREA_PAGE} min-w-0 wrap-anywhere`} aria-label="Library Memory">
      <AreaHeader
        title={LIBRARY_SECTION_LABELS.memory}
        description="Workspace and global memory. Editing and forgetting ask for approval first; the change is confirmed separately after approval."
        actions={
          <Button size="sm" disabled={list.isFetching || learnings.isFetching} onClick={reloadDirectory}>
            {stalePage ? "Reload memory directory" : "Refresh memory directory"}
          </Button>
        }
      />
      {savedLessons.length || learnings.isFetching || showLearningError ? (
        <Section title="Saved workspace lessons" description="Recent trusted lessons in this workspace.">
          {learnings.isFetching ? <p aria-busy="true">Reading saved lessons…</p> : null}
          {showLearningError && learningsFeatureOff ? <FeatureOffNotice flag={learningsFeatureOff} /> : null}
          {showLearningError && !learningsFeatureOff ? (
            <Callout announce={false} tone="error">
              Couldn’t read saved lessons. {describeApiError(learnings.error).summary}
            </Callout>
          ) : null}
          {savedLessons.length ? (
            <ul className="min-w-0 divide-y divide-line-subtle">
              {savedLessons.map((lesson) => (
                <li key={lesson.learningId} className="min-w-0 whitespace-pre-wrap py-3">
                  {lesson.insight}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}
      {noActiveMemoryItems ? (
        savedLessons.length ? (
          <Section title="Memory items" actions={emptyItemActions}>
            <p className="text-sm text-fg-muted">No active memory items.</p>
          </Section>
        ) : (
          <EmptyState
            title="No active memory items"
            action={<div className="flex flex-wrap items-center justify-center gap-2">{emptyItemActions}</div>}
          />
        )
      ) : (
        <>
          <form
            aria-label="Filter memory items"
            className="flex min-w-0 flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setCursors([undefined]);
              setQuery(filter.trim());
            }}
          >
            <Field label="Search memory">
              {(props) => (
                <input
                  {...props}
                  className="min-w-0 w-full max-w-full rounded-md border border-line-control bg-raised p-2"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              )}
            </Field>
            <Field label="Memory status">
              {(props) => (
                <select
                  {...props}
                  className="min-w-0 w-full max-w-full rounded-md border border-line-control bg-raised p-2"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setCursors([undefined]);
                  }}
                >
                  <option value="active">Active</option>
                  <option value="forgotten">Forgotten</option>
                  <option value="all">All statuses, including expired</option>
                </select>
              )}
            </Field>
            <Field label="Memory namespace">
              {(props) => (
                <select
                  {...props}
                  className="min-w-0 w-full max-w-full rounded-md border border-line-control bg-raised p-2"
                  value={namespace}
                  onChange={(event) => {
                    setNamespace(event.target.value);
                    setCursors([undefined]);
                  }}
                >
                  <option value="">All namespaces</option>
                  {namespaces.map((value) => (
                    <option key={value} value={value}>
                      {memoryNamespaceLabel(value)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </form>
          {rows.length || selected.length ? (
            <LibraryMemoryBatch
              key={access.identity}
              workspaceId={workspaceId}
              items={rows.flatMap((resource) =>
                resource.kind === "memory" && selected.includes(resource.item.itemId) ? [resource.item] : [],
              )}
              available={!list.isFetching && !list.isError}
              onClear={() => setSelected([])}
              onRefresh={() => list.refetch()}
            />
          ) : null}
        </>
      )}
      {list.isFetching ? <p role="status">Reading memory directory…</p> : null}
      {listFeatureOff ? <FeatureOffNotice flag={listFeatureOff} /> : null}
      {list.error && !listFeatureOff ? (
        <Callout tone="error">
          {stalePage
            ? "Memory changed while paging. Reload the directory to read the current records."
            : describeApiError(list.error).summary}
        </Callout>
      ) : null}
      <Sheet
        open={Boolean(itemId)}
        onOpenChange={(open) => {
          if (!open) select();
        }}
        title="Memory item"
        closeLabel="Close memory item"
        sideOnDesktop
      >
        {itemId ? (
          <LibraryMemoryEditor key={`${workspaceId}:${itemId}`} itemId={itemId} workspaceId={workspaceId} />
        ) : null}
      </Sheet>
      {noActiveMemoryItems ? null : <p className="text-sm text-fg-muted">{list.data?.coverage}</p>}
      <ul className="min-w-0 divide-y divide-line-subtle">
        {rows.map((resource) =>
          resource.kind === "memory" ? (
            <li key={resource.item.itemId} className="min-w-0 space-y-1 py-3">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Select memory ${resource.item.title}`}
                  checked={selected.includes(resource.item.itemId)}
                  onChange={(event) =>
                    setSelected((value) =>
                      event.target.checked
                        ? [...value, resource.item.itemId]
                        : value.filter((id) => id !== resource.item.itemId),
                    )
                  }
                />
                {resource.item.title}
              </label>
              <p className="text-sm text-fg-secondary">
                {presentMemoryLifecycle(resource.item.lifecycleState).label}
                {" · "}
                {memoryNamespaceLabel(resource.item.namespace)}
                {" · "}
                {memoryOwnerLabel(resource.item, workspaceId, workspaceName)}
              </p>
              <TechnicalDetails label="Memory identifiers">
                <p>Item ID: {resource.item.itemId}</p>
                <p>Namespace: {resource.item.namespace}</p>
                <p>Owner: {String(resource.item.workspaceId ?? resource.item.metadata.workspaceId ?? "global")}</p>
              </TechnicalDetails>
              <Button size="sm" onClick={() => select(resource.item.itemId)}>
                Open {resource.item.title}
              </Button>
            </li>
          ) : null,
        )}
      </ul>
      {paged ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            disabled={cursors.length < 2 || list.isFetching}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous memory page
          </Button>
          <Button
            disabled={!list.data?.nextCursor || list.isFetching || list.isError}
            onClick={() => setCursors((value) => [...value, list.data?.nextCursor])}
          >
            Next memory page
          </Button>
        </div>
      ) : null}
      {noActiveMemoryItems ? null : (
        <div>
          <Button onClick={() => setDiagnostics(true)}>Open memory diagnostics and maintenance</Button>
        </div>
      )}
      {diagnostics ? (
        <Suspense fallback={<p role="status">Loading memory diagnostics…</p>}>
          <Diagnostics workspaceId={workspaceId} />
        </Suspense>
      ) : null}
      <LibraryMemoryProposals workspaceId={workspaceId} hideWhenEmpty={noActiveMemoryItems} />
    </section>
  );
}
