/**
 * HX-408 M3: the generation-fenced mesh capability invocation owner.
 *
 * Gateway is the sole invocation authority. This service creates the
 * immutable invocation intent ONLY for a still-callable exact activation (the
 * committed 168/110 storage guard re-verifies the full binding inside its own
 * transaction), hands the credential-free dispatch envelope to the EXISTING
 * mesh replication transport, and ingests node-side progress plus ONE
 * terminal settlement under the storage-enforced invariants it surfaces —
 * never re-implements:
 *
 * - intent creation is idempotency-keyed and same-byte replayable; changed
 *   bytes conflict; a non-callable activation cannot mint an intent;
 * - ONE settlement per invocation (first writer wins); duplicate identical
 *   settlement bytes converge idempotently; changed bytes conflict; a stale
 *   publisher generation or lease fencing token can never settle;
 * - the settling node identity is admission-bound (bearer join-token digest
 *   plus fingerprint pinning) and must match the dispatched node — it is
 *   never read from a request body.
 *
 * HX-305: the Chat execution fence fires exactly once immediately before the
 * envelope append (the external-exposure write). Missing/ambiguous delivery
 * settles `unknown` and is flagged for manual reconciliation; it is NEVER
 * auto-replayed (the declared idempotency posture alone does not authorize
 * replay, so replay authorization is deferred entirely).
 *
 * HX-306: a Gateway-proxied model call performed on behalf of an invocation
 * must attribute through `resolveModelUsageAttribution`, which binds the
 * originating attempt lineage from the immutable intent (server truth). The
 * dispatch itself fabricates NO model-usage record.
 */
