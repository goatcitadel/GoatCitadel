import type {
  SkillActivationPolicy,
  SkillImportHistoryRecord,
  SkillImportSourceType,
  SkillImportValidationResult,
  SkillListItem,
  SkillRuntimeState,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills");
}

export async function reloadSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchSkillSources(query?: { q?: string; limit?: number }): Promise<SkillSourceListResponse> {
  const params = new URLSearchParams();
  if (query?.q?.trim()) {
    params.set("q", query.q.trim());
  }
  if (query?.limit) {
    params.set("limit", String(Math.max(1, Math.min(query.limit, 100))));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<SkillSourceListResponse>(`/api/v1/skills/sources${suffix}`);
}

export async function fetchSkillLookup(query: { q: string; limit?: number }): Promise<SkillSourceLookupResponse> {
  const params = new URLSearchParams();
  params.set("q", query.q.trim());
  if (query.limit) {
    params.set("limit", String(Math.max(1, Math.min(query.limit, 100))));
  }
  return request<SkillSourceLookupResponse>(`/api/v1/skills/lookup?${params.toString()}`);
}

export async function validateSkillImport(input: {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
}): Promise<SkillImportValidationResult> {
  return request<SkillImportValidationResult>("/api/v1/skills/import/validate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function installSkillImport(input: {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
  force?: boolean;
  confirmHighRisk?: boolean;
}): Promise<{
  validation: SkillImportValidationResult;
  installedPath: string;
  sourceManifestPath: string;
  installedSkillId?: string;
}> {
  return request<{
    validation: SkillImportValidationResult;
    installedPath: string;
    sourceManifestPath: string;
    installedSkillId?: string;
  }>("/api/v1/skills/import/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchSkillImportHistory(limit = 100): Promise<{ items: SkillImportHistoryRecord[] }> {
  const boundedLimit = Math.max(1, Math.min(limit, 300));
  return request<{ items: SkillImportHistoryRecord[] }>(`/api/v1/skills/import/history?limit=${boundedLimit}`);
}

export async function updateSkillState(
  skillId: string,
  input: { state: SkillRuntimeState; note?: string },
): Promise<SkillStateRecord> {
  return request<SkillStateRecord>(`/api/v1/skills/${encodeURIComponent(skillId)}/state`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function bulkUpdateSkillState(input: {
  skillIds: string[];
  state: SkillRuntimeState;
  note?: string;
}): Promise<{ items: SkillStateRecord[] }> {
  return request<{ items: SkillStateRecord[] }>("/api/v1/skills/bulk-state", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchSkillActivationPolicies(): Promise<SkillActivationPolicy> {
  return request<SkillActivationPolicy>("/api/v1/skills/activation-policies");
}

export async function patchSkillActivationPolicies(
  input: Partial<SkillActivationPolicy>,
): Promise<SkillActivationPolicy> {
  return request<SkillActivationPolicy>("/api/v1/skills/activation-policies", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
