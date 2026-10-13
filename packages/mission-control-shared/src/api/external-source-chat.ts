/** Eager Chat API owner; transport, normalization and response checks are unchanged. */
import {
  EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
  assertExternalSessionAttachment,
  assertExternalSourceAttachmentCandidateListResponse,
  normalizeExternalSessionAttachInput,
  normalizeExternalSessionDetachInput,
  normalizeExternalSourceKnowledgeSnapshotRequestInput,
} from "@goatcitadel/contracts/external-source-chat";
import type {
  ExternalSessionAttachInput,
  ExternalSessionAttachmentListResponse,
  ExternalSessionAttachmentResponse,
  ExternalSessionDetachInput,
  ExternalSessionDetachResponse,
  ExternalSourceAttachmentCandidateListResponse,
  ExternalSourceKnowledgeSnapshotRequestInput,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";
import { isApiRequestError } from "./http-internal.js";

export const LIBRARY_IMPORTS_PATH = "/api/v1/library/external-source-imports";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export function requireIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    throw new Error(`External source client requires a valid ${label}.`);
  }
  return trimmed;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseAttachmentListResponse(payload: unknown): ExternalSessionAttachmentListResponse {
  if (!isRecord(payload) || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("External attachment list response is malformed.");
  }
  // C4 durable-reload truth: the list optionally carries the current
  // server-owned session incarnation (the sanctioned place clients learn the
  // exact-CAS mutation precondition). When present it must be a bounded
  // non-empty string; anything else is a malformed response, never a value the
  // Chat hook may hand to attach/detach/knowledge-request.
  const sessionIncarnationId = (payload as { sessionIncarnationId?: unknown }).sessionIncarnationId;
  if (
    sessionIncarnationId !== undefined &&
    (typeof sessionIncarnationId !== "string" ||
      sessionIncarnationId.trim() === "" ||
      sessionIncarnationId.length > EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH)
  ) {
    throw new Error("External attachment list response is malformed.");
  }
  const list = payload as unknown as ExternalSessionAttachmentListResponse;
  for (const item of list.items) {
    assertExternalSessionAttachment(item);
  }
  return list;
}

function parseAttachmentCandidateListResponse(payload: unknown): ExternalSourceAttachmentCandidateListResponse {
  if (!isRecord(payload) || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("External attachment candidate list response is malformed.");
  }
  const list = payload as unknown as ExternalSourceAttachmentCandidateListResponse;
  assertExternalSourceAttachmentCandidateListResponse(list);
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
 * Fetch bounded, content-free picker choices for one session. Only the
 * Gateway decides eligibility; the subsequent attach repeats all checks.
 */
export async function fetchExternalSourceAttachmentCandidates(
  sessionId: string,
  workspaceId: string,
  limit?: number,
): Promise<ExternalSourceAttachmentCandidateListResponse> {
  const query = new URLSearchParams({ workspaceId: requireIdentifier(workspaceId, "workspace id") });
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  const path = `/api/v1/chat/sessions/${encodeURIComponent(requireIdentifier(sessionId, "session id"))}/external-source-attachment-candidates`;
  const payload = await request<unknown>(`${path}?${query.toString()}`, { cache: "no-store" });
  return parseAttachmentCandidateListResponse(payload);
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
