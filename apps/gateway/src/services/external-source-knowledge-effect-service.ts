import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_TTL_MS,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CHUNK_MAX_CHARS,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  NotFoundError,
  assertExternalSourceKnowledgeSnapshotApprovalPayload,
  canonicalJsonString,
  normalizeExternalSourceKnowledgeSnapshotApplyInput,
  type ApprovalRequest,
  type ExternalSourceKnowledgeLinkRecord,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type ExternalSourceKnowledgeSnapshotRequestMaterial,
  type GovernanceJourneyEventRecord,
  type ThreadKnowledgeAttachmentRecord,
} from "@goatcitadel/contracts";
import {
  buildApprovalEffectIdempotencyKey,
  buildExternalSourceKnowledgeDocumentBinding,
  sealExternalSourceKnowledgeLink,
  type AsyncStorage as Storage,
} from "@goatcitadel/storage";
import {
  ExternalSourceAttachmentService,
  ExternalSourceAttachmentServiceError,
} from "./external-source-attachment-service.js";
import { buildExternalSourceKnowledgeSnapshotJourneyEvent } from "./external-source-journey-producer.js";
import type { ExternalSourceRequestActor } from "./external-source-service.js";

export type ExternalSourceKnowledgeEffectServiceErrorCode =
  | "approval_conflict"
  | "approval_expired"
  | "approval_not_approved"
  | "artifact_failure"
  | "cancelled"
  | "conflict"
  | "identity_drift"
  | "not_found"
  | "policy_denied"
  | "session_incarnation_stale"
  | "source_not_active";

const ERROR_MESSAGES: Readonly<Record<ExternalSourceKnowledgeEffectServiceErrorCode, string>> = Object.freeze({
  approval_conflict: "External source knowledge-snapshot approval conflicts with immutable request material.",
  approval_expired: "External source knowledge-snapshot approval has expired.",
  approval_not_approved: "External source knowledge-snapshot approval is not an executable approved request.",
  artifact_failure: "External source managed artifact verification failed.",
  cancelled: "External source knowledge-snapshot operation was cancelled.",
  conflict: "External source knowledge-snapshot state conflicts with immutable evidence.",
  identity_drift: "External source identity drifted; live attachment use is invalidated.",
  not_found: "External source knowledge-snapshot resource was not found.",
  policy_denied: "External source knowledge snapshot was denied by current policy.",
  session_incarnation_stale: "External source knowledge-snapshot session incarnation is stale.",
  source_not_active: "External source is not active.",
});

export class ExternalSourceKnowledgeEffectServiceError extends Error {
  public constructor(
    public readonly code: ExternalSourceKnowledgeEffectServiceErrorCode,
    public readonly reasonCode?: string,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceKnowledgeEffectServiceError";
  }
}

export type ExternalSourceKnowledgeSnapshotPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reasonCode: string };

/**
 * The deny-wins policy seam the recovered effect re-evaluates inside its
 * materialization transaction. C4 composes the production policy owner; a
 * throwing or denying evaluation fails the apply closed with zero writes.
 */
export interface ExternalSourceKnowledgeSnapshotPolicyPort {
  evaluateKnowledgeSnapshotApply(context: {
    workspaceId: string;
    sourceId: string;
    importId: string;
    itemId: string;
    approvalId: string;
    normalizedArtifactSha256: string;
  }): Promise<ExternalSourceKnowledgeSnapshotPolicyDecision>;
}

interface ExternalSourceKnowledgeEffectServiceClock {
  nowMs(): number;
}

export interface ExternalSourceKnowledgeEffectServiceDependencies {
  /**
   * The C1 attachment service: the full identity-chain revalidation (workspace,
   * session incarnation, source ownership/liveness/drift, applied import,
   * attachment revision, managed-artifact rehash) and the byte-exact read.
   */
  requests: Pick<ExternalSourceAttachmentService, "buildKnowledgeSnapshotRequest" | "readAttachedExternalContext">;
  approvals: Pick<Storage["approvals"], "createDeterministicDetachedWithTtlDuration" | "get">;
  links: Pick<Storage["externalSourceKnowledgeLinks"], "find" | "materializeApprovedSnapshotWithJourneyResolved">;
  journeys: Pick<Storage["governanceJourneyEvents"], "create">;
  policy: ExternalSourceKnowledgeSnapshotPolicyPort;
  runImmediateTransaction: <T>(callback: () => T | Promise<T>) => Promise<Awaited<T>>;
  clock?: ExternalSourceKnowledgeEffectServiceClock;
}

