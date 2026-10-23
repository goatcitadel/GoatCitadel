import {
  canonicalJsonString,
  type ChatGeneratedArtifactRecord,
  type MemoryItemRecord,
  type NoteRecord,
} from "@goatcitadel/contracts";
import { fetchMemoryItems } from "@goatcitadel/mission-control-shared/api/memory";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { fetchChatGeneratedArtifacts } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchFilesPage } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { formatBytes, plural } from "@goatcitadel/mission-control-shared/content/format";
import { resourceFolder } from "./resource-title";
import { artifactKindLabel, memoryNamespaceLabel, noteLifecycleLabel, presentMemoryStatus } from "./library-vocabulary";
export { resourceFolder, resourceTitle } from "./resource-title";

export const RESOURCE_KINDS = ["memory", "notes", "files", "artifacts"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_LIMIT = 100;
/** The artifact owner returns at most this many recent records; "Load more" grows the window up to it. */
export const ARTIFACT_WINDOW_MAX = 1000;
export type FileResource = {
  relativePath: string;
  size: number;
  modifiedAt: string;
};
export type LibraryResource =
  | { kind: "memory"; item: MemoryItemRecord }
  | { kind: "notes"; item: NoteRecord }
  | { kind: "files"; item: FileResource }
  | { kind: "artifacts"; item: ChatGeneratedArtifactRecord };
export interface ResourcePage {
  items: LibraryResource[];
  coverage: string;
  nextCursor?: string;
  /** Files only: the listed folder's direct subfolders. */
  folders?: string[];
  /** Files and artifacts: a larger window would return more records. */
  hasMore?: boolean;
}
export interface ResourceQuery {
  kind: ResourceKind;
  workspaceId: string;
  citadelId: string;
  query: string;
  status: string;
  cursor?: string;
  /** Memory only: exact namespace, filtered by the Gateway. */
  namespace?: string;
  /** Files only: the folder to list, relative to the shared file root ("." for the root). */
  dir?: string;
  /** Files and artifacts: how many of the newest records to read (grows with "Load more"). */
  limit?: number;
  projectId?: string;
  sourceSurface?: ChatGeneratedArtifactRecord["sourceSurface"];
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
export function resourceDescription(resource: LibraryResource) {
  switch (resource.kind) {
    case "memory":
      return `${memoryNamespaceLabel(resource.item.namespace)} · ${presentMemoryStatus(resource.item.status).label} · ${memoryScope(resource.item) === undefined ? "Shared across workspaces" : "Workspace memory"}`;
    case "notes":
      return `${noteLifecycleLabel(resource.item.lifecycleStatus)} · Version ${resource.item.revision}`;
    case "files": {
      const folder = resourceFolder(resource);
      return `${folder ? `In ${folder} · ` : ""}${formatBytes(resource.item.size)} · Installation shared files`;
    }
    case "artifacts":
      return `${artifactKindLabel(resource.item.kind)} · Version ${resource.item.version}`;
  }
}
/** When a resource last changed, for a `TimeText` beside it in lists and previews. */
export function resourceTime(resource: LibraryResource): { label: string; value: string } {
  switch (resource.kind) {
    case "files":
      return { label: "Modified", value: resource.item.modifiedAt };
    case "artifacts":
      return { label: "Created", value: resource.item.createdAt };
    default:
      return { label: "Updated", value: resource.item.updatedAt };
  }
}
export function resourceBinding(resource: LibraryResource) {
  // Bind previews to the exact list evidence, including content supplied by that owner.
  return canonicalJsonString(resource);
}

export async function loadLibraryResources(input: ResourceQuery): Promise<ResourcePage> {
  const { kind, workspaceId, citadelId, query, status, cursor, signal, projectId } = input;
  signal?.throwIfAborted();
  if (!workspaceId.trim() || !citadelId.trim())
    throw new Error("Choose a workspace and Citadel before reading Library resources.");
  if (kind === "memory") {
    const response = await fetchMemoryItems({
      workspaceId,
      query,
      ...(input.namespace ? { namespace: input.namespace } : {}),
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
      coverage: `Workspace and global memory. ${withheld ? "Some inconsistent scope records were withheld." : `${plural(response.total, "matching record")} when this list was read.`} ${response.nextCursor ? "More pages are available." : "End of this list."}`,
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
  const limit = input.limit ?? RESOURCE_LIMIT;
  if (kind === "artifacts") {
    const window = Math.min(limit, ARTIFACT_WINDOW_MAX);
    const response = await fetchChatGeneratedArtifacts({
      workspaceId,
      citadelId,
      ...(projectId ? { projectId } : {}),
      limit: window,
    });
    const scoped = response.items.filter(
      (item) => item.workspaceId === workspaceId && (!projectId || item.projectId === projectId),
    );
    const hasMore = response.items.length >= window && window < ARTIFACT_WINDOW_MAX;
    return {
      items: scoped
        .filter(
          (item) =>
            (!input.sourceSurface || item.sourceSurface === input.sourceSurface) &&
            (!text ||
              `${item.title} ${item.kind} ${item.sessionId} ${item.turnId} ${item.projectId ?? ""} ${item.contentHash ?? ""}`
                .toLowerCase()
                .includes(text)),
        )
        .map((item) => ({ kind, item })),
      hasMore,
      coverage:
        `Search and the source filter cover the ${plural(response.items.length, "most recent artifact")} loaded. ${hasMore ? "Older records may not be shown; load more to include them." : response.items.length >= window ? `This list stops at the ${window} most recent artifacts; older ones are not shown.` : "There are no older artifacts."} ${scoped.length !== response.items.length ? "Records without this workspace binding were withheld." : ""}`.trim(),
    };
  }
  const dir = input.dir?.trim() || ".";
  // This owner uses the installation file root. Its route does not honor workspace/Citadel query parameters.
  // The Gateway searches and pages the whole folder; item paths come back relative to it.
  const response = await fetchFilesPage({ dir, limit, query });
  const prefix = dir === "." ? "" : `${dir}/`;
  const hasMore = Boolean(response.nextCursor);
  return {
    items: response.items.map((item) => ({ kind, item: { ...item, relativePath: prefix + item.relativePath } })),
    folders: response.folders,
    hasMore,
    coverage: `${response.items.length} newest ${query.trim() ? "matching " : ""}files in ${dir === "." ? "the shared file root" : dir} and its subfolders. ${hasMore ? "Load more to see older files." : "No more files."}${response.complete ? "" : " GoatCitadel stopped scanning at its limit, so some files may be missing."} This list is shared across workspaces.`,
  };
}
