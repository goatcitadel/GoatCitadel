import type {
  BlueprintReviewSummary,
  Citadel,
  CitadelBlueprint,
  CitadelBlueprintValidationResult,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCreateInput,
  CitadelCouncilAssignment,
  CitadelGatehouseSummary,
  CitadelRecord,
  CitadelTemplate,
  CitadelUpdateInput,
  CitadelVaultSecretMetadata,
  CitadelWardInput,
  CitadelWardRecord,
  MasonAnswers,
  MasonSession,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

// Inputs whose citadelId is supplied via the URL path, not the body.
type ChamberBody = Omit<CitadelChamberInput, "citadelId">;
type CharterBody = Omit<CitadelCharterInput, "citadelId">;
type WardBody = Omit<CitadelWardInput, "citadelId">;

export interface CitadelsResponse {
  items: CitadelRecord[];
  view?: "active" | "archived" | "all";
}

function id(value: string): string {
  return encodeURIComponent(value);
}

// --- Citadel identity ---

export async function listCitadels(
  view: "active" | "archived" | "all" = "active",
  limit = 200,
): Promise<CitadelsResponse> {
  const query = new URLSearchParams({
    view,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  return request<CitadelsResponse>(`/api/v1/citadels?${query.toString()}`);
}

export async function createCitadel(input: CitadelCreateInput): Promise<CitadelRecord> {
  return request<CitadelRecord>("/api/v1/citadels", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCitadel(citadelId: string, input: CitadelUpdateInput): Promise<CitadelRecord> {
  return request<CitadelRecord>(`/api/v1/citadels/${id(citadelId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveCitadel(citadelId: string): Promise<CitadelRecord> {
  return request<CitadelRecord>(`/api/v1/citadels/${id(citadelId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restoreCitadel(citadelId: string): Promise<CitadelRecord> {
  return request<CitadelRecord>(`/api/v1/citadels/${id(citadelId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function getCitadel(citadelId: string): Promise<Citadel> {
  return request<Citadel>(`/api/v1/citadels/${id(citadelId)}`);
}

export async function upsertCitadelCharter(citadelId: string, charter: CharterBody): Promise<CitadelCharter> {
  return request<CitadelCharter>(`/api/v1/citadels/${id(citadelId)}/charter`, {
    method: "PUT",
    body: JSON.stringify(charter),
  });
}

export async function listCitadelChambers(citadelId: string): Promise<CitadelChamber[]> {
  const { items } = await request<{ items: CitadelChamber[] }>(`/api/v1/citadels/${id(citadelId)}/chambers`);
  return items;
}

export async function createCitadelChamber(citadelId: string, chamber: ChamberBody): Promise<CitadelChamber> {
  return request<CitadelChamber>(`/api/v1/citadels/${id(citadelId)}/chambers`, {
    method: "POST",
    body: JSON.stringify(chamber),
  });
}

// --- Council, Gatehouse, Wards ---

export async function listCitadelCouncil(citadelId: string): Promise<CitadelCouncilAssignment[]> {
  const { items } = await request<{ items: CitadelCouncilAssignment[] }>(`/api/v1/citadels/${id(citadelId)}/council`);
  return items;
}

export async function assignCitadelCouncilAgent(citadelId: string, agentId: string): Promise<CitadelCouncilAssignment> {
  return request<CitadelCouncilAssignment>(`/api/v1/citadels/${id(citadelId)}/council`, {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
}

export async function unassignCitadelCouncilAgent(citadelId: string, agentId: string): Promise<void> {
  await request<void>(`/api/v1/citadels/${id(citadelId)}/council/${id(agentId)}`, {
    method: "DELETE",
  });
}

export async function getCitadelGatehouse(citadelId: string): Promise<CitadelGatehouseSummary & { wardCount: number }> {
  return request<CitadelGatehouseSummary & { wardCount: number }>(`/api/v1/citadels/${id(citadelId)}/gatehouse`);
}

export async function listCitadelWards(citadelId: string): Promise<CitadelWardRecord[]> {
  const { items } = await request<{ items: CitadelWardRecord[] }>(`/api/v1/citadels/${id(citadelId)}/wards`);
  return items;
}

export async function addCitadelWard(citadelId: string, ward: WardBody): Promise<CitadelWardRecord> {
  return request<CitadelWardRecord>(`/api/v1/citadels/${id(citadelId)}/wards`, {
    method: "POST",
    body: JSON.stringify(ward),
  });
}

export async function removeCitadelWard(citadelId: string, wardId: string): Promise<void> {
  await request<void>(`/api/v1/citadels/${id(citadelId)}/wards/${id(wardId)}`, {
    method: "DELETE",
  });
}

export async function evaluateCitadelGatehouseAction(
  citadelId: string,
  action: string,
): Promise<{ action: string; effect: string }> {
  return request<{ action: string; effect: string }>(`/api/v1/citadels/${id(citadelId)}/gatehouse/evaluate`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

// --- Templates & Blueprints ---

export async function listCitadelTemplates(): Promise<CitadelTemplate[]> {
  const { items } = await request<{ items: CitadelTemplate[] }>("/api/v1/citadel-templates");
  return items;
}

export async function createCitadelFromTemplate(citadelId: string, templateId: string): Promise<Citadel> {
  return request<Citadel>(`/api/v1/citadels/${id(citadelId)}/from-template`, {
    method: "POST",
    body: JSON.stringify({ templateId }),
  });
}

export async function exportCitadelBlueprint(citadelId: string): Promise<CitadelBlueprint> {
  return request<CitadelBlueprint>(`/api/v1/citadels/${id(citadelId)}/blueprint`);
}

export async function validateCitadelBlueprint(blueprint: unknown): Promise<CitadelBlueprintValidationResult> {
  return request<CitadelBlueprintValidationResult>("/api/v1/blueprints/validate", {
    method: "POST",
    body: JSON.stringify(blueprint),
  });
}

export async function importCitadelBlueprint(citadelId: string, blueprint: CitadelBlueprint): Promise<Citadel> {
  return request<Citadel>(`/api/v1/citadels/${id(citadelId)}/from-blueprint`, {
    method: "POST",
    body: JSON.stringify(blueprint),
  });
}

// --- The Mason ---

export async function getMasonSetupQuestions(): Promise<string[]> {
  const { items } = await request<{ items: string[] }>("/api/v1/mason/setup-questions");
  return items;
}

export async function draftMasonBlueprint(answers: MasonAnswers): Promise<CitadelBlueprint> {
  return request<CitadelBlueprint>("/api/v1/mason/draft", { method: "POST", body: JSON.stringify(answers) });
}

export async function reviewMasonBlueprint(blueprint: CitadelBlueprint): Promise<BlueprintReviewSummary> {
  return request<BlueprintReviewSummary>("/api/v1/mason/review", { method: "POST", body: JSON.stringify(blueprint) });
}

export async function createMasonSession(): Promise<MasonSession> {
  return request<MasonSession>("/api/v1/mason/sessions", { method: "POST" });
}

export async function getMasonSession(sessionId: string): Promise<MasonSession> {
  return request<MasonSession>(`/api/v1/mason/sessions/${id(sessionId)}`);
}

export async function updateMasonSessionAnswers(
  sessionId: string,
  patch: Partial<MasonAnswers>,
): Promise<MasonSession> {
  return request<MasonSession>(`/api/v1/mason/sessions/${id(sessionId)}/answers`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function sendMasonMessage(sessionId: string, message: string): Promise<MasonSession> {
  return request<MasonSession>(`/api/v1/mason/sessions/${id(sessionId)}/message`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function draftBlueprintFromMasonSession(sessionId: string): Promise<CitadelBlueprint> {
  return request<CitadelBlueprint>(`/api/v1/mason/sessions/${id(sessionId)}/draft`, { method: "POST" });
}

// --- The Vault (§13) ---

export async function listCitadelVaultSecrets(citadelId: string): Promise<CitadelVaultSecretMetadata[]> {
  const { items } = await request<{ items: CitadelVaultSecretMetadata[] }>(
    `/api/v1/citadels/${id(citadelId)}/vault-secrets`,
  );
  return items;
}

export async function storeCitadelVaultSecret(
  citadelId: string,
  name: string,
  value: string,
): Promise<CitadelVaultSecretMetadata> {
  return request<CitadelVaultSecretMetadata>(`/api/v1/citadels/${id(citadelId)}/vault-secrets`, {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });
}

/** Explicit reveal — returns the opened plaintext for a single secret. */
export async function revealCitadelVaultSecret(citadelId: string, secretId: string): Promise<string> {
  const { value } = await request<{ value: string }>(
    `/api/v1/citadels/${id(citadelId)}/vault-secrets/${id(secretId)}/reveal`,
  );
  return value;
}

export async function deleteCitadelVaultSecret(citadelId: string, secretId: string): Promise<void> {
  await request<void>(`/api/v1/citadels/${id(citadelId)}/vault-secrets/${id(secretId)}`, { method: "DELETE" });
}
