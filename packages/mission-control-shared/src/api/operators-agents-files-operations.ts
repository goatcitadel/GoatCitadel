import type { FileTemplate } from "./operators-agents-files.js";
import type {
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
} from "@goatcitadel/contracts";

import type { OperatorsResponse } from "./types.js";

import { request } from "./client-core.js";

export async function fetchOperators(): Promise<OperatorsResponse> {
  return request<OperatorsResponse>("/api/v1/operators");
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