export interface ExternalSourceKnowledgeSnapshotApprovalResult {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  approval: ApprovalRequest;
  material: ExternalSourceKnowledgeSnapshotRequestMaterial;
  disposition: "created" | "replayed";
}

export interface ExternalSourceKnowledgeSnapshotApplyResult {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  disposition: "created" | "replayed";
  link: ExternalSourceKnowledgeLinkRecord;
  knowledgeDocumentId: string;
  chunkCount: number;
  threadKnowledgeAttachmentId?: string;
}

export interface ExternalSourceKnowledgeSnapshotMaterializedIdentities {
  approvalId: string;
  bindingSha256: string;
  knowledgeDocumentId: string;
  linkId: string;
  threadKnowledgeAttachmentId: string;
  effectId: string;
  targetId: string;
  effectIdempotencyKey: string;
}

const APPROVAL_RISK_LEVEL = "danger" as const;
const DEFAULT_CLOCK: ExternalSourceKnowledgeEffectServiceClock = { nowMs: () => Date.now() };

/**
 * Deterministic server-owned approval identity for one exact request payload.
 * C4 composition constraint: the shipped approvals surface resolves approvals
 * through `POST /api/v1/approvals/:approvalId/resolve`, whose route contract
 * pins a UUID-shaped id — so the deterministic identity is the canonical
 * payload digest formatted as a UUID (128 bits of the SHA-256), which stays
 * exactly replayable while remaining resolvable by the existing operator
 * surface. The approval `kind` column carries the domain identity.
 */
export function deriveExternalSourceKnowledgeSnapshotApprovalId(
  payload: ExternalSourceKnowledgeSnapshotApprovalPayload,
): string {
  assertExternalSourceKnowledgeSnapshotApprovalPayload(payload);
  const material = digest(payload).slice(0, 32);
  return [
    material.slice(0, 8),
    material.slice(8, 12),
    material.slice(12, 16),
    material.slice(16, 20),
    material.slice(20, 32),
  ].join("-");
}

/**
 * Every identity the approved effect materializes, derived only from the
 * immutable approval payload: the same approved request always addresses the
 * same document, chunk namespace, link, thread attachment, and effect row.
 */
export function deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(
  payload: ExternalSourceKnowledgeSnapshotApprovalPayload,
): ExternalSourceKnowledgeSnapshotMaterializedIdentities {
  const approvalId = deriveExternalSourceKnowledgeSnapshotApprovalId(payload);
  const binding = buildExternalSourceKnowledgeDocumentBinding({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: payload.workspaceId,
    sourceId: payload.sourceId,
    importId: payload.importId,
    itemId: payload.itemId,
    normalizedArtifactSha256: payload.normalizedArtifactSha256,
    approvalId,
  });
  const token = binding.metadata.bindingSha256.slice(0, 48);
  const targetId = `${payload.importId}:${payload.itemId}`;
  return {
    approvalId,
    bindingSha256: binding.metadata.bindingSha256,
    knowledgeDocumentId: `external-knowledge-doc-${token}`,
    linkId: `external-knowledge-link-${token}`,
    threadKnowledgeAttachmentId: `external-knowledge-thread-${token}`,
    effectId: `external-knowledge-effect-${token}`,
    targetId,
    effectIdempotencyKey: buildApprovalEffectIdempotencyKey({
      approvalId,
      effectKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
      targetKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
      targetId,
    }),
  };
}

/**
 * Deterministic, lossless chunking of the normalized artifact text: fixed
 * character bound, newline-preferring boundaries, never splits a surrogate
 * pair, never trims or overlaps — the chunk sequence concatenates back to the
 * exact source text, so the copy is byte-faithful and replay-stable.
 */
