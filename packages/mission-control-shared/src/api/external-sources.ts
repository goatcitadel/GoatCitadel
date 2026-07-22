/**
 * HX-407 C3 typed Library + Chat external-sources client.
 *
 * Library calls target the shipped (proof-gated) Gateway routes in
 * `apps/gateway/src/routes/external-sources.ts`. Chat attachment calls are
 * typed against the frozen C1 contracts and the C4 packet's route paths
 * (`/api/v1/chat/sessions/:sessionId/external-source-attachments`); those
 * routes do not exist until C4 composes them, so callers MUST treat a 404 as
 * "capability absent" (see `isExternalSourceCapabilityAbsent`) and degrade
 * instead of surfacing an error.
 *
 * Every request body passes through the frozen contract normalizers before it
 * leaves the client, so the operator UI can never send malformed material and
 * can never smuggle a client-supplied hash (the exact-key gates throw). Every
 * response is re-validated with the frozen contract asserts, so the UI never
 * trusts an unvalidated or content-bearing payload.
 */
import {
  assertExternalSessionAttachment,
  assertExternalSourceImportIntent,
  assertExternalSourceImportItem,
  assertExternalSourceImportPlan,
  assertExternalSourceImportSettlement,
  assertExternalSourcePage,
  assertExternalSourceRecord,
  assertExternalSourceScanRecord,
  assertExternalSourceScanSummary,
  assertExternalSourceSummary,
  normalizeExternalSessionAttachInput,
  normalizeExternalSessionDetachInput,
  normalizeExternalSourceCatalogListInput,
  normalizeExternalSourceCreateInput,
  normalizeExternalSourceImportApplyInput,
  normalizeExternalSourceImportPlanInput,
  normalizeExternalSourceKnowledgeSnapshotRequestInput,
  normalizeExternalSourceScanInput,
  type ExternalSessionAttachInput,
  type ExternalSessionAttachmentListResponse,
  type ExternalSessionAttachmentResponse,
  type ExternalSessionDetachInput,
  type ExternalSessionDetachResponse,
  type ExternalSourceCatalogListInput,
  type ExternalSourceCreateInput,
  type ExternalSourceDetailResponse,
  type ExternalSourceImportApplyResponse,
  type ExternalSourceImportDetailResponse,
  type ExternalSourceImportPlanInput,
  type ExternalSourceImportPlanResponse,
  type ExternalSourceKnowledgeSnapshotRequestInput,
  type ExternalSourceListResponse,
  type ExternalSourcePage,
  type ExternalSourceScanInput,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";
import { isApiRequestError } from "./http-internal.js";

const LIBRARY_SOURCES_PATH = "/api/v1/library/external-sources";
const LIBRARY_IMPORT_PLANS_PATH = "/api/v1/library/external-source-import-plans";
const LIBRARY_IMPORTS_PATH = "/api/v1/library/external-source-imports";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function requireIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    throw new Error(`External source client requires a valid ${label}.`);
  }
  return trimmed;
}

function workspaceQuery(workspaceId: string): string {
  return `workspaceId=${encodeURIComponent(requireIdentifier(workspaceId, "workspace id"))}`;
}

/**
 * True when the Gateway answered 404 for an external-source call. Until C4
 * composes the routes (and while the proof gate keeps them dark) this is the
 * expected steady state, so UI surfaces hide their controls instead of
 * treating it as an error.
 */