import { createHash } from "node:crypto";
import {
  ConflictError,
  canonicalJsonString,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityInvocationIntentRecord,
  type MeshCapabilityInvocationSettlementRecord,
  type MeshCapabilitySettlementDisposition,
  type MeshReplicationIngestRequest,
  type MeshReplicationRecord,
  type ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { MeshCapabilityAuthenticatedNodeIdentity } from "./mesh-capability-publication-service.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

export const MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION =
  "goatcitadel.mesh-capability-invocation-envelope.v1" as const;
export const MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE = "mesh_capability_invocation_dispatch" as const;

const DEFAULT_SETTLEMENT_POLL_INTERVAL_MS = 150;
const DEFAULT_DEADLINE_SAFETY_MARGIN_MS = 1_000;
const MINIMUM_DISPATCH_DEADLINE_MS = 1_000;
const INPUT_VAULT_MAX_ENTRIES = 256;
const INPUT_VAULT_GRACE_MS = 60_000;
const MAX_PROGRESS_EVENTS_PER_INVOCATION = 64;
const MAX_TRACKED_PROGRESS_INVOCATIONS = 1_024;
const MAX_SETTLEMENT_OUTPUT_BYTES = 512 * 1_024;
const EXPIRED_INTENT_RECONCILE_BATCH = 8;
const GATEWAY_SETTLEMENT_AUTHORITY = "gateway" as const;

export type MeshCapabilityInvocationServiceErrorCode =
  | "mesh_capability_invocation_not_callable"
  | "mesh_capability_invocation_input_invalid"
  | "mesh_capability_invocation_capacity_exhausted"
  | "mesh_capability_invocation_conflict"
  | "mesh_capability_invocation_not_found"
  | "mesh_capability_settlement_node_mismatch"
  | "mesh_capability_settlement_stale_generation"
  | "mesh_capability_settlement_conflict"
  | "mesh_capability_settlement_invalid"
  | "mesh_capability_progress_rejected";

const ERROR_STATUS: Readonly<Record<MeshCapabilityInvocationServiceErrorCode, number>> = Object.freeze({
  mesh_capability_invocation_not_callable: 409,
  mesh_capability_invocation_input_invalid: 400,
  mesh_capability_invocation_capacity_exhausted: 503,
  mesh_capability_invocation_conflict: 409,
  mesh_capability_invocation_not_found: 404,
  mesh_capability_settlement_node_mismatch: 403,
  mesh_capability_settlement_stale_generation: 409,
  mesh_capability_settlement_conflict: 409,
  mesh_capability_settlement_invalid: 400,
  mesh_capability_progress_rejected: 409,
});

/** Content-free typed failure; the reason code is the entire disclosure. */
export class MeshCapabilityInvocationServiceError extends Error {
  public readonly statusCode: number;

  public constructor(public readonly code: MeshCapabilityInvocationServiceErrorCode) {
    super(`Mesh capability invocation request failed: ${code}.`);
    this.name = "MeshCapabilityInvocationServiceError";
    this.statusCode = ERROR_STATUS[code];
  }
}

/**
 * The exact packet-mandated dispatch envelope. It binds the invocation ID and
 * idempotency key, the workspace/session/turn/run lineage, the exact
 * capability/profile/manifest/entry/activation identities, the publisher
 * generation and lease fencing token, the input hash and bounded deadline,
 * and the required approval ID when applicable. It NEVER carries a provider
 * credential and NEVER echoes raw input beyond the hash.
 */
export interface MeshCapabilityInvocationDispatchEnvelope {
  schemaVersion: typeof MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION;
  invocationId: string;
  idempotencyKey: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  capabilityId: string;
  executionProfileSha256: string;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  activationId: string;
  activationRevision: number;
  nodeId: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
  inputSha256: string;
  deadlineAt: string;
  approvalId?: string;
}

export interface MeshCapabilityInvocationDispatchInput {
  workspaceId: string;
  binding: ChatTurnCapabilityToolMeshPublicationBinding;
  capabilityId: string;
  args: Record<string, unknown>;
  toolRunId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  /** Required approval ID when an approval gated this invocation. */
  approvalId?: string;
  executionProfileSha256: string;
}

export interface MeshCapabilityInvocationDispatchOptions {
  /**
   * HX-305 execution fence. Fired exactly once immediately before the
   * envelope append (the external-exposure write) — never on attempts the
   * storage intent guard rejects and never on a pre-dispatch cancellation.
   */
  executionFence?: () => void;
  signal?: AbortSignal;
}

export interface MeshCapabilityInvocationReceipt {
  invocationId: string;
  capabilityId: string;
  nodeId: string;
  activationId: string;
  activationRevision: number;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
  inputSha256: string;
  deadlineAt: string;
  outputSha256?: string;
  settlementSha256?: string;
  errorCode?: string;
  settledAt?: string;
}

export interface MeshCapabilityInvocationDispatchOutcome {
  invocationId: string;
  disposition: MeshCapabilitySettlementDisposition;
  /** True when the ONE immutable settlement row exists in storage. */
  settled: boolean;
  /** HX-305 delivery truth: the remote effect state cannot be proven. */
  deliveryUncertain: boolean;
  /** Unknown/ambiguous outcomes require operator reconciliation; never auto-replayed. */
  manualReconciliationRequired: boolean;
  /** Transient node output (same-process rendezvous), digest-verified. */
  output?: Record<string, unknown>;
  errorCode?: string;
  receipt: MeshCapabilityInvocationReceipt;
}

export interface MeshCapabilityNodeSettlementSubmission {
  invocationId: string;
  disposition: MeshCapabilitySettlementDisposition;
  settlementSha256: string;
  outputSha256?: string;
  /** Transient output content; only its digest is durable. */
  output?: Record<string, unknown>;
  errorCode?: string;
  effectiveCostAttributionSha256?: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
}

export interface MeshCapabilityNodeProgressSubmission {
  invocationId: string;
  sequence: number;
  stage: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
}

export interface MeshCapabilityInvocationServiceOptions {
  storage: Storage;
  transport: {
    localNodeId(): string;
    appendEvent(input: MeshReplicationIngestRequest): MeshReplicationRecord;
  };
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  now?: () => Date;
  settlementPollIntervalMs?: number;
  deadlineSafetyMarginMs?: number;
}

interface InputVaultEntry {
  inputCanonicalJson: string;
  inputSha256: string;
  expiresAtMs: number;
  outputSha256?: string;
  output?: Record<string, unknown>;
}

/**
 * Only the exact node-facing invocation paths below carry admitted-node
 * credentials instead of operator authority. The auth plugin defers them to
 * the mesh-node route access class (M1 convention), whose enforcement calls
 * the durable admission authority.
 */
export function isMeshCapabilityNodeInvocationPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return /^\/api\/v1\/mesh\/capabilities\/invocations\/[^/]{1,256}\/(?:input|progress|settlement)$/u.test(pathname);
}

export class MeshCapabilityInvocationService {
  private readonly storage: Storage;
  private readonly transport: MeshCapabilityInvocationServiceOptions["transport"];
  private readonly publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  private readonly now: () => Date;
  private readonly settlementPollIntervalMs: number;
  private readonly deadlineSafetyMarginMs: number;
  private readonly inputVault = new Map<string, InputVaultEntry>();
  private readonly progressSequences = new Map<string, { lastSequence: number; count: number }>();

  public constructor(options: MeshCapabilityInvocationServiceOptions) {
    this.storage = options.storage;
    this.transport = options.transport;
    this.publishRealtime = options.publishRealtime;
    this.now = options.now ?? (() => new Date());
    this.settlementPollIntervalMs = Math.max(
      10,
      options.settlementPollIntervalMs ?? DEFAULT_SETTLEMENT_POLL_INTERVAL_MS,
    );
    this.deadlineSafetyMarginMs = Math.max(0, options.deadlineSafetyMarginMs ?? DEFAULT_DEADLINE_SAFETY_MARGIN_MS);
  }

