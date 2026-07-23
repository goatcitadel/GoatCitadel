/**
 * HX-408 M2: the governed mesh capability activation owner.
 *
 * One operator request for ONE exact manifest entry produces a REAL
 * deterministic detached approval (HX-407 C2 convention: payload-hash UUID
 * identity, `createDeterministicDetachedWithTtlDuration`, bounded database
 * expiry, request Journey evidence in the approval transaction, effect
 * execution on approve). The approved resolution executes exclusively through
 * the committed storage owner's `activate()` under its concurrency-safe
 * invariants — the SQLite/Postgres activation guard re-verifies the exact
 * entry binding, the real approved approval payload, online health, the live
 * database-clock lease, the current publisher generation, and the revision
 * CAS inside the insert transaction. This service surfaces those invariants;
 * it never re-implements them.
 *
 * Skill descriptors are never activatable here: staging an inactive skill
 * candidate requires the exact content bytes, which live on the remote node
 * and only arrive with the M3 dispatch runtime — so skill activation fails
 * closed with `mesh_capability_skill_staging_deferred`.
 */
import { createHash } from "node:crypto";
import {
  GOVERNANCE_JOURNEY_EVENT_VERSION,
  MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
  NotFoundError,
  assertMeshCapabilityActivationApprovalPayload,
  canonicalJsonString,
  type ApprovalRequest,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type GovernanceJourneyEventRecord,
  type MeshCapabilityActivationApprovalPayload,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityActivationRevocationRecord,
  type MeshCapabilityEffectDiff,
  type MeshCapabilityManifestEntry,
  type MeshCapabilityPermissionDiff,
} from "@goatcitadel/contracts";
import {
  buildMeshCapabilityActivationDiffs,
  computeMeshCapabilityActivationRequestSha256,
  type ActivateMeshCapabilityInput,
  type Storage,
} from "@goatcitadel/storage";
import {
  createMeshCapabilityActivationApproval,
  deriveMeshCapabilityActivationApprovalId,
  type CreateMeshCapabilityActivationApprovalInput,
} from "./mesh-capability-activation-approval-service.js";
import type { MeshCapabilityPublicationService } from "./mesh-capability-publication-service.js";

const MESH_CAPABILITY_ACTIVATION_ID_SCHEMA_VERSION = "goatcitadel.mesh-capability-activation-id.v1" as const;
const ACTIVATABLE_PROJECTION_STATUSES = new Set(["review_required", "active"]);

export type MeshCapabilityActivationServiceErrorCode =
  | "mesh_capability_manifest_not_found"
  | "mesh_capability_entry_binding_mismatch"
  | "mesh_capability_skill_staging_deferred"
  | "mesh_capability_publisher_not_activatable"
  | "mesh_capability_activation_state_drift"
  | "mesh_capability_approval_not_executable"
  | "mesh_capability_approval_expired"
  | "mesh_capability_request_evidence_missing"
  | "mesh_capability_activation_conflict"
  | "mesh_capability_activation_not_found";

const ERROR_STATUS: Readonly<Record<MeshCapabilityActivationServiceErrorCode, number>> = Object.freeze({
  mesh_capability_manifest_not_found: 404,
  mesh_capability_entry_binding_mismatch: 409,
  mesh_capability_skill_staging_deferred: 409,
  mesh_capability_publisher_not_activatable: 409,
  mesh_capability_activation_state_drift: 409,
  mesh_capability_approval_not_executable: 409,
  mesh_capability_approval_expired: 409,
  mesh_capability_request_evidence_missing: 409,
  mesh_capability_activation_conflict: 409,
  mesh_capability_activation_not_found: 404,
});

/** Content-free typed failure; the reason code is the entire disclosure. */
export class MeshCapabilityActivationServiceError extends Error {
  public readonly statusCode: number;

  public constructor(public readonly code: MeshCapabilityActivationServiceErrorCode) {
    super(`Mesh capability activation request failed: ${code}.`);
    this.name = "MeshCapabilityActivationServiceError";
    this.statusCode = ERROR_STATUS[code];
  }
}

