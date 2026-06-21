import type {
  GuidanceBundleRecord,
  GuidanceDocType,
  GuidanceDocumentRecord,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
} from "@goatcitadel/contracts";
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
): Promise<WorkspacesResponse> {
  const query = new URLSearchParams({
    view,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  if (citadelId?.trim()) {
    query.set("citadelId", citadelId.trim());
  }
  return request<WorkspacesResponse>(`/api/v1/workspaces?${query.toString()}`);
}

export async function createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkspace(workspaceId: string, input: WorkspaceUpdateInput): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restoreWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchGlobalGuidance(): Promise<{ items: GuidanceDocumentRecord[] }> {
  return request<{ items: GuidanceDocumentRecord[] }>("/api/v1/guidance/global");
}

export async function updateGlobalGuidance(docType: GuidanceDocType, content: string): Promise<GuidanceDocumentRecord> {
  return request<GuidanceDocumentRecord>(`/api/v1/guidance/global/${encodeURIComponent(docType)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export async function fetchWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {
  return request<GuidanceBundleRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guidance`);
}

export async function updateWorkspaceGuidance(
  workspaceId: string,
  docType: GuidanceDocType,
  content: string,
): Promise<GuidanceDocumentRecord> {
  return request<GuidanceDocumentRecord>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guidance/${encodeURIComponent(docType)}`,
    {
      method: "PUT",
      body: JSON.stringify({ content }),
    },
  );
}