  /**
   * Dispatches one governed invocation for a still-valid frozen binding and
   * awaits its ONE terminal settlement under the bounded deadline. The whole
   * flow is deterministic per tool run: a Gateway restart that re-executes the
   * same attempt converges on the existing intent, the same idempotent
   * envelope, and — when the node already settled — the settled outcome,
   * without a duplicate dispatch.
   */
  public async dispatch(
    input: MeshCapabilityInvocationDispatchInput,
    options: MeshCapabilityInvocationDispatchOptions = {},
  ): Promise<MeshCapabilityInvocationDispatchOutcome> {
    const normalized = normalizeDispatchInput(input);
    const inputCanonicalJson = canonicalJsonString(normalized.args);
    const inputSha256 = sha256Utf8(inputCanonicalJson);
    const invocationId = deriveMeshCapabilityInvocationId({
      workspaceId: normalized.workspaceId,
      toolRunId: normalized.toolRunId,
      capabilityId: normalized.capabilityId,
      binding: normalized.binding,
      inputSha256,
    });
    const idempotencyKey = `mesh-capability-invocation:${normalized.toolRunId}`;
    if (options.signal?.aborted) {
      // Cancelled before any dispatch write: no intent, no fence, no exposure.
      return {
        invocationId,
        disposition: "cancelled",
        settled: false,
        deliveryUncertain: false,
        manualReconciliationRequired: false,
        errorCode: "mesh_capability_dispatch_cancelled_before_dispatch",
        receipt: {
          invocationId,
          capabilityId: normalized.capabilityId,
          nodeId: normalized.binding.nodeId,
          activationId: normalized.binding.activationId,
          activationRevision: normalized.binding.activationRevision,
          publisherGeneration: normalized.binding.publisherGeneration,
          publicationLeaseFencingToken: normalized.binding.publicationLeaseFencingToken,
          inputSha256,
          deadlineAt: this.now().toISOString(),
          errorCode: "mesh_capability_dispatch_cancelled_before_dispatch",
        },
      };
    }
    // Lazy storage-truth recovery: settle other expired unsettled intents to a
    // bounded terminal state before this dispatch proceeds.
    this.reconcileExpiredInvocationIntents(normalized.workspaceId);

    const existingSettlement = this.storage.meshCapabilityPublications.findInvocationSettlement(
      normalized.workspaceId,
      invocationId,
    );
    if (existingSettlement) {
      // The dispatch write happened on an earlier attempt of this exact tool
      // run; mark the fence before the possibly-effectful outcome is consumed.
      options.executionFence?.();
      const intent = this.storage.meshCapabilityPublications.findInvocationIntent(normalized.workspaceId, invocationId);
      return this.buildSettledOutcome(normalized.workspaceId, intent, invocationId, existingSettlement);
    }

    let intent = this.storage.meshCapabilityPublications.findInvocationIntent(normalized.workspaceId, invocationId);
    if (!intent) {
      intent = this.createIntentForCallableActivation(normalized, invocationId, idempotencyKey, inputSha256);
    } else if (intent.idempotencyKey !== idempotencyKey || intent.inputSha256 !== inputSha256) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_conflict");
    }