export interface MeshCapabilityActivationRequestInput {
  workspaceId: string;
  capabilityId: string;
  manifestSha256: string;
  entrySha256: string;
  actorId: string;
  sessionId?: string;
  turnId?: string;
}

export interface MeshCapabilityActivationRequestResult {
  approval: ApprovalRequest;
  replayed: boolean;
  activationId: string;
  activationRevision: number;
  permissionDiff: MeshCapabilityPermissionDiff;
  effectDiff: MeshCapabilityEffectDiff;
}

export interface MeshCapabilityActivationApplyResult {
  activation: MeshCapabilityActivationRecord;
  replayed: boolean;
}

export interface MeshCapabilityActivationRevokeInput {
  workspaceId: string;
  activationId: string;
  reason: string;
  actorId: string;
}

export interface MeshCapabilityActivationRevokeResult {
  revocation: MeshCapabilityActivationRevocationRecord;
  replayed: boolean;
}

export interface MeshCapabilityActivationServiceOptions {
  storage: Storage;
  publication: Pick<MeshCapabilityPublicationService, "listPublicationInspection">;
  now?: () => Date;
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

export class MeshCapabilityActivationService {
  private readonly storage: Storage;
  private readonly publication: Pick<MeshCapabilityPublicationService, "listPublicationInspection">;
  private readonly now: () => Date;
  private readonly publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;

  public constructor(options: MeshCapabilityActivationServiceOptions) {
    this.storage = options.storage;
    this.publication = options.publication;
    this.now = options.now ?? (() => new Date());
    this.publishRealtime = options.publishRealtime;
  }

