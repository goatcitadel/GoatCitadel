/**
 * HX-408 M4 operator-scoped mesh-capability client.
 *
 * These calls use the operator's NORMAL Mission Control authentication (the
 * shared `request` transport). They speak only to the three operator-only
 * routes the M1/M2 slices shipped — inspection listing, governed activation
 * request, and activation revoke — plus the pre-existing retained-events
 * listing for invocation-outcome visibility:
 *
 *  - GET  /api/v1/mesh/capabilities/publications?workspaceId=…       (M1, no-store)
 *  - POST /api/v1/mesh/capabilities/activations                      (M2, operator only)
 *  - POST /api/v1/mesh/capabilities/activations/:activationId/revoke (M2, operator only)
 *  - GET  /api/v1/events?limit=…                (existing retained realtime events)
 *
 * There is deliberately NO manifest/descriptor fetch here: the inspection
 * projection carries server-owned facts (identity, generations, digests,
 * status, reasons, posture, activation linkage) and the Ops surface renders
 * those semantically — raw manifest bytes never reach this client. Every
 * response is validated with bounded parsers so the operator UI cannot render
 * unvalidated or smuggled server content.
 */
import type {
  MeshCapabilityCatalogEntryStatus,
  MeshCapabilityEffectPosture,
  MeshCapabilityKind,
  MeshCapabilitySettlementDisposition,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,256}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIVATION_ID_PATTERN = /^mesh-activation-[a-f0-9]{48}$/u;
const MAX_MANIFESTS = 512;
const MAX_ENTRIES = 128;
const MAX_REASONS = 16;

const ENTRY_STATUSES = new Set<MeshCapabilityCatalogEntryStatus>([
  "review_required",
  "active",
  "revoked",
  "offline",
  "superseded",
  "blocked",
]);
const ENTRY_KINDS = new Set<MeshCapabilityKind>(["tool", "mcp_server", "skill"]);
const EFFECT_POSTURES = new Set<MeshCapabilityEffectPosture>([
  "none",
  "read_only",
  "write_local",
  "external_side_effect",
  "unknown",
]);
const SETTLEMENT_DISPOSITIONS = new Set<MeshCapabilitySettlementDisposition>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
]);
const PERMISSION_DIFF_DISPOSITIONS = new Set(["initial", "unchanged", "narrowed", "widened", "mixed"]);
const EFFECT_DIFF_DISPOSITIONS = new Set(["initial", "unchanged", "reduced", "increased", "changed"]);

export interface MeshCapabilityOpsEntryActivation {
  readonly activationId: string;
  readonly activationRevision: number;
  readonly approvalId: string;
  readonly revoked: boolean;
}

/** One server-projected manifest entry (facts only — never descriptor bytes). */
export interface MeshCapabilityOpsEntry {
  readonly nodeId: string;
  readonly admissionGeneration: number;
  readonly publisherGeneration: number;
  readonly manifestSha256: string;
  readonly entrySha256: string;
  readonly localId: string;
  readonly capabilityKind: MeshCapabilityKind;
  readonly status: MeshCapabilityCatalogEntryStatus;
  readonly reasons: readonly string[];
  readonly effectPosture: MeshCapabilityEffectPosture;
  readonly activation?: MeshCapabilityOpsEntryActivation;
}

export interface MeshCapabilityOpsManifest {
  readonly publicationKey: string;
  readonly manifestSha256: string;
  readonly admissionGeneration: number;
  readonly publisherGeneration: number;
  readonly createdAt: string;
  readonly supersedesManifestSha256?: string;
  readonly supersededByManifestSha256?: string;
  readonly entries: readonly MeshCapabilityOpsEntry[];
}

export interface MeshCapabilityPublicationInspectionResponse {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly manifests: readonly MeshCapabilityOpsManifest[];
}

export interface MeshCapabilityActivationDiffSummary {
  readonly permissionDisposition: string;
  readonly permissionsAdded: readonly string[];
  readonly permissionsRemoved: readonly string[];
  readonly effectDisposition: string;
  readonly priorEffectPosture?: MeshCapabilityEffectPosture;
  readonly currentEffectPosture: MeshCapabilityEffectPosture;
}

export interface MeshCapabilityActivationRequestResponse {
  readonly replayed: boolean;
  readonly activationId: string;
  readonly activationRevision: number;
  readonly approvalId: string;
  readonly approvalStatus: string;
  readonly approvalExpiresAt?: string;
  readonly diff: MeshCapabilityActivationDiffSummary;
}

export interface MeshCapabilityActivationRevokeResponse {
  readonly replayed: boolean;
  readonly activationId: string;
  readonly reason: string;
  readonly revokedAt: string;
}