    // Vault storage is a purely in-process staging write with no external
    // exposure, so it runs BEFORE the fence: vault-capacity exhaustion then
    // rejects as a clean pre-dispatch block (M4 fold of the M3 review Minor)
    // instead of a post-fence dispatch failure.
    this.storeVaultInput(normalized.workspaceId, invocationId, inputCanonicalJson, inputSha256, intent.deadlineAt);
    // The envelope append is the external-exposure write: the durable
    // execution fence must land immediately before it (HX-415 discipline).
    options.executionFence?.();
    const envelope = buildDispatchEnvelope(intent);
    try {
      this.transport.appendEvent({
        sourceNodeId: this.transport.localNodeId(),
        eventType: MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE,
        payload: envelope as unknown as Record<string, unknown>,
        idempotencyKey: intent.idempotencyKey,
      });
    } catch {
      // The append outcome is unknowable after a transport error: treat the
      // delivery as ambiguous, settle a bounded terminal state, and flag it.
      const settlement = this.settleAsGateway(intent, "unknown", "mesh_capability_dispatch_transport_failed");
      return this.buildGatewaySettledOutcome(normalized.workspaceId, intent, settlement, {
        disposition: "unknown",
        errorCode: "mesh_capability_dispatch_transport_failed",
      });
    }
    this.publishRealtime?.("mesh_capability_invocation_dispatched", "mesh", {
      workspaceId: intent.workspaceId,
      invocationId: intent.invocationId,
      capabilityId: intent.capabilityId,
      nodeId: intent.nodeId,
      activationId: intent.activationId,
      publisherGeneration: intent.publisherGeneration,
      deadlineAt: intent.deadlineAt,
    });
    return this.awaitSettlement(intent, options.signal);
  }

  /**
   * Node-facing transient input read. The node identity is admission-bound;
   * only the dispatched node of an unsettled, un-expired invocation can read
   * the exact input bytes whose digest the envelope binds. After a Gateway
   * restart the transient bytes are gone and the read fails content-free.
   */
  public readInvocationInput(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    invocationId: string,
  ): { invocationId: string; inputSha256: string; input: Record<string, unknown> } {
    const intent = this.requireIntentForNode(identity, invocationId);
    const settled = this.storage.meshCapabilityPublications.findInvocationSettlement(
      identity.workspaceId,
      invocationId,
    );
    if (settled || Date.parse(intent.deadlineAt) <= this.now().getTime()) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    }
    const entry = this.readVaultEntry(identity.workspaceId, invocationId);
    if (!entry || entry.inputSha256 !== intent.inputSha256) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    }
    return {
      invocationId: intent.invocationId,
      inputSha256: intent.inputSha256,
      input: JSON.parse(entry.inputCanonicalJson) as Record<string, unknown>,
    };
  }

  /**
   * Bounded, generation-fenced progress ingestion. Progress is transient
   * observability — it never mutates durable invocation state.
   */
  public recordProgress(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityNodeProgressSubmission,
  ): { accepted: true; sequence: number } {
    const intent = this.requireIntentForNode(identity, submission.invocationId);
    if (
      submission.publisherGeneration !== intent.publisherGeneration ||
      submission.publicationLeaseFencingToken !== intent.publicationLeaseFencingToken
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_stale_generation");
    }
    if (
      !Number.isSafeInteger(submission.sequence) ||
      submission.sequence < 1 ||
      typeof submission.stage !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(submission.stage)
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_progress_rejected");
    }
    const settled = this.storage.meshCapabilityPublications.findInvocationSettlement(
      identity.workspaceId,
      submission.invocationId,
    );
    if (settled) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_progress_rejected");
    }
    const key = vaultKey(identity.workspaceId, submission.invocationId);
    const tracked = this.progressSequences.get(key);
    if (!tracked && this.progressSequences.size >= MAX_TRACKED_PROGRESS_INVOCATIONS) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_progress_rejected");
    }
    if (
      tracked &&
      (submission.sequence <= tracked.lastSequence || tracked.count >= MAX_PROGRESS_EVENTS_PER_INVOCATION)
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_progress_rejected");
    }
    this.progressSequences.set(key, {
      lastSequence: submission.sequence,
      count: (tracked?.count ?? 0) + 1,
    });
    this.publishRealtime?.("mesh_capability_invocation_progress", "mesh", {
      workspaceId: identity.workspaceId,
      invocationId: intent.invocationId,
      capabilityId: intent.capabilityId,
      nodeId: intent.nodeId,
      sequence: submission.sequence,
      stage: submission.stage,
    });
    return { accepted: true, sequence: submission.sequence };
  }

  /**
   * Node-facing terminal settlement ingestion. Storage owns one-winner,
   * duplicate-identical idempotence, changed-byte conflict, and
   * stale-generation rejection; this owner surfaces them as content-free
   * codes and additionally pins the settling node to the dispatched node.
   */
  public settleFromNode(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityNodeSettlementSubmission,
  ): { settlement: MeshCapabilityInvocationSettlementRecord; replayed: boolean } {
    const intent = this.requireIntentForNode(identity, submission.invocationId);
    if (
      submission.publisherGeneration !== intent.publisherGeneration ||
      submission.publicationLeaseFencingToken !== intent.publicationLeaseFencingToken
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_stale_generation");
    }
    const output = this.verifySettlementOutput(intent, submission);
    const existing = this.storage.meshCapabilityPublications.findInvocationSettlement(
      identity.workspaceId,
      submission.invocationId,
    );
    let settlement: MeshCapabilityInvocationSettlementRecord;
    try {
      settlement = this.storage.meshCapabilityPublications.settleInvocation({
        workspaceId: identity.workspaceId,
        invocationId: submission.invocationId,
        disposition: submission.disposition,
        ...(submission.outputSha256 === undefined ? {} : { outputSha256: submission.outputSha256 }),
        ...(submission.errorCode === undefined ? {} : { errorCode: submission.errorCode }),
        settlementSha256: submission.settlementSha256,
        ...(submission.effectiveCostAttributionSha256 === undefined
          ? {}
          : { effectiveCostAttributionSha256: submission.effectiveCostAttributionSha256 }),
        publisherGeneration: submission.publisherGeneration,
        publicationLeaseFencingToken: submission.publicationLeaseFencingToken,
        idempotencyKey: `mesh-capability-settlement:node:${identity.nodeId}:${submission.invocationId}`,
      });
    } catch (error) {
      throw this.mapSettlementWriteError(identity.workspaceId, submission.invocationId, error);
    }
    if (output) {
      this.storeVaultOutput(identity.workspaceId, submission.invocationId, output, submission.outputSha256);
    }
    this.clearProgressTracking(identity.workspaceId, submission.invocationId);
    this.publishRealtime?.("mesh_capability_invocation_settled", "mesh", {
      workspaceId: identity.workspaceId,
      invocationId: settlement.invocationId,
      capabilityId: intent.capabilityId,
      nodeId: intent.nodeId,
      disposition: settlement.disposition,
      settlementAuthority: "node",
    });
    return { settlement, replayed: Boolean(existing) };
  }

  /**
   * HX-306 seam: server-owned attribution for a Gateway-proxied model call
   * performed on behalf of one invocation. Lineage comes exclusively from the
   * immutable intent — a node can never self-attribute cost or lineage.
   */
  public resolveModelUsageAttribution(workspaceId: string, invocationId: string): ModelUsageAttributionContext {
    const intent = this.storage.meshCapabilityPublications.findInvocationIntent(workspaceId, invocationId);
    if (!intent) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    }
    return createUtilityModelUsageAttribution({
      operationId: `mesh-capability-invocation:${intent.invocationId}`,
      utilityKind: "mesh_capability_invocation",
      lineage: {
        workspaceId: intent.workspaceId,
        sessionId: intent.sessionId,
        turnId: intent.turnId,
        ...(intent.runId === undefined ? {} : { durableRunId: intent.runId }),
      },
    });
  }

  /**
   * Settles expired unsettled intents to the bounded `unknown` terminal state
   * (storage truth) so a Gateway restart or crash never strands an invocation
   * open forever. Late node settlements after this terminal state conflict
   * per the storage rules.
   */
  public reconcileExpiredInvocationIntents(workspaceId: string, limit = EXPIRED_INTENT_RECONCILE_BATCH): number {
    const expired = this.storage.meshCapabilityPublications.listUnsettledExpiredInvocationIntents(
      workspaceId,
      Math.max(1, Math.min(limit, 64)),
    );
    let reconciled = 0;
    for (const intent of expired) {
      const settlement = this.settleAsGateway(intent, "unknown", "mesh_capability_dispatch_deadline_expired");
      if (settlement) {
        reconciled += 1;
        this.publishRealtime?.("mesh_capability_invocation_reconciled", "mesh", {
          workspaceId: intent.workspaceId,
          invocationId: intent.invocationId,
          capabilityId: intent.capabilityId,
          nodeId: intent.nodeId,
          disposition: settlement.disposition,
          errorCode: "mesh_capability_dispatch_deadline_expired",
        });
      }
    }
    return reconciled;
  }

  private createIntentForCallableActivation(
    input: ReturnType<typeof normalizeDispatchInput>,
    invocationId: string,
    idempotencyKey: string,
    inputSha256: string,
  ): MeshCapabilityInvocationIntentRecord {
    const activation = this.resolveCallableActivation(input.workspaceId, input.binding, input.capabilityId);
    const limits = this.resolveDeclaredResourceLimits(activation);
    if (
      Buffer.byteLength(canonicalJsonString(input.args), "utf8") >
      Math.min(limits.maxRequestBytes, MAX_SETTLEMENT_OUTPUT_BYTES)
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_input_invalid");
    }
    const deadlineMs = Math.max(MINIMUM_DISPATCH_DEADLINE_MS, limits.timeoutMs - this.deadlineSafetyMarginMs);
    const deadlineAt = new Date(this.now().getTime() + deadlineMs).toISOString();
    try {
      return this.storage.meshCapabilityPublications.createInvocationIntent({
        workspaceId: input.workspaceId,
        invocationId,
        activationId: activation.activationId,
        activationRevision: activation.activationRevision,
        capabilityId: activation.capabilityId,
        nodeId: activation.nodeId,
        publisherGeneration: activation.publisherGeneration,
        healthGeneration: activation.healthGeneration,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
        manifestSha256: activation.manifestSha256,
        entrySha256: activation.entrySha256,
        descriptorSha256: activation.descriptorSha256,
        permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
        executionProfileSha256: input.executionProfileSha256,
        inputSha256,
        sessionId: input.sessionId,
        turnId: input.turnId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
        deadlineAt,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof MeshCapabilityInvocationServiceError) throw error;
      if (error instanceof ConflictError) {
        // The committed 168/110 intent guard rejected the write: either the
        // activation stopped being callable between the gate and this write,
        // or the idempotency key was reused with different bytes.
        throw new MeshCapabilityInvocationServiceError(
          /different request bytes/iu.test(error.message)
            ? "mesh_capability_invocation_conflict"
            : "mesh_capability_invocation_not_callable",
        );
      }
      throw error;
    }
  }

  private resolveCallableActivation(
    workspaceId: string,
    binding: ChatTurnCapabilityToolMeshPublicationBinding,
    capabilityId: string,
  ): MeshCapabilityActivationRecord {
    const activation = this.storage.meshCapabilityPublications
      .listCallableActivations(workspaceId)
      .find((candidate) => candidate.activationId === binding.activationId);
    if (
      !activation ||
      activation.capabilityId !== capabilityId ||
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
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
    }
    return activation;
  }

  private resolveDeclaredResourceLimits(activation: MeshCapabilityActivationRecord): {
    timeoutMs: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
  } {
    let entryDescriptor: {
      resourceLimits?: { timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number };
    };
    try {
      const manifest = this.storage.meshCapabilityPublications.getManifest(
        activation.workspaceId,
        activation.nodeId,
        activation.publisherGeneration,
        activation.manifestSha256,
      );
      const entry = manifest.entries.find(
        (candidate) =>
          candidate.capabilityId === activation.capabilityId && candidate.entrySha256 === activation.entrySha256,
      );
      if (!entry) {
        throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
      }
      entryDescriptor = entry.descriptor as typeof entryDescriptor;
    } catch (error) {
      if (error instanceof MeshCapabilityInvocationServiceError) throw error;
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
    }
    const limits = entryDescriptor.resourceLimits;
    if (
      !limits ||
      !Number.isSafeInteger(limits.timeoutMs) ||
      (limits.timeoutMs ?? 0) < 1 ||
      !Number.isSafeInteger(limits.maxRequestBytes) ||
      (limits.maxRequestBytes ?? 0) < 1 ||
      !Number.isSafeInteger(limits.maxResponseBytes) ||
      (limits.maxResponseBytes ?? 0) < 1
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
    }
    return {
      timeoutMs: limits.timeoutMs as number,
      maxRequestBytes: limits.maxRequestBytes as number,
      maxResponseBytes: limits.maxResponseBytes as number,
    };
  }

  private async awaitSettlement(
    intent: MeshCapabilityInvocationIntentRecord,
    signal?: AbortSignal,
  ): Promise<MeshCapabilityInvocationDispatchOutcome> {
    const deadlineMs = Date.parse(intent.deadlineAt);
    for (;;) {
      const settlement = this.storage.meshCapabilityPublications.findInvocationSettlement(
        intent.workspaceId,
        intent.invocationId,
      );
      if (settlement) {
        return this.buildSettledOutcome(intent.workspaceId, intent, intent.invocationId, settlement);
      }
      if (signal?.aborted) {
        const written = this.settleAsGateway(intent, "cancelled", "mesh_capability_dispatch_cancelled");
        return this.buildGatewaySettledOutcome(intent.workspaceId, intent, written, {
          disposition: "cancelled",
          errorCode: "mesh_capability_dispatch_cancelled",
        });
      }
      if (this.now().getTime() >= deadlineMs) {
        const written = this.settleAsGateway(intent, "unknown", "mesh_capability_dispatch_deadline_expired");
        return this.buildGatewaySettledOutcome(intent.workspaceId, intent, written, {
          disposition: "unknown",
          errorCode: "mesh_capability_dispatch_deadline_expired",
        });
      }
      await delay(this.settlementPollIntervalMs, signal);
    }
  }

  /**
   * Gateway-authored bounded terminal settlement (cancellation, deadline
   * expiry, transport ambiguity). One-winner: a concurrent node settlement
   * wins the race and this converges on it; a stale-generation guard
   * rejection leaves the invocation unsettled for manual reconciliation.
   */
  private settleAsGateway(
    intent: MeshCapabilityInvocationIntentRecord,
    disposition: MeshCapabilitySettlementDisposition,
    errorCode: string,
  ): MeshCapabilityInvocationSettlementRecord | undefined {
    const settlementSha256 = sha256Utf8(
      canonicalJsonString({
        schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
        settlementAuthority: GATEWAY_SETTLEMENT_AUTHORITY,
        invocationId: intent.invocationId,
        disposition,
        errorCode,
      }),
    );
    try {
      const settlement = this.storage.meshCapabilityPublications.settleInvocation({
        workspaceId: intent.workspaceId,
        invocationId: intent.invocationId,
        disposition,
        errorCode,
        settlementSha256,
        publisherGeneration: intent.publisherGeneration,
        publicationLeaseFencingToken: intent.publicationLeaseFencingToken,
        idempotencyKey: `mesh-capability-settlement:gateway:${intent.invocationId}`,
      });
      this.clearProgressTracking(intent.workspaceId, intent.invocationId);
      this.publishRealtime?.("mesh_capability_invocation_settled", "mesh", {
        workspaceId: intent.workspaceId,
        invocationId: intent.invocationId,
        capabilityId: intent.capabilityId,
        nodeId: intent.nodeId,
        disposition,
        settlementAuthority: GATEWAY_SETTLEMENT_AUTHORITY,
        errorCode,
      });
      return settlement;
    } catch {
      // One-winner: converge on a concurrent settlement when present.
      const settlement = this.storage.meshCapabilityPublications.findInvocationSettlement(
        intent.workspaceId,
        intent.invocationId,
      );
      if (settlement) {
        this.clearProgressTracking(intent.workspaceId, intent.invocationId);
      }
      return settlement;
    }
  }

  private buildSettledOutcome(
    workspaceId: string,
    intent: MeshCapabilityInvocationIntentRecord | undefined,
    invocationId: string,
    settlement: MeshCapabilityInvocationSettlementRecord,
  ): MeshCapabilityInvocationDispatchOutcome {
    this.clearProgressTracking(workspaceId, invocationId);
    const vault = this.readVaultEntry(workspaceId, invocationId);
    const output =
      settlement.disposition === "succeeded" &&
      settlement.outputSha256 !== undefined &&
      vault?.outputSha256 === settlement.outputSha256 &&
      vault.output !== undefined
        ? vault.output
        : undefined;
    const uncertain = settlement.disposition === "unknown" || settlement.disposition === "cancelled";
    return {
      invocationId,
      disposition: settlement.disposition,
      settled: true,
      deliveryUncertain: uncertain,
      manualReconciliationRequired: settlement.disposition === "unknown",
      ...(output === undefined ? {} : { output }),
      ...(settlement.errorCode === undefined ? {} : { errorCode: settlement.errorCode }),
      receipt: buildReceipt(intent, invocationId, settlement),
    };
  }

  private clearProgressTracking(workspaceId: string, invocationId: string): void {
    this.progressSequences.delete(vaultKey(workspaceId, invocationId));
  }

  private buildGatewaySettledOutcome(
    workspaceId: string,
    intent: MeshCapabilityInvocationIntentRecord,
    written: MeshCapabilityInvocationSettlementRecord | undefined,
    fallback: { disposition: MeshCapabilitySettlementDisposition; errorCode: string },
  ): MeshCapabilityInvocationDispatchOutcome {
    if (written) {
      return this.buildSettledOutcome(workspaceId, intent, intent.invocationId, written);
    }
    // The settlement guard refused every writer (stale generation): the
    // invocation stays unsettled in storage and requires operator
    // reconciliation; the delivery truth is unknown.
    return {
      invocationId: intent.invocationId,
      disposition: fallback.disposition,
      settled: false,
      deliveryUncertain: true,
      manualReconciliationRequired: true,
      errorCode: fallback.errorCode,
      receipt: buildReceipt(intent, intent.invocationId, undefined),
    };
  }

  private mapSettlementWriteError(
    workspaceId: string,
    invocationId: string,
    error: unknown,
  ): MeshCapabilityInvocationServiceError | Error {
    if (error instanceof MeshCapabilityInvocationServiceError) return error;
    if (error instanceof ConflictError) {
      if (/different request bytes/iu.test(error.message)) {
        return new MeshCapabilityInvocationServiceError("mesh_capability_settlement_conflict");
      }
      const existing = this.storage.meshCapabilityPublications.findInvocationSettlement(workspaceId, invocationId);
      return new MeshCapabilityInvocationServiceError(
        existing ? "mesh_capability_settlement_conflict" : "mesh_capability_settlement_stale_generation",
      );
    }
    if (error instanceof TypeError) {
      return new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private verifySettlementOutput(
    intent: MeshCapabilityInvocationIntentRecord,
    submission: MeshCapabilityNodeSettlementSubmission,
  ): Record<string, unknown> | undefined {
    if (submission.output === undefined) return undefined;
    if (
      typeof submission.output !== "object" ||
      Array.isArray(submission.output) ||
      submission.outputSha256 === undefined
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    const canonical = canonicalJsonString(submission.output);
    const maxResponseBytes = ((): number => {
      try {
        const activation = this.storage.meshCapabilityPublications.getActivation(
          intent.workspaceId,
          intent.activationId,
        );
        return Math.min(this.resolveDeclaredResourceLimits(activation).maxResponseBytes, MAX_SETTLEMENT_OUTPUT_BYTES);
      } catch {
        return MAX_SETTLEMENT_OUTPUT_BYTES;
      }
    })();
    if (Buffer.byteLength(canonical, "utf8") > maxResponseBytes) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    if (sha256Utf8(canonical) !== submission.outputSha256) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    return submission.output;
  }

  private requireIntentForNode(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    invocationId: string,
  ): MeshCapabilityInvocationIntentRecord {
    if (typeof invocationId !== "string" || invocationId.length < 1 || invocationId.length > 256) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    }
    const intent = this.storage.meshCapabilityPublications.findInvocationIntent(identity.workspaceId, invocationId);
    if (!intent) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    }
    if (intent.nodeId !== identity.nodeId) {
      // Admission-bound identity, never body-claimed: only the dispatched
      // node can read input, report progress, or settle this invocation.
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_node_mismatch");
    }
    return intent;
  }

  private storeVaultInput(
    workspaceId: string,
    invocationId: string,
    inputCanonicalJson: string,
    inputSha256: string,
    deadlineAt: string,
  ): void {
    this.sweepVault();
    const key = vaultKey(workspaceId, invocationId);
    const existing = this.inputVault.get(key);
    if (!existing && this.inputVault.size >= INPUT_VAULT_MAX_ENTRIES) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_capacity_exhausted");
    }
    this.inputVault.set(key, {
      inputCanonicalJson,
      inputSha256,
      expiresAtMs: Date.parse(deadlineAt) + INPUT_VAULT_GRACE_MS,
      ...(existing?.output === undefined ? {} : { output: existing.output }),
      ...(existing?.outputSha256 === undefined ? {} : { outputSha256: existing.outputSha256 }),
    });
  }

  private storeVaultOutput(
    workspaceId: string,
    invocationId: string,
    output: Record<string, unknown>,
    outputSha256: string | undefined,
  ): void {
    const key = vaultKey(workspaceId, invocationId);
    const existing = this.inputVault.get(key);
    if (!existing) return;
    this.inputVault.set(key, {
      ...existing,
      ...(output === undefined ? {} : { output }),
      ...(outputSha256 === undefined ? {} : { outputSha256 }),
    });
  }

  private readVaultEntry(workspaceId: string, invocationId: string): InputVaultEntry | undefined {
    this.sweepVault();
    return this.inputVault.get(vaultKey(workspaceId, invocationId));
  }

  private sweepVault(): void {
    const nowMs = this.now().getTime();
    for (const [key, entry] of this.inputVault) {
      if (entry.expiresAtMs <= nowMs) this.inputVault.delete(key);
    }
  }
}