  /**
   * Operator request for ONE exact entry. The approval payload binds the
   * derived capability ID, immutable manifest/entry/descriptor/permission
   * digests, and declared effect posture directly, and — through its
   * `requestSha256` — the admitted node, admission generation (via the
   * publisher row), current publisher generation, health generation, live
   * lease fencing token, the exact permission/effect diff the operator
   * approves, and the requesting actor. Publisher health must be activatable
   * at request time; the storage guard re-checks everything again inside the
   * approved activation transaction.
   */
  public requestActivation(input: MeshCapabilityActivationRequestInput): MeshCapabilityActivationRequestResult {
    const { entry, manifest } = this.resolveExactEntry(input);
    if (entry.kind === "skill") {
      // Staging an inactive candidate needs the exact content bytes, which
      // remain on the remote node until the M3 dispatch runtime exists.
      throw new MeshCapabilityActivationServiceError("mesh_capability_skill_staging_deferred");
    }
    this.assertEntryActivatable(input.workspaceId, manifest.manifestSha256, entry.entrySha256);
    const liveBinding = this.resolveLivePublisherBinding(input.workspaceId, manifest.nodeId, {
      publisherGeneration: manifest.publisherGeneration,
    });
    const prior = this.resolvePriorActivation(input.workspaceId, entry.capabilityId);
    const diffs = buildMeshCapabilityActivationDiffs({
      currentEntry: entry,
      ...(prior === undefined ? {} : { prior }),
    });
    const activationRevision = (prior?.activation.activationRevision ?? 0) + 1;
    const activationId = deriveMeshCapabilityActivationId({
      workspaceId: input.workspaceId,
      capabilityId: entry.capabilityId,
      activationRevision,
      nodeId: manifest.nodeId,
      publisherGeneration: manifest.publisherGeneration,
      healthGeneration: liveBinding.healthGeneration,
      publicationLeaseFencingToken: liveBinding.publicationLeaseFencingToken,
      manifestSha256: manifest.manifestSha256,
      entrySha256: entry.entrySha256,
      actorId: input.actorId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
    const activationInput: CreateMeshCapabilityActivationApprovalInput = {
      workspaceId: input.workspaceId,
      activationId,
      activationRevision,
      capabilityId: entry.capabilityId,
      nodeId: manifest.nodeId,
      publisherGeneration: manifest.publisherGeneration,
      healthGeneration: liveBinding.healthGeneration,
      publicationLeaseFencingToken: liveBinding.publicationLeaseFencingToken,
      manifestSha256: manifest.manifestSha256,
      entrySha256: entry.entrySha256,
      descriptorSha256: entry.descriptorSha256,
      permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
      effectPosture: entry.descriptor.effectPosture,
      permissionDiff: diffs.permissionDiff,
      effectDiff: diffs.effectDiff,
      actorId: input.actorId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      idempotencyKey: activationIdempotencyKey(activationId),
    };
    let committed!: ReturnType<typeof createMeshCapabilityActivationApproval>;
    this.storage.runImmediateTransaction(() => {
      committed = createMeshCapabilityActivationApproval({ storage: this.storage }, activationInput);
      // Request Journey evidence commits atomically with the approval row and
      // is the durable requester-identity record the approved apply recovers.
      this.storage.governanceJourneyEvents.create(
        buildActivationRequestJourneyEvent({
          approval: committed.approval,
          activationInput: committed.activationInput,
          actorId: input.actorId,
        }),
      );
    });
    if (!committed.replayed) {
      this.publishRealtime?.("mesh_capability_activation_requested", "mesh", {
        workspaceId: input.workspaceId,
        capabilityId: entry.capabilityId,
        activationId,
        activationRevision,
        approvalId: committed.approval.approvalId,
      });
    }
    return {
      approval: committed.approval,
      replayed: committed.replayed,
      activationId,
      activationRevision,
      permissionDiff: diffs.permissionDiff,
      effectDiff: diffs.effectDiff,
    };
  }

  /**
   * Executes one approved activation. The activation input is rebuilt from
   * live durable state plus the immutable approval payload, the requester is
   * recovered from the request Journey evidence, and the rebuilt bytes must
   * reproduce the approved `requestSha256` exactly — any drift between
   * request and approve (permission drift via manifest supersession, health
   * or lease change, competing activation, actor mismatch) fails closed with
   * zero writes. The storage `activate()` guard then re-verifies the exact
   * binding, approval, health, lease, and caps inside its own transaction.
   */
  public executeApprovedActivation(input: {
    workspaceId: string;
    approvalId: string;
  }): MeshCapabilityActivationApplyResult {
    const approval = this.requireExecutableApproval(input.workspaceId, input.approvalId);
    const payload = approval.payload as unknown as MeshCapabilityActivationApprovalPayload;
    // Exact replay converges on the already-applied immutable row before any
    // live-state rebuild: post-apply publisher churn must never fail a retry
    // of an activation that already exists.
    const existing = this.findActivation(input.workspaceId, payload.activationId);
    if (existing) {
      if (existing.requestSha256 !== payload.requestSha256 || existing.approvalId !== approval.approvalId) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_conflict");
      }
      return { activation: existing, replayed: true };
    }
    const actorId = this.recoverRequestActorId(approval.approvalId);
    const rebuilt = this.rebuildActivationInput(payload, approval, actorId);
    if (computeMeshCapabilityActivationRequestSha256(rebuilt) !== payload.requestSha256) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
    }
    let activation: MeshCapabilityActivationRecord;
    try {
      activation = this.storage.meshCapabilityPublications.activate(rebuilt);
    } catch (error) {
      if (error instanceof MeshCapabilityActivationServiceError) throw error;
      throw new MeshCapabilityActivationServiceError("mesh_capability_activation_conflict");
    }
    this.publishRealtime?.("mesh_capability_activation_applied", "mesh", {
      workspaceId: activation.workspaceId,
      capabilityId: activation.capabilityId,
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      approvalId: activation.approvalId,
    });
    return { activation, replayed: false };
  }

