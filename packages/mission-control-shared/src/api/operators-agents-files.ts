import type {
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
} from "@goatcitadel/contracts";
import type { AgentsResponse, OperatorsResponse } from "./types.js";
import { request } from "./client-core.js";

export interface FileTemplate {
  templateId: string;
  title: string;
  description: string;
  defaultPath: string;
  body: string;
}

export async function fetchOperators(): Promise<OperatorsResponse> {
  return request<OperatorsResponse>("/api/v1/operators");
}

export async function fetchAgents(
  view: "active" | "archived" | "all" = "active",
  limit = 300,
): Promise<AgentsResponse> {
  return request<AgentsResponse>(`/api/v1/agents?view=${encodeURIComponent(view)}&limit=${limit}`);
}

export async function fetchAgent(agentId: string): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}`);
}

export async function createAgentProfile(input: AgentProfileCreateInput): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateAgentProfile(agentId: string, input: AgentProfileUpdateInput): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveAgentProfile(
  agentId: string,
  input?: AgentProfileArchiveInput,
): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}/archive`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function restoreAgentProfile(agentId: string): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function hardDeleteAgentProfile(
  agentId: string,
): Promise<{ deleted: boolean; agentId: string; mode: "hard" }> {
  return request<{ deleted: boolean; agentId: string; mode: "hard" }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}?mode=hard`,
    {
      method: "DELETE",
      body: JSON.stringify({}),
    },
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

export async function fetchPathSuggestions(root = ".", limit = 150): Promise<{ items: string[] }> {
  return request<{ items: string[] }>(
    `/api/v1/files/path-suggestions?root=${encodeURIComponent(root)}&limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchFileTemplates(): Promise<{ items: FileTemplate[] }> {
  return request<{ items: FileTemplate[] }>("/api/v1/files/templates");
}

export async function createFileFromTemplate(
  templateId: string,
  targetPath?: string,
  scope?: { citadelId?: string; workspaceId?: string },
): Promise<{ relativePath: string; fullPath: string; bytes: number }> {
  return request<{ relativePath: string; fullPath: string; bytes: number }>(
    `/api/v1/files/templates/${encodeURIComponent(templateId)}/create`,
    {
      method: "POST",
      body: JSON.stringify({ targetPath, ...scope }),
    },
  );
}

export async function uploadFile(
  relativePath: string,
  content: string,
): Promise<{ relativePath: string; fullPath: string; bytes: number }> {
  return request<{ relativePath: string; fullPath: string; bytes: number }>("/api/v1/files/upload", {
    method: "POST",
    body: JSON.stringify({ relativePath, content }),
  });
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
