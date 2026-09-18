import { MeshCapabilityInvocationServiceError } from "./mesh-capability-invocation-errors.js";
export { MeshCapabilityInvocationServiceError, type MeshCapabilityInvocationServiceErrorCode } from "./mesh-capability-invocation-errors.js";
import { requireMeshInvocationIntentForNode, prepareMeshInvocationInputRead, type InputVaultEntry } from "./mesh-invocation-read-authority-service.js";
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
  NotFoundError,
  canonicalJsonString,
  buildMeshCapabilityDispatchEnvelope as buildDispatchEnvelope,
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE,
  MESH_CAPABILITY_MAX_PENDING_INVOCATIONS,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityDescriptor,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityInvocationInputResponse,
  type MeshCapabilityInvocationPendingList,
  type MeshCapabilityInvocationIntentRecord,
  type MeshCapabilityInvocationSettlementRecord,
  type MeshCapabilityNodeSettlementSubmission,
  type MeshCapabilityNodeProgressSubmission,
  type MeshCapabilitySettlementDisposition,
  type MeshReplicationIngestRequest,
  type MeshReplicationRecord,
  type ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import { MeshSchemaValidationError, validateMeshCapabilityInput, validateMeshCapabilityOutput } from "@goatcitadel/contracts/mesh-schema-node";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { resolveMeshCapabilityNodeAuthorityFence, type MeshCapabilityAuthenticatedNodeIdentity } from "./mesh-capability-publication-service.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

export {
  buildMeshCapabilityDispatchEnvelope as buildDispatchEnvelope,
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityNodeSettlementSubmission,
  type MeshCapabilityNodeProgressSubmission,
} from "@goatcitadel/contracts";

const DEFAULT_SETTLEMENT_POLL_INTERVAL_MS = 150;
const DEFAULT_DEADLINE_SAFETY_MARGIN_MS = 1_000;
const MINIMUM_DISPATCH_DEADLINE_MS = 1_000;
const INPUT_VAULT_MAX_ENTRIES = MESH_CAPABILITY_MAX_PENDING_INVOCATIONS;
const INPUT_VAULT_GRACE_MS = 60_000;
const MAX_PROGRESS_EVENTS_PER_INVOCATION = 64;
const MAX_TRACKED_PROGRESS_INVOCATIONS = 1_024;
const MAX_SETTLEMENT_OUTPUT_BYTES = 512 * 1_024;
const EXPIRED_INTENT_RECONCILE_BATCH = 8;
const GATEWAY_SETTLEMENT_AUTHORITY = "gateway" as const;

/**
 * The exact packet-mandated dispatch envelope. It binds the invocation ID and
 * idempotency key, the workspace/session/turn/run lineage, the exact
 * capability/profile/manifest/entry/activation identities, the publisher
 * generation and lease fencing token, the input hash and bounded deadline,
 * and the required approval ID when applicable. It NEVER carries a provider
 * credential and NEVER echoes raw input beyond the hash.
 */
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
  executionFence?: () => Promise<void>;
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

export interface MeshCapabilityInvocationServiceOptions {
  storage: Storage;
  transport: {
    localNodeId(): string;
    appendEvent(input: MeshReplicationIngestRequest): Promise<MeshReplicationRecord>;
  };
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
  settlementPollIntervalMs?: number;
  deadlineSafetyMarginMs?: number;
}


/**
 * Only the exact node-facing invocation paths below carry admitted-node
 * credentials instead of operator authority. The auth plugin defers them to
 * the mesh-node route access class (M1 convention), whose enforcement calls
 * the durable admission authority.
 */
export function isMeshCapabilityNodeInvocationPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/v1/mesh/capabilities/invocations/pending" ||
    /^\/api\/v1\/mesh\/capabilities\/invocations\/[^/]{1,256}\/(?:input|progress|settlement)$/u.test(pathname);
}