  /** Operator revoke: terminal, replay-converging, removes callability immediately. */
  public revokeActivation(input: MeshCapabilityActivationRevokeInput): MeshCapabilityActivationRevokeResult {
    let activation: MeshCapabilityActivationRecord;
    try {
      activation = this.storage.meshCapabilityPublications.getActivation(input.workspaceId, input.activationId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_not_found");
      }
      throw error;
    }
    const existing = this.storage.meshCapabilityPublications.findActivationRevocation(
      input.workspaceId,
      input.activationId,
    );
    if (existing) {
      return { revocation: existing, replayed: true };
    }
    let revocation: MeshCapabilityActivationRevocationRecord;
    try {
      revocation = this.storage.meshCapabilityPublications.revoke({
        workspaceId: input.workspaceId,
        activationId: input.activationId,
        reason: input.reason,
        actorId: input.actorId,
        idempotencyKey: `mesh-capability-activation-revoke:${input.activationId}`,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_not_found");
      }
      throw new MeshCapabilityActivationServiceError("mesh_capability_activation_conflict");
    }
    this.publishRealtime?.("mesh_capability_activation_revoked", "mesh", {
      workspaceId: input.workspaceId,
      capabilityId: activation.capabilityId,
      activationId: input.activationId,
      activationRevision: activation.activationRevision,
    });
    return { revocation, replayed: false };
  }

  /**
   * Profile-freeze seam: the packet-mandated snapshot for one mesh-published
   * callable, re-verified through the storage-owned full revalidation query at
   * freeze time. Returns undefined — so the profile freeze fails closed —
   * unless the workspace's currently-callable activation binds this exact
   * entry (capability, entry digest, manifest digest, publisher generation).
   */
  public resolveProfileBinding(input: {
    workspaceId: string;
    capabilityId: string;
    entrySha256: string;
    manifestSha256: string;
    publisherGeneration: number;
  }): ChatTurnCapabilityToolMeshPublicationBinding | undefined {
    const activation = this.storage.meshCapabilityPublications
      .listCallableActivations(input.workspaceId)
      .find((candidate) => candidate.capabilityId === input.capabilityId);
    if (
      !activation ||
      activation.entrySha256 !== input.entrySha256 ||
      activation.manifestSha256 !== input.manifestSha256 ||
      activation.publisherGeneration !== input.publisherGeneration
    ) {
      return undefined;
    }
    return Object.freeze({
      nodeId: activation.nodeId,
      publisherGeneration: activation.publisherGeneration,
      manifestSha256: activation.manifestSha256,
      entrySha256: activation.entrySha256,
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
      effectPosture: activation.effectPosture,
      healthGeneration: activation.healthGeneration,
    });
  }

  /**
   * Pre-dispatch drift gate. Re-verifies every frozen snapshot field against
   * the storage-owned revalidation query immediately before dispatch and
   * always returns a content-free block reason in M2:
   * `mesh_capability_binding_drift` when live state diverged from the frozen
   * snapshot (disconnect, offline/suspect, lease expiry, certificate drift,
   * supersession, permission drift, revoke, generation change), otherwise the
   * M3-pending `mesh_capability_dispatch_unready` — no mesh dispatch runtime
   * is composed yet, so a still-valid binding remains fail-closed. M3 slots
   * the real dispatch behind the valid branch of this exact gate.
   */
  public resolvePreDispatchBlock(
    workspaceId: string,
    binding: ChatTurnCapabilityToolMeshPublicationBinding,
  ): "mesh_capability_binding_drift" | "mesh_capability_dispatch_unready" {
    const activation = this.storage.meshCapabilityPublications
      .listCallableActivations(workspaceId)
      .find((candidate) => candidate.activationId === binding.activationId);
    if (
      !activation ||
      activation.nodeId !== binding.nodeId ||
      activation.publisherGeneration !== binding.publisherGeneration ||
      activation.manifestSha256 !== binding.manifestSha256 ||
      activation.entrySha256 !== binding.entrySha256 ||
      activation.activationRevision !== binding.activationRevision ||
      activation.publicationLeaseFencingToken !== binding.publicationLeaseFencingToken ||
      activation.permissionEnvelopeSha256 !== binding.permissionEnvelopeSha256 ||
      activation.effectPosture !== binding.effectPosture ||
      activation.healthGeneration !== binding.healthGeneration
    ) {
      return "mesh_capability_binding_drift";
    }
    return "mesh_capability_dispatch_unready";
  }

  private resolveExactEntry(input: MeshCapabilityActivationRequestInput): {
    entry: MeshCapabilityManifestEntry;
    manifest: { nodeId: string; publisherGeneration: number; manifestSha256: string };
  } {
    const record = this.storage.meshCapabilityPublications
      .listManifestRecords(input.workspaceId)
      .find((candidate) => candidate.manifest.manifestSha256 === input.manifestSha256);
    if (!record) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_manifest_not_found");
    }
    const entry = record.manifest.entries.find((candidate) => candidate.capabilityId === input.capabilityId);
    if (!entry || entry.entrySha256 !== input.entrySha256) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_entry_binding_mismatch");
    }
    return {
      entry,
      manifest: {
        nodeId: record.manifest.nodeId,
        publisherGeneration: record.manifest.publisherGeneration,
        manifestSha256: record.manifest.manifestSha256,
      },
    };
  }