export function deriveMeshCapabilityInvocationId(input: {
  workspaceId: string;
  toolRunId: string;
  capabilityId: string;
  binding: Pick<
    ChatTurnCapabilityToolMeshPublicationBinding,
    "activationId" | "activationRevision" | "publisherGeneration" | "publicationLeaseFencingToken"
  >;
  inputSha256: string;
}): string {
  const material = canonicalJsonString({
    schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    toolRunId: input.toolRunId,
    capabilityId: input.capabilityId,
    activationId: input.binding.activationId,
    activationRevision: input.binding.activationRevision,
    publisherGeneration: input.binding.publisherGeneration,
    publicationLeaseFencingToken: input.binding.publicationLeaseFencingToken,
    inputSha256: input.inputSha256,
  });
  return `mesh-invocation-${sha256Utf8(material).slice(0, 48)}`;
}

export function buildDispatchEnvelope(
  intent: MeshCapabilityInvocationIntentRecord,
): MeshCapabilityInvocationDispatchEnvelope {
  return {
    schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
    invocationId: intent.invocationId,
    idempotencyKey: intent.idempotencyKey,
    workspaceId: intent.workspaceId,
    sessionId: intent.sessionId,
    turnId: intent.turnId,
    ...(intent.runId === undefined ? {} : { runId: intent.runId }),
    capabilityId: intent.capabilityId,
    executionProfileSha256: intent.executionProfileSha256,
    manifestSha256: intent.manifestSha256,
    entrySha256: intent.entrySha256,
    descriptorSha256: intent.descriptorSha256,
    permissionEnvelopeSha256: intent.permissionEnvelopeSha256,
    activationId: intent.activationId,
    activationRevision: intent.activationRevision,
    nodeId: intent.nodeId,
    publisherGeneration: intent.publisherGeneration,
    publicationLeaseFencingToken: intent.publicationLeaseFencingToken,
    inputSha256: intent.inputSha256,
    deadlineAt: intent.deadlineAt,
    ...(intent.approvalId === undefined ? {} : { approvalId: intent.approvalId }),
  };
}