export class MeshCapabilityInvocationService {
  private readonly storage: Storage;
  private readonly transport: MeshCapabilityInvocationServiceOptions["transport"];
  private readonly publishRealtime?: (
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
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
    await this.reconcileExpiredInvocationIntents(normalized.workspaceId);

    const existingSettlement = await this.storage.meshCapabilityPublications.findInvocationSettlement(
      normalized.workspaceId,
      invocationId,
    );
    let intent = await this.storage.meshCapabilityPublications.findInvocationIntent(
      normalized.workspaceId,
      invocationId,
    );
    if (intent) assertDispatchIntentMatches(intent, normalized, invocationId, idempotencyKey, inputSha256);
    if (existingSettlement) {
      if (!intent) throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_conflict");
      // The dispatch write happened on an earlier attempt of this exact tool
      // run; mark the fence before the possibly-effectful outcome is consumed.
      await options.executionFence?.();
      return this.buildSettledOutcome(normalized.workspaceId, intent, invocationId, existingSettlement);
    }

    const activation = await this.resolveCallableActivation(normalized.workspaceId, normalized.binding, normalized.capabilityId);
    const descriptor = await this.resolveDeclaredDescriptor(activation);
    if (Buffer.byteLength(inputCanonicalJson, "utf8") >
      Math.min(descriptor.resourceLimits.maxRequestBytes, MAX_SETTLEMENT_OUTPUT_BYTES))
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_input_invalid");
    try { await validateMeshCapabilityInput(descriptor, inputCanonicalJson, options.signal); }
    catch (error) {
      throw new MeshCapabilityInvocationServiceError(error instanceof MeshSchemaValidationError && error.reason === "invalid"
        ? "mesh_capability_invocation_input_invalid" : "mesh_capability_invocation_not_callable");
    }
    options.signal?.throwIfAborted();
    if (!intent) intent = await this.createIntentForCallableActivation(
      normalized, invocationId, idempotencyKey, inputSha256, activation, descriptor,
    );
    assertDispatchIntentMatches(intent, normalized, invocationId, idempotencyKey, inputSha256);

    // Vault storage is a purely in-process staging write with no external
    // exposure, so it runs BEFORE the fence: vault-capacity exhaustion then
    // rejects as a clean pre-dispatch block (M4 fold of the M3 review Minor)
    // instead of a post-fence dispatch failure.
    this.storeVaultInput(normalized.workspaceId, invocationId, inputCanonicalJson, inputSha256, intent.deadlineAt);
    const stagedKey = vaultKey(normalized.workspaceId, invocationId);
    const stagedInput = this.inputVault.get(stagedKey)!;
    // Fences can await approvals or durable claims. Re-read current activation
    // afterward, including when recovering a previously created intent.
    try {
      await options.executionFence?.();
      await this.resolveCallableActivation(normalized.workspaceId, normalized.binding, normalized.capabilityId);
      options.signal?.throwIfAborted();
      if (Date.parse(intent.deadlineAt) <= this.now().getTime())
        throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
    } catch (error) {
      if (!stagedInput.dispatchStarted && this.inputVault.get(stagedKey) === stagedInput) this.inputVault.delete(stagedKey);
      throw error;
    }
    // Only input belonging to a dispatch that actually starts can be read by
    // the remote node. A guessed invocation ID cannot read pre-fence staging.
    const dispatchInput = this.inputVault.get(stagedKey);
    if (!dispatchInput) throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    dispatchInput.dispatchStarted = true;
    const envelope = buildDispatchEnvelope(intent);
    try {
      const sourceNodeId = this.transport.localNodeId();
      const event = await this.transport.appendEvent({
        sourceNodeId,
        eventType: MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE,
        payload: envelope as unknown as Record<string, unknown>,
        idempotencyKey: intent.idempotencyKey,
      });
      if (event.sourceNodeId !== sourceNodeId || event.eventType !== MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE ||
        event.idempotencyKey !== intent.idempotencyKey || canonicalJsonString(event.payload) !== canonicalJsonString(envelope))
        throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_conflict");
      const currentInput = this.inputVault.get(stagedKey);
      if (currentInput) currentInput.dispatchEnvelope = Object.freeze({ ...envelope });
    } catch {
      // The append outcome is unknowable after a transport error: treat the
      // delivery as ambiguous, settle a bounded terminal state, and flag it.
      const settlement = await this.settleAsGateway(intent, "unknown", "mesh_capability_dispatch_transport_failed");
      return this.buildGatewaySettledOutcome(normalized.workspaceId, intent, settlement, {
        disposition: "unknown",
        errorCode: "mesh_capability_dispatch_transport_failed",
      });
    }
    await this.publishRealtime?.("mesh_capability_invocation_dispatched", "mesh", {
      workspaceId: intent.workspaceId,
      invocationId: intent.invocationId,
      capabilityId: intent.capabilityId,
      nodeId: intent.nodeId,
      activationId: intent.activationId,
      publisherGeneration: intent.publisherGeneration,
      deadlineAt: intent.deadlineAt,
    });
    return await this.awaitSettlement(intent, options.signal);
  }

