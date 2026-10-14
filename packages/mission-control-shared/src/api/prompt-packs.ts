import type { PromptPackRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchPromptPacks(limit = 200): Promise<{ items: PromptPackRecord[] }> {
  return request<{ items: PromptPackRecord[] }>(`/api/v1/prompt-packs?limit=${Math.max(1, Math.min(limit, 2000))}`);
}

export async function fetchPromptPackTests(packId: string, limit = 2000): Promise<{ items: PromptPackTestRecord[] }> {
  return request<{ items: PromptPackTestRecord[] }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  importPromptPack,
  previewPromptPackImport,
  fetchPromptPackBuiltins,
  fetchPromptPackSecurityGates,
  importBuiltinPromptPack,
  importBuiltinPromptPackIfAbsent,
  runPromptPackTest,
  scorePromptPackTest,
  autoScorePromptPackTest,
  fetchPromptPackReviews,
  autoScorePromptPackBatch,
  fetchPromptPackReport,
  runPromptPackBenchmark,
  fetchPromptPackBenchmark,
  cancelPromptPackBenchmark,
  runPromptPackReplayRegression,
  createPromptRetuneCampaign,
  fetchPromptRetuneCampaigns,
  fetchPromptRetuneCampaign,
  startPromptRetuneNoise,
  startPromptRetuneCandidate,
  dispositionPromptRetunePass,
  cancelPromptRetuneCampaign,
  fetchPromptPackReplayRegressionStatus,
  fetchPromptPackTrends,
  fetchPromptPackExport,
  exportPromptPackReport,
  resetPromptPack,
} from "./prompt-packs-operations.js";
