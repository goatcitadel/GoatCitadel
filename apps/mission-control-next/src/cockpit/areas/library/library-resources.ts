import {
  canonicalJsonString,
  type ChatGeneratedArtifactRecord,
  type MemoryItemRecord,
  type NoteRecord,
} from "@goatcitadel/contracts";
import { fetchMemoryItems } from "@goatcitadel/mission-control-shared/api/memory";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { fetchChatGeneratedArtifacts } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchFilesList } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

export const RESOURCE_KINDS = ["memory", "notes", "files", "artifacts"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_LIMIT = 100;
export type FileResource = { relativePath: string; size: number; modifiedAt: string };
export type LibraryResource =
  | { kind: "memory"; item: MemoryItemRecord }
  | { kind: "notes"; item: NoteRecord }
  | { kind: "files"; item: FileResource }
  | { kind: "artifacts"; item: ChatGeneratedArtifactRecord };
export interface ResourcePage {
  items: LibraryResource[];
  coverage: string;
  nextCursor?: string;
}
export interface ResourceQuery {
  kind: ResourceKind;
  workspaceId: string;
  citadelId: string;
  query: string;
  status: string;
  cursor?: string;
  /** Checked between reads; the Library owners themselves take no signal. */
  signal?: AbortSignal;
}

function memoryScope(item: MemoryItemRecord): string | undefined | null {
  const canonical = item.workspaceId;
  const legacy = item.metadata?.workspaceId;
  if (
    (canonical !== undefined && (typeof canonical !== "string" || !canonical.trim())) ||
    (legacy !== undefined && (typeof legacy !== "string" || !legacy.trim())) ||
    (canonical && legacy && canonical !== legacy)
  )
    return null;
  return canonical ?? (legacy as string | undefined);
}

export function resourceId(resource: LibraryResource) {
  switch (resource.kind) {
    case "memory":
      return resource.item.itemId;
    case "notes":
      return resource.item.noteId;
    case "files":
      return resource.item.relativePath;
    case "artifacts":
      return resource.item.artifactId;
  }
}
export function resourceTitle(resource: LibraryResource) {
  return (resource.kind === "files" ? resource.item.relativePath : resource.item.title).slice(0, 300);
}
export function resourceDescription(resource: LibraryResource) {
  switch (resource.kind) {
    case "memory":
      return `${humanizeToken(resource.item.namespace)} · ${humanizeToken(resource.item.status)} · ${memoryScope(resource.item) === undefined ? "Global memory" : "Workspace memory"}`;
    case "notes":
      return `${humanizeToken(resource.item.lifecycleStatus)} · Revision ${resource.item.revision}`;
    case "files":
      return `${resource.item.size.toLocaleString()} bytes · Installation shared files`;
    case "artifacts":
      return `${humanizeToken(resource.item.kind)} · Version ${resource.item.version}`;
  }
}
export function resourceBinding(resource: LibraryResource) {
  // Bind previews to the exact list evidence, including content supplied by that owner.
  return canonicalJsonString(resource);
}

export async function loadLibraryResources(input: ResourceQuery): Promise<ResourcePage> {
  const { kind, workspaceId, citadelId, query, status, cursor, signal } = input;
  signal?.throwIfAborted();
  if (!workspaceId.trim() || !citadelId.trim())
    throw new Error("Choose a workspace and Citadel before reading Library resources.");
  if (kind === "memory") {
    const response = await fetchMemoryItems({
      workspaceId,
      query,
      limit: RESOURCE_LIMIT,
      cursor,
      status: status === "forgotten" || status === "all" ? status : "active",
    });
    const items = response.items.filter((item) => {
      const scope = memoryScope(item);
      return scope !== null && (scope === undefined || scope === workspaceId);
    });
    const withheld = response.items.length - items.length;
    return {
      items: items.map((item) => ({ kind, item })),
      nextCursor: response.nextCursor,
      coverage: `Workspace and canonical global memory. ${withheld ? "Some inconsistent scope records were withheld." : `${response.total} matching records at the enumeration snapshot.`} ${response.nextCursor ? "More pages are available." : "End of this enumeration."}`,
    };
  }
  const text = query.trim().toLowerCase();
  if (kind === "notes") {
    const response = await listNotes(workspaceId, {
      lifecycleStatus: status === "archived" || status === "all" ? status : "active",
    });
    const scoped = response.items.filter((item) => item.workspaceId === workspaceId);
    const matches = scoped.filter((item) => !text || `${item.title} ${item.body}`.toLowerCase().includes(text));
    return {
      items: matches.slice(0, RESOURCE_LIMIT).map((item) => ({ kind, item })),
      coverage: `Showing up to ${RESOURCE_LIMIT} matching workspace notes. ${matches.length > RESOURCE_LIMIT ? "Narrow the filter to inspect additional notes." : ""} ${scoped.length !== response.items.length ? "Records from another or unknown workspace were withheld." : ""}`,
    };
  }
  if (kind === "artifacts") {
    const response = await fetchChatGeneratedArtifacts({ workspaceId, citadelId, limit: RESOURCE_LIMIT });
    const scoped = response.items.filter((item) => item.workspaceId === workspaceId);
    return {
      items: scoped
        .filter((item) => !text || `${item.title} ${item.kind}`.toLowerCase().includes(text))
        .slice(0, RESOURCE_LIMIT)
        .map((item) => ({ kind, item })),
      coverage: `Up to ${RESOURCE_LIMIT} recent workspace artifacts; filtering applies to this returned window. Older records may not be shown. ${scoped.length !== response.items.length ? "Records without this workspace binding were withheld." : ""}`,
    };
  }
  // This owner uses the installation file root. Its route does not honor workspace/Citadel query parameters.
  const response = await fetchFilesList(".", RESOURCE_LIMIT);
  return {
    items: response.items
      .filter((item) => !text || item.relativePath.toLowerCase().includes(text))
      .slice(0, RESOURCE_LIMIT)
      .map((item) => ({ kind, item })),
    coverage: `Up to ${RESOURCE_LIMIT} files from the installation shared file root. This list is shared across workspaces; filtering applies to this returned window.`,
  };
}