  /**
   * Node-facing transient input read. The node identity is admission-bound;
   * only the dispatched node of an unsettled, un-expired invocation can read
   * the exact input bytes whose digest the envelope binds. After a Gateway
   * restart the transient bytes are gone and the read fails content-free.
   */
  public async readInvocationInput(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    invocationId: string,
  ): Promise<MeshCapabilityInvocationInputResponse> {
    const { intent, entry } = await this.prepareNodeInputRead(identity, invocationId);
    const activations = await this.storage.meshCapabilityPublications.listCallableActivations(identity.workspaceId);
    if (!activations.some((activation) => activationMatchesIntent(activation, intent)))
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
    if (Date.parse(intent.deadlineAt) <= this.now().getTime())
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
    return {
      invocationId: intent.invocationId,
      inputSha256: intent.inputSha256,
      input: JSON.parse(entry.inputCanonicalJson) as Record<string, unknown>,
    };
  }

  /**
   * Bounded admitted-node polling over confirmed replication deliveries. This
   * reveals neither another node's work nor the general replication log. An
   * envelope is discoverable only while this process can serve its exact input;
   * restart never manufactures missing bytes or authorizes a second execution.
   * Polling is a read, not an execution claim: consumers must retain their own
   * execution/settlement evidence before crossing an effect boundary.
   */
  public async listPendingInvocations(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
  ): Promise<MeshCapabilityInvocationPendingList> {
    this.sweepVault();
    const candidates = [...this.inputVault.values()]
      .map((entry) => entry.dispatchEnvelope)
      .filter((envelope) => envelope?.workspaceId === identity.workspaceId && envelope.nodeId === identity.nodeId);
    const prepared: MeshCapabilityInvocationIntentRecord[] = [];
    for (const envelope of candidates) {
      if (!envelope) continue;
      try {
        prepared.push((await this.prepareNodeInputRead(identity, envelope.invocationId)).intent);
      } catch (error) {
        if (!(error instanceof MeshCapabilityInvocationServiceError) ||
          !["mesh_capability_invocation_not_found", "mesh_capability_invocation_not_callable"].includes(error.code))
          throw error;
      }
    }
    if (!prepared.length) return { items: [] };
    // Read current callability once, after gathering immutable identities and
    // settlement state. Revocation, health, admission and lease checks remain
    // owned by storage's database-clock projection.
    const activations = new Map((await this.storage.meshCapabilityPublications.listCallableActivations(identity.workspaceId))
      .map((activation) => [activation.activationId, activation]));
    return { items: prepared.filter((intent) => {
      const activation = activations.get(intent.activationId);
      return activation && activationMatchesIntent(activation, intent) && Date.parse(intent.deadlineAt) > this.now().getTime();
    }).map(buildDispatchEnvelope) };
  }