function buildReceipt(
  intent: MeshCapabilityInvocationIntentRecord | undefined,
  invocationId: string,
  settlement: MeshCapabilityInvocationSettlementRecord | undefined,
): MeshCapabilityInvocationReceipt {
  return {
    invocationId,
    capabilityId: intent?.capabilityId ?? "unknown",
    nodeId: intent?.nodeId ?? "unknown",
    activationId: intent?.activationId ?? "unknown",
    activationRevision: intent?.activationRevision ?? 0,
    publisherGeneration: settlement?.publisherGeneration ?? intent?.publisherGeneration ?? 0,
    publicationLeaseFencingToken: settlement?.publicationLeaseFencingToken ?? intent?.publicationLeaseFencingToken ?? 0,
    inputSha256: intent?.inputSha256 ?? "",
    deadlineAt: intent?.deadlineAt ?? "",
    ...(settlement?.outputSha256 === undefined ? {} : { outputSha256: settlement.outputSha256 }),
    ...(settlement?.settlementSha256 === undefined ? {} : { settlementSha256: settlement.settlementSha256 }),
    ...(settlement?.errorCode === undefined ? {} : { errorCode: settlement.errorCode }),
    ...(settlement?.settledAt === undefined ? {} : { settledAt: settlement.settledAt }),
  };
}

function normalizeDispatchInput(input: MeshCapabilityInvocationDispatchInput): MeshCapabilityInvocationDispatchInput {
  const fail = (): never => {
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_input_invalid");
  };
  const id = (value: string, max = 256): string =>
    typeof value === "string" && value.length >= 1 && value.length <= max && !/\p{Cc}/u.test(value) ? value : fail();
  if (typeof input.args !== "object" || input.args === null || Array.isArray(input.args)) fail();
  if (!/^[0-9a-f]{64}$/u.test(input.executionProfileSha256)) fail();
  return {
    workspaceId: id(input.workspaceId),
    binding: input.binding,
    capabilityId: id(input.capabilityId, 512),
    args: input.args,
    toolRunId: id(input.toolRunId),
    sessionId: id(input.sessionId),
    turnId: id(input.turnId),
    ...(input.runId === undefined ? {} : { runId: id(input.runId, 512) }),
    ...(input.approvalId === undefined ? {} : { approvalId: id(input.approvalId, 512) }),
    executionProfileSha256: input.executionProfileSha256,
  };
}

function vaultKey(workspaceId: string, invocationId: string): string {
  return `${workspaceId}
${invocationId}`;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
