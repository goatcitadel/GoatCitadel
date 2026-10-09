import { useLibraryOperation } from "./use-library-operation";
import { LibraryMemoryBatch } from "./LibraryMemoryBatch";
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { loadLibraryResources } from "./library-resources";
import { LibraryMemoryEditor } from "./LibraryMemoryEditor";
import { LibraryMemoryProposals } from "./LibraryMemoryProposals";

const Diagnostics = lazy(() => import("./LibraryMemoryDiagnostics").then(module => ({ default: module.LibraryMemoryDiagnostics })));
export function LibraryMemoryWorkspace(props: { workspaceId: string; citadelId: string }) {
  const access = useLibraryOperation(JSON.stringify(["memory-directory", props.workspaceId, props.citadelId]));
  return <MemoryWorkspace key={access.identity} {...props} />;
}
function MemoryWorkspace({ workspaceId, citadelId }: { workspaceId: string; citadelId: string }) {
  const access = useLibraryOperation(JSON.stringify(["memory-directory", workspaceId, citadelId]));
  const route = useCockpitRoute();
  const [namespace, setNamespace] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState(false);
  const params = new URLSearchParams(route.search), itemId = params.get("itemId") ?? params.get("memoryItemId");
  const [query, setQuery] = useState(""), [filter, setFilter] = useState(""), [status, setStatus] = useState("active");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const list = useQuery({ queryKey: ["library", "memory", workspaceId, citadelId, query, status, cursors.at(-1), access.identity], queryFn: () => loadLibraryResources({ kind: "memory", workspaceId, citadelId, query, status, cursor: cursors.at(-1) }), staleTime: 0 });
  const rows = list.data?.items.filter(resource => resource.kind === "memory" && (!namespace || resource.item.namespace === namespace) && (!lifecycle || resource.item.lifecycleState === lifecycle)) ?? [];
  function select(id: string) { const next = new URLSearchParams(route.search); next.set("itemId", id); next.delete("memoryItemId"); next.set("shell", "cockpit"); route.navigate(`/library/memory?${next}`); }
  return <section className="mx-auto grid min-w-0 w-full max-w-5xl grid-cols-1 gap-4 wrap-anywhere p-4" aria-label="Library Memory"><header><h1 className="font-display text-xl font-semibold text-fg">Memory</h1><p className="text-sm text-fg-secondary">Canonical workspace and global memory. Editing and forgetting request approval; follow-on settlement is separate.</p></header>
    <form className="grid min-w-0 grid-cols-1 items-end gap-2 sm:flex sm:flex-wrap" onSubmit={event => { event.preventDefault(); setCursors([undefined]); setQuery(filter); }}><Field label="Search memory">{props => <input {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={filter} onChange={event => setFilter(event.target.value)} />}</Field><Field label="Memory status">{props => <select {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={status} onChange={event => { setStatus(event.target.value); setCursors([undefined]); }}><option value="active">Active</option><option value="forgotten">Forgotten</option><option value="all">All statuses</option></select>}</Field><Button type="submit">Apply memory filter</Button></form>
    <Field label="Memory namespace on this page">{props => <select {...props} className="min-h-11 min-w-0 w-full max-w-full rounded-md border border-line bg-canvas p-2" value={namespace} onChange={event => setNamespace(event.target.value)}><option value="">All namespaces</option>{[...new Set(list.data?.items.flatMap(resource => resource.kind === "memory" ? [resource.item.namespace] : []) ?? [])].map(value => <option key={value}>{value}</option>)}</select>}</Field>
    <Field label="Memory lifecycle on this page">{props => <select {...props} className="min-h-11 min-w-0 w-full max-w-full rounded-md border border-line bg-canvas p-2" value={lifecycle} onChange={event => setLifecycle(event.target.value)}><option value="">All lifecycle states</option><option value="active">Active</option><option value="expired">Expired</option><option value="forgotten">Forgotten</option></select>}</Field>
    <LibraryMemoryBatch key={access.identity} workspaceId={workspaceId} items={rows.flatMap(resource => resource.kind === "memory" && selected.includes(resource.item.itemId) ? [resource.item] : [])} available={!list.isFetching && !list.isError} onClear={() => setSelected([])} onRefresh={() => list.refetch()} />
    <Button disabled={list.isFetching} onClick={() => void list.refetch()}>Refresh memory directory</Button>
    {list.isFetching ? <p role="status">Reading memory directory…</p> : null}{list.error ? <Callout tone="error">{describeApiError(list.error).summary}</Callout> : null}
    {itemId ? <LibraryMemoryEditor key={`${workspaceId}:${itemId}`} itemId={itemId} workspaceId={workspaceId} /> : null}
    <p className="text-sm text-fg-muted">{list.data?.coverage}</p><ul className="grid min-w-0 grid-cols-1 gap-2">{rows.map(resource => resource.kind === "memory" ? <li key={resource.item.itemId} className="min-w-0 rounded-lg border border-line bg-raised p-3"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label={`Select memory ${resource.item.title}`} checked={selected.includes(resource.item.itemId)} onChange={event => setSelected(value => event.target.checked ? [...value, resource.item.itemId] : value.filter(id => id !== resource.item.itemId))} />{resource.item.title}</label><p className="text-sm text-fg-secondary">{resource.item.lifecycleState} · {resource.item.namespace} · {resource.item.workspaceId ?? String(resource.item.metadata.workspaceId ?? "Global")}</p><Button size="sm" onClick={() => select(resource.item.itemId)}>Open {resource.item.title}</Button></li> : null)}</ul>
    <div className="flex min-w-0 flex-wrap gap-2"><Button disabled={cursors.length < 2 || list.isFetching} onClick={() => setCursors(value => value.slice(0, -1))}>Previous memory page</Button><Button disabled={!list.data?.nextCursor || list.isFetching} onClick={() => setCursors(value => [...value, list.data?.nextCursor])}>Next memory page</Button></div>
    <Button onClick={() => setDiagnostics(true)}>Open memory diagnostics and maintenance</Button>{diagnostics ? <Suspense fallback={<p role="status">Loading memory diagnostics…</p>}><Diagnostics workspaceId={workspaceId} /></Suspense> : null}
    <LibraryMemoryProposals workspaceId={workspaceId} />
    <ClassicOwnerLink href="/library/memory?shell=classic" scope={workspaceId} label="Open detailed memory management in classic view" />
  </section>;
}
