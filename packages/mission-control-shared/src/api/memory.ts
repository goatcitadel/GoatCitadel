import type {
  DocsIngestInput,
  EmbeddingIndexInput,
  EmbeddingQueryInput,
  MemoryChangeEvent,
  MemoryContextPack,
  MemoryDecisionInput,
  MemoryDecisionRecord,
  MemoryDecisionRetrospectiveInput,
  MemoryEntityInput,
  MemoryEntityRecord,
  MemoryFeedbackInput,
  MemoryFeedbackKind,
  MemoryFeedbackRecord,
  MemoryFeedbackStatus,
  MemoryFeedbackTargetKind,
  MemoryItemRecord,
  MemoryLearningRecord,
  MemoryLifecyclePatch,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  MemoryQualityIssueListRequest,
  MemoryQualityIssuePatchInput,
  MemoryQualityIssueRecord,
  MemoryQualityScanRequest,
  MemoryQualityScanResponse,
  MemoryRelationInput,
  MemoryRelationRecord,
  MemoryQmdStatsResponse,
  MemoryRetrievalBenchmarkRequest,
  MemoryRetrievalBenchmarkResponse,
  MemoryRetrievalStatusResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemorySearchQuery,
  MemoryWriteInput,
  ToolInvokeResult,
  TraceMemoryCandidateInput,
  TraceMemoryCandidateRecord,
  TraceMemoryCandidateStatus,
} from "@goatcitadel/contracts";

import { request } from "./client-core.js";

export async function knowledgeMemoryWrite(
  input: MemoryWriteInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/memory/write", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeMemorySearch(
  input: MemorySearchQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/memory/search", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeDocsIngest(input: DocsIngestInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/docs/ingest", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeEmbeddingsIndex(
  input: EmbeddingIndexInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/embeddings/index", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeEmbeddingsQuery(
  input: EmbeddingQueryInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/embeddings/query", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryFiles(
  dir = "memory",
): Promise<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }> {
  return request<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }>(
    `/api/v1/memory/files?dir=${encodeURIComponent(dir)}`,
  );
}