/**
 * Latest known dispatch/settlement fact for one invocation, reduced from the
 * retained realtime events the M3 invocation owner publishes (source "mesh").
 * `manualReconciliationRequired` mirrors the M3 rule: an `unknown` settlement
 * is never auto-replayed and waits for operator reconciliation.
 */
export interface MeshCapabilityInvocationActivityItem {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly phase: "dispatched" | "settled" | "reconciled";
  readonly disposition?: MeshCapabilitySettlementDisposition;
  readonly settlementAuthority?: "node" | "gateway";
  readonly errorCode?: string;
  readonly manualReconciliationRequired: boolean;
  readonly observedAt: string;
}

function normalizeWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error("Mesh capability inspection requires a valid workspace scope.");
  }
  return normalized;
}

/** Operator-only, read-only inspection of a workspace's mesh publications. */
export async function fetchMeshCapabilityPublications(
  workspaceId: string,
): Promise<MeshCapabilityPublicationInspectionResponse> {
  const normalized = normalizeWorkspaceId(workspaceId);
  const query = new URLSearchParams({ workspaceId: normalized });
  const payload = await request<unknown>(`/api/v1/mesh/capabilities/publications?${query.toString()}`);
  return parseInspection(payload, normalized);
}

export interface MeshCapabilityActivationRequestInput {
  readonly workspaceId: string;
  readonly capabilityId: string;
  readonly manifestSha256: string;
  readonly entrySha256: string;
}

/** Request governed activation of one EXACT manifest entry (detached approval). */
export async function requestMeshCapabilityActivation(
  input: MeshCapabilityActivationRequestInput,
): Promise<MeshCapabilityActivationRequestResponse> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  if (!IDENTIFIER_PATTERN.test(input.capabilityId)) {
    throw new Error("Mesh capability activation requires the server-derived capability id.");
  }
  if (!SHA256_PATTERN.test(input.manifestSha256) || !SHA256_PATTERN.test(input.entrySha256)) {
    throw new Error("Mesh capability activation requires the exact manifest and entry digests.");
  }
  const payload = await request<unknown>("/api/v1/mesh/capabilities/activations", {
    method: "POST",
    body: JSON.stringify({
      workspaceId,
      capabilityId: input.capabilityId,
      manifestSha256: input.manifestSha256,
      entrySha256: input.entrySha256,
    }),
  });
  return parseActivationRequestResponse(payload);
}

export interface MeshCapabilityActivationRevokeInput {
  readonly workspaceId: string;
  readonly activationId: string;
  readonly reason: string;
}

/** Revoke one governed activation; callability is gone before the next read. */
export async function revokeMeshCapabilityActivation(
  input: MeshCapabilityActivationRevokeInput,
): Promise<MeshCapabilityActivationRevokeResponse> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  if (!ACTIVATION_ID_PATTERN.test(input.activationId)) {
    throw new Error("Mesh capability revoke requires a valid activation id.");
  }
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 2_000) {
    throw new Error("Mesh capability revoke requires a non-empty reason (max 2000 characters).");
  }
  const payload = await request<unknown>(
    `/api/v1/mesh/capabilities/activations/${encodeURIComponent(input.activationId)}/revoke`,
    { method: "POST", body: JSON.stringify({ workspaceId, reason }) },
  );
  return parseActivationRevokeResponse(payload);
}

const MESH_INVOCATION_EVENT_TYPES = new Set([
  "mesh_capability_invocation_dispatched",
  "mesh_capability_invocation_settled",
  "mesh_capability_invocation_reconciled",
]);

/**
 * Reduce retained realtime events to the latest dispatch/settlement fact per
 * invocation. Pure so the reduction is unit-testable; unknown or malformed
 * event payloads are dropped, never guessed at.
 */