export function isExternalSourceCapabilityAbsent(error: unknown): boolean {
  return isApiRequestError(error) && error.status === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function parseAttachmentListResponse(payload: unknown): ExternalSessionAttachmentListResponse {
  if (!isRecord(payload) || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("External attachment list response is malformed.");
  }
  const list = payload as unknown as ExternalSessionAttachmentListResponse;
  for (const item of list.items) {
    assertExternalSessionAttachment(item);
  }
  return list;
}

function parseAttachmentEnvelope<T extends { attachment: unknown }>(payload: unknown, dispositions: string[]): T {
  if (!isRecord(payload) || typeof (payload as { disposition?: unknown }).disposition !== "string") {
    throw new Error("External attachment response is malformed.");
  }
  const envelope = payload as unknown as T & { disposition: string };
  if (!dispositions.includes(envelope.disposition)) {
    throw new Error("External attachment response disposition is invalid.");
  }
  assertExternalSessionAttachment(envelope.attachment as never);
  return envelope;
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

function chatAttachmentsPath(sessionId: string, suffix = ""): string {
  return `/api/v1/chat/sessions/${encodeURIComponent(requireIdentifier(sessionId, "session id"))}/external-source-attachments${suffix}`;
}

/**
 * Durably reload content-free attachment truth for one workspace-bound session
 * (C4 packet route: `GET /api/v1/chat/sessions/:sessionId/external-source-attachments`).
 * A 404 means the capability is absent (pre-C4); callers degrade, never retry-spam.
 */
export async function fetchExternalSessionAttachments(
  sessionId: string,
  workspaceId: string,
  limit?: number,
): Promise<ExternalSessionAttachmentListResponse> {
  const query = new URLSearchParams({ workspaceId: requireIdentifier(workspaceId, "workspace id") });
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  const payload = await request<unknown>(`${chatAttachmentsPath(sessionId)}?${query.toString()}`, {
    cache: "no-store",
  });
  return parseAttachmentListResponse(payload);
}

/**
 * Attach one applied import item read-only. The body is the exact C1 contract
 * input: identifiers plus the expected session incarnation only — the server
 * derives every hash, and the exact-key normalizer throws on any smuggled one.
 */
export async function attachExternalSourceToSession(
  input: ExternalSessionAttachInput,
): Promise<ExternalSessionAttachmentResponse> {
  const body = normalizeExternalSessionAttachInput(input);
  const payload = await request<unknown>(chatAttachmentsPath(body.sessionId), {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  return parseAttachmentEnvelope<ExternalSessionAttachmentResponse>(payload, ["created", "replayed"]);
}

/** Exact CAS detach; imported evidence remains immutable server-side. */
export async function detachExternalSourceAttachment(
  input: ExternalSessionDetachInput,
): Promise<ExternalSessionDetachResponse> {
  const body = normalizeExternalSessionDetachInput(input);
  const payload = await request<unknown>(
    chatAttachmentsPath(body.sessionId, `/${encodeURIComponent(body.attachmentId)}`),
    { method: "DELETE", cache: "no-store", body: JSON.stringify(body) },
  );
  return parseAttachmentEnvelope<ExternalSessionDetachResponse>(payload, ["detached", "replayed"]);
}

/**
 * Receipt for a governed knowledge-snapshot approval request. C4 owns the final
 * route envelope; the client requires only the approval identity the UI needs
 * to hand the operator to the existing approvals surface.
 */
export interface ExternalSourceKnowledgeSnapshotRequestReceipt {
  readonly approvalId: string | null;
}

/**
 * Create the dedicated knowledge-snapshot approval request (C4 packet route:
 * `POST /api/v1/library/external-source-imports/:importId/knowledge-snapshot-requests`).
 * The payload is identifier-only (plus expected revisions); it can never carry
 * content bytes or client-supplied hashes, and it never creates knowledge inline —
 * the approval flow itself is the existing approvals UI.
 */
export async function requestExternalSourceKnowledgeSnapshot(
  input: ExternalSourceKnowledgeSnapshotRequestInput,
): Promise<ExternalSourceKnowledgeSnapshotRequestReceipt> {
  const body = normalizeExternalSourceKnowledgeSnapshotRequestInput(input);
  const payload = await request<unknown>(
    `${LIBRARY_IMPORTS_PATH}/${encodeURIComponent(body.importId)}/knowledge-snapshot-requests`,
    { method: "POST", cache: "no-store", body: JSON.stringify(body) },
  );
  if (isRecord(payload)) {
    const direct = (payload as { approvalId?: unknown }).approvalId;
    if (typeof direct === "string" && direct.trim()) {
      return { approvalId: direct.trim() };
    }
    const nested = (payload as { approval?: unknown }).approval;
    if (isRecord(nested) && typeof nested.approvalId === "string" && nested.approvalId.trim()) {
      return { approvalId: nested.approvalId.trim() };
    }
  }
  return { approvalId: null };
}
