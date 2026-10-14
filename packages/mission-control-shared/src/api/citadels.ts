import { id } from "./citadels-query.js";
import type { CitadelRecord, CitadelStructureSnapshot } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

// Inputs whose citadelId is supplied via the URL path, not the body.

export interface CitadelsResponse {
  items: CitadelRecord[];
  view?: "active" | "archived" | "all";
}

// --- Citadel identity ---

export async function listCitadels(
  view: "active" | "archived" | "all" = "active",
  limit = 200,
  options: { signal?: AbortSignal } = {},
): Promise<CitadelsResponse> {
  const query = new URLSearchParams({
    view,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  return request<CitadelsResponse>(
    `/api/v1/citadels?${query.toString()}`,
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
}

export async function getCitadelStructureSnapshot(
  citadelId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CitadelStructureSnapshot> {
  return request<CitadelStructureSnapshot>(
    `/api/v1/citadels/${id(citadelId)}/structure`,
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  createCitadel,
  updateCitadel,
  archiveCitadel,
  restoreCitadel,
  fetchCitadelBrief,
  getCitadel,
  upsertCitadelCharter,
  listCitadelChambers,
  createCitadelChamber,
  getCitadelAccessSnapshot,
  listCitadelCouncil,
  assignCitadelCouncilAgent,
  unassignCitadelCouncilAgent,
  getCitadelGatehouse,
  listCitadelWards,
  addCitadelWard,
  removeCitadelWard,
  evaluateCitadelGatehouseAction,
  listCitadelTemplates,
  createCitadelFromTemplate,
  exportCitadelBlueprint,
  validateCitadelBlueprint,
  importCitadelBlueprint,
  getMasonSetupQuestions,
  draftMasonBlueprint,
  reviewMasonBlueprint,
  createMasonSession,
  getMasonSession,
  updateMasonSessionAnswers,
  sendMasonMessage,
  draftBlueprintFromMasonSession,
  stageMasonBlueprint,
  getCitadelVaultSnapshot,
  listCitadelVaultSecrets,
  storeCitadelVaultSecret,
  revealCitadelVaultSecret,
  deleteCitadelVaultSecret,
} from "./citadels-operations.js";
