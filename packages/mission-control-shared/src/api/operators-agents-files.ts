import type { AgentsResponse } from "./types.js";
import { request } from "./client-core.js";

export interface FileTemplate {
  templateId: string;
  title: string;
  description: string;
  defaultPath: string;
  body: string;
}

export async function fetchAgents(
  view: "active" | "archived" | "all" = "active",
  limit = 300,
  options: { signal?: AbortSignal } = {},
): Promise<AgentsResponse> {
  return request<AgentsResponse>(
    `/api/v1/agents?view=${encodeURIComponent(view)}&limit=${limit}`,
    options.signal ? { cache: "no-store", signal: options.signal } : undefined,
  );
}

export async function fetchFilesList(
  dir = ".",
  limit = 1000,
  scope?: { citadelId?: string; workspaceId?: string },
): Promise<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }> {
  const query = new URLSearchParams({
    dir,
    limit: String(limit),
  });
  if (scope?.citadelId?.trim()) {
    query.set("citadelId", scope.citadelId.trim());
  }
  if (scope?.workspaceId?.trim()) {
    query.set("workspaceId", scope.workspaceId.trim());
  }
  return request<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }>(
    `/api/v1/files/list?${query.toString()}`,
  );
}

/**
 * One page of a shared-file folder, newest first, searched and paged by the Gateway.
 * Item paths are relative to `dir`; `folders` are its direct subfolders; `complete` is false when the
 * Gateway's scan stopped at a cap, so a search may have missed files.
 */
export interface FilesPage {
  items: Array<{ relativePath: string; size: number; modifiedAt: string }>;
  folders: string[];
  nextCursor?: string;
  complete: boolean;
}

export async function fetchFilesPage(input: {
  dir?: string;
  limit?: number;
  query?: string;
  cursor?: string;
}): Promise<FilesPage> {
  const query = new URLSearchParams({ dir: input.dir ?? ".", limit: String(input.limit ?? 100), paged: "1" });
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.cursor) query.set("cursor", input.cursor);
  return request<FilesPage>(`/api/v1/files/list?${query.toString()}`);
}

export async function downloadFile(
  relativePath: string,
  scope?: { citadelId?: string; workspaceId?: string },
): Promise<{
  relativePath: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
  contentType: string;
  encoding: string;
  content: string;
}> {
  const query = new URLSearchParams({ relativePath });
  if (scope?.citadelId?.trim()) {
    query.set("citadelId", scope.citadelId.trim());
  }
  if (scope?.workspaceId?.trim()) {
    query.set("workspaceId", scope.workspaceId.trim());
  }
  return request(`/api/v1/files/download?${query.toString()}`);
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchOperators,
  fetchAgent,
  createAgentProfile,
  updateAgentProfile,
  archiveAgentProfile,
  restoreAgentProfile,
  hardDeleteAgentProfile,
  fetchPathSuggestions,
  fetchFileTemplates,
  createFileFromTemplate,
  uploadFile,
} from "./operators-agents-files-operations.js";