  /**
   * Bounded, generation-fenced progress ingestion. Progress is transient
   * observability — it never mutates durable invocation state.
   */
  public async recordProgress(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityNodeProgressSubmission,
  ): Promise<{ accepted: true; sequence: number }> {
    const intent = await this.requireIntentForNode(identity, submission.invocationId);
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
    const settled = await this.storage.meshCapabilityPublications.findInvocationSettlement(
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
    await this.publishRealtime?.("mesh_capability_invocation_progress", "mesh", {
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
  public async settleFromNode(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityNodeSettlementSubmission,
  ): Promise<{ settlement: MeshCapabilityInvocationSettlementRecord; replayed: boolean }> {
    try {
      const canonical = canonicalJsonString(submission);
      if (Buffer.byteLength(canonical, "utf8") > MAX_SETTLEMENT_OUTPUT_BYTES + 16 * 1024) throw new Error();
      submission = JSON.parse(canonical) as MeshCapabilityNodeSettlementSubmission;
    } catch { throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid"); }
    const authorityFence = resolveMeshCapabilityNodeAuthorityFence(identity);
    const intent = await this.requireIntentForNode(identity, submission.invocationId);
    if (
      submission.publisherGeneration !== intent.publisherGeneration ||
      submission.publicationLeaseFencingToken !== intent.publicationLeaseFencingToken
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_stale_generation");
    }
    const existing = await this.storage.meshCapabilityPublications.findInvocationSettlement(
      identity.workspaceId,
      submission.invocationId,
    );
    if (existing && (existing.disposition !== submission.disposition ||
      existing.outputSha256 !== submission.outputSha256 || existing.errorCode !== submission.errorCode ||
      existing.settlementSha256 !== submission.settlementSha256 ||
      existing.effectiveCostAttributionSha256 !== submission.effectiveCostAttributionSha256))
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_conflict");
    const output = await this.verifySettlementOutput(intent, submission);
    let settlement: MeshCapabilityInvocationSettlementRecord;
    try {
      const settlementInput = {
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
      };
      settlement = authorityFence
        ? await this.storage.meshCapabilityPublications.settleRemoteWorkerInvocation({ authorityFence, settlement: settlementInput })
        : await this.storage.meshCapabilityPublications.settleInvocation(settlementInput);
    } catch (error) {
      throw await this.mapSettlementWriteError(identity.workspaceId, submission.invocationId, error);
    }
    if (output) {
      this.storeVaultOutput(identity.workspaceId, submission.invocationId, output, submission.outputSha256);
    }
    this.clearProgressTracking(identity.workspaceId, submission.invocationId);
    await this.publishRealtime?.("mesh_capability_invocation_settled", "mesh", {
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
  public async resolveModelUsageAttribution(
    workspaceId: string,
    invocationId: string,
  ): Promise<ModelUsageAttributionContext> {
    const intent = await this.storage.meshCapabilityPublications.findInvocationIntent(workspaceId, invocationId);
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
  public async reconcileExpiredInvocationIntents(
    workspaceId: string,
    limit = EXPIRED_INTENT_RECONCILE_BATCH,
  ): Promise<number> {
    const expired = await this.storage.meshCapabilityPublications.listUnsettledExpiredInvocationIntents(
      workspaceId,
      Math.max(1, Math.min(limit, 64)),
    );
    let reconciled = 0;
    for (const intent of expired) {
      const settlement = await this.settleAsGateway(intent, "unknown", "mesh_capability_dispatch_deadline_expired");
      if (settlement) {
        reconciled += 1;
        await this.publishRealtime?.("mesh_capability_invocation_reconciled", "mesh", {
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

  private async createIntentForCallableActivation(
    input: ReturnType<typeof normalizeDispatchInput>,
    invocationId: string,
    idempotencyKey: string,
    inputSha256: string,
    activation: MeshCapabilityActivationRecord,
    descriptor: MeshCapabilityDescriptor,
  ): Promise<MeshCapabilityInvocationIntentRecord> {
    const limits = descriptor.resourceLimits;
    const deadlineMs = Math.max(MINIMUM_DISPATCH_DEADLINE_MS, limits.timeoutMs - this.deadlineSafetyMarginMs);
    const deadlineAt = new Date(this.now().getTime() + deadlineMs).toISOString();
    try {
      return await this.storage.meshCapabilityPublications.createInvocationIntent({
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

  private async resolveCallableActivation(
    workspaceId: string,
    binding: ChatTurnCapabilityToolMeshPublicationBinding,
    capabilityId: string,
  ): Promise<MeshCapabilityActivationRecord> {
    const activation = (await this.storage.meshCapabilityPublications.listCallableActivations(workspaceId)).find(
      (candidate) => candidate.activationId === binding.activationId,
    );
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

  private async resolveDeclaredDescriptor(activation: Pick<MeshCapabilityActivationRecord,
    "workspaceId" | "nodeId" | "publisherGeneration" | "manifestSha256" | "capabilityId" |
    "entrySha256" | "descriptorSha256" | "permissionEnvelopeSha256">): Promise<MeshCapabilityDescriptor> {
    let entryDescriptor: MeshCapabilityDescriptor;
    try {
      const manifest = await this.storage.meshCapabilityPublications.getManifest(
        activation.workspaceId,
        activation.nodeId,
        activation.publisherGeneration,
        activation.manifestSha256,
      );
      const entry = manifest.entries.find(
        (candidate) =>
          candidate.capabilityId === activation.capabilityId && candidate.entrySha256 === activation.entrySha256,
      );
      if (!entry || manifest.workspaceId !== activation.workspaceId || manifest.nodeId !== activation.nodeId ||
        manifest.publisherGeneration !== activation.publisherGeneration || manifest.manifestSha256 !== activation.manifestSha256 ||
        entry.descriptorSha256 !== activation.descriptorSha256 || entry.permissionEnvelopeSha256 !== activation.permissionEnvelopeSha256 ||
        entry.descriptor.kind === "skill") {
        throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
      }
      entryDescriptor = entry.descriptor;
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
    return entryDescriptor;
  }

  private async awaitSettlement(
    intent: MeshCapabilityInvocationIntentRecord,
    signal?: AbortSignal,
  ): Promise<MeshCapabilityInvocationDispatchOutcome> {
    const deadlineMs = Date.parse(intent.deadlineAt);
    for (;;) {
      const settlement = await this.storage.meshCapabilityPublications.findInvocationSettlement(
        intent.workspaceId,
        intent.invocationId,
      );
      if (settlement) {
        return this.buildSettledOutcome(intent.workspaceId, intent, intent.invocationId, settlement);
      }
      if (signal?.aborted) {
        const written = await this.settleAsGateway(intent, "cancelled", "mesh_capability_dispatch_cancelled");
        return this.buildGatewaySettledOutcome(intent.workspaceId, intent, written, {
          disposition: "cancelled",
          errorCode: "mesh_capability_dispatch_cancelled",
        });
      }
      if (this.now().getTime() >= deadlineMs) {
        const written = await this.settleAsGateway(intent, "unknown", "mesh_capability_dispatch_deadline_expired");
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
  private async settleAsGateway(
    intent: MeshCapabilityInvocationIntentRecord,
    disposition: MeshCapabilitySettlementDisposition,
    errorCode: string,
  ): Promise<MeshCapabilityInvocationSettlementRecord | undefined> {
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
      const settlement = await this.storage.meshCapabilityPublications.settleInvocation({
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
      await this.publishRealtime?.("mesh_capability_invocation_settled", "mesh", {
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
      const settlement = await this.storage.meshCapabilityPublications.findInvocationSettlement(
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

  private async mapSettlementWriteError(
    workspaceId: string,
    invocationId: string,
    error: unknown,
  ): Promise<MeshCapabilityInvocationServiceError | Error> {
    if (error instanceof MeshCapabilityInvocationServiceError) return error;
    if (error instanceof NotFoundError)
      return new MeshCapabilityInvocationServiceError("mesh_capability_settlement_stale_generation");
    if (error instanceof ConflictError) {
      if (/different request bytes/iu.test(error.message)) {
        return new MeshCapabilityInvocationServiceError("mesh_capability_settlement_conflict");
      }
      const existing = await this.storage.meshCapabilityPublications.findInvocationSettlement(
        workspaceId,
        invocationId,
      );
      return new MeshCapabilityInvocationServiceError(
        existing ? "mesh_capability_settlement_conflict" : "mesh_capability_settlement_stale_generation",
      );
    }
    if (error instanceof TypeError) {
      return new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async verifySettlementOutput(
    intent: MeshCapabilityInvocationIntentRecord,
    submission: MeshCapabilityNodeSettlementSubmission,
  ): Promise<Record<string, unknown> | undefined> {
    if (submission.output === undefined) {
      if (submission.disposition === "succeeded")
        throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
      return undefined;
    }
    if (
      submission.disposition !== "succeeded" ||
      submission.output === null ||
      typeof submission.output !== "object" ||
      Array.isArray(submission.output) ||
      submission.outputSha256 === undefined
    ) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    const canonical = canonicalJsonString(submission.output);
    let descriptor: MeshCapabilityDescriptor;
    try { descriptor = await this.resolveDeclaredDescriptor(intent); }
    catch { throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid"); }
    const maxResponseBytes = Math.min(descriptor.resourceLimits.maxResponseBytes, MAX_SETTLEMENT_OUTPUT_BYTES);
    if (Buffer.byteLength(canonical, "utf8") > maxResponseBytes) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    if (sha256Utf8(canonical) !== submission.outputSha256) {
      throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid");
    }
    try { await validateMeshCapabilityOutput(descriptor, canonical); }
    catch { throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid"); }
    // Validation can await its isolated worker. Commit the bytes it checked,
    // never a caller-owned object that may have changed during that wait.
    return JSON.parse(canonical) as Record<string, unknown>;
  }

  private async requireIntentForNode(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    invocationId: string,
  ): Promise<MeshCapabilityInvocationIntentRecord> {
    return requireMeshInvocationIntentForNode(this.storage, identity, invocationId);
  }

  private async prepareNodeInputRead(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    invocationId: string,
  ): Promise<{ intent: MeshCapabilityInvocationIntentRecord; entry: InputVaultEntry }> {
    return prepareMeshInvocationInputRead(
      this.storage,
      (workspaceId, id) => this.readVaultEntry(workspaceId, id),
      this.now,
      identity,
      invocationId,
    );
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
      dispatchStarted: existing?.dispatchStarted ?? false,
      ...(existing?.dispatchEnvelope === undefined ? {} : { dispatchEnvelope: existing.dispatchEnvelope }),
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

function activationMatchesIntent(
  activation: MeshCapabilityActivationRecord,
  intent: MeshCapabilityInvocationIntentRecord,
): boolean {
  return (["workspaceId", "activationId", "activationRevision", "capabilityId", "nodeId", "publisherGeneration",
    "healthGeneration", "publicationLeaseFencingToken", "manifestSha256", "entrySha256", "descriptorSha256",
    "permissionEnvelopeSha256"] as const).every((key) => activation[key] === intent[key]);
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

function assertDispatchIntentMatches(
  intent: MeshCapabilityInvocationIntentRecord,
  input: MeshCapabilityInvocationDispatchInput,
  invocationId: string,
  idempotencyKey: string,
  inputSha256: string,
): void {
  // Invocation IDs intentionally remain stable per tool run. They cannot stand
  // in for the immutable execution and approval lineage retained by storage.
  const expected = {
    workspaceId: input.workspaceId, invocationId, idempotencyKey, inputSha256,
    sessionId: input.sessionId, turnId: input.turnId, runId: input.runId, approvalId: input.approvalId,
    executionProfileSha256: input.executionProfileSha256, capabilityId: input.capabilityId,
    nodeId: input.binding.nodeId, activationId: input.binding.activationId,
    activationRevision: input.binding.activationRevision, publisherGeneration: input.binding.publisherGeneration,
    publicationLeaseFencingToken: input.binding.publicationLeaseFencingToken,
    manifestSha256: input.binding.manifestSha256, entrySha256: input.binding.entrySha256,
    permissionEnvelopeSha256: input.binding.permissionEnvelopeSha256, healthGeneration: input.binding.healthGeneration,
  } satisfies Partial<MeshCapabilityInvocationIntentRecord>;
  if ((Object.keys(expected) as Array<keyof typeof expected>).some((key) => intent[key] !== expected[key])) {
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_conflict");
  }
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
    binding: { ...input.binding },
    capabilityId: id(input.capabilityId, 512),
    args: JSON.parse(canonicalJsonString(input.args)) as Record<string, unknown>,
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