export function chunkExternalSourceKnowledgeText(text: string): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CHUNK_MAX_CHARS);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end - 1);
      if (lastNewline >= cursor) {
        end = lastNewline + 1;
      } else {
        const lead = text.charCodeAt(end - 1);
        if (lead >= 0xd800 && lead <= 0xdbff) end -= 1;
        if (end <= cursor) end = cursor + 2;
      }
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

/**
 * C2 owner of the governed recovered-knowledge effect: the real deterministic
 * `external_source.knowledge_snapshot` approval (bounded expiry, exact-payload
 * identity, request Journey evidence in the approval transaction) and the
 * approved-recovery apply that revalidates the entire identity chain through
 * the C1 attachment service, re-reads and re-hashes the managed artifact, then
 * materializes the deterministic knowledge document, chunks, link, optional
 * ordinary thread attachment, terminal effect row, and Journey evidence in ONE
 * storage transaction. Replay, concurrency, crash, denial, expiry, revoke,
 * policy-flip, drift, and tamper all fail closed with zero partial state. It
 * never calls the public ingest shortcut and promotes nothing into memory,
 * skills, or callable capabilities. Production-dark: constructed only by its
 * tests until the C4 composition tranche wires it behind the HX-407 proof
 * gate.
 */
export class ExternalSourceKnowledgeEffectService {
  private readonly clock: ExternalSourceKnowledgeEffectServiceClock;

  public constructor(private readonly dependencies: ExternalSourceKnowledgeEffectServiceDependencies) {
    if (
      !dependencies.requests ||
      !dependencies.approvals ||
      !dependencies.links ||
      !dependencies.journeys ||
      !dependencies.policy ||
      typeof dependencies.runImmediateTransaction !== "function"
    ) {
      throw new TypeError("External source knowledge effect service dependencies are required.");
    }
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
  }