  /**
   * Healthy-publisher gate at request time, surfaced from the M1 server-built
   * projection: the exact entry must currently project as `review_required`
   * or `active`. Superseded, offline, suspect, revoked, or blocked entries
   * fail closed with one coarse reason.
   */
  private assertEntryActivatable(workspaceId: string, manifestSha256: string, entrySha256: string): void {
    const inspection = this.publication.listPublicationInspection(workspaceId);
    const manifestView = inspection.manifests.find((candidate) => candidate.manifestSha256 === manifestSha256);
    const projection = manifestView?.entries.find((candidate) => candidate.entrySha256 === entrySha256);
    if (!projection || !ACTIVATABLE_PROJECTION_STATUSES.has(projection.status)) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_publisher_not_activatable");
    }
  }

  private resolveLivePublisherBinding(
    workspaceId: string,
    nodeId: string,
    expected: { publisherGeneration: number },
  ): { healthGeneration: number; publicationLeaseFencingToken: number } {
    const publications = this.storage.meshCapabilityPublications;
    const publisher = publications.findCurrentPublisher(workspaceId, nodeId);
    if (!publisher || publisher.publisherGeneration !== expected.publisherGeneration) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_publisher_not_activatable");
    }
    let health;
    try {
      health = publications.getPublisherHealth(workspaceId, nodeId, publisher.publisherGeneration);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_publisher_not_activatable");
      }
      throw error;
    }
    if (health.status !== "online" || health.publicationLeaseFencingToken !== publisher.publicationLeaseFencingToken) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_publisher_not_activatable");
    }
    return {
      healthGeneration: health.healthGeneration,
      publicationLeaseFencingToken: health.publicationLeaseFencingToken,
    };
  }

  private resolvePriorActivation(
    workspaceId: string,
    capabilityId: string,
  ): { activation: MeshCapabilityActivationRecord; entry: MeshCapabilityManifestEntry } | undefined {
    const prior = this.storage.meshCapabilityPublications.findLatestActivation(workspaceId, capabilityId);
    if (!prior) return undefined;
    let priorEntry: MeshCapabilityManifestEntry | undefined;
    try {
      priorEntry = this.storage.meshCapabilityPublications
        .getManifest(workspaceId, prior.nodeId, prior.publisherGeneration, prior.manifestSha256)
        .entries.find((candidate) => candidate.capabilityId === capabilityId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    if (!priorEntry || priorEntry.entrySha256 !== prior.entrySha256) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
    }
    return { activation: prior, entry: priorEntry };
  }

  private requireExecutableApproval(workspaceId: string, approvalId: string): ApprovalRequest {
    let approval: ApprovalRequest;
    try {
      approval = this.storage.approvals.get(approvalId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_approval_not_executable");
      }
      throw error;
    }
    if (approval.kind !== MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND || approval.linkage?.workspaceId !== workspaceId) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_approval_not_executable");
    }
    const payload = approval.payload as unknown as MeshCapabilityActivationApprovalPayload;
    try {
      assertMeshCapabilityActivationApprovalPayload(payload);
    } catch {
      throw new MeshCapabilityActivationServiceError("mesh_capability_approval_not_executable");
    }
    if (
      payload.workspaceId !== workspaceId ||
      deriveMeshCapabilityActivationApprovalId(payload) !== approval.approvalId
    ) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_approval_not_executable");
    }
    if (approval.status !== "approved") {
      throw new MeshCapabilityActivationServiceError("mesh_capability_approval_not_executable");
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= this.now().getTime()) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_approval_expired");
    }
    return approval;
  }

  private recoverRequestActorId(approvalId: string): string {
    const evidence = this.storage.governanceJourneyEvents.findByIdempotencyKey(
      activationRequestJourneyIdempotencyKey(approvalId),
    );
    if (!evidence || evidence.approvalId !== approvalId || !evidence.actorId) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_request_evidence_missing");
    }
    return evidence.actorId;
  }

  private rebuildActivationInput(
    payload: MeshCapabilityActivationApprovalPayload,
    approval: ApprovalRequest,
    actorId: string,
  ): ActivateMeshCapabilityInput {
    let entry: MeshCapabilityManifestEntry;
    let manifest: { nodeId: string; publisherGeneration: number; manifestSha256: string };
    try {
      ({ entry, manifest } = this.resolveExactEntry({
        workspaceId: payload.workspaceId,
        capabilityId: payload.capabilityId,
        manifestSha256: payload.manifestSha256,
        entrySha256: payload.entrySha256,
        actorId,
      }));
    } catch (error) {
      if (error instanceof MeshCapabilityActivationServiceError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
      }
      throw error;
    }
    if (
      entry.descriptorSha256 !== payload.descriptorSha256 ||
      entry.permissionEnvelopeSha256 !== payload.permissionEnvelopeSha256 ||
      entry.descriptor.effectPosture !== payload.effectPosture
    ) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
    }
    let liveBinding: { healthGeneration: number; publicationLeaseFencingToken: number };
    let prior: { activation: MeshCapabilityActivationRecord; entry: MeshCapabilityManifestEntry } | undefined;
    try {
      liveBinding = this.resolveLivePublisherBinding(payload.workspaceId, manifest.nodeId, {
        publisherGeneration: manifest.publisherGeneration,
      });
      prior = this.resolvePriorActivation(payload.workspaceId, payload.capabilityId);
    } catch (error) {
      if (error instanceof MeshCapabilityActivationServiceError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
      }
      throw error;
    }
    // An exact replay of an already-applied activation rebuilds against its
    // own stored row: the prior for revision N is the activation at N-1.
    if (prior && prior.activation.activationRevision === payload.activationRevision) {
      const replayed = prior.activation;
      if (replayed.activationId !== payload.activationId) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
      }
      prior = this.resolvePriorForReplay(payload.workspaceId, payload.capabilityId, replayed);
    }
    const diffs = buildMeshCapabilityActivationDiffs({
      currentEntry: entry,
      ...(prior === undefined ? {} : { prior }),
    });
    const sessionId = asOptionalIdentifier(approval.linkage?.sessionId);
    const turnId = asOptionalIdentifier(approval.linkage?.turnId);
    return {
      workspaceId: payload.workspaceId,
      activationId: payload.activationId,
      activationRevision: payload.activationRevision,
      capabilityId: payload.capabilityId,
      nodeId: manifest.nodeId,
      publisherGeneration: manifest.publisherGeneration,
      healthGeneration: liveBinding.healthGeneration,
      publicationLeaseFencingToken: liveBinding.publicationLeaseFencingToken,
      manifestSha256: payload.manifestSha256,
      entrySha256: payload.entrySha256,
      descriptorSha256: payload.descriptorSha256,
      permissionEnvelopeSha256: payload.permissionEnvelopeSha256,
      effectPosture: payload.effectPosture,
      permissionDiff: diffs.permissionDiff,
      effectDiff: diffs.effectDiff,
      approvalId: approval.approvalId,
      actorId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(turnId === undefined ? {} : { turnId }),
      idempotencyKey: activationIdempotencyKey(payload.activationId),
    };
  }

  private resolvePriorForReplay(
    workspaceId: string,
    capabilityId: string,
    replayed: MeshCapabilityActivationRecord,
  ): { activation: MeshCapabilityActivationRecord; entry: MeshCapabilityManifestEntry } | undefined {
    const priorActivationId = replayed.permissionDiff.priorActivationId;
    if (!priorActivationId) return undefined;
    let activation: MeshCapabilityActivationRecord;
    try {
      activation = this.storage.meshCapabilityPublications.getActivation(workspaceId, priorActivationId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
      }
      throw error;
    }
    const entry = this.storage.meshCapabilityPublications
      .getManifest(workspaceId, activation.nodeId, activation.publisherGeneration, activation.manifestSha256)
      .entries.find((candidate) => candidate.capabilityId === capabilityId);
    if (!entry || entry.entrySha256 !== activation.entrySha256) {
      throw new MeshCapabilityActivationServiceError("mesh_capability_activation_state_drift");
    }
    return { activation, entry };
  }

  private findActivation(workspaceId: string, activationId: string): MeshCapabilityActivationRecord | undefined {
    try {
      return this.storage.meshCapabilityPublications.getActivation(workspaceId, activationId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}

export function deriveMeshCapabilityActivationId(input: {
  workspaceId: string;
  capabilityId: string;
  activationRevision: number;
  nodeId: string;
  publisherGeneration: number;
  healthGeneration: number;
  publicationLeaseFencingToken: number;
  manifestSha256: string;
  entrySha256: string;
  actorId: string;
  sessionId?: string;
  turnId?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      canonicalJsonString({
        schemaVersion: MESH_CAPABILITY_ACTIVATION_ID_SCHEMA_VERSION,
        workspaceId: input.workspaceId,
        capabilityId: input.capabilityId,
        activationRevision: input.activationRevision,
        nodeId: input.nodeId,
        publisherGeneration: input.publisherGeneration,
        healthGeneration: input.healthGeneration,
        publicationLeaseFencingToken: input.publicationLeaseFencingToken,
        manifestSha256: input.manifestSha256,
        entrySha256: input.entrySha256,
        actorId: input.actorId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
      }),
      "utf8",
    )
    .digest("hex");
  return `mesh-activation-${digest.slice(0, 48)}`;
}

function activationIdempotencyKey(activationId: string): string {
  return `mesh-capability-activation:${activationId}`;
}

export function activationRequestJourneyIdempotencyKey(approvalId: string): string {
  return `mesh-capability-activation:request:${approvalId}`;
}

/**
 * The content-free request Journey evidence committed atomically with the
 * approval row. Its actorId is the requesting operator the approved apply
 * recovers; the approved payload's requestSha256 re-verifies that recovery
 * byte-exactly, so tampered or substituted evidence fails the apply closed.
 */
export function buildActivationRequestJourneyEvent(input: {
  approval: ApprovalRequest;
  activationInput: ActivateMeshCapabilityInput;
  actorId: string;
}): GovernanceJourneyEventRecord {
  const activation = input.activationInput;
  const fingerprint = createHash("sha256")
    .update(
      canonicalJsonString({
        action: "activation_requested",
        workspaceId: activation.workspaceId,
        approvalId: input.approval.approvalId,
        activationId: activation.activationId,
        activationRevision: activation.activationRevision,
        capabilityId: activation.capabilityId,
        requestSha256: computeMeshCapabilityActivationRequestSha256(activation),
      }),
      "utf8",
    )
    .digest("hex");
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: `mesh-capability-activation-request-${fingerprint.slice(0, 48)}`,
    idempotencyKey: activationRequestJourneyIdempotencyKey(input.approval.approvalId),
    scopeKind: "workspace",
    workspaceId: activation.workspaceId,
    eventType: "mesh_capability_activation",
    subjectKind: "mesh_capability_activation",
    subjectId: activation.activationId,
    action: "activation_requested",
    actorId: input.actorId,
    actorType: "operator",
    ...(activation.sessionId === undefined ? {} : { sessionId: activation.sessionId }),
    ...(activation.turnId === undefined ? {} : { turnId: activation.turnId }),
    approvalId: input.approval.approvalId,
    fingerprint,
    sourceKind: "approval",
    sourceId: input.approval.approvalId,
    trustDisposition: "pending",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "approval", refId: input.approval.approvalId }],
    provenance: { sourceRequired: true, approvalRequired: true },
    summary: {
      capabilityId: activation.capabilityId,
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      effectPosture: activation.effectPosture,
      permissionDisposition: activation.permissionDiff.disposition,
      effectDisposition: activation.effectDiff.disposition,
    },
    occurredAt: input.approval.createdAt,
    recordedAt: input.approval.createdAt,
  };
}

function asOptionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
