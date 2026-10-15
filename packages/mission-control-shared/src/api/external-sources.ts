/**
 * HX-407 C3 typed Library + Chat external-sources client.
 *
 * Library calls target the shipped (proof-gated) Gateway routes in
 * `apps/gateway/src/routes/external-sources.ts`. Chat attachment calls are
 * typed against the frozen C1 contracts and the C4 packet's route paths
 * (`/api/v1/chat/sessions/:sessionId/external-source-attachments`); those
 * routes are composed by the current Gateway. Older or disabled runtimes may
 * return 404; callers treat that as capability absent and retain read restrictions.
 *
 * Every request body passes through the frozen contract normalizers before it
 * leaves the client, so the operator UI can never send malformed material and
 * can never smuggle a client-supplied hash (the exact-key gates throw). Every
 * response is re-validated with the frozen contract asserts, so the UI never
 * trusts an unvalidated or content-bearing payload.
 */
import {
  assertExternalSourceImportIntent,
  assertExternalSourceImportItem,
  assertExternalSourceImportPlan,
  assertExternalSourceImportSettlement,
  assertExternalSourcePage,
  assertExternalSourceRecord,
  assertExternalSourceScanRecord,
  assertExternalSourceScanSummary,
  assertExternalSourceSummary,
  normalizeExternalSourceCatalogListInput,
  normalizeExternalSourceCreateInput,
  normalizeExternalSourceImportApplyInput,
  normalizeExternalSourceImportPlanInput,
  normalizeExternalSourceScanInput,
  type ExternalSourceCatalogListInput,
  type ExternalSourceCreateInput,
  type ExternalSourceDetailResponse,
  type ExternalSourceImportApplyResponse,
  type ExternalSourceImportDetailResponse,
  type ExternalSourceImportPlanInput,
  type ExternalSourceImportPlanResponse,
  type ExternalSourceListResponse,
  type ExternalSourcePage,
  type ExternalSourceScanInput,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";
import {
  LIBRARY_IMPORTS_PATH,
  requireIdentifier,
  isRecord,
} from "./external-source-chat.js";
export {
  isExternalSourceCapabilityAbsent,
  fetchExternalSessionAttachments,
  fetchExternalSourceAttachmentCandidates,
  attachExternalSourceToSession,
  detachExternalSourceAttachment,
  requestExternalSourceKnowledgeSnapshot,
} from "./external-source-chat.js";
export type {
  ExternalSourceKnowledgeSnapshotRequestReceipt,
} from "./external-source-chat.js";
import { assertWorkspacePathBridgeSnapshot, type WorkspacePathBridgeResolveRequest, type WorkspacePathBridgeSnapshotRecord } from "@goatcitadel/contracts";

/** Verify an exact root through the existing inspection-only Gateway owner. */
export async function resolveExternalSourcePath(input: WorkspacePathBridgeResolveRequest): Promise<WorkspacePathBridgeSnapshotRecord> {
  const result = await request<WorkspacePathBridgeSnapshotRecord>("/api/v1/ops/workspace-path-bridges/resolve", { method: "POST", cache: "no-store", body: JSON.stringify(input) });
  assertWorkspacePathBridgeSnapshot(result);
  return result;
}
export async function inspectExternalSourcePath(workspaceId: string, snapshotId: string): Promise<WorkspacePathBridgeSnapshotRecord> {
  const result = await request<WorkspacePathBridgeSnapshotRecord>(`/api/v1/ops/workspace-path-bridges/${encodeURIComponent(snapshotId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
  assertWorkspacePathBridgeSnapshot(result);
  return result;
}

const LIBRARY_SOURCES_PATH = "/api/v1/library/external-sources";
const LIBRARY_IMPORT_PLANS_PATH = "/api/v1/library/external-source-import-plans";

function workspaceQuery(workspaceId: string): string {
  return `workspaceId=${encodeURIComponent(requireIdentifier(workspaceId, "workspace id"))}`;
}

function parseDetailResponse(payload: unknown): ExternalSourceDetailResponse {
  if (!isRecord(payload)) {
    throw new Error("External source detail response is malformed.");
  }
  const detail = payload as unknown as ExternalSourceDetailResponse;
  assertExternalSourceRecord(detail.source);
  if (detail.latestScan !== undefined) {
    assertExternalSourceScanSummary(detail.latestScan);
  }
  return detail;
}

function parseListResponse(payload: unknown): ExternalSourceListResponse {
  if (!isRecord(payload) || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("External source list response is malformed.");
  }
  const list = payload as unknown as ExternalSourceListResponse;
  for (const item of list.items) {
    assertExternalSourceSummary(item);
  }
  return list;
}

function parseImportDetail(payload: unknown): ExternalSourceImportDetailResponse {
  if (!isRecord(payload) || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("External source import response is malformed.");
  }
  const detail = payload as unknown as ExternalSourceImportDetailResponse;
  assertExternalSourceImportPlan(detail.plan);
  assertExternalSourceImportIntent(detail.intent);
  for (const item of detail.items) {
    assertExternalSourceImportItem(item);
  }
  if (detail.settlement !== undefined) {
    assertExternalSourceImportSettlement(detail.settlement);
  }
  return detail;
}

/** Register one exact source/root grant. No scan is implied. */
export async function registerExternalSource(input: ExternalSourceCreateInput): Promise<ExternalSourceDetailResponse> {
  const body = normalizeExternalSourceCreateInput(input);
  const payload = await request<unknown>(LIBRARY_SOURCES_PATH, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  return parseDetailResponse(payload);
}

/** Workspace-scoped source list: content-free health plus latest-scan summary only. */
export async function fetchExternalSources(workspaceId: string): Promise<ExternalSourceListResponse> {
  const payload = await request<unknown>(`${LIBRARY_SOURCES_PATH}?${workspaceQuery(workspaceId)}`, {
    cache: "no-store",
  });
  return parseListResponse(payload);
}

/** Operator-only config detail for one source (the sole projection exposing the exact root). */
export async function fetchExternalSourceDetail(
  workspaceId: string,
  sourceId: string,
): Promise<ExternalSourceDetailResponse> {
  const payload = await request<unknown>(
    `${LIBRARY_SOURCES_PATH}/${encodeURIComponent(requireIdentifier(sourceId, "source id"))}?${workspaceQuery(workspaceId)}`,
    { cache: "no-store" },
  );
  return parseDetailResponse(payload);
}

/** Seal one bounded catalog scan against the source's current root/config identity. */
export async function scanExternalSource(
  sourceId: string,
  input: ExternalSourceScanInput,
): Promise<ExternalSourceScanRecord> {
  const body = normalizeExternalSourceScanInput(input);
  const payload = await request<unknown>(
    `${LIBRARY_SOURCES_PATH}/${encodeURIComponent(requireIdentifier(sourceId, "source id"))}/scans`,
    { method: "POST", cache: "no-store", body: JSON.stringify(body) },
  );
  const scan = payload as ExternalSourceScanRecord;
  assertExternalSourceScanRecord(scan);
  return scan;
}

/** Page one immutable sealed scan via the opaque high-water cursor. */
export async function fetchExternalSourceCatalogPage(
  sourceId: string,
  input: ExternalSourceCatalogListInput,
): Promise<ExternalSourcePage> {
  const normalized = normalizeExternalSourceCatalogListInput(input);
  const query = new URLSearchParams({ workspaceId: normalized.workspaceId, scanId: normalized.scanId });
  for (const disposition of normalized.dispositions ?? []) {
    query.append("dispositions", disposition);
  }
  if (normalized.cursor) {
    query.set("cursor", normalized.cursor);
  }
  if (normalized.limit !== undefined) {
    query.set("limit", String(normalized.limit));
  }
  const payload = await request<unknown>(
    `${LIBRARY_SOURCES_PATH}/${encodeURIComponent(requireIdentifier(sourceId, "source id"))}/items?${query.toString()}`,
    { cache: "no-store" },
  );
  const page = payload as ExternalSourcePage;
  assertExternalSourcePage(page);
  return page;
}

/** Dry-run the exact selected item set; copies no foreign state. */
export async function createExternalSourceImportPlan(
  input: ExternalSourceImportPlanInput,
): Promise<ExternalSourceImportPlanResponse> {
  const body = normalizeExternalSourceImportPlanInput(input);
  const payload = await request<unknown>(LIBRARY_IMPORT_PLANS_PATH, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!isRecord(payload) || typeof (payload as { idempotencyKey?: unknown }).idempotencyKey !== "string") {
    throw new Error("External source import plan response is malformed.");
  }
  const response = payload as unknown as ExternalSourceImportPlanResponse;
  assertExternalSourceImportPlan(response.plan);
  return response;
}

export interface ApplyExternalSourceImportInput {
  readonly workspaceId: string;
  readonly planId: string;
  readonly expectedPlanSha256: string;
  /** Durable retry key; a fresh contract-shaped key is generated when absent. */
  readonly idempotencyKey?: string;
}

/** Apply exactly one immutable plan; exact replays return the canonical result. */
export async function applyExternalSourceImport(
  input: ApplyExternalSourceImportInput,
): Promise<ExternalSourceImportApplyResponse> {
  const body = normalizeExternalSourceImportApplyInput({
    workspaceId: input.workspaceId,
    planId: input.planId,
    expectedPlanSha256: input.expectedPlanSha256,
    idempotencyKey: input.idempotencyKey ?? `mc-ext-import-${crypto.randomUUID()}`,
  });
  const payload = await request<unknown>(LIBRARY_IMPORTS_PATH, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const response = parseImportDetail(payload) as ExternalSourceImportApplyResponse;
  if (response.applyDisposition !== "created" && response.applyDisposition !== "replayed") {
    throw new Error("External source import response disposition is invalid.");
  }
  return response;
}

/** Inspect content-free provenance and settlement for one import. */
export async function fetchExternalSourceImportDetail(
  workspaceId: string,
  importId: string,
): Promise<ExternalSourceImportDetailResponse> {
  const payload = await request<unknown>(
    `${LIBRARY_IMPORTS_PATH}/${encodeURIComponent(requireIdentifier(importId, "import id"))}?${workspaceQuery(workspaceId)}`,
    { cache: "no-store" },
  );
  return parseImportDetail(payload);
}