  /**
   * Creates (or exactly replays) the REAL deterministic knowledge-snapshot
   * approval. The request material is rebuilt and fully revalidated by the C1
   * service, the approval ID derives from the canonical payload hash, expiry
   * is database-clock bounded, and the content-free `approval_requested`
   * Journey record commits in the same transaction as the approval row.
   */
  public async createApprovalRequest(
    rawInput: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotApprovalResult> {
    assertSignal(signal);
    const material = await this.dependencies.requests.buildKnowledgeSnapshotRequest(rawInput, actor, signal);
    throwIfAborted(signal);
    const approvalId = deriveExternalSourceKnowledgeSnapshotApprovalId(material.payload);
    try {
      return await this.dependencies.runImmediateTransaction(async () => {
        const existing = await this.findApproval(approvalId);
        if (existing) {
          if (
            existing.kind !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND ||
            canonicalJsonString(existing.payload) !== canonicalJsonString(material.payload)
          ) {
            throw new ExternalSourceKnowledgeEffectServiceError("approval_conflict");
          }
          await this.commitRequestJourney(material.payload, approvalId, actor, existing.createdAt);
          return {
            schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
            approval: existing,
            material,
            disposition: "replayed" as const,
          };
        }
        const stored = await this.dependencies.approvals.createDeterministicDetachedWithTtlDuration(
          {
            approvalId,
            kind: material.approvalKind,
            riskLevel: APPROVAL_RISK_LEVEL,
            payload: { ...material.payload },
            preview: { ...material.preview },
            linkage: {
              workspaceId: material.payload.workspaceId,
              sessionId: material.payload.sessionId,
              operatorId: actor.actorId,
              authActorId: actor.actorId,
              authActorSource: actor.source,
            },
          },
          EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_TTL_MS,
        );
        await this.commitRequestJourney(material.payload, approvalId, actor, stored.approval.createdAt);
        return {
          schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
          approval: stored.approval,
          material,
          disposition: stored.created ? ("created" as const) : ("replayed" as const),
        };
      });
    } catch (error) {
      throw normalizeEffectFailure(error, signal, "approval_conflict");
    }
  }

  /**
   * Executes one approved knowledge-snapshot recovery. The approval row is
   * revalidated (kind, workspace binding, canonical payload, derived identity,
   * approved status, bounded expiry), the full C1 identity chain is re-run
   * against live state and must reproduce the approved payload byte-for-byte,
   * the managed artifact is reopened and re-hashed, and the deterministic
   * materialization then commits in one storage transaction that re-asserts
   * approval/attachment state and current deny-wins policy. Exact replays
   * converge on the stored materialization and write nothing new.
   */
  public async applyApprovedSnapshot(
    rawInput: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotApplyResult> {
    assertSignal(signal);
    const input = normalizeExternalSourceKnowledgeSnapshotApplyInput(rawInput);
    const approval = await this.requireWorkspaceApproval(input.workspaceId, input.approvalId);
    const payload = readApprovalPayload(approval);
    if (payload.workspaceId !== input.workspaceId) {
      throw new ExternalSourceKnowledgeEffectServiceError("not_found");
    }
    if (deriveExternalSourceKnowledgeSnapshotApprovalId(payload) !== approval.approvalId) {
      throw new ExternalSourceKnowledgeEffectServiceError("approval_conflict");
    }
    if (approval.status !== "approved") {
      throw new ExternalSourceKnowledgeEffectServiceError("approval_not_approved");
    }
    const nowMs = this.clock.nowMs();
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= nowMs) {
      throw new ExternalSourceKnowledgeEffectServiceError("approval_expired");
    }

    let material: ExternalSourceKnowledgeSnapshotRequestMaterial;
    let bytes: Buffer;
    try {
      material = await this.dependencies.requests.buildKnowledgeSnapshotRequest(
        {
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          expectedSessionIncarnationId: payload.sessionIncarnationId,
          attachmentId: payload.attachmentId,
          importId: payload.importId,
          itemId: payload.itemId,
          expectedAttachmentRevision: payload.attachmentRevision,
        },
        actor,
        signal,
      );
      const read = await this.dependencies.requests.readAttachedExternalContext(
        { workspaceId: payload.workspaceId, sessionId: payload.sessionId, attachmentId: payload.attachmentId },
        signal,
      );
      bytes = read.bytes;
      if (read.provenance.normalizedArtifactSha256 !== payload.normalizedArtifactSha256) {
        throw new ExternalSourceKnowledgeEffectServiceError("conflict");
      }
    } catch (error) {
      throw normalizeEffectFailure(error, signal, "conflict");
    }
    if (canonicalJsonString(material.payload) !== canonicalJsonString(payload)) {
      throw new ExternalSourceKnowledgeEffectServiceError("conflict");
    }
    throwIfAborted(signal);

    const text = decodeStrictUtf8(bytes);
    const identities = deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(payload);
    const nowIso = new Date(this.clock.nowMs()).toISOString();
    const chunkContents = chunkExternalSourceKnowledgeText(text);
    const chunks = chunkContents.map((content, seq) => ({
      chunkId: `external-knowledge-chunk-${digest({ docId: identities.knowledgeDocumentId, seq, chunkSha256: digest(content) }).slice(0, 48)}`,
      seq,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
    }));
    const includeThreadAttachment = input.includeThreadAttachment === true;
    const binding = buildExternalSourceKnowledgeDocumentBinding({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: payload.workspaceId,
      sourceId: payload.sourceId,
      importId: payload.importId,
      itemId: payload.itemId,
      normalizedArtifactSha256: payload.normalizedArtifactSha256,
      approvalId: approval.approvalId,
    });
    const link = sealExternalSourceKnowledgeLink({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      linkId: identities.linkId,
      workspaceId: payload.workspaceId,
      sourceId: payload.sourceId,
      importId: payload.importId,
      itemId: payload.itemId,
      normalizedArtifactSha256: payload.normalizedArtifactSha256,
      approvalId: approval.approvalId,
      knowledgeDocumentId: identities.knowledgeDocumentId,
      ...(includeThreadAttachment ? { threadKnowledgeAttachmentId: identities.threadKnowledgeAttachmentId } : {}),
      createdAt: nowIso,
    });
    const threadAttachment: ThreadKnowledgeAttachmentRecord | undefined = includeThreadAttachment
      ? {
          attachmentId: identities.threadKnowledgeAttachmentId,
          sessionId: payload.sessionId,
          sourceType: "url",
          sourceRef: binding.sourceRef,
          title: `External source snapshot ${payload.itemId}`,
          retrievalMode: "retrieval",
          ingestStatus: "ready",
          chunkCount: chunks.length,
          namespace: binding.namespace,
          documentId: identities.knowledgeDocumentId,
          lastIngestAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      : undefined;
    // The effect draft is option-independent so an exact replay converges on
    // the identical terminal effect row regardless of the replay's options.
    const effect = {
      effectId: identities.effectId,
      targetId: identities.targetId,
      idempotencyKey: identities.effectIdempotencyKey,
      payload: {
        ...payload,
        linkId: identities.linkId,
        knowledgeDocumentId: identities.knowledgeDocumentId,
      } as Record<string, unknown>,
      result: {
        disposition: "applied",
        linkId: identities.linkId,
        knowledgeDocumentId: identities.knowledgeDocumentId,
        chunkCount: chunks.length,
        normalizedArtifactSha256: payload.normalizedArtifactSha256,
      } as Record<string, unknown>,
    };

    try {
      const materialized = await this.dependencies.runImmediateTransaction(async () => {
        const policyDecision = await this.dependencies.policy.evaluateKnowledgeSnapshotApply({
          workspaceId: payload.workspaceId,
          sourceId: payload.sourceId,
          importId: payload.importId,
          itemId: payload.itemId,
          approvalId: approval.approvalId,
          normalizedArtifactSha256: payload.normalizedArtifactSha256,
        });
        const storedLink = await this.dependencies.links.find(link.workspaceId, link.linkId);
        const effectiveLink = storedLink ?? link;
        const journeyEvents = this.buildApplyJourneyEvents(effectiveLink, chunks.length, payload, actor);
        return await this.dependencies.links.materializeApprovedSnapshotWithJourneyResolved({
          link,
          documentTitle: `External source snapshot ${payload.itemId}`,
          chunks,
          threadAttachment,
          effect,
          approvalExpiryCutoffIso: nowIso,
          createdAt: nowIso,
          policyDecision,
          journeyEvents,
        });
      });
      return {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        disposition: materialized.disposition,
        link: materialized.link,
        knowledgeDocumentId: materialized.link.knowledgeDocumentId,
        chunkCount: materialized.chunkCount,
        ...(materialized.link.threadKnowledgeAttachmentId
          ? { threadKnowledgeAttachmentId: materialized.link.threadKnowledgeAttachmentId }
          : {}),
      };
    } catch (error) {
      throw normalizeEffectFailure(error, signal, "conflict");
    }
  }

  private buildApplyJourneyEvents(
    storedLink: ExternalSourceKnowledgeLinkRecord,
    chunkCount: number,
    payload: ExternalSourceKnowledgeSnapshotApprovalPayload,
    actor: ExternalSourceRequestActor,
  ): GovernanceJourneyEventRecord[] {
    const materialized = {
      linkId: storedLink.linkId,
      knowledgeDocumentId: storedLink.knowledgeDocumentId,
      chunkCount,
      ...(storedLink.threadKnowledgeAttachmentId
        ? { threadKnowledgeAttachmentId: storedLink.threadKnowledgeAttachmentId }
        : {}),
    };
    const events = [
      buildExternalSourceKnowledgeSnapshotJourneyEvent({
        action: "snapshot_created",
        payload,
        approvalId: storedLink.approvalId,
        actorId: actor.actorId,
        occurredAt: storedLink.createdAt,
        materialized,
      }),
    ];
    if (storedLink.threadKnowledgeAttachmentId) {
      events.push(
        buildExternalSourceKnowledgeSnapshotJourneyEvent({
          action: "attached",
          payload,
          approvalId: storedLink.approvalId,
          actorId: actor.actorId,
          occurredAt: storedLink.createdAt,
          materialized,
        }),
      );
    }
    return events;
  }

  private async commitRequestJourney(
    payload: ExternalSourceKnowledgeSnapshotApprovalPayload,
    approvalId: string,
    actor: ExternalSourceRequestActor,
    occurredAt: string,
  ): Promise<void> {
    await this.dependencies.journeys.create(
      buildExternalSourceKnowledgeSnapshotJourneyEvent({
        action: "approval_requested",
        payload,
        approvalId,
        actorId: actor.actorId,
        occurredAt,
      }),
    );
  }

  private async requireWorkspaceApproval(workspaceId: string, approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.findApproval(approvalId);
    if (
      !approval ||
      approval.kind !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND ||
      approval.linkage?.workspaceId !== workspaceId
    ) {
      throw new ExternalSourceKnowledgeEffectServiceError("not_found");
    }
    return approval;
  }

  private async findApproval(approvalId: string): Promise<ApprovalRequest | undefined> {
    try {
      return await this.dependencies.approvals.get(approvalId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}

function readApprovalPayload(approval: ApprovalRequest): ExternalSourceKnowledgeSnapshotApprovalPayload {
  const payload = approval.payload as unknown as ExternalSourceKnowledgeSnapshotApprovalPayload;
  try {
    assertExternalSourceKnowledgeSnapshotApprovalPayload(payload);
  } catch {
    throw new ExternalSourceKnowledgeEffectServiceError("approval_conflict");
  }
  return payload;
}

function decodeStrictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExternalSourceKnowledgeEffectServiceError("artifact_failure");
  }
}

function normalizeEffectFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: ExternalSourceKnowledgeEffectServiceErrorCode,
): ExternalSourceKnowledgeEffectServiceError {
  if (error instanceof ExternalSourceKnowledgeEffectServiceError) return error;
  if (error instanceof ExternalSourceAttachmentServiceError) {
    return new ExternalSourceKnowledgeEffectServiceError(error.code);
  }
  const materialization = readMaterializationFailure(error);
  if (materialization) {
    switch (materialization.reason) {
      case "approval_expired":
        return new ExternalSourceKnowledgeEffectServiceError("approval_expired");
      case "approval_not_executable":
        return new ExternalSourceKnowledgeEffectServiceError("approval_not_approved");
      case "policy_denied":
        return new ExternalSourceKnowledgeEffectServiceError("policy_denied", materialization.reasonCode);
      default:
        return new ExternalSourceKnowledgeEffectServiceError("conflict");
    }
  }
  if (signal?.aborted) return new ExternalSourceKnowledgeEffectServiceError("cancelled");
  if (hasCode(error, "STATE_CONFLICT") || hasCode(error, "WRITE_CONFLICT")) {
    return new ExternalSourceKnowledgeEffectServiceError(
      fallback === "approval_conflict" ? "approval_conflict" : "conflict",
    );
  }
  if (error instanceof NotFoundError) return new ExternalSourceKnowledgeEffectServiceError("not_found");
  return new ExternalSourceKnowledgeEffectServiceError(fallback);
}

/**
 * Structural detection of the storage materialization failure. The storage
 * package deliberately keeps its index surface frozen for this tranche, so
 * the class itself is not importable here; name plus typed reason fields are
 * the stable contract.
 */
function readMaterializationFailure(error: unknown): { reason: string; reasonCode?: string } | undefined {
  if (
    error instanceof Error &&
    error.name === "ExternalSourceKnowledgeSnapshotMaterializationError" &&
    "reason" in error &&
    typeof (error as { reason?: unknown }).reason === "string"
  ) {
    const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
    return {
      reason: (error as { reason: string }).reason,
      ...(typeof reasonCode === "string" ? { reasonCode } : {}),
    };
  }
  return undefined;
}

function assertSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean") {
    throw new TypeError("External source knowledge-snapshot operations require a signal.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceKnowledgeEffectServiceError("cancelled");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}