export function summarizeMeshCapabilityInvocationActivity(
  events: readonly RealtimeEvent[],
  workspaceId: string,
): MeshCapabilityInvocationActivityItem[] {
  const latestByInvocation = new Map<string, MeshCapabilityInvocationActivityItem>();
  // The events listing returns newest-first; keep the FIRST (newest) fact seen
  // per invocation id.
  for (const event of events) {
    if (event.source !== "mesh" || !MESH_INVOCATION_EVENT_TYPES.has(String(event.eventType))) continue;
    const payload = event.payload;
    if (payload.workspaceId !== workspaceId) continue;
    const invocationId = payload.invocationId;
    const capabilityId = payload.capabilityId;
    const nodeId = payload.nodeId;
    if (
      typeof invocationId !== "string" ||
      !IDENTIFIER_PATTERN.test(invocationId) ||
      typeof capabilityId !== "string" ||
      typeof nodeId !== "string"
    ) {
      continue;
    }
    if (latestByInvocation.has(invocationId)) continue;
    const phase =
      event.eventType === "mesh_capability_invocation_dispatched"
        ? "dispatched"
        : event.eventType === "mesh_capability_invocation_reconciled"
          ? "reconciled"
          : "settled";
    const disposition =
      typeof payload.disposition === "string" &&
      SETTLEMENT_DISPOSITIONS.has(payload.disposition as MeshCapabilitySettlementDisposition)
        ? (payload.disposition as MeshCapabilitySettlementDisposition)
        : undefined;
    const settlementAuthority =
      payload.settlementAuthority === "node" || payload.settlementAuthority === "gateway"
        ? payload.settlementAuthority
        : undefined;
    const errorCode =
      typeof payload.errorCode === "string" && IDENTIFIER_PATTERN.test(payload.errorCode)
        ? payload.errorCode
        : undefined;
    latestByInvocation.set(invocationId, {
      invocationId,
      capabilityId,
      nodeId,
      phase,
      ...(disposition === undefined ? {} : { disposition }),
      ...(settlementAuthority === undefined ? {} : { settlementAuthority }),
      ...(errorCode === undefined ? {} : { errorCode }),
      manualReconciliationRequired: phase !== "dispatched" && disposition === "unknown",
      observedAt: event.timestamp,
    });
  }
  return [...latestByInvocation.values()];
}

/**
 * Invocation-outcome visibility for the Ops panel, via the EXISTING retained
 * events route. This is deliberately best-effort observability — the durable
 * per-invocation queue (immutable intents + settlements, including the
 * unsettled/manual-reconciliation projection) has no operator inspection route
 * yet, and this client never invents one.
 */
