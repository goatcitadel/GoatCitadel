/**
 * HX-507B operator-scoped remote-worker Ops client.
 *
 * These calls use the operator's NORMAL Mission Control authentication (the
 * shared `request` transport). They speak only to the read-only, no-store,
 * operator-authenticated GET routes the visibility tranche ships:
 *
 *  - GET /api/v1/ops/workspaces/:workspaceId/remote-workers                      (registry page)
 *  - GET /api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId            (registry detail)
 *  - GET /api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/reconciliation
 *  - GET /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments           (assignment page)
 *  - GET /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/events
 *
 * Every response is validated with the SAME server contract validators the
 * Gateway freezes with, so the operator UI can never render unvalidated or
 * smuggled server content. There is deliberately no mutation surface here: the
 * server owns all remote-worker state; this client only projects it. Cursors
 * and identifiers are opaque, server-derived values echoed back verbatim.
 */
import {
  freezeRemoteWorkerAssignmentEventPage,
  freezeRemoteWorkerAssignmentPage,
  freezeRemoteWorkerReconciliation,
  freezeRemoteWorkerRegistryDetail,
  freezeRemoteWorkerRegistryPage,
  type RemoteWorkerAssignmentEventPage,
  type RemoteWorkerAssignmentPage,
  type RemoteWorkerReconciliation,
  type RemoteWorkerRegistryDetail,
  type RemoteWorkerRegistryPage,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,256}$/u;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{1,256}$/u;
const MAX_CURSOR_LENGTH = 2_048;

function normalizeScopedId(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`Remote worker request requires a valid ${label}.`);
  }
  return normalized;
}

function normalizeWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error("Remote worker request requires a valid workspace scope.");
  }
  return normalized;
}

function boundedCursor(cursor: string): string {
  if (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new Error("Remote worker cursor is out of bounds.");
  }
  return cursor;
}

export interface RemoteWorkerRegistryQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Operator-only, read-only registry page for one workspace. */
export async function fetchRemoteWorkerRegistry(
  workspaceId: string,
  query: RemoteWorkerRegistryQuery = {},
): Promise<RemoteWorkerRegistryPage> {
  const scope = normalizeWorkspaceId(workspaceId);
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", boundedCursor(query.cursor));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const payload = await request<unknown>(`/api/v1/ops/workspaces/${encodeURIComponent(scope)}/remote-workers${suffix}`);
  return freezeRemoteWorkerRegistryPage(payload);
}

/** Operator-only, read-only registry detail for one worker. */
export async function fetchRemoteWorkerDetail(
  workspaceId: string,
  workerId: string,
): Promise<RemoteWorkerRegistryDetail> {
  const scope = normalizeWorkspaceId(workspaceId);
  const worker = normalizeScopedId(workerId, "worker id");
  const payload = await request<unknown>(
    `/api/v1/ops/workspaces/${encodeURIComponent(scope)}/remote-workers/${encodeURIComponent(worker)}`,
  );
  return freezeRemoteWorkerRegistryDetail(payload);
}

/** Read-only cross-owner reconciliation projection for one worker. */
export async function fetchRemoteWorkerReconciliation(
  workspaceId: string,
  workerId: string,
): Promise<RemoteWorkerReconciliation> {
  const scope = normalizeWorkspaceId(workspaceId);
  const worker = normalizeScopedId(workerId, "worker id");
  const payload = await request<unknown>(
    `/api/v1/ops/workspaces/${encodeURIComponent(scope)}/remote-workers/${encodeURIComponent(worker)}/reconciliation`,
  );
  return freezeRemoteWorkerReconciliation(payload);
}

export interface RemoteWorkerAssignmentsQuery {
  readonly workerId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Read-only assignment projection page; storage lineage decides membership. */
export async function fetchRemoteWorkerAssignments(
  workspaceId: string,
  query: RemoteWorkerAssignmentsQuery = {},
): Promise<RemoteWorkerAssignmentPage> {
  const scope = normalizeWorkspaceId(workspaceId);
  const params = new URLSearchParams();
  if (query.workerId !== undefined) params.set("workerId", normalizeScopedId(query.workerId, "worker id"));
  if (query.sessionId !== undefined) params.set("sessionId", normalizeScopedId(query.sessionId, "session id"));
  if (query.turnId !== undefined) params.set("turnId", normalizeScopedId(query.turnId, "turn id"));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", boundedCursor(query.cursor));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const payload = await request<unknown>(
    `/api/v1/ops/workspaces/${encodeURIComponent(scope)}/remote-worker-assignments${suffix}`,
  );
  return freezeRemoteWorkerAssignmentPage(payload);
}

export interface RemoteWorkerAssignmentEventsQuery {
  readonly afterSequence?: number;
  readonly limit?: number;
}

/** Read-only sanitized event summaries for one assignment's current generation. */
export async function fetchRemoteWorkerAssignmentEvents(
  workspaceId: string,
  assignmentId: string,
  query: RemoteWorkerAssignmentEventsQuery = {},
): Promise<RemoteWorkerAssignmentEventPage> {
  const scope = normalizeWorkspaceId(workspaceId);
  const assignment = normalizeScopedId(assignmentId, "assignment id");
  const params = new URLSearchParams();
  if (query.afterSequence !== undefined) params.set("afterSequence", String(query.afterSequence));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const payload = await request<unknown>(
    `/api/v1/ops/workspaces/${encodeURIComponent(scope)}/remote-worker-assignments/${encodeURIComponent(
      assignment,
    )}/events${suffix}`,
  );
  return freezeRemoteWorkerAssignmentEventPage(payload);
}
