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

/** Hashing needs the whole file in memory (Web Crypto cannot hash a stream), so only small uploads carry a hash. */
const UPLOAD_HASH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Uploads UTF-8 text as a raw byte stream, so neither the browser nor the Gateway builds a JSON copy of a large file.
 * The Gateway verifies `X-Content-SHA256` when it is sent; it is skipped where Web Crypto is unavailable (plain-HTTP
 * LAN origins) and for large files.
 */
export async function uploadFile(
  relativePath: string,
  content: string | Blob,
  options: { expectAbsent?: boolean } = {},
): Promise<{ relativePath: string; fullPath: string; bytes: number }> {
  const body = typeof content === "string" ? new Blob([content], { type: "text/plain;charset=utf-8" }) : content;
  const query = new URLSearchParams({ relativePath });
  if (options.expectAbsent) query.set("expectAbsent", "true");
  const sha256 = await hashUploadBody(body);
  return request<{ relativePath: string; fullPath: string; bytes: number }>(
    `/api/v1/files/upload?${query.toString()}`,
    {
      method: "POST",
      body,
      ...(sha256 ? { headers: { "X-Content-SHA256": sha256 } } : {}),
    },
  );
}

async function hashUploadBody(body: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || body.size > UPLOAD_HASH_MAX_BYTES) return undefined;
  const digest = new Uint8Array(await subtle.digest("SHA-256", await body.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