export async function fetchMeshCapabilityInvocationActivity(
  workspaceId: string,
  limit = 200,
): Promise<MeshCapabilityInvocationActivityItem[]> {
  const normalized = normalizeWorkspaceId(workspaceId);
  const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 500))) });
  const payload = await request<{ items?: RealtimeEvent[] }>(`/api/v1/events?${query.toString()}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return summarizeMeshCapabilityInvocationActivity(items, normalized);
}

// ---------------------------------------------------------------------------
// Bounded response parsers.
// ---------------------------------------------------------------------------

function parseInspection(payload: unknown, workspaceId: string): MeshCapabilityPublicationInspectionResponse {
  const record = asRecord(payload);
  if (
    !record ||
    record.workspaceId !== workspaceId ||
    !isIsoTimestamp(record.generatedAt) ||
    !Array.isArray(record.manifests) ||
    record.manifests.length > MAX_MANIFESTS
  ) {
    throw invalidResponse();
  }
  return {
    workspaceId,
    generatedAt: record.generatedAt,
    manifests: record.manifests.map((manifest) => parseManifest(manifest)),
  };
}

function parseManifest(value: unknown): MeshCapabilityOpsManifest {
  const record = asRecord(value);
  if (
    !record ||
    !isBoundedText(record.publicationKey, 512) ||
    !isSha256(record.manifestSha256) ||
    !isPositiveInteger(record.admissionGeneration) ||
    !isPositiveInteger(record.publisherGeneration) ||
    !isIsoTimestamp(record.createdAt) ||
    (record.supersedesManifestSha256 !== undefined && !isSha256(record.supersedesManifestSha256)) ||
    (record.supersededByManifestSha256 !== undefined && !isSha256(record.supersededByManifestSha256)) ||
    !Array.isArray(record.entries) ||
    record.entries.length > MAX_ENTRIES
  ) {
    throw invalidResponse();
  }
  return {
    publicationKey: record.publicationKey,
    manifestSha256: record.manifestSha256,
    admissionGeneration: record.admissionGeneration,
    publisherGeneration: record.publisherGeneration,
    createdAt: record.createdAt,
    ...(record.supersedesManifestSha256 === undefined
      ? {}
      : { supersedesManifestSha256: record.supersedesManifestSha256 }),
    ...(record.supersededByManifestSha256 === undefined
      ? {}
      : { supersededByManifestSha256: record.supersededByManifestSha256 }),
    entries: record.entries.map((entry) => parseEntry(entry)),
  };
}

function parseEntry(value: unknown): MeshCapabilityOpsEntry {
  const record = asRecord(value);
  if (
    !record ||
    !isBoundedText(record.nodeId, 128) ||
    !isPositiveInteger(record.admissionGeneration) ||
    !isPositiveInteger(record.publisherGeneration) ||
    !isSha256(record.manifestSha256) ||
    !isSha256(record.entrySha256) ||
    !isBoundedText(record.localId, 128) ||
    !ENTRY_KINDS.has(record.capabilityKind as MeshCapabilityKind) ||
    !ENTRY_STATUSES.has(record.status as MeshCapabilityCatalogEntryStatus) ||
    !EFFECT_POSTURES.has(record.effectPosture as MeshCapabilityEffectPosture) ||
    !Array.isArray(record.reasons) ||
    record.reasons.length > MAX_REASONS ||
    !record.reasons.every((reason) => isBoundedText(reason, 128))
  ) {
    throw invalidResponse();
  }
  const activation = record.activation === undefined ? undefined : parseEntryActivation(record.activation);
  return {
    nodeId: record.nodeId,
    admissionGeneration: record.admissionGeneration,
    publisherGeneration: record.publisherGeneration,
    manifestSha256: record.manifestSha256,
    entrySha256: record.entrySha256,
    localId: record.localId,
    capabilityKind: record.capabilityKind as MeshCapabilityKind,
    status: record.status as MeshCapabilityCatalogEntryStatus,
    reasons: record.reasons as string[],
    effectPosture: record.effectPosture as MeshCapabilityEffectPosture,
    ...(activation === undefined ? {} : { activation }),
  };
}

function parseEntryActivation(value: unknown): MeshCapabilityOpsEntryActivation {
  const record = asRecord(value);
  if (
    !record ||
    !isBoundedText(record.activationId, 256) ||
    !isPositiveInteger(record.activationRevision) ||
    !isBoundedText(record.approvalId, 256) ||
    typeof record.revoked !== "boolean"
  ) {
    throw invalidResponse();
  }
  return {
    activationId: record.activationId,
    activationRevision: record.activationRevision,
    approvalId: record.approvalId,
    revoked: record.revoked,
  };
}

function parseActivationRequestResponse(payload: unknown): MeshCapabilityActivationRequestResponse {
  const record = asRecord(payload);
  const approval = asRecord(record?.approval);
  const permissionDiff = asRecord(record?.permissionDiff);
  const effectDiff = asRecord(record?.effectDiff);
  if (
    !record ||
    !approval ||
    !permissionDiff ||
    !effectDiff ||
    typeof record.replayed !== "boolean" ||
    !isBoundedText(record.activationId, 256) ||
    !isPositiveInteger(record.activationRevision) ||
    !isBoundedText(approval.approvalId, 256) ||
    !isBoundedText(approval.status, 64) ||
    (approval.expiresAt !== undefined && !isIsoTimestamp(approval.expiresAt)) ||
    typeof permissionDiff.disposition !== "string" ||
    !PERMISSION_DIFF_DISPOSITIONS.has(permissionDiff.disposition) ||
    !Array.isArray(permissionDiff.added) ||
    !Array.isArray(permissionDiff.removed) ||
    !permissionDiff.added.every((item) => isBoundedText(item, 512)) ||
    !permissionDiff.removed.every((item) => isBoundedText(item, 512)) ||
    typeof effectDiff.disposition !== "string" ||
    !EFFECT_DIFF_DISPOSITIONS.has(effectDiff.disposition) ||
    !EFFECT_POSTURES.has(effectDiff.currentEffectPosture as MeshCapabilityEffectPosture) ||
    (effectDiff.priorEffectPosture !== undefined &&
      !EFFECT_POSTURES.has(effectDiff.priorEffectPosture as MeshCapabilityEffectPosture))
  ) {
    throw invalidResponse();
  }
  return {
    replayed: record.replayed,
    activationId: record.activationId,
    activationRevision: record.activationRevision,
    approvalId: approval.approvalId,
    approvalStatus: approval.status,
    ...(approval.expiresAt === undefined ? {} : { approvalExpiresAt: approval.expiresAt }),
    diff: {
      permissionDisposition: permissionDiff.disposition,
      permissionsAdded: permissionDiff.added as string[],
      permissionsRemoved: permissionDiff.removed as string[],
      effectDisposition: effectDiff.disposition,
      ...(effectDiff.priorEffectPosture === undefined
        ? {}
        : { priorEffectPosture: effectDiff.priorEffectPosture as MeshCapabilityEffectPosture }),
      currentEffectPosture: effectDiff.currentEffectPosture as MeshCapabilityEffectPosture,
    },
  };
}

function parseActivationRevokeResponse(payload: unknown): MeshCapabilityActivationRevokeResponse {
  const record = asRecord(payload);
  const revocation = asRecord(record?.revocation);
  if (
    !record ||
    !revocation ||
    typeof record.replayed !== "boolean" ||
    !isBoundedText(revocation.activationId, 256) ||
    !isBoundedText(revocation.reason, 2_000) ||
    !isIsoTimestamp(revocation.revokedAt)
  ) {
    throw invalidResponse();
  }
  return {
    replayed: record.replayed,
    activationId: revocation.activationId,
    reason: revocation.reason,
    revokedAt: revocation.revokedAt,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function invalidResponse(): Error {
  return new Error("Gateway returned an invalid mesh capability envelope.");
}
