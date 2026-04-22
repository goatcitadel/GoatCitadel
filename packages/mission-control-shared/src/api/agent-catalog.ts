import type {
  AgencyCatalogImportRequest,
  AgencyCatalogImportResponse,
  CatalogSessionActivationRequest,
  ChatSpecialistCandidateRecord,
  ImportedAgentCatalogListInput,
  ImportedAgentCatalogRecord,
  ImportedAgentCatalogStatePatchInput,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchImportedAgentCatalog(input: ImportedAgentCatalogListInput = {}): Promise<{
  workspaceId: string;
  divisions: string[];
  items: ImportedAgentCatalogRecord[];
}> {
  const params = new URLSearchParams();
  if (input.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  if (input.division) {
    params.set("division", input.division);
  }
  if (input.search) {
    params.set("search", input.search);
  }
  if (input.state) {
    params.set("state", input.state);
  }
  if (input.parseStatus) {
    params.set("parseStatus", input.parseStatus);
  }
  params.set("limit", String(Math.max(1, Math.min(input.limit ?? 300, 1000))));
  return request(`/api/v1/agents/catalog?${params.toString()}`);
}

export async function fetchImportedAgentCatalogEntry(entryId: string): Promise<ImportedAgentCatalogRecord> {
  return request(`/api/v1/agents/catalog/${encodeURIComponent(entryId)}`);
}

export async function importAgencyAgentCatalog(
  input: AgencyCatalogImportRequest = {},
): Promise<AgencyCatalogImportResponse> {
  return request("/api/v1/agents/catalog/import/agency-agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function patchImportedAgentCatalogState(
  entryId: string,
  input: ImportedAgentCatalogStatePatchInput,
): Promise<ImportedAgentCatalogRecord> {
  return request(`/api/v1/agents/catalog/${encodeURIComponent(entryId)}/state`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function activateImportedAgentCatalogEntry(
  entryId: string,
  input: CatalogSessionActivationRequest,
): Promise<{
  catalogEntry: ImportedAgentCatalogRecord;
  specialist: ChatSpecialistCandidateRecord;
}> {
  return request(`/api/v1/agents/catalog/${encodeURIComponent(entryId)}/activate-session`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