export async function composeMemoryContext(input: {
  scope: "chat" | "orchestration";
  prompt: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  workspace?: string;
  relationScope?: "self" | "peer" | "project";
  maxContextTokens?: number;
  forceRefresh?: boolean;
  queryEmbedding?: number[];
}): Promise<MemoryContextPack> {
  return request<MemoryContextPack>("/api/v1/memory/context/compose", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryContext(contextId: string): Promise<MemoryContextPack> {
  return request<MemoryContextPack>(`/api/v1/memory/context/${encodeURIComponent(contextId)}`);
}

export async function fetchMemoryQmdStats(
  from?: string,
  to?: string,
  limit = 60,
): Promise<MemoryQmdStatsResponse & { recent: MemoryContextPack[] }> {
  const search = new URLSearchParams();
  if (from) search.set("from", from);
  if (to) search.set("to", to);
  search.set("limit", String(limit));
  return request<MemoryQmdStatsResponse & { recent: MemoryContextPack[] }>(
    `/api/v1/memory/qmd/stats?${search.toString()}`,
  );
}

export async function fetchMemoryRetrievalStatus(): Promise<MemoryRetrievalStatusResponse> {
  return request<MemoryRetrievalStatusResponse>("/api/v1/memory/retrieval/status");
}

export async function runMemoryRetrievalBenchmark(
  input: MemoryRetrievalBenchmarkRequest,
): Promise<MemoryRetrievalBenchmarkResponse> {
  return request<MemoryRetrievalBenchmarkResponse>("/api/v1/memory/retrieval-benchmark", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function recallMemory(input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
  return request<MemoryRecallResponse>("/api/v1/memory/recall", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryFeedback(input?: {
  workspaceId?: string;
  kind?: MemoryFeedbackKind | "all";
  status?: MemoryFeedbackStatus | "all";
  targetKind?: MemoryFeedbackTargetKind;
  limit?: number;
}): Promise<{ items: MemoryFeedbackRecord[] }> {
  const params = new URLSearchParams();
  if (input?.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input?.kind) params.set("kind", input.kind);
  if (input?.status) params.set("status", input.status);
  if (input?.targetKind) params.set("targetKind", input.targetKind);
  params.set("limit", String(Math.max(1, Math.min(input?.limit ?? 100, 500))));
  return request<{ items: MemoryFeedbackRecord[] }>(`/api/v1/memory/feedback?${params.toString()}`);
}

export async function recordMemoryFeedback(input: MemoryFeedbackInput): Promise<MemoryFeedbackRecord> {
  return request<MemoryFeedbackRecord>("/api/v1/memory/feedback", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryQualityIssues(
  input: MemoryQualityIssueListRequest = {},
): Promise<{ items: MemoryQualityIssueRecord[] }> {
  const params = new URLSearchParams();
  if (input.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input.kind) params.set("kind", input.kind);
  if (input.status) params.set("status", input.status);
  if (input.targetKind) params.set("targetKind", input.targetKind);
  params.set("limit", String(Math.max(1, Math.min(input.limit ?? 100, 500))));
  return request<{ items: MemoryQualityIssueRecord[] }>(`/api/v1/memory/quality/issues?${params.toString()}`);
}

export async function runMemoryQualityScan(input: MemoryQualityScanRequest): Promise<MemoryQualityScanResponse> {
  return request<MemoryQualityScanResponse>("/api/v1/memory/quality/scan", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function patchMemoryQualityIssue(
  issueId: string,
  input: MemoryQualityIssuePatchInput,
): Promise<MemoryQualityIssueRecord> {
  return request<MemoryQualityIssueRecord>(`/api/v1/memory/quality/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchTraceMemoryCandidates(input?: {
  workspaceId?: string;
  status?: TraceMemoryCandidateStatus | "all";
  limit?: number;
}): Promise<{ items: TraceMemoryCandidateRecord[] }> {
  const params = new URLSearchParams();
  if (input?.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input?.status) params.set("status", input.status);
  params.set("limit", String(Math.max(1, Math.min(input?.limit ?? 100, 500))));
  return request<{ items: TraceMemoryCandidateRecord[] }>(`/api/v1/memory/trace-candidates?${params.toString()}`);
}

export async function proposeTraceMemoryCandidate(
  input: TraceMemoryCandidateInput,
): Promise<TraceMemoryCandidateRecord> {
  return request<TraceMemoryCandidateRecord>("/api/v1/memory/trace-candidates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function promoteTraceMemoryCandidate(candidateId: string): Promise<MemoryLearningRecord> {
  return request<MemoryLearningRecord>(`/api/v1/memory/trace-candidates/${encodeURIComponent(candidateId)}/promote`, {
    method: "POST",
  });
}

export async function fetchMemoryItems(input?: {
  namespace?: string;
  status?: "active" | "forgotten" | "all";
  query?: string;
  limit?: number;
}): Promise<{ items: MemoryItemRecord[] }> {
  const params = new URLSearchParams();
  if (input?.namespace) params.set("namespace", input.namespace);
  if (input?.status) params.set("status", input.status);
  if (input?.query) params.set("query", input.query);
  params.set("limit", String(Math.max(1, Math.min(input?.limit ?? 200, 500))));
  return request<{ items: MemoryItemRecord[] }>(`/api/v1/memory/items?${params.toString()}`);
}

export async function patchMemoryItem(
  itemId: string,
  patch: MemoryLifecyclePatch & { actorId?: string },
): Promise<MemoryItemRecord> {
  return request<MemoryItemRecord>(`/api/v1/memory/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function forgetMemoryItem(itemId: string, actorId?: string): Promise<MemoryItemRecord> {
  return request<MemoryItemRecord>(`/api/v1/memory/items/${encodeURIComponent(itemId)}/forget`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function fetchMemoryItemHistory(itemId: string, limit = 200): Promise<{ items: MemoryChangeEvent[] }> {
  return request<{ items: MemoryChangeEvent[] }>(
    `/api/v1/memory/items/${encodeURIComponent(itemId)}/history?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

export async function fetchMemoryMaintenancePolicy(workspaceId?: string): Promise<MemoryMaintenancePolicyRecord> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<MemoryMaintenancePolicyRecord>(`/api/v1/memory/maintenance/policy${query}`);
}

export async function patchMemoryMaintenancePolicy(
  workspaceId: string | undefined,
  patch: MemoryMaintenancePolicyPatchInput,
): Promise<MemoryMaintenancePolicyRecord> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<MemoryMaintenancePolicyRecord>(`/api/v1/memory/maintenance/policy${query}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function fetchMemoryMaintenanceStatus(workspaceId?: string): Promise<MemoryMaintenanceStatusRecord> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<MemoryMaintenanceStatusRecord>(`/api/v1/memory/maintenance/status${query}`);
}

export async function fetchMemoryMaintenanceRuns(
  workspaceId?: string,
  limit = 50,
): Promise<{ items: MemoryMaintenanceRunRecord[] }> {
  const search = new URLSearchParams();
  if (workspaceId) {
    search.set("workspaceId", workspaceId);
  }
  search.set("limit", String(Math.max(1, Math.min(limit, 500))));
  return request<{ items: MemoryMaintenanceRunRecord[] }>(`/api/v1/memory/maintenance/runs?${search.toString()}`);
}

export async function runMemoryMaintenanceNow(
  input: MemoryMaintenanceRunNowInput,
): Promise<MemoryMaintenanceRunRecord> {
  return request<MemoryMaintenanceRunRecord>("/api/v1/memory/maintenance/run-now", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryMaintenanceRunProvenance(runId: string): Promise<MemoryMaintenanceProvenanceRecord> {
  return request<MemoryMaintenanceProvenanceRecord>(
    `/api/v1/memory/maintenance/runs/${encodeURIComponent(runId)}/provenance`,
  );
}

export async function fetchMemoryMaintenanceRecommendations(
  workspaceId?: string,
  limit = 50,
): Promise<{ items: MemoryMaintenanceRecommendationRecord[] }> {
  const search = new URLSearchParams();
  if (workspaceId) {
    search.set("workspaceId", workspaceId);
  }
  search.set("limit", String(Math.max(1, Math.min(limit, 500))));
  return request<{ items: MemoryMaintenanceRecommendationRecord[] }>(
    `/api/v1/memory/maintenance/recommendations?${search.toString()}`,
  );
}

export async function acceptMemoryMaintenanceRecommendation(
  recommendationId: string,
): Promise<MemoryMaintenanceRecommendationRecord> {
  return request<MemoryMaintenanceRecommendationRecord>(
    `/api/v1/memory/maintenance/recommendations/${encodeURIComponent(recommendationId)}/accept`,
    { method: "POST" },
  );
}

export async function rejectMemoryMaintenanceRecommendation(
  recommendationId: string,
): Promise<MemoryMaintenanceRecommendationRecord> {
  return request<MemoryMaintenanceRecommendationRecord>(
    `/api/v1/memory/maintenance/recommendations/${encodeURIComponent(recommendationId)}/reject`,
    { method: "POST" },
  );
}

export async function forgetMemory(input: {
  itemIds?: string[];
  namespace?: string;
  query?: string;
  actorId?: string;
}): Promise<{ forgottenCount: number; itemIds: string[] }> {
  return request<{ forgottenCount: number; itemIds: string[] }>("/api/v1/memory/forget", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryEntities(input?: {
  workspaceId?: string;
  status?: "active" | "forgotten" | "superseded" | "all";
  query?: string;
  limit?: number;
}): Promise<{ items: MemoryEntityRecord[] }> {
  const params = buildStructuredMemoryParams(input);
  return request<{ items: MemoryEntityRecord[] }>(`/api/v1/memory/entities?${params.toString()}`);
}

export async function createMemoryEntity(input: MemoryEntityInput): Promise<MemoryEntityRecord> {
  return request<MemoryEntityRecord>("/api/v1/memory/entities", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function forgetMemoryEntity(entityId: string): Promise<MemoryEntityRecord> {
  return request<MemoryEntityRecord>(`/api/v1/memory/entities/${encodeURIComponent(entityId)}/forget`, {
    method: "POST",
  });
}

export async function fetchMemoryRelations(input?: {
  workspaceId?: string;
  status?: "active" | "forgotten" | "superseded" | "all";
  entityId?: string;
  limit?: number;
}): Promise<{ items: MemoryRelationRecord[] }> {
  const params = buildStructuredMemoryParams(input);
  if (input?.entityId) params.set("entityId", input.entityId);
  return request<{ items: MemoryRelationRecord[] }>(`/api/v1/memory/relations?${params.toString()}`);
}

export async function createMemoryRelation(input: MemoryRelationInput): Promise<MemoryRelationRecord> {
  return request<MemoryRelationRecord>("/api/v1/memory/relations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryDecisions(input?: {
  workspaceId?: string;
  status?: "active" | "forgotten" | "superseded" | "all";
  dueForReview?: boolean;
  limit?: number;
}): Promise<{ items: MemoryDecisionRecord[] }> {
  const params = buildStructuredMemoryParams(input);
  if (input?.dueForReview !== undefined) params.set("dueForReview", String(input.dueForReview));
  return request<{ items: MemoryDecisionRecord[] }>(`/api/v1/memory/decisions?${params.toString()}`);
}

export async function createMemoryDecision(input: MemoryDecisionInput): Promise<MemoryDecisionRecord> {
  return request<MemoryDecisionRecord>("/api/v1/memory/decisions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function addMemoryDecisionRetrospective(
  decisionId: string,
  input: MemoryDecisionRetrospectiveInput,
): Promise<MemoryDecisionRecord> {
  return request<MemoryDecisionRecord>(`/api/v1/memory/decisions/${encodeURIComponent(decisionId)}/retrospective`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function forgetMemoryDecision(decisionId: string): Promise<MemoryDecisionRecord> {
  return request<MemoryDecisionRecord>(`/api/v1/memory/decisions/${encodeURIComponent(decisionId)}/forget`, {
    method: "POST",
  });
}

export async function fetchStructuredMemoryHistory(
  kind: "entity" | "relation" | "decision",
  id: string,
  limit = 100,
): Promise<{ items: MemoryChangeEvent[] }> {
  return request<{ items: MemoryChangeEvent[] }>(
    `/api/v1/memory/structured/${kind}/${encodeURIComponent(id)}/history?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

function buildStructuredMemoryParams(input?: {
  workspaceId?: string;
  status?: "active" | "forgotten" | "superseded" | "all";
  query?: string;
  limit?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (input?.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input?.status) params.set("status", input.status);
  if (input?.query) params.set("query", input.query);
  params.set("limit", String(Math.max(1, Math.min(input?.limit ?? 100, 500))));
  return params;
}
