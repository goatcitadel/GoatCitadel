import type { WorkspaceRecord } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export interface WorkspacesResponse {
  items: WorkspaceRecord[];
  view?: "active" | "archived" | "all";
  citadelId?: string;
}

export async function fetchWorkspaces(
  view: "active" | "archived" | "all" = "active",
  limit = 200,
  citadelId?: string,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspacesResponse> {
  const query = new URLSearchParams({
    view,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  if (citadelId?.trim()) {
    query.set("citadelId", citadelId.trim());
  }
  return request<WorkspacesResponse>(
    `/api/v1/workspaces?${query.toString()}`,
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  createWorkspace,
  updateWorkspace,
  archiveWorkspace,
  restoreWorkspace,
  fetchGlobalGuidance,
  updateGlobalGuidance,
  fetchWorkspaceGuidance,
  updateWorkspaceGuidance,
} from "./workspaces-operations.js";
