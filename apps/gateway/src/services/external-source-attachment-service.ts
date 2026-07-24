import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  assertExternalSourceKnowledgeSnapshotApprovalPayload,
  canonicalJsonString,
  normalizeExternalSessionAttachInput,
  normalizeExternalSessionAttachmentListInput,
  normalizeExternalSessionDetachInput,
  normalizeExternalSourceKnowledgeSnapshotRequestInput,
  type ChatRoutedContextExternalProvenance,
  type ExternalSessionAttachmentListResponse,
  type ExternalSessionAttachmentRecord,
  type ExternalSessionAttachmentResponse,
  type ExternalSessionDetachResponse,
  type ExternalSourceImportItem,
  type ExternalSourceKnowledgeSnapshotRequestMaterial,
  type ExternalSourceRecord,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import {
  verifyExternalSourceImportSettlement,
  type ExternalSessionAttachmentRepository,
  type ExternalSourceImportRepository,
} from "@goatcitadel/storage";
import {
  ExternalSourceArtifactStoreError,
  type ExternalSourceArtifactStore,
} from "./external-source-artifact-store.js";
import { buildExternalSourceAttachmentJourneyEvent } from "./external-source-journey-producer.js";
import type { ExternalSourceRequestActor } from "./external-source-service.js";

export type ExternalSourceAttachmentServiceErrorCode =
  | "artifact_failure"
  | "cancelled"
  | "conflict"
  | "identity_drift"
  | "not_found"
  | "session_incarnation_stale"
  | "source_not_active";

const ERROR_MESSAGES: Readonly<Record<ExternalSourceAttachmentServiceErrorCode, string>> = Object.freeze({
  artifact_failure: "External source managed artifact verification failed.",
  cancelled: "External source attachment operation was cancelled.",
  conflict: "External source attachment conflicts with immutable evidence.",
  identity_drift: "External source identity drifted; live attachment use is invalidated.",
  not_found: "External source attachment resource was not found.",
  session_incarnation_stale: "External source attachment session incarnation is stale.",
  source_not_active: "External source is not active.",
});

export class ExternalSourceAttachmentServiceError extends Error {
  public constructor(public readonly code: ExternalSourceAttachmentServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceAttachmentServiceError";
  }
}

interface ExternalSourceAttachmentSessionMeta {
  sessionId: string;
  workspaceId: string;
  lifecycleStatus: "active" | "archived";
  lifecycleIntentId?: string;
}

interface ExternalSourceAttachmentServiceClock {
  nowMs(): number;
}

export interface ExternalSourceAttachmentServiceDependencies {
  configs: { find(workspaceId: string, sourceId: string): ExternalSourceRecord | undefined };
  scans: { find(workspaceId: string, scanId: string): ExternalSourceScanRecord | undefined };
  imports: Pick<ExternalSourceImportRepository, "getIntent" | "getItem" | "getSettlement" | "listItems">;
  attachments: Pick<
    ExternalSessionAttachmentRepository,
    "attachWithJourney" | "detachCasWithJourney" | "find" | "findBySessionBinding" | "listBySession"
  >;
  sessions: { get(sessionId: string): ExternalSourceAttachmentSessionMeta | undefined };
  artifacts: Pick<ExternalSourceArtifactStore, "read">;
  clock?: ExternalSourceAttachmentServiceClock;
}

export interface ExternalSessionAttachmentReadResult {
  attachment: ExternalSessionAttachmentRecord;
  /** Exact managed normalized-artifact bytes, rehash-verified on this read. */
  bytes: Buffer;
  provenance: ChatRoutedContextExternalProvenance;
}

const DEFAULT_CLOCK: ExternalSourceAttachmentServiceClock = { nowMs: () => Date.now() };

/** Deterministic server-owned attachment identity for one session/import/item binding. */
export function deriveExternalSessionAttachmentId(input: {
  workspaceId: string;
  sessionId: string;
  importId: string;
  itemId: string;
}): string {
  return `external-attachment-${digest({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    importId: input.importId,
    itemId: input.itemId,
  }).slice(0, 48)}`;
}

/**
 * C1 owner of governed read-only external-source attachment truth: attach,
 * list, detach, the deterministic knowledge-snapshot request material, and the
 * exact-byte read the HX-307 routed-context freeze consumes. Every mutating
 * operation rechecks the applied import, the managed CAS artifact, workspace
 * and session-incarnation binding, the attachment revision, the exact
 * source/import/item/artifact identity chain, and the addendum's
 * liveness/drift state; drifted or tombstoned sources fail closed while the
 * immutable imported evidence stays untouched. Nothing here promotes content
 * into knowledge, memory, a skill, or a callable capability. The service is
 * production-dark: it is constructed by tests only until the composition
 * tranche wires it behind the HX-407 proof gate.
 */
export class ExternalSourceAttachmentService {
  private readonly clock: ExternalSourceAttachmentServiceClock;

  public constructor(private readonly dependencies: ExternalSourceAttachmentServiceDependencies) {
    if (
      !dependencies.configs ||
      !dependencies.scans ||
      !dependencies.imports ||
      !dependencies.attachments ||
      !dependencies.sessions ||
      !dependencies.artifacts
    ) {
      throw new TypeError("External source attachment service dependencies are required.");
    }
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
  }

  public async attach(
    rawInput: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSessionAttachmentResponse> {
    assertSignal(signal);
    assertActor(actor);
    const input = normalizeExternalSessionAttachInput(rawInput);
    const session = this.requireActiveSessionIncarnation(
      input.workspaceId,
      input.sessionId,
      input.expectedSessionIncarnationId,
    );
    const source = this.requireOwnedSource(input.workspaceId, input.sourceId, actor, { requireActive: true });
    const { intent, item } = this.requireAppliedImportItem(
      input.workspaceId,
      input.sourceId,
      input.importId,
      input.itemId,
    );
    this.assertNoIdentityDrift(source, intent.scanId);
    await this.verifyManagedArtifact(item, signal);
    throwIfAborted(signal);
    const record: ExternalSessionAttachmentRecord = {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      attachmentId: deriveExternalSessionAttachmentId(input),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      importId: input.importId,
      itemId: input.itemId,
      normalizedArtifactSha256: item.normalizedArtifactSha256,
      mode: "read_only_external",
      status: "attached",
      revision: 1,
      attachedByActorId: actor.actorId,
      attachedAt: new Date(this.clock.nowMs()).toISOString(),
    };
    try {
      const committed = this.dependencies.attachments.attachWithJourney(record, (attachment) =>
        buildExternalSourceAttachmentJourneyEvent({
          attachment,
          sessionIncarnationId: session.sessionIncarnationId,
        }),
      );
      return {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        attachment: committed.attachment,
        disposition: committed.disposition,
      };
    } catch (error) {
      throw normalizeAttachmentFailure(error, signal, "conflict");
    }
  }

  public list(rawInput: unknown, actor: ExternalSourceRequestActor): ExternalSessionAttachmentListResponse {
    assertActor(actor);
    const input = normalizeExternalSessionAttachmentListInput(rawInput);
    const meta = this.requireSessionInWorkspace(input.workspaceId, input.sessionId);
    try {
      return {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        // The durable reload surface is where clients learn the exact
        // incarnation the mutation contracts demand (C4 composition).
        sessionIncarnationId: meta.lifecycleIntentId ?? `legacy-session-incarnation:${input.sessionId}`,
        items: this.dependencies.attachments.listBySession(input.workspaceId, input.sessionId, input.limit ?? 100),
      };
    } catch (error) {
      throw normalizeAttachmentFailure(error, undefined, "not_found");
    }
  }

  /**
   * Detach is the exposure-reducing lifecycle exit: it rechecks the full
   * identity chain, revision CAS, and session incarnation, but deliberately
   * remains available for tombstoned or drifted sources so stale attachments
   * can always be withdrawn. Imported evidence stays immutable either way.
   */
  public async detach(
    rawInput: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSessionDetachResponse> {
    assertSignal(signal);
    assertActor(actor);
    const input = normalizeExternalSessionDetachInput(rawInput);
    const session = this.requireActiveSessionIncarnation(
      input.workspaceId,
      input.sessionId,
      input.expectedSessionIncarnationId,
    );
    const current = this.requireSessionAttachment(input.workspaceId, input.sessionId, input.attachmentId);
    this.requireOwnedSource(input.workspaceId, current.sourceId, actor, { requireActive: false });
    const { item } = this.requireAppliedImportItem(
      input.workspaceId,
      current.sourceId,
      current.importId,
      current.itemId,
    );
    if (item.normalizedArtifactSha256 !== current.normalizedArtifactSha256) {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    await this.verifyManagedArtifact(item, signal);
    throwIfAborted(signal);
    const detachTarget: ExternalSessionAttachmentRecord =
      current.status === "detached"
        ? current
        : {
            ...current,
            status: "detached",
            revision: input.expectedRevision + 1,
            detachedByActorId: actor.actorId,
            detachedAt: new Date(this.clock.nowMs()).toISOString(),
          };
    if (current.status === "attached" && current.revision !== input.expectedRevision) {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    try {
      const committed = this.dependencies.attachments.detachCasWithJourney(
        detachTarget,
        input.expectedRevision,
        (attachment) =>
          buildExternalSourceAttachmentJourneyEvent({
            attachment,
            sessionIncarnationId: session.sessionIncarnationId,
          }),
      );
      return {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        attachment: committed.attachment,
        disposition: committed.disposition,
      };
    } catch (error) {
      throw normalizeAttachmentFailure(error, signal, "conflict");
    }
  }

  /**
   * Reads the exact managed normalized bytes for one live attachment so the
   * HX-307 routed-context snapshot can freeze them before any provider use.
   * A detached attachment, a tombstoned source, or a drifted identity chain
   * fails closed; route-level authentication and the attach-time ownership
   * gate authorize the session-scoped read itself.
   */
  public async readAttachedExternalContext(
    input: { workspaceId: string; sessionId: string; attachmentId: string },
    signal: AbortSignal,
  ): Promise<ExternalSessionAttachmentReadResult> {
    assertSignal(signal);
    this.requireSessionInWorkspace(input.workspaceId, input.sessionId);
    const current = this.requireSessionAttachment(input.workspaceId, input.sessionId, input.attachmentId);
    if (current.status !== "attached") {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    const source = this.requireLiveSource(input.workspaceId, current.sourceId);
    const { intent, item } = this.requireAppliedImportItem(
      input.workspaceId,
      current.sourceId,
      current.importId,
      current.itemId,
    );
    this.assertNoIdentityDrift(source, intent.scanId);
    if (item.normalizedArtifactSha256 !== current.normalizedArtifactSha256) {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    const artifact = await this.verifyManagedArtifact(item, signal);
    return {
      attachment: current,
      bytes: Buffer.from(artifact.bytes),
      provenance: {
        sourceId: current.sourceId,
        importId: current.importId,
        itemId: current.itemId,
        attachmentId: current.attachmentId,
        attachmentRevision: current.revision,
        normalizedArtifactSha256: current.normalizedArtifactSha256,
      },
    };
  }

  /**
   * Builds the deterministic knowledge-snapshot approval-request material.
   * Every hash is server-derived from the immutable import item; nothing is
   * persisted here — approval creation and the recovered effect are the
   * dedicated later tranche. No knowledge, memory, skill, or capability row
   * is touched.
   */
  public async buildKnowledgeSnapshotRequest(
    rawInput: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotRequestMaterial> {
    assertSignal(signal);
    assertActor(actor);
    const input = normalizeExternalSourceKnowledgeSnapshotRequestInput(rawInput);
    const session = this.requireActiveSessionIncarnation(
      input.workspaceId,
      input.sessionId,
      input.expectedSessionIncarnationId,
    );
    const current = this.requireSessionAttachment(input.workspaceId, input.sessionId, input.attachmentId);
    if (
      current.status !== "attached" ||
      current.revision !== input.expectedAttachmentRevision ||
      current.importId !== input.importId ||
      current.itemId !== input.itemId
    ) {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    const source = this.requireOwnedSource(input.workspaceId, current.sourceId, actor, { requireActive: true });
    const { intent, item } = this.requireAppliedImportItem(
      input.workspaceId,
      current.sourceId,
      input.importId,
      input.itemId,
    );
    this.assertNoIdentityDrift(source, intent.scanId);
    if (item.normalizedArtifactSha256 !== current.normalizedArtifactSha256) {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    await this.verifyManagedArtifact(item, signal);
    const payload = {
      workspaceId: input.workspaceId,
      sourceId: current.sourceId,
      importId: current.importId,
      itemId: current.itemId,
      normalizedArtifactSha256: item.normalizedArtifactSha256,
      rawSha256: item.rawSha256,
      sessionId: current.sessionId,
      sessionIncarnationId: session.sessionIncarnationId,
      attachmentId: current.attachmentId,
      attachmentRevision: current.revision,
    };
    assertExternalSourceKnowledgeSnapshotApprovalPayload(payload);
    return {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      approvalKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
      effectKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
      effectTargetKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
      payload,
      preview: {
        sourceId: current.sourceId,
        importId: current.importId,
        itemId: current.itemId,
        attachmentId: current.attachmentId,
        normalizedArtifactSha256: item.normalizedArtifactSha256,
        normalizedByteCount: item.normalizedByteCount,
      },
    };
  }

  private requireActiveSessionIncarnation(
    workspaceId: string,
    sessionId: string,
    expectedSessionIncarnationId: string,
  ): { sessionIncarnationId: string } {
    const meta = this.requireSessionInWorkspace(workspaceId, sessionId);
    const sessionIncarnationId = meta.lifecycleIntentId ?? `legacy-session-incarnation:${sessionId}`;
    if (expectedSessionIncarnationId !== sessionIncarnationId) {
      throw new ExternalSourceAttachmentServiceError("session_incarnation_stale");
    }
    return { sessionIncarnationId };
  }

  private requireSessionInWorkspace(workspaceId: string, sessionId: string): ExternalSourceAttachmentSessionMeta {
    const meta = this.dependencies.sessions.get(sessionId);
    if (!meta || meta.workspaceId !== workspaceId) {
      throw new ExternalSourceAttachmentServiceError("not_found");
    }
    if (meta.lifecycleStatus !== "active") {
      throw new ExternalSourceAttachmentServiceError("conflict");
    }
    return meta;
  }

  private requireSessionAttachment(
    workspaceId: string,
    sessionId: string,
    attachmentId: string,
  ): ExternalSessionAttachmentRecord {
    let current: ExternalSessionAttachmentRecord | undefined;
    try {
      current = this.dependencies.attachments.find(workspaceId, attachmentId);
    } catch (error) {
      throw normalizeAttachmentFailure(error, undefined, "not_found");
    }
    if (!current || current.sessionId !== sessionId) {
      throw new ExternalSourceAttachmentServiceError("not_found");
    }
    return current;
  }

  private requireOwnedSource(
    workspaceId: string,
    sourceId: string,
    actor: ExternalSourceRequestActor,
    options: { requireActive: boolean },
  ): ExternalSourceRecord {
    const source = this.dependencies.configs.find(workspaceId, sourceId);
    if (
      !source ||
      source.ownerActorId !== actor.actorId ||
      source.authActorId !== actor.actorId ||
      source.authActorSource !== actor.source
    ) {
      throw new ExternalSourceAttachmentServiceError("not_found");
    }
    if (options.requireActive && source.status !== "active") {
      throw new ExternalSourceAttachmentServiceError("source_not_active");
    }
    return source;
  }

  private requireLiveSource(workspaceId: string, sourceId: string): ExternalSourceRecord {
    const source = this.dependencies.configs.find(workspaceId, sourceId);
    if (!source) throw new ExternalSourceAttachmentServiceError("not_found");
    if (source.status !== "active") {
      throw new ExternalSourceAttachmentServiceError("source_not_active");
    }
    return source;
  }

  private requireAppliedImportItem(workspaceId: string, sourceId: string, importId: string, itemId: string) {
    try {
      const intent = this.dependencies.imports.getIntent(workspaceId, importId);
      if (intent.sourceId !== sourceId) {
        throw new ExternalSourceAttachmentServiceError("conflict");
      }
      const item = this.dependencies.imports.getItem(workspaceId, importId, itemId);
      const settlement = this.dependencies.imports.getSettlement(workspaceId, importId);
      const items = this.dependencies.imports.listItems(workspaceId, importId);
      verifyExternalSourceImportSettlement(settlement, items);
      if (settlement.disposition !== "applied") {
        throw new ExternalSourceAttachmentServiceError("conflict");
      }
      return { intent, item };
    } catch (error) {
      throw normalizeAttachmentFailure(error, undefined, "conflict");
    }
  }

  /**
   * The addendum's identity-drift rule: a reviewed generation whose immutable
   * identity chain no longer matches the import's sealed scan binding
   * invalidates live attachment use without deleting immutable imports.
   */
  private assertNoIdentityDrift(source: ExternalSourceRecord, scanId: string): void {
    const scan = this.dependencies.scans.find(source.workspaceId, scanId);
    if (
      !scan ||
      scan.sourceId !== source.sourceId ||
      scan.rootIdentitySha256 !== source.rootIdentitySha256 ||
      scan.pathBridgeSnapshotSha256 !== source.pathBridgeSnapshotSha256 ||
      scan.adapterId !== source.adapterId ||
      scan.adapterVersion !== source.adapterVersion
    ) {
      throw new ExternalSourceAttachmentServiceError("identity_drift");
    }
  }

  private async verifyManagedArtifact(item: ExternalSourceImportItem, signal: AbortSignal) {
    let artifact;
    try {
      artifact = await this.dependencies.artifacts.read({
        artifactRelPath: item.artifactRelativeKey,
        expectedSha256: item.normalizedArtifactSha256,
        signal,
      });
    } catch (error) {
      throw normalizeAttachmentFailure(error, signal, "artifact_failure");
    }
    if (artifact.byteCount !== item.normalizedByteCount || artifact.artifactSha256 !== item.normalizedArtifactSha256) {
      throw new ExternalSourceAttachmentServiceError("artifact_failure");
    }
    return artifact;
  }
}

function normalizeAttachmentFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: ExternalSourceAttachmentServiceErrorCode,
): ExternalSourceAttachmentServiceError {
  if (error instanceof ExternalSourceAttachmentServiceError) return error;
  if (signal?.aborted) return new ExternalSourceAttachmentServiceError("cancelled");
  if (error instanceof ExternalSourceArtifactStoreError) {
    return new ExternalSourceAttachmentServiceError(error.code === "cancelled" ? "cancelled" : "artifact_failure");
  }
  if (hasCode(error, "STATE_CONFLICT") || hasCode(error, "WRITE_CONFLICT")) {
    return new ExternalSourceAttachmentServiceError("conflict");
  }
  if (hasCode(error, "NOT_FOUND")) return new ExternalSourceAttachmentServiceError("not_found");
  return new ExternalSourceAttachmentServiceError(fallback);
}

function assertActor(actor: ExternalSourceRequestActor): void {
  if (
    !actor ||
    !["token", "basic", "loopback"].includes(actor.source) ||
    typeof actor.actorId !== "string" ||
    actor.actorId.length < 1 ||
    actor.actorId.length > 256 ||
    actor.actorId !== actor.actorId.normalize("NFKC").trim() ||
    hasControlCharacter(actor.actorId)
  ) {
    throw new ExternalSourceAttachmentServiceError("not_found");
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean") {
    throw new TypeError("External source attachment operations require a signal.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceAttachmentServiceError("cancelled");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}
