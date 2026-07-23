/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import type {
  ApprovalEffectRecord,
  ApprovalInboxItemState,
  ApprovalObservabilityAttribution,
  ApprovalObservabilityDelivery,
  ApprovalObservabilityEnvelope,
  ApprovalObservabilityEffectInput as ApprovalObservabilityEffectInputContract,
  ApprovalRequest,
  RealtimeEvent,
  ApprovalResolveInput,
  ChatCitationRecord,
  ChatDelegationRunStatus,
  ChatDelegationStepRecord,
  ChatExecutionPlanStepRecord,
  ChatMessageRecord,
  ChatTurnTraceRecord,
  PendingApprovalAction,
  DurableWakeResult,
  DurableRunRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
  MEMORY_LIFECYCLE_APPROVAL_KIND,
  MEMORY_LIFECYCLE_EFFECT_KIND,
  MEMORY_LIFECYCLE_EFFECT_TARGET_KIND,
  MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
  assertExternalSourceKnowledgeSnapshotApprovalPayload,
  assertMeshCapabilityActivationApprovalPayload,
  buildToolEffectEvidence,
  canonicalJsonString,
  ConflictError,
  isChatTurnTerminalStatus,
  NotFoundError,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type MeshCapabilityActivationApprovalPayload,
} from "@goatcitadel/contracts";
import {
  buildApprovalEffectIdempotencyKey,
  getRequestAttribution,
  runWithIsolatedRequestAttribution,
  type PostCommitEligibility,
  type Storage,
} from "@goatcitadel/storage";
import {
  MeshCapabilityActivationServiceError,
  type MeshCapabilityActivationApplyResult,
} from "./mesh-capability-activation-service.js";
import { MemoryLifecycleApplyError } from "./memory-domain-journey-producer.js";
import { parseMemoryLifecycleApprovalBinding } from "./memory-journey-producer.js";
import type { MemoryLifecycleApplyResult } from "./memory-lifecycle-service.js";
import { APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
import {
  ExternalSourceKnowledgeEffectServiceError,
  deriveExternalSourceKnowledgeSnapshotMaterializedIdentities,
  type ExternalSourceKnowledgeSnapshotApplyResult,
} from "./external-source-knowledge-effect-service.js";
import type { ExternalSourceRequestActor } from "./external-source-service.js";
import { materializeApprovedSkillHubIntent, type SkillHubLifecycleApplyResult } from "./skill-hub-lifecycle-service.js";
import type { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";
import {
  AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  markTerminalChatPostCommitPending,
  mergeCanonicalDurableChatTerminalOutputMetadata,
  resetChatTurnRuntimeTransitionMetadata,
} from "./chat-durable-run-service.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  buildChatTurnRuntimeAuthoritySeal,
  readChatTurnRuntimeAuthoritySeal,
  readExactGeneralChatPostCommitPendingMarker,
  readExactGeneralChatPostCommitSettlement,
  verifyAutonomousChatAdmissionRunMetadata,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { assertDurableRetryPolicyMatchesRun, DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
  reconstructAdmittedChatTurnRequest,
} from "./session-control-service.js";
import { readToolDomainExecutionFailure, type ToolDomainExecutionFailure } from "./tool-domain-result-truth.js";
import type { SharedHostLifecycleAdmissionPort, SharedHostWorkReservation } from "./shared-host-lifecycle-service.js";

export type ApprovalObservabilityEffectInput = ApprovalObservabilityEffectInputContract;

export interface ApprovalResolutionEffectEnqueueOptions {
  /**
   * Expiry reconciliation resolves the canonical approval as a system
   * rejection after its deadline. Those terminal transitions still need to
   * release durable waiters and linked Chat work even though resolvedAt is
   * necessarily later than expiresAt.
   */
  allowExpired?: boolean;
}

const APPROVAL_EFFECT_LEASE_TTL_MS = 15_000;
const APPROVAL_EFFECT_HEARTBEAT_MS = 5_000;
const APPROVAL_EFFECT_POLL_MIN_MS = 1_000;
const APPROVAL_EFFECT_POLL_JITTER_MS = 500;
const APPROVAL_EFFECT_CHILD_WAIT_RETRY_MS = 2_000;
const APPROVAL_EFFECT_CODE_MODE_CLAIM_RETRY_MS = 1_000;
const APPROVAL_OBSERVABILITY_RETRY_BASE_MS = 1_000;
const APPROVAL_OBSERVABILITY_RETRY_MAX_MS = 5 * 60_000;
const APPROVAL_OBSERVABILITY_PREDECESSOR_RETRY_MS = 250;
const APPROVAL_WAIT_MATERIALIZE_RETRY_MS = 1_000;
const APPROVAL_EXPIRY_SWEEP_INTERVAL_MS = 1_000;
const APPROVAL_EFFECT_RESPONSE_SETTLE_MS = 500;
const APPROVAL_MATERIALIZED_POST_COMMIT_METADATA_KEY = "approvalMaterializedPostCommit";
export const MESH_CAPABILITY_ACTIVATION_EFFECT_KIND = "mesh_capability_activation_apply" as const;
export const MESH_CAPABILITY_ACTIVATION_EFFECT_TARGET_KIND = "mesh_capability_activation" as const;

interface ApprovalMaterializationPostCommitInput {
  approvalId: string;
  turnId: string;
  traceStatus: ChatTurnTraceRecord["status"];
  materializationKey?: string;
}

interface ApprovalMaterializedPostCommitReceipt {
  approvalId: string;
  turnId: string;
  traceStatus?: ChatTurnTraceRecord["status"];
  materializationKey?: string;
}

interface DelegationParentMaterialization {
  trace: ChatTurnTraceRecord;
  runId: string;
}

interface ChatMaterializationProjection {
  operationId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  options: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;
}

function buildApprovalTerminalCheckpointState(
  input: Record<string, unknown>,
  terminalStatus: "completed" | "failed",
  assistantMessageId: string,
  outputText: string,
  outputSummary: string,
): Record<string, unknown> {
  const checkpoint = { ...input };
  for (const key of ["finalOutput", "finalSummary", "outputMessageId", "outputTraceStatus"]) {
    delete checkpoint[key];
  }
  if (terminalStatus === "completed") {
    return { ...checkpoint, assistantMessageId, outputText, outputSummary };
  }
  for (const key of ["assistantMessageId", "outputText", "outputSummary"]) {
    delete checkpoint[key];
  }
  return checkpoint;
}

function requireExactApprovalChatParentAuthority(
  storage: ApprovalEffectsServiceContext["storage"],
  run: DurableRunRecord,
  trace: ChatTurnTraceRecord | undefined,
  expectedTurnId: string,
): { sessionId: string } {
  const payload =
    run.payload && typeof run.payload === "object" && !Array.isArray(run.payload)
      ? (run.payload as Record<string, unknown>)
      : {};
  const request = payload.request;
  const requestActor = payload.requestActor;
  if (
    run.workflowKey !== "chat.turn.execute" ||
    run.status !== "waiting" ||
    payload.version !== "chat.turn.execute.v2" ||
    typeof payload.admissionId !== "string" ||
    typeof payload.sessionIncarnationId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.turnId !== "string" ||
    typeof payload.userMessageId !== "string" ||
    typeof payload.assistantMessageId !== "string" ||
    typeof payload.admissionMaterialSha256 !== "string" ||
    typeof payload.effectiveRequestMaterialSha256 !== "string" ||
    !Number.isSafeInteger(payload.admissionAggregateRevision) ||
    !Number.isSafeInteger(payload.admissionControllerGeneration) ||
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    !requestActor ||
    typeof requestActor !== "object" ||
    Array.isArray(requestActor) ||
    payload.turnId !== expectedTurnId ||
    !trace ||
    trace.turnId !== payload.turnId ||
    trace.sessionId !== payload.sessionId ||
    trace.userMessageId !== payload.userMessageId ||
    trace.assistantMessageId !== payload.assistantMessageId ||
    (trace.status !== "waiting_for_approval" && trace.status !== "running")
  ) {
    throw new Error(`Durable run ${run.runId} has no canonical Chat parent context for approval post-commit.`);
  }
  const admission = storage.sessionMutationAdmissions.require(payload.admissionId);
  const admittedRequest = reconstructAdmittedChatTurnRequest(request as never, payload.surfaceDerivation as never);
  if (
    admission.admissionKind !== "turn_write" ||
    admission.sessionIncarnationId !== payload.sessionIncarnationId ||
    admission.workspaceId !== payload.workspaceId ||
    admission.sessionId !== payload.sessionId ||
    admission.turnId !== payload.turnId ||
    admission.materialSha256 !== payload.admissionMaterialSha256 ||
    admission.aggregateRevision !== payload.admissionAggregateRevision ||
    admission.controllerGeneration !== payload.admissionControllerGeneration ||
    admission.actorKind !== (requestActor as Record<string, unknown>).actorKind ||
    admission.actorId !== (requestActor as Record<string, unknown>).actorId ||
    computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest) !== payload.admissionMaterialSha256 ||
    computeEffectiveChatTurnRequestMaterialSha256(payload.admissionMaterialSha256, request as never) !==
      payload.effectiveRequestMaterialSha256
  ) {
    throw new Error(`Durable run ${run.runId} approval parent drifted from its mutation admission.`);
  }
  assertDurableRetryPolicyMatchesRun(run.metadata?.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
  if (run.metadata?.autonomousAdmission !== undefined) {
    verifyAutonomousChatAdmissionRunMetadata(run, { admission, trace });
  } else if (
    run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
    run.metadata?.autonomousChatPostCommit !== undefined
  ) {
    throw new Error(`Durable run ${run.runId} carries autonomous finalizer evidence without autonomous admission.`);
  }
  const authority = readChatTurnRuntimeAuthoritySeal(run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
  if (
    !authority ||
    authority.material.runId !== run.runId ||
    authority.material.turnId !== payload.turnId ||
    authority.material.transitionKind !== "waiting" ||
    authority.material.durableStatus !== "waiting" ||
    authority.material.traceStatus !== "waiting_for_approval" ||
    canonicalJsonString(run.metadata?.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent)
  ) {
    throw new Error(`Durable run ${run.runId} has no exact waiting approval runtime authority.`);
  }
  const checkpoint = storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_waiting");
  if (!checkpoint) {
    throw new Error(`Durable run ${run.runId} has no latest waiting approval authority checkpoint.`);
  }
  verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
  if (
    ["outputText", "finalOutput", "outputSummary", "finalSummary", "outputMessageId", "outputTraceStatus"].some(
      (key) => run.metadata?.[key] !== undefined,
    ) ||
    ["assistantMessageId", "outputText", "outputSummary", "outputMessageId", "outputTraceStatus"].some(
      (key) => checkpoint.state[key] !== undefined,
    ) ||
    run.metadata?.linkedFinalizationPending !== undefined ||
    run.metadata?.linkedFinalization !== undefined ||
    run.metadata?.chatTurnAdmissionHandoff !== undefined
  ) {
    throw new Error(`Durable run ${run.runId} carries stale terminal evidence while waiting for approval.`);
  }
  const pending = readExactGeneralChatPostCommitPendingMarker(
    run.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
  );
  const settlement = readExactGeneralChatPostCommitSettlement(run.metadata?.generalChatPostCommit);
  const matchingPending =
    pending &&
    pending.generationId === authority.material.postCommitGenerationId &&
    pending.traceStatus === authority.material.traceStatus &&
    pending.requestedAt === authority.material.transitionAt &&
    canonicalJsonString(pending.postCommitEligibility) ===
      canonicalJsonString(authority.material.postCommitEligibility);
  const matchingSettlement =
    settlement &&
    settlement.generationId === authority.material.postCommitGenerationId &&
    settlement.traceStatus === authority.material.traceStatus &&
    settlement.requestedAt === authority.material.transitionAt &&
    canonicalJsonString(settlement.postCommitEligibility) ===
      canonicalJsonString(authority.material.postCommitEligibility) &&
    (settlement.settlementStatus === "completed" || settlement.settlementStatus === "settled_with_failures") &&
    typeof settlement.completedAt === "string";
  if (Boolean(pending) === Boolean(settlement) || (!matchingPending && !matchingSettlement)) {
    throw new Error(`Durable run ${run.runId} waiting approval finalizer drifted from runtime authority.`);
  }
  return { sessionId: payload.sessionId };
}

export interface ApprovalChatTurnResumeResult {
  resumed: boolean;
  turnId?: string;
  durableRunId?: string;
  wakeOutcome?: DurableWakeResult["outcome"];
}

export interface ApprovalResolutionEffectsResult {
  approvalWaitDurableRunId?: string;
  proactiveRunIds: string[];
  chatTurnResume: ApprovalChatTurnResumeResult;
}

export interface ApprovalEffectsServiceDeps {
  backgroundTasks: Set<Promise<void>>;
  sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
  ): DurableWakeResult;
  requestRunProcessing(runId: string): void;
  findProactiveDurableRunIdsForApproval(approvalId: string): string[];
  executeCodeModePendingApproval(approvalId: string, signal?: AbortSignal): Promise<ToolInvokeResult | undefined>;
  executeApprovedPendingAction(approvalId: string, signal?: AbortSignal): Promise<ToolInvokeResult | undefined>;
  executeApprovedSkillHubLifecycleOperation?(
    operationId: string,
    approvalId: string,
    requestSha256: string,
    signal?: AbortSignal,
  ): Promise<SkillHubLifecycleApplyResult>;
  /**
   * HX-407 C4: executes one approved `external_source.knowledge_snapshot`
   * recovery through the composed C2 effect service. The executor revalidates
   * the approval, the full C1 identity chain, current deny-wins policy, and
   * the managed artifact, and converges on the deterministic terminal effect
   * row this worker claimed.
   */
  executeApprovedExternalSourceKnowledgeSnapshot?(
    input: { workspaceId: string; approvalId: string },
    actor: ExternalSourceRequestActor,
    signal?: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotApplyResult>;
  /**
   * HX-408 M2: executes one approved `mesh.capability.activate` through the
   * composed activation owner. The executor revalidates the approval, rebuilds
   * the exact activation input from live durable state (recovering the
   * requester from the request Journey evidence), verifies the approved
   * requestSha256 byte-exactly, and lets the storage activation guard
   * re-verify binding, health, lease, and caps inside its transaction.
   */
  executeApprovedMeshCapabilityActivation?(input: {
    workspaceId: string;
    approvalId: string;
  }): MeshCapabilityActivationApplyResult;
  /**
   * HX-402 P1: executes one approved `memory.lifecycle` mutation through the
   * memory lifecycle owner. The executor revalidates the exact approval
   * (kind, deterministic identity, workspace linkage, status, expiry),
   * recovers the requester from the immutable request Journey evidence,
   * byte-verifies the approved requestSha256 against the rebuilt mutation,
   * re-checks current policy, and executes only through the approved producer
   * (which revalidates everything again inside its own transaction).
   */
  executeApprovedMemoryLifecycleMutation?(input: {
    workspaceId: string;
    approvalId: string;
  }): MemoryLifecycleApplyResult;
  enqueueAfterHooks(input: {
    workspaceId: string;
    trigger: "approval.resolve.after" | "approval.response.after";
    entityType: "approval";
    entityId: string;
    payload: Record<string, unknown>;
  }): void;
  resolveApprovalHookWorkspaceId(payload: Record<string, unknown>): string;
  resolvePostCommitEligibility?(sessionId: string): PostCommitEligibility;
  recordDurableTimelineEvent?(
    runId: string,
    eventType: "run_completed" | "run_failed",
    payload?: Record<string, unknown>,
  ): void;
  recordApprovalResolutionSignals?(approval: ApprovalRequest): void;
  materializeApprovalWaitRun?(approvalId: string): DurableRunRecord | undefined;
  reconcileExpiredApprovals?(limit: number): number;
  reconcileExpiredDeviceAccessRequests?(limit: number): Promise<number> | number;
  readonly approvalRemoteTokenSecrets?: Pick<ApprovalRemoteTokenSecretService, "reconcileExpired" | "deleteById">;
}

export interface ApprovalEffectsServiceContext {
  readonly storage: Pick<
    Storage,
    | "approvalEffects"
    | "approvals"
    | "skillHubOperations"
    | "approvalWaitRuns"
    | "pendingApprovalActions"
    | "approvalInbox"
    | "remoteActionTokens"
    | "chatInlineApprovals"
    | "chatMessages"
    | "chatToolRuns"
    | "chatDelegationSteps"
    | "chatDelegationRuns"
    | "chatExecutionPlans"
    | "chatTurnTraces"
    | "durableRuns"
    | "sessionMutationAdmissions"
    | "runImmediateTransaction"
    | "orchestration"
    | "audit"
  >;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

export class ApprovalEffectsService {
  private workerActive = false;
  private observabilityWorkerActive = false;
  private workerRequested = false;
  private observabilityWorkerRequested = false;
  private workerStopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workerId = randomUUID();
  private readonly observabilityWorkerId = randomUUID();
  private readonly activeEffectAbortControllers = new Map<string, AbortController>();
  private actionWorkerTask: Promise<void> | undefined;
  private lastExpirySweepAtMs = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly ctx: ApprovalEffectsServiceContext,
    private readonly deps: ApprovalEffectsServiceDeps,
  ) {}

  public startWorker(): void {
    this.workerStopped = false;
    this.ensurePollLoop();
    this.requestEffectProcessing();
  }

  public stopWorker(): void {
    this.workerStopped = true;
    this.workerRequested = false;
    this.observabilityWorkerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const [effectId, controller] of this.activeEffectAbortControllers.entries()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`Approval effect ${effectId} aborted because the worker stopped.`));
      }
    }
    this.activeEffectAbortControllers.clear();
  }

  /** Stop future claims while allowing the currently admitted effect to settle. */
  public stopAdmission(): void {
    this.workerStopped = true;
    this.workerRequested = false;
    this.observabilityWorkerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public requestEffectProcessing(): void {
    this.requestActionEffectProcessing();
    this.requestObservabilityEffectProcessing();
  }

  private requestActionEffectProcessing(): void {
    if (this.workerStopped) {
      return;
    }
    this.workerRequested = true;
    if (this.workerActive) {
      return;
    }
    this.workerActive = true;
    const reservation = this.reserveWorker("approval-effects-action");
    if (reservation === null) {
      this.workerActive = false;
      this.workerRequested = false;
      return;
    }
    const backgroundTasks = this.deps.backgroundTasks;
    const task = runWithIsolatedRequestAttribution({}, () =>
      Promise.resolve().then(async () => {
        try {
          do {
            this.workerRequested = false;
            await this.drainPendingEffects();
          } while (this.workerRequested && !this.workerStopped);
        } catch (error) {
          this.publishWorkerFailure("action", error);
        } finally {
          this.workerActive = false;
          backgroundTasks.delete(task);
          if (this.actionWorkerTask === task) {
            this.actionWorkerTask = undefined;
          }
          reservation?.release();
        }
      }),
    );
    this.actionWorkerTask = task;
    backgroundTasks.add(task);
  }

  private requestObservabilityEffectProcessing(): void {
    if (this.workerStopped) {
      return;
    }
    this.observabilityWorkerRequested = true;
    if (this.observabilityWorkerActive) {
      return;
    }
    this.observabilityWorkerActive = true;
    const reservation = this.reserveWorker("approval-effects-observability");
    if (reservation === null) {
      this.observabilityWorkerActive = false;
      this.observabilityWorkerRequested = false;
      return;
    }
    const backgroundTasks = this.deps.backgroundTasks;
    const task = runWithIsolatedRequestAttribution({}, () =>
      Promise.resolve().then(async () => {
        try {
          do {
            this.observabilityWorkerRequested = false;
            await this.drainPendingObservabilityEffects();
          } while (this.observabilityWorkerRequested && !this.workerStopped);
        } catch (error) {
          this.publishWorkerFailure("observability", error);
        } finally {
          this.observabilityWorkerActive = false;
          backgroundTasks.delete(task);
          reservation?.release();
        }
      }),
    );
    backgroundTasks.add(task);
  }

  private reserveWorker(label: string): SharedHostWorkReservation | undefined | null {
    const admission = this.deps.sharedHostLifecycle?.tryReserve("worker", `${label}:${this.workerId}:${randomUUID()}`);
    if (!admission) return undefined;
    if (!admission.admitted) return null;
    const stopOnForceDrain = () => this.stopWorker();
    admission.reservation.signal.addEventListener("abort", stopOnForceDrain, { once: true });
    const release = admission.reservation.release.bind(admission.reservation);
    return {
      ...admission.reservation,
      release: () => {
        admission.reservation.signal.removeEventListener("abort", stopOnForceDrain);
        release();
      },
    };
  }

  private publishWorkerFailure(lane: "action" | "observability", error: unknown): void {
    try {
      this.ctx.publishRealtime("approval_effect_worker_failed", "approvals", {
        lane,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (diagnosticError) {
      void diagnosticError;
      // The durable effect row and its lease remain the recovery authority when
      // the realtime diagnostic sink is unavailable too.
    }
  }

  public listByApproval(approvalId: string): ApprovalEffectRecord[] {
    return this.ctx.storage.approvalEffects.listByApproval(approvalId);
  }

  public async awaitResolutionEffects(
    approvalId: string,
    timeoutMs = APPROVAL_EFFECT_RESPONSE_SETTLE_MS,
  ): Promise<ApprovalEffectRecord[]> {
    this.requestActionEffectProcessing();
    const task = this.actionWorkerTask;
    if (task && timeoutMs > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          task,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
    return this.listByApproval(approvalId);
  }

  public enqueueObservabilityEffects(
    approvalIdInput: string,
    items: readonly ApprovalObservabilityEffectInput[],
  ): ApprovalEffectRecord[] {
    const approvalId = requireObservabilityIdentifier(approvalIdInput, "approvalId");
    const effects = this.ctx.storage.approvalEffects.upsertObservabilityBatch({
      approvalId,
      occurredAt: new Date().toISOString(),
      attribution: captureApprovalObservabilityAttribution(),
      items: items.map((input) => ({
        operationId: requireObservabilityIdentifier(input.operationId, "operationId"),
        delivery: input.delivery,
      })),
    });
    if (effects.length > 0) {
      this.requestEffectProcessing();
    }
    return effects;
  }

  public enqueueResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    options: ApprovalResolutionEffectEnqueueOptions = {},
  ): ApprovalEffectRecord[] {
    if (isExpiredApprovalRequest(approval) && !options.allowExpired) {
      return [];
    }
    const enqueued: ApprovalEffectRecord[] = [];
    const wakePayload = buildWakePayload(approval, input);
    if (approval.kind === "skill_hub.lifecycle" && input.decision === "approve") {
      const intent = materializeApprovedSkillHubIntent(approval);
      this.ctx.storage.skillHubOperations.createIntent(intent);
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "skill_hub_lifecycle_apply",
          targetKind: "skill_hub_operation",
          targetId: intent.operationId,
          payload: {
            operationId: intent.operationId,
            approvalId: intent.approvalId,
            requestSha256: intent.requestSha256,
          },
        }),
      );
    }
    if (approval.kind === EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND && input.decision === "approve") {
      enqueued.push(this.enqueueExternalSourceKnowledgeSnapshotApply(approval));
    }
    if (approval.kind === MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND && input.decision === "approve") {
      enqueued.push(this.enqueueMeshCapabilityActivationApply(approval));
    }
    if (approval.kind === MEMORY_LIFECYCLE_APPROVAL_KIND && input.decision === "approve") {
      enqueued.push(this.enqueueMemoryLifecycleApply(approval));
    }
    enqueued.push(
      this.ctx.storage.approvalEffects.upsert({
        approvalId: approval.approvalId,
        effectKind: "approval_resolution_signals",
        targetKind: "approval",
        targetId: approval.approvalId,
        payload: {
          decision: input.decision,
          resolvedBy: input.resolvedBy,
        },
      }),
    );
    const pendingAction = this.ctx.storage.pendingApprovalActions.find(approval.approvalId);
    if (
      (input.decision === "approve" && pendingAction?.resolutionStatus === "pending") ||
      (approval.kind === "code_mode.run" &&
        (input.decision === "approve" || input.decision === "reject") &&
        !pendingAction)
    ) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "pending_action_execute",
          targetKind: "pending_action",
          targetId: approval.approvalId,
          payload: {
            actionType: pendingAction?.actionType ?? "code_mode.run",
            pendingActionMissing: pendingAction ? undefined : true,
            decision: input.decision,
          },
        }),
      );
    }

    const approvalWaitRunId = this.ctx.storage.approvalWaitRuns.getRunId(approval.approvalId);
    if (approvalWaitRunId) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "approval_wait_wake",
          targetKind: "durable_run",
          targetId: approvalWaitRunId,
          payload: wakePayload,
        }),
      );
    }

    for (const proactiveRunId of this.deps.findProactiveDurableRunIdsForApproval(approval.approvalId)) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "proactive_run_wake",
          targetKind: "durable_run",
          targetId: proactiveRunId,
          payload: wakePayload,
        }),
      );
    }

    const linkedTurn = this.resolveLinkedTurnWakeTarget(approval);
    if (linkedTurn) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "linked_chat_turn_wake",
          targetKind: "chat_turn",
          targetId: linkedTurn.turnId,
          payload: {
            ...wakePayload,
            turnId: linkedTurn.turnId,
            runId: linkedTurn.runId,
          },
        }),
      );
    }

    for (const parentRun of this.resolveOrchestrationParentWakeTargets(approval)) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "orchestration_parent_wake",
          targetKind: "durable_run",
          targetId: parentRun.durableRunId,
          payload: {
            ...wakePayload,
            orchestrationRunId: parentRun.orchestrationRunId,
            childRunId: linkedTurn?.runId,
            childTurnId: linkedTurn?.turnId,
          },
        }),
      );
    }

    for (const parentTurn of this.resolveDelegationParentWakeTargets(approval)) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "linked_chat_turn_wake",
          targetKind: "chat_turn",
          targetId: parentTurn.turnId,
          payload: {
            ...wakePayload,
            turnId: parentTurn.turnId,
            runId: parentTurn.runId,
            childSessionId: parentTurn.childSessionId,
            delegationRunId: parentTurn.delegationRunId,
          },
        }),
      );
    }
    const remoteTokenTargets = new Map<string, { connectorId?: string }>();
    for (const token of this.ctx.storage.remoteActionTokens?.listByApprovalId?.(approval.approvalId) ?? []) {
      remoteTokenTargets.set(token.tokenId, { connectorId: token.connectorId });
    }
    if (approval.linkage?.tokenId && !remoteTokenTargets.has(approval.linkage.tokenId)) {
      remoteTokenTargets.set(approval.linkage.tokenId, { connectorId: approval.linkage.connectorId });
    }
    for (const [tokenId, token] of remoteTokenTargets) {
      const inboxItem = this.ctx.storage.approvalInbox.findByApprovalAndToken(approval.approvalId, tokenId);
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "approval_inbox_follow_up",
          targetKind: "remote_token",
          targetId: tokenId,
          payload: {
            connectorId: token.connectorId,
            inboxItemId: inboxItem?.inboxItemId,
            decision: input.decision,
            approvalStatus: approval.status,
            resolvedBy: input.resolvedBy,
            inboxState: options.allowExpired ? "expired" : undefined,
          },
        }),
      );
    }

    enqueued.push(
      this.ctx.storage.approvalEffects.upsert({
        approvalId: approval.approvalId,
        effectKind: "approval_after_hooks",
        targetKind: "approval",
        targetId: approval.approvalId,
        payload: {
          decision: input.decision,
          resolvedBy: input.resolvedBy,
        },
      }),
    );

    if (enqueued.length > 0) {
      this.requestEffectProcessing();
    }
    return enqueued;
  }

  /**
   * HX-407 C4: enqueue the approved knowledge-snapshot recovery on the SAME
   * deterministic effect identity the C2 materialization writes terminally
   * (`buildApprovalEffectIdempotencyKey` over approval/effect/target), with the
   * byte-identical canonical payload, so the pending row this resolution
   * creates and the terminal row the apply asserts are one row: a replayed
   * resolution converges on the completed effect instead of double-executing,
   * and the in-flight worker row satisfies the materialization's exact
   * payload assert. The payload is server-derived approval material; a
   * non-canonical payload fails the resolution loudly (fail closed).
   */
  private enqueueExternalSourceKnowledgeSnapshotApply(approval: ApprovalRequest): ApprovalEffectRecord {
    const payload = approval.payload as unknown as ExternalSourceKnowledgeSnapshotApprovalPayload;
    assertExternalSourceKnowledgeSnapshotApprovalPayload(payload);
    const identities = deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(payload);
    if (identities.approvalId !== approval.approvalId) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Approval ${approval.approvalId} payload does not derive its own knowledge-snapshot identity.`,
      });
    }
    // Canonical key order end-to-end: the stored payload_json must equal
    // canonicalJsonString(payload) byte-for-byte for the C2 insert-site assert.
    const effectPayload = JSON.parse(
      canonicalJsonString({
        ...payload,
        linkId: identities.linkId,
        knowledgeDocumentId: identities.knowledgeDocumentId,
      }),
    ) as Record<string, unknown>;
    return this.ctx.storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
      targetKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
      targetId: identities.targetId,
      idempotencyKey: identities.effectIdempotencyKey,
      payload: effectPayload,
    });
  }

  /**
   * HX-408 M2: enqueue the approved mesh capability activation on one
   * deterministic effect identity per activation, with a server-derived
   * payload copied from the immutable approval payload. The executor rebuilds
   * the exact activation input from live durable state and the storage
   * activation guard re-verifies everything inside its own transaction, so a
   * replayed resolution converges instead of double-activating.
   */
  private enqueueMeshCapabilityActivationApply(approval: ApprovalRequest): ApprovalEffectRecord {
    const payload = approval.payload as unknown as MeshCapabilityActivationApprovalPayload;
    assertMeshCapabilityActivationApprovalPayload(payload);
    return this.ctx.storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: MESH_CAPABILITY_ACTIVATION_EFFECT_KIND,
      targetKind: MESH_CAPABILITY_ACTIVATION_EFFECT_TARGET_KIND,
      targetId: payload.activationId,
      idempotencyKey: buildApprovalEffectIdempotencyKey({
        approvalId: approval.approvalId,
        effectKind: MESH_CAPABILITY_ACTIVATION_EFFECT_KIND,
        targetKind: MESH_CAPABILITY_ACTIVATION_EFFECT_TARGET_KIND,
        targetId: payload.activationId,
      }),
      payload: {
        workspaceId: payload.workspaceId,
        activationId: payload.activationId,
        activationRevision: payload.activationRevision,
        requestSha256: payload.requestSha256,
      },
    });
  }

  /**
   * HX-402 P1: enqueue the recovered `memory.lifecycle` mutation effect on one
   * deterministic effect identity per approval, with a server-derived
   * content-free payload verified against the immutable approval binding. The
   * executor and the approved producer revalidate everything again, so a
   * replayed resolution converges instead of double-mutating.
   */
  private enqueueMemoryLifecycleApply(approval: ApprovalRequest): ApprovalEffectRecord {
    const binding = parseMemoryLifecycleApprovalBinding(
      (approval.payload as Record<string, unknown> | undefined)?.memoryLifecycle,
    );
    if (!binding || approval.linkage?.workspaceId !== binding.workspaceId) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Approval ${approval.approvalId} does not carry a canonical memory.lifecycle binding.`,
      });
    }
    return this.ctx.storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: MEMORY_LIFECYCLE_EFFECT_KIND,
      targetKind: MEMORY_LIFECYCLE_EFFECT_TARGET_KIND,
      targetId: approval.approvalId,
      idempotencyKey: buildApprovalEffectIdempotencyKey({
        approvalId: approval.approvalId,
        effectKind: MEMORY_LIFECYCLE_EFFECT_KIND,
        targetKind: MEMORY_LIFECYCLE_EFFECT_TARGET_KIND,
        targetId: approval.approvalId,
      }),
      payload: {
        workspaceId: binding.workspaceId,
        action: binding.action,
        subjectKind: binding.subjectKind,
        ...(binding.subjectId === undefined ? {} : { subjectId: binding.subjectId }),
        requestSha256: binding.requestSha256,
      },
    });
  }

  public enqueueApprovalWaitMaterialization(approval: ApprovalRequest): ApprovalEffectRecord | undefined {
    const runId = asOptionalString(approval.linkage?.durableRunId);
    if (!runId) {
      return undefined;
    }
    const effect = this.ctx.storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "approval_wait_materialize",
      targetKind: "durable_run",
      targetId: runId,
      payload: {
        approvalId: approval.approvalId,
        runId,
      },
    });
    this.requestEffectProcessing();
    return effect;
  }

  private async drainPendingEffects(): Promise<void> {
    await this.reconcileExpiredApprovalsIfDue();
    while (true) {
      const now = new Date().toISOString();
      const effect = this.ctx.storage.approvalEffects.claimNextPendingEffect(
        this.workerId,
        now,
        new Date(Date.now() + APPROVAL_EFFECT_LEASE_TTL_MS).toISOString(),
      );
      if (!effect) {
        return;
      }
      try {
        await this.executeWithLeaseHeartbeat(effect, (signal) => this.executeClaimedEffect(effect.effectId, signal));
      } catch (error) {
        const current = this.ctx.storage.approvalEffects.get(effect.effectId);
        if (current.status === "running" && current.claimedBy === this.workerId) {
          this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, current.version, {
            lastError: error instanceof Error ? error.message : "Approval effect execution failed.",
            result: {
              error: error instanceof Error ? error.message : "Approval effect execution failed.",
            },
          });
        }
      }
    }
  }

  private async reconcileExpiredApprovalsIfDue(): Promise<void> {
    const reconcile = this.deps.reconcileExpiredApprovals;
    const reconcileDeviceAccess = this.deps.reconcileExpiredDeviceAccessRequests;
    const remoteTokenSecrets = this.deps.approvalRemoteTokenSecrets;
    if (!reconcile && !reconcileDeviceAccess && !remoteTokenSecrets) {
      return;
    }
    const now = Date.now();
    if (now >= this.lastExpirySweepAtMs && now - this.lastExpirySweepAtMs < APPROVAL_EXPIRY_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastExpirySweepAtMs = now;
    if (reconcile) {
      try {
        reconcile(100);
      } catch (error) {
        this.publishWorkerFailure("action", error);
      }
    }
    if (reconcileDeviceAccess) {
      try {
        await reconcileDeviceAccess(100);
      } catch (error) {
        this.publishWorkerFailure("action", error);
      }
    }
    if (remoteTokenSecrets) {
      try {
        await remoteTokenSecrets.reconcileExpired(100);
      } catch (error) {
        this.publishWorkerFailure("action", error);
      }
    }
  }

  private async drainPendingObservabilityEffects(): Promise<void> {
    const claim = (
      this.ctx.storage.approvalEffects as Storage["approvalEffects"] & {
        claimNextPendingObservabilityEffect?: Storage["approvalEffects"]["claimNextPendingObservabilityEffect"];
      }
    ).claimNextPendingObservabilityEffect;
    if (typeof claim !== "function") {
      return;
    }
    while (true) {
      const now = new Date().toISOString();
      const effect = claim.call(
        this.ctx.storage.approvalEffects,
        this.observabilityWorkerId,
        now,
        new Date(Date.now() + APPROVAL_EFFECT_LEASE_TTL_MS).toISOString(),
      );
      if (!effect) {
        return;
      }
      try {
        await this.executeWithLeaseHeartbeat(effect, (signal) => this.executeClaimedEffect(effect.effectId, signal));
      } catch (error) {
        const current = this.ctx.storage.approvalEffects.get(effect.effectId);
        if (current.status === "running" && current.claimedBy === this.observabilityWorkerId) {
          this.deferClaimedEffectForRetry(current, this.observabilityWorkerId, error, {
            deliveryState: "retry_scheduled",
            deliveryKind: "unknown",
            operationId: asOptionalString(current.payload.operationId) ?? current.targetId,
          });
        }
      }
    }
  }

  private async executeWithLeaseHeartbeat<T>(
    effect: ApprovalEffectRecord,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let active = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHeartbeatFailure!: (error: Error) => void;
    const controller = new AbortController();
    const workerId = this.workerIdForEffect(effect);
    this.activeEffectAbortControllers.set(effect.effectId, controller);
    const heartbeatFailure = new Promise<never>((_, reject) => {
      rejectHeartbeatFailure = reject;
    });
    const heartbeat = async () => {
      if (!active) {
        return;
      }
      if (this.workerStopped) {
        active = false;
        const failure = new Error(`Approval effect ${effect.effectId} worker stopped.`);
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      let current: ApprovalEffectRecord;
      try {
        current = this.ctx.storage.approvalEffects.get(effect.effectId);
      } catch (error) {
        active = false;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      if (current.status !== "running" || current.claimedBy !== workerId) {
        active = false;
        const failure = new Error(`Approval effect ${current.effectId} lease ownership moved to another worker.`);
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      const now = new Date().toISOString();
      try {
        const renewed = this.ctx.storage.approvalEffects.renewEffectLease(
          current.effectId,
          workerId,
          current.version,
          now,
          new Date(Date.now() + APPROVAL_EFFECT_LEASE_TTL_MS).toISOString(),
        );
        if (!renewed) {
          throw new Error(`Approval effect ${current.effectId} lease renewal lost ownership.`);
        }
      } catch (error) {
        active = false;
        const failure =
          error instanceof Error ? error : new Error(`Approval effect ${effect.effectId} lease heartbeat failed.`);
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      heartbeatTimer = setTimeout(() => void heartbeat(), APPROVAL_EFFECT_HEARTBEAT_MS);
    };

    heartbeatTimer = setTimeout(() => void heartbeat(), APPROVAL_EFFECT_HEARTBEAT_MS);
    try {
      return await Promise.race([execute(controller.signal), heartbeatFailure]);
    } finally {
      active = false;
      this.activeEffectAbortControllers.delete(effect.effectId);
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
    }
  }

  private isEffectStillClaimed(effectId: string): boolean {
    try {
      const current = this.ctx.storage.approvalEffects.get(effectId);
      return current.status === "running" && current.claimedBy === this.workerIdForEffect(current);
    } catch {
      return false;
    }
  }

  private async executeClaimedEffect(effectId: string, signal?: AbortSignal): Promise<void> {
    const effect = this.ctx.storage.approvalEffects.get(effectId);
    switch (effect.effectKind) {
      case "approval_wait_materialize":
        await this.handleApprovalWaitMaterialization(effect);
        return;
      case "approval_wait_wake":
        await this.handleWakeEffect(effect, true);
        return;
      case "proactive_run_wake":
        await this.handleWakeEffect(effect, false);
        return;
      case "orchestration_parent_wake":
        await this.handleWakeEffect(effect, false);
        return;
      case "linked_chat_turn_wake":
        await this.handleLinkedChatTurnWake(effect);
        return;
      case "pending_action_execute":
        await this.handlePendingActionExecute(effect, signal);
        return;
      case "skill_hub_lifecycle_apply":
        await this.handleSkillHubLifecycleApply(effect, signal);
        return;
      case EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND:
        await this.handleExternalSourceKnowledgeSnapshotApply(effect, signal);
        return;
      case MESH_CAPABILITY_ACTIVATION_EFFECT_KIND:
        this.handleMeshCapabilityActivationApply(effect);
        return;
      case MEMORY_LIFECYCLE_EFFECT_KIND:
        this.handleMemoryLifecycleApply(effect);
        return;
      case "approval_inbox_follow_up":
        await this.handleApprovalInboxFollowUp(effect);
        return;
      case "approval_after_hooks":
        await this.handleApprovalAfterHooks(effect);
        return;
      case "approval_resolution_signals":
        await this.handleApprovalResolutionSignals(effect);
        return;
      case "approval_observability":
        await this.handleApprovalObservability(effect);
        return;
      default:
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerIdForEffect(effect), effect.version, {
          lastError: `Unsupported approval effect kind ${(effect as { effectKind: string }).effectKind}`,
          result: {
            unsupportedEffectKind: (effect as { effectKind: string }).effectKind,
          },
        });
    }
  }

  private workerIdForEffect(effect: ApprovalEffectRecord): string {
    return effect.effectKind === "approval_observability" ? this.observabilityWorkerId : this.workerId;
  }

  private async handleSkillHubLifecycleApply(effect: ApprovalEffectRecord, signal?: AbortSignal): Promise<void> {
    const execute = this.deps.executeApprovedSkillHubLifecycleOperation;
    const operationId = asOptionalString(effect.payload.operationId);
    const approvalId = asOptionalString(effect.payload.approvalId);
    const requestSha256 = asOptionalString(effect.payload.requestSha256);
    if (!execute || !operationId || !approvalId || !requestSha256) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "Skill Hub lifecycle effect is missing its executor or immutable operation identity.",
        result: { operationId, approvalId, configured: Boolean(execute) },
      });
      return;
    }
    try {
      const applied = await execute(operationId, approvalId, requestSha256, signal);
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.workerId,
        effect.version,
        {
          result: {
            operationId,
            settlementId: applied.settlement.settlementId,
            disposition: applied.settlement.disposition,
            resultSha256: applied.settlement.resultSha256,
            replayed: applied.replayed,
          },
        },
      );
      if (!completed) throw new Error(`Skill Hub lifecycle effect ${effect.effectId} lost its completion lease.`);
    } catch (error) {
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        operationId,
        approvalId,
      });
    }
  }

  /**
   * HX-407 C4: execute one approved knowledge-snapshot recovery. The actor is
   * reconstructed from the approval's own linkage (the authenticated operator
   * whose request created the approval); the C2 apply then re-runs ownership,
   * incarnation, drift, revision, artifact, and deny-wins policy checks
   * against live state. Terminal governance denials (policy flip, expiry,
   * revoke, drift, conflict) fail the effect closed instead of retrying
   * forever; only cancellation/lease interruptions defer for retry.
   */
  private async handleExternalSourceKnowledgeSnapshotApply(
    effect: ApprovalEffectRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const execute = this.deps.executeApprovedExternalSourceKnowledgeSnapshot;
    const workspaceId = asOptionalString(effect.payload.workspaceId);
    if (!execute || !workspaceId) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "External source knowledge-snapshot effect is missing its executor or workspace binding.",
        result: { workspaceId, configured: Boolean(execute) },
      });
      return;
    }
    let actor: ExternalSourceRequestActor | undefined;
    try {
      const approval = this.ctx.storage.approvals.get(effect.approvalId);
      const linkageActorId = asOptionalString(approval.linkage?.authActorId);
      const linkageActorSource = asOptionalString(approval.linkage?.authActorSource);
      if (
        linkageActorId &&
        (linkageActorSource === "token" || linkageActorSource === "basic" || linkageActorSource === "loopback")
      ) {
        actor = { actorId: linkageActorId, source: linkageActorSource };
      }
    } catch {
      actor = undefined;
    }
    if (!actor) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "External source knowledge-snapshot approval carries no authenticated operator linkage.",
        result: { approvalId: effect.approvalId },
      });
      return;
    }
    try {
      const applied = await execute({ workspaceId, approvalId: effect.approvalId }, actor, signal);
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.workerId,
        effect.version,
        {
          result: {
            disposition: "applied",
            applyDisposition: applied.disposition,
            linkId: applied.link.linkId,
            knowledgeDocumentId: applied.knowledgeDocumentId,
            chunkCount: applied.chunkCount,
            normalizedArtifactSha256: applied.link.normalizedArtifactSha256,
            ...(applied.threadKnowledgeAttachmentId
              ? { threadKnowledgeAttachmentId: applied.threadKnowledgeAttachmentId }
              : {}),
          },
        },
      );
      if (!completed) {
        throw new Error(`External source knowledge-snapshot effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      // A deny-wins policy denial is the one governance outcome the C2 design
      // explicitly allows to heal (deny now, re-allow later ⇒ apply succeeds),
      // so it defers for bounded retry: the approval's own expiry converts a
      // standing denial into a terminal `approval_expired` failure. Every
      // other governance denial (expiry, revoke, drift, detach, conflict,
      // tamper) fails the effect closed immediately.
      if (
        error instanceof ExternalSourceKnowledgeEffectServiceError &&
        error.code !== "cancelled" &&
        error.code !== "policy_denied"
      ) {
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
          lastError: error.message,
          result: {
            errorCode: error.code,
            ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
          },
        });
        return;
      }
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        approvalId: effect.approvalId,
        ...(error instanceof ExternalSourceKnowledgeEffectServiceError
          ? { errorCode: error.code, ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}) }
          : {}),
      });
    }
  }

  /**
   * HX-408 M2: execute one approved mesh capability activation. Every
   * governance denial (state drift, expiry, foreign approval, missing request
   * evidence, storage-guard conflict) is terminal and fails the effect closed
   * with its content-free code; only unexpected infrastructure errors defer
   * for bounded retry. Replays converge on the immutable activation row.
   */
  private handleMeshCapabilityActivationApply(effect: ApprovalEffectRecord): void {
    const execute = this.deps.executeApprovedMeshCapabilityActivation;
    const workspaceId = asOptionalString(effect.payload.workspaceId);
    if (!execute || !workspaceId) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "Mesh capability activation effect is missing its executor or workspace binding.",
        result: { workspaceId, configured: Boolean(execute) },
      });
      return;
    }
    try {
      const applied = execute({ workspaceId, approvalId: effect.approvalId });
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.workerId,
        effect.version,
        {
          result: {
            disposition: "activated",
            activationId: applied.activation.activationId,
            activationRevision: applied.activation.activationRevision,
            capabilityId: applied.activation.capabilityId,
            requestSha256: applied.activation.requestSha256,
            replayed: applied.replayed,
          },
        },
      );
      if (!completed) {
        throw new Error(`Mesh capability activation effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      if (error instanceof MeshCapabilityActivationServiceError) {
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
          lastError: error.message,
          result: { errorCode: error.code },
        });
        return;
      }
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        approvalId: effect.approvalId,
      });
    }
  }

  /**
   * HX-402 P1: execute one approved memory lifecycle mutation. Governance
   * denials (missing/foreign/expired approval, missing request evidence,
   * request drift, policy flip, producer state conflict) are terminal and fail
   * the effect closed with their content-free code; only unexpected
   * infrastructure errors defer for bounded retry. Replays converge on the
   * immutable history/Journey/governed-event evidence.
   */
  private handleMemoryLifecycleApply(effect: ApprovalEffectRecord): void {
    const execute = this.deps.executeApprovedMemoryLifecycleMutation;
    const workspaceId = asOptionalString(effect.payload.workspaceId);
    if (!execute || !workspaceId) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "Memory lifecycle effect is missing its executor or workspace binding.",
        result: { workspaceId, configured: Boolean(execute) },
      });
      return;
    }
    try {
      const applied = execute({ workspaceId, approvalId: effect.approvalId });
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.workerId,
        effect.version,
        {
          result: {
            disposition: applied.disposition,
            action: applied.action,
            subjectKind: applied.subjectKind,
            ...(applied.subjectId === undefined ? {} : { subjectId: applied.subjectId }),
            workspaceId: applied.workspaceId,
            itemIds: applied.itemIds,
            changedCount: applied.changedCount,
          },
        },
      );
      if (!completed) {
        throw new Error(`Memory lifecycle effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      if (!this.isEffectStillClaimed(effect.effectId)) return;
      if (error instanceof MemoryLifecycleApplyError) {
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
          lastError: error.message,
          result: { errorCode: error.code },
        });
        return;
      }
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        approvalId: effect.approvalId,
      });
    }
  }

  private async handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void> {
    if (resolveApprovalWait && this.deferApprovalWaitWakeUntilMaterialized(effect)) {
      return;
    }
    if (this.deferOrchestrationParentWakeUntilChildTerminal(effect)) {
      return;
    }

    const payload = effect.payload;
    const wake = runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
      const wakeResult = this.deps.wakeDurableRun(effect.targetId, {
        eventKey: "approval.resolved",
        correlationId: asOptionalString(payload.correlationId) ?? effect.approvalId,
        payload: asRecord(payload.payload),
      });
      if (
        resolveApprovalWait &&
        (wakeResult.outcome === "woke" ||
          buildRecoveredWakeResult(wakeResult, buildWakeResultRecord(wakeResult, effect)))
      ) {
        this.ctx.storage.approvalWaitRuns.markResolved(effect.approvalId, new Date().toISOString());
      }
      const wakeResultRecord = buildWakeResultRecord(wakeResult, effect);
      const recovered = buildRecoveredWakeResult(wakeResult, wakeResultRecord);
      const explicitNonWake = recovered
        ? undefined
        : buildExplicitNonWakeResult(wakeResult, wakeResultRecord, this.buildAlreadyRunningWakeProof(effect));
      const settled =
        wakeResult.outcome === "woke" || recovered
          ? this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
              result: recovered ?? wakeResultRecord,
            })
          : explicitNonWake
            ? this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
                result: explicitNonWake,
              })
            : wakeResult.outcome === "failed"
              ? this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
                  lastError: wakeResult.detail ?? "Approval wake failed.",
                  result: wakeResultRecord,
                })
              : this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
                  result: wakeResultRecord,
                });
      if (!settled) {
        throw new Error(`Approval wake effect ${effect.effectId} lost its terminal lease.`);
      }
      return {
        result: wakeResult,
        resultRecord: wakeResultRecord,
        recoveredResult: recovered,
        explicitNonWakeResult: explicitNonWake,
      };
    });
    const { result, recoveredResult, explicitNonWakeResult } = wake;
    if (result.outcome === "woke") {
      this.deps.requestRunProcessing(effect.targetId);
      return;
    }
    if (recoveredResult) {
      if (result.run?.status === "queued") {
        this.deps.requestRunProcessing(effect.targetId);
      }
      return;
    }
    if (explicitNonWakeResult) {
      this.ctx.publishRealtime(
        resolveApprovalWait ? "approval_wait_wake_skipped" : "approval_wake_skipped",
        "approvals",
        {
          approvalId: effect.approvalId,
          effectKind: effect.effectKind,
          targetId: effect.targetId,
          reason: explicitNonWakeResult.outcome,
          detail: result.detail,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            approvalId: effect.approvalId,
            runId: effect.targetId,
          },
        },
      );
      return;
    }
    if (result.outcome === "failed") {
      return;
    }
    this.ctx.publishRealtime(
      resolveApprovalWait ? "approval_wait_wake_skipped" : "approval_wake_skipped",
      "approvals",
      {
        approvalId: effect.approvalId,
        effectKind: effect.effectKind,
        targetId: effect.targetId,
        reason: result.outcome,
        detail: result.detail,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          approvalId: effect.approvalId,
          runId: effect.targetId,
        },
      },
    );
  }

  private async handleApprovalWaitMaterialization(effect: ApprovalEffectRecord): Promise<void> {
    try {
      const materialize = this.deps.materializeApprovalWaitRun;
      if (!materialize) {
        throw new Error("Approval wait-run materialization is not configured.");
      }
      runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
        const run = materialize(effect.approvalId);
        if (!run || run.runId !== effect.targetId) {
          throw new Error(`Approval ${effect.approvalId} did not materialize reserved run ${effect.targetId}.`);
        }
        const completed = this.ctx.storage.approvalEffects.completeEffect(
          effect.effectId,
          this.workerId,
          effect.version,
          {
            result: {
              approvalId: effect.approvalId,
              runId: run.runId,
              status: run.status,
              materialized: true,
            },
          },
        );
        if (!completed) {
          throw new Error(`Approval wait materialization effect ${effect.effectId} lost its completion lease.`);
        }
      });
    } catch (error) {
      this.deferClaimedEffectForRetry(
        effect,
        this.workerId,
        error,
        {
          deliveryState: "retry_scheduled",
          approvalId: effect.approvalId,
          runId: effect.targetId,
          materialized: false,
        },
        APPROVAL_WAIT_MATERIALIZE_RETRY_MS,
      );
    }
  }

  private deferApprovalWaitWakeUntilMaterialized(effect: ApprovalEffectRecord): boolean {
    const durableRuns = (this.ctx.storage as Partial<Pick<Storage, "durableRuns">>).durableRuns;
    if (!durableRuns) {
      return false;
    }
    try {
      durableRuns.getRun(effect.targetId);
      return false;
    } catch (error) {
      this.deferClaimedEffectForRetry(
        effect,
        this.workerId,
        error,
        {
          deliveryState: "retry_scheduled",
          approvalId: effect.approvalId,
          runId: effect.targetId,
          reason: "reserved_wait_run_not_materialized",
        },
        APPROVAL_WAIT_MATERIALIZE_RETRY_MS,
      );
      return true;
    }
  }

  private deferOrchestrationParentWakeUntilChildTerminal(effect: ApprovalEffectRecord): boolean {
    if (effect.effectKind !== "orchestration_parent_wake") {
      return false;
    }
    const childRunId = asOptionalString(effect.payload.childRunId);
    if (!childRunId) {
      return false;
    }
    const durableRuns = (this.ctx.storage as Partial<Pick<Storage, "durableRuns">>).durableRuns;
    if (!durableRuns) {
      return false;
    }
    let childRun: { status?: string } | undefined;
    try {
      childRun = durableRuns.getRun(childRunId) as { status?: string } | undefined;
    } catch {
      return false;
    }
    if (!childRun || isTerminalDurableRunStatus(childRun.status)) {
      return false;
    }

    this.deps.requestRunProcessing(childRunId);
    const now = new Date().toISOString();
    const retryAt = new Date(Date.now() + APPROVAL_EFFECT_CHILD_WAIT_RETRY_MS).toISOString();
    const renewed = this.ctx.storage.approvalEffects.renewEffectLease(
      effect.effectId,
      this.workerId,
      effect.version,
      now,
      retryAt,
    );
    if (!renewed) {
      throw new Error(`Approval effect ${effect.effectId} lease renewal lost ownership while waiting for child run.`);
    }
    this.ctx.publishRealtime(
      "approval_effect_deferred",
      "approvals",
      {
        approvalId: effect.approvalId,
        effectKind: effect.effectKind,
        targetId: effect.targetId,
        reason: "child_durable_run_not_terminal",
        childRunId,
        childRunStatus: childRun.status,
        retryAt,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          approvalId: effect.approvalId,
          runId: effect.targetId,
        },
      },
    );
    return true;
  }

  private async handleLinkedChatTurnWake(effect: ApprovalEffectRecord): Promise<void> {
    const payload = effect.payload;
    const runId = asOptionalString(payload.runId);
    if (!runId) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "Linked chat turn wake effect is missing a durable run id.",
        result: {
          turnId: effect.targetId,
        },
      });
      return;
    }
    const wake = runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
      const wakeResult = this.deps.wakeDurableRun(runId, {
        eventKey: "approval.resolved",
        correlationId: asOptionalString(payload.correlationId) ?? effect.approvalId,
        payload: asRecord(payload.payload),
      });
      const wakeResultRecord = buildWakeResultRecord(wakeResult, effect, {
        turnId: effect.targetId,
        runId,
      });
      const recovered = buildRecoveredWakeResult(wakeResult, wakeResultRecord);
      const explicitNonWake = recovered
        ? undefined
        : buildExplicitNonWakeResult(wakeResult, wakeResultRecord, this.buildAlreadyRunningWakeProof(effect));
      const settled =
        wakeResult.outcome === "woke" || recovered
          ? this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
              result: recovered ?? wakeResultRecord,
            })
          : explicitNonWake
            ? this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
                result: explicitNonWake,
              })
            : wakeResult.outcome === "failed"
              ? this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
                  lastError: wakeResult.detail ?? "Linked chat turn wake failed.",
                  result: wakeResultRecord,
                })
              : this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
                  result: wakeResultRecord,
                });
      if (!settled) {
        throw new Error(`Linked Chat wake effect ${effect.effectId} lost its terminal lease.`);
      }
      return {
        result: wakeResult,
        resultRecord: wakeResultRecord,
        recoveredResult: recovered,
        explicitNonWakeResult: explicitNonWake,
      };
    });
    const { result, recoveredResult, explicitNonWakeResult } = wake;
    if (result.outcome === "woke") {
      this.deps.requestRunProcessing(runId);
      return;
    }
    if (recoveredResult) {
      if (result.run?.status === "queued") {
        this.deps.requestRunProcessing(runId);
      }
      return;
    }
    if (explicitNonWakeResult) {
      return;
    }
    if (result.outcome === "failed") {
      return;
    }
  }

  private async handlePendingActionExecute(effect: ApprovalEffectRecord, signal?: AbortSignal): Promise<void> {
    const pendingAction = this.ctx.storage.pendingApprovalActions.find(effect.approvalId);
    if (!pendingAction || pendingAction.resolutionStatus === "executed") {
      const completionPendingAction = pendingAction;
      if (!pendingAction && effect.payload.actionType === "code_mode.run") {
        const recoveredAction = await this.deps.executeCodeModePendingApproval(effect.approvalId, signal);
        if (!this.isEffectStillClaimed(effect.effectId)) {
          return;
        }
        if (recoveredAction?.outcome === "executed") {
          this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
            result: toolInvokeResultToRecord(recoveredAction, "code_mode.run"),
          });
          return;
        }
        const failureRecord = toolInvokeResultToRecord(recoveredAction, "code_mode.run");
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
          lastError: recoveredAction?.policyReason ?? "Code Mode pending action could not be recovered.",
          result: failureRecord,
        });
        return;
      }
      if (pendingAction?.resolutionStatus === "executed") {
        const storedExecutionFailure = readStoredApprovedActionExecutionFailure(pendingAction.result);
        let materializationAction = pendingAction;
        if (storedExecutionFailure && pendingAction.result) {
          materializationAction = runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () =>
            this.ctx.storage.pendingApprovalActions.reclassifyExecutedAsFailed(
              effect.approvalId,
              pendingAction.result!,
              pendingAction.result!,
            ),
          );
        }
        const materialized = storedExecutionFailure
          ? this.materializeFailedChatApprovalOrDefer(
              effect,
              materializationAction,
              materializationAction.result,
              storedExecutionFailure,
            )
          : this.materializeExecutedChatApprovalOrDefer(effect, materializationAction, materializationAction.result);
        if (!materialized) {
          return;
        }
        return;
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: completionPendingAction?.actionType,
          resolutionStatus: completionPendingAction?.resolutionStatus ?? "missing",
          ...(completionPendingAction?.result ? { result: completionPendingAction.result } : {}),
        },
      });
      return;
    }
    if (pendingAction.resolutionStatus && pendingAction.resolutionStatus !== "pending") {
      const storedExecutionFailure = readStoredApprovedActionExecutionFailure(pendingAction.result);
      if (pendingAction.resolutionStatus === "failed" && storedExecutionFailure) {
        if (
          !this.materializeFailedChatApprovalOrDefer(
            effect,
            pendingAction,
            pendingAction.result,
            storedExecutionFailure,
          )
        ) {
          return;
        }
        return;
      }
      this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: pendingAction.actionType,
          resolutionStatus: pendingAction.resolutionStatus,
        },
      });
      return;
    }

    let executedAction: ToolInvokeResult | undefined;
    if (pendingAction.actionType === "code_mode.run") {
      executedAction = await this.deps.executeCodeModePendingApproval(effect.approvalId, signal);
    } else {
      executedAction = await this.deps.executeApprovedPendingAction(effect.approvalId, signal);
    }

    if (!this.isEffectStillClaimed(effect.effectId)) {
      return;
    }

    const refreshedPendingAction = this.ctx.storage.pendingApprovalActions.find(effect.approvalId);
    if (
      refreshedPendingAction &&
      refreshedPendingAction.resolutionStatus &&
      refreshedPendingAction.resolutionStatus !== "pending"
    ) {
      const completionPendingAction = refreshedPendingAction;
      if (refreshedPendingAction.resolutionStatus === "executed") {
        const storedExecutionFailure = readStoredApprovedActionExecutionFailure(refreshedPendingAction.result);
        let materializationAction = refreshedPendingAction;
        if (storedExecutionFailure && refreshedPendingAction.result) {
          const actionRecord = toolInvokeResultToRecord(executedAction, refreshedPendingAction.actionType);
          materializationAction = runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () =>
            this.ctx.storage.pendingApprovalActions.reclassifyExecutedAsFailed(
              effect.approvalId,
              refreshedPendingAction.result!,
              actionRecord,
            ),
          );
        }
        const materialized = storedExecutionFailure
          ? this.materializeFailedChatApprovalOrDefer(
              effect,
              materializationAction,
              materializationAction.result,
              storedExecutionFailure,
            )
          : this.materializeExecutedChatApprovalOrDefer(effect, materializationAction, materializationAction.result);
        if (!materialized) {
          return;
        }
        return;
      } else if (refreshedPendingAction.resolutionStatus === "failed") {
        const storedExecutionFailure = readStoredApprovedActionExecutionFailure(refreshedPendingAction.result);
        if (storedExecutionFailure) {
          if (
            !this.materializeFailedChatApprovalOrDefer(
              effect,
              refreshedPendingAction,
              refreshedPendingAction.result,
              storedExecutionFailure,
            )
          ) {
            return;
          }
          return;
        }
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: completionPendingAction.actionType,
          resolutionStatus: completionPendingAction.resolutionStatus,
          ...(completionPendingAction.result ? { result: completionPendingAction.result } : {}),
        },
      });
      return;
    }

    if (!executedAction && pendingAction.actionType === "code_mode.run") {
      if (signal?.aborted) {
        return;
      }
      const codeModeRunId =
        typeof pendingAction.request?.runId === "string" && pendingAction.request.runId.trim()
          ? pendingAction.request.runId.trim()
          : undefined;
      const deferredReason = "Code Mode execution claim is still active; retry is scheduled.";
      this.deferClaimedEffectForRetry(
        effect,
        this.workerId,
        new Error(deferredReason),
        {
          deliveryState: "retry_scheduled",
          actionType: pendingAction.actionType,
          approvalId: effect.approvalId,
          ...(codeModeRunId ? { runId: codeModeRunId } : {}),
          reason: "code_mode_run_already_claimed",
          resolutionStatus: refreshedPendingAction?.resolutionStatus ?? pendingAction.resolutionStatus ?? "pending",
        },
        APPROVAL_EFFECT_CODE_MODE_CLAIM_RETRY_MS,
      );
      try {
        this.ctx.publishRealtime(
          "approval_effect_deferred",
          "approvals",
          {
            approvalId: effect.approvalId,
            effectKind: effect.effectKind,
            targetId: effect.targetId,
            actionType: pendingAction.actionType,
            reason: "code_mode_run_already_claimed",
            resolutionStatus: refreshedPendingAction?.resolutionStatus ?? pendingAction.resolutionStatus ?? "pending",
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: {
              approvalId: effect.approvalId,
              ...(codeModeRunId ? { runId: codeModeRunId } : {}),
            },
          },
        );
      } catch (diagnosticError) {
        void diagnosticError;
        // The durable effect retry is authoritative. A retained-stream
        // diagnostic failure must not terminalize or strand the pending action.
      }
      return;
    }

    const executionFailure = readApprovedActionExecutionFailure(executedAction);
    if (executedAction?.outcome === "executed" && !executionFailure) {
      const actionRecord = toolInvokeResultToRecord(executedAction, pendingAction.actionType);
      if (!refreshedPendingAction || refreshedPendingAction.resolutionStatus === "pending") {
        runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () =>
          this.ctx.storage.pendingApprovalActions.markResolved(effect.approvalId, "executed", actionRecord),
        );
      }
      if (!this.materializeExecutedChatApprovalOrDefer(effect, pendingAction, actionRecord)) {
        return;
      }
      return;
    }

    if (executedAction && executionFailure) {
      const actionRecord = toolInvokeResultToRecord(executedAction, pendingAction.actionType);
      if (!refreshedPendingAction || refreshedPendingAction.resolutionStatus === "pending") {
        runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () =>
          this.ctx.storage.pendingApprovalActions.markResolved(effect.approvalId, "failed", actionRecord),
        );
      }
      if (!this.materializeFailedChatApprovalOrDefer(effect, pendingAction, actionRecord, executionFailure)) {
        return;
      }
      return;
    }

    const failureRecord = toolInvokeResultToRecord(executedAction, pendingAction.actionType);
    if (!refreshedPendingAction || refreshedPendingAction.resolutionStatus === "pending") {
      runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () =>
        this.ctx.storage.pendingApprovalActions.markResolved(effect.approvalId, "failed", failureRecord),
      );
    }
    this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
      lastError: executedAction?.policyReason ?? "Approved action could not execute.",
      result: failureRecord,
    });
  }

  private async handleApprovalInboxFollowUp(effect: ApprovalEffectRecord): Promise<void> {
    const payload = effect.payload;
    const inboxItemId = asOptionalString(payload.inboxItemId);
    const resolvedBy = asOptionalString(payload.resolvedBy);
    const approvalStatus = asApprovalStatus(payload.approvalStatus);
    const state = payload.inboxState === "expired" ? "expired" : mapDecisionToInboxState(asDecision(payload.decision));
    let item;
    if (inboxItemId) {
      try {
        item = this.ctx.storage.approvalInbox.get(inboxItemId);
      } catch {
        item = undefined;
      }
    }
    item ??= this.ctx.storage.approvalInbox.findByApprovalAndToken(effect.approvalId, effect.targetId);
    if (!item) {
      if (!this.cleanupRemoteActionTokenSecretOrDefer(effect, "missing")) {
        return;
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          tokenId: effect.targetId,
          inboxItemId: undefined,
          state: "missing",
        },
      });
      return;
    }
    const updated = runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () =>
      this.ctx.storage.approvalInbox.reconcileResolution(item.inboxItemId, {
        state,
        approvalStatus,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
      }),
    );
    if (updated.state !== state || updated.approvalStatus !== approvalStatus) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: `Approval inbox item ${updated.inboxItemId} is already ${updated.state}; expected ${state}.`,
        result: {
          inboxItemId: updated.inboxItemId,
          tokenId: effect.targetId,
          observedState: updated.state,
          expectedState: state,
          observedApprovalStatus: updated.approvalStatus,
          expectedApprovalStatus: approvalStatus,
        },
      });
      return;
    }
    if (!this.cleanupRemoteActionTokenSecretOrDefer(effect, updated.state)) {
      return;
    }
    this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
      result: {
        inboxItemId: updated.inboxItemId,
        tokenId: effect.targetId,
        state: updated.state,
      },
    });
  }

  private cleanupRemoteActionTokenSecretOrDefer(effect: ApprovalEffectRecord, inboxState: string): boolean {
    const tokenSecrets = this.deps.approvalRemoteTokenSecrets;
    if (!tokenSecrets) {
      return true;
    }
    try {
      tokenSecrets.deleteById(effect.targetId);
      return true;
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "secret_cleanup_retry_scheduled",
        tokenId: effect.targetId,
        inboxState,
      });
      return false;
    }
  }

  private materializeExecutedChatApprovalOrDefer(
    effect: ApprovalEffectRecord,
    pendingAction: PendingApprovalAction,
    actionRecord: Record<string, unknown> | undefined,
  ): boolean {
    try {
      this.materializeExecutedChatApproval(effect, pendingAction, actionRecord);
      return true;
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        actionType: pendingAction.actionType,
        resolutionStatus: "executed",
        materialized: false,
      });
      return false;
    }
  }

  private materializeExecutedChatApproval(
    effect: ApprovalEffectRecord,
    pendingAction: PendingApprovalAction,
    actionRecord: Record<string, unknown> | undefined,
  ): void {
    const testFallbackProjections: ChatMaterializationProjection[] = [];
    let queuedDurableProjection = false;
    try {
      runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
        const completeMaterialization = () => {
          const completed = this.ctx.storage.approvalEffects.completeEffect(
            effect.effectId,
            this.workerId,
            effect.version,
            { result: actionRecord ?? {} },
          );
          if (!completed) {
            throw new Error(`Approval effect ${effect.effectId} lost its materialization completion lease.`);
          }
        };
        if (pendingAction.actionType !== "tool.invoke") {
          completeMaterialization();
          return;
        }
        const inlineApproval = this.ctx.storage.chatInlineApprovals.get(effect.approvalId);
        if (!inlineApproval) {
          completeMaterialization();
          return;
        }
        const now = new Date().toISOString();
        const toolResult = asRecord(actionRecord?.result) ?? {};
        const toolName =
          asOptionalString(pendingAction.request.toolName) ??
          asOptionalString(inlineApproval.toolName) ??
          asOptionalString(actionRecord?.toolName) ??
          "tool.invoke";
        const toolRun = this.ctx.storage.chatToolRuns
          .listByTurn(inlineApproval.turnId)
          .find((candidate) => candidate.approvalId === effect.approvalId);
        if (toolRun && toolRun.status !== "executed") {
          const settlement = buildToolEffectEvidence({ potential: "unknown", phase: "completed" });
          this.ctx.storage.chatToolRuns.patch(toolRun.toolRunId, {
            status: "executed",
            effectPotential: "unknown",
            effectDisposition: settlement.disposition,
            effectOutcomeKind: settlement.outcomeKind,
            effectEvidence: settlement.evidence,
            failureGuidance:
              "Approved execution completed without a canonical effect receipt. Inspect external or runtime state before retrying or running it again.",
            result: toolResult,
            finishedAt: now,
          });
        }
        this.ctx.storage.chatInlineApprovals.upsert({
          approvalId: inlineApproval.approvalId,
          sessionId: inlineApproval.sessionId,
          turnId: inlineApproval.turnId,
          kind: inlineApproval.kind,
          toolName: inlineApproval.toolName ?? toolName,
          status: "approved",
          reason: inlineApproval.reason,
          riskLevel: inlineApproval.riskLevel,
          details: inlineApproval.details,
          expiresAt: inlineApproval.expiresAt,
          resolvedBy: asOptionalString(effect.payload.resolvedBy) ?? "operator",
          resolvedAt: now,
        });

        let childTrace: ChatTurnTraceRecord;
        try {
          childTrace = this.ctx.storage.chatTurnTraces.get(inlineApproval.turnId);
        } catch (error) {
          throw new Error(`Chat turn ${inlineApproval.turnId} is unavailable for approval materialization.`, {
            cause: error,
          });
        }
        const outputText = buildApprovedToolActionOutput(toolName, toolResult);
        const childMaterialized = this.completeChatTurnFromApprovedAction({
          trace: childTrace,
          outputText,
          now,
          approvalId: effect.approvalId,
          actionRecord,
        });
        if (!childMaterialized) {
          return;
        }
        queuedDurableProjection =
          this.enqueueChatMaterializationProjection(
            effect,
            {
              operationId: `chat.approval.materialized:${effect.effectId}:${childMaterialized.turnId}`,
              occurredAt: now,
              payload: {
                type: "chat_thread_approval_materialized",
                sessionId: childMaterialized.sessionId,
                turnId: childMaterialized.turnId,
                activeLeafTurnId: childMaterialized.turnId,
                approvalId: effect.approvalId,
              },
              options: {
                eventClass: "operational_signal",
                eventAuthority: "retained_stream",
                links: {
                  sessionId: childMaterialized.sessionId,
                  turnId: childMaterialized.turnId,
                  approvalId: effect.approvalId,
                  ...(childMaterialized.durable?.runId ? { runId: childMaterialized.durable.runId } : {}),
                },
              },
            },
            testFallbackProjections,
          ) || queuedDurableProjection;
        const parentMaterialized = this.materializeDelegationParentsFromApprovedChild({
          childTrace,
          outputText,
          now,
          approvalId: effect.approvalId,
        });
        if (parentMaterialized) {
          queuedDurableProjection =
            this.enqueueDelegationParentMaterializationProjection(
              effect,
              parentMaterialized,
              now,
              testFallbackProjections,
            ) || queuedDurableProjection;
        }
        completeMaterialization();
      });
      if (queuedDurableProjection) {
        this.requestObservabilityEffectProcessing();
      }
      this.publishTestFallbackProjections(testFallbackProjections);
    } catch (error) {
      try {
        this.ctx.publishRealtime(
          "approval_effect_materialization_failed",
          "approvals",
          {
            approvalId: effect.approvalId,
            effectKind: effect.effectKind,
            targetId: effect.targetId,
            error: error instanceof Error ? error.message : String(error),
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: {
              approvalId: effect.approvalId,
            },
          },
        );
      } catch (diagnosticError) {
        void diagnosticError;
      }
      throw error;
    }
  }

  private materializeFailedChatApprovalOrDefer(
    effect: ApprovalEffectRecord,
    pendingAction: PendingApprovalAction,
    actionRecord: Record<string, unknown> | undefined,
    failure: ToolDomainExecutionFailure,
  ): boolean {
    try {
      this.materializeFailedChatApproval(effect, pendingAction, actionRecord, failure);
      return true;
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        actionType: pendingAction.actionType,
        resolutionStatus: "failed",
        materialized: false,
        failureKind: failure.kind,
      });
      return false;
    }
  }

  private materializeFailedChatApproval(
    effect: ApprovalEffectRecord,
    pendingAction: PendingApprovalAction,
    actionRecord: Record<string, unknown> | undefined,
    failure: ToolDomainExecutionFailure,
  ): void {
    const testFallbackProjections: ChatMaterializationProjection[] = [];
    let queuedDurableProjection = false;
    runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
      const completeMaterialization = () => {
        const completed = this.ctx.storage.approvalEffects.completeEffect(
          effect.effectId,
          this.workerId,
          effect.version,
          { result: actionRecord ?? {} },
        );
        if (!completed) {
          throw new Error(`Approval effect ${effect.effectId} lost its failed-materialization completion lease.`);
        }
      };
      if (pendingAction.actionType !== "tool.invoke") {
        completeMaterialization();
        return;
      }
      const inlineApproval = this.ctx.storage.chatInlineApprovals.get(effect.approvalId);
      if (!inlineApproval) {
        completeMaterialization();
        return;
      }
      const now = new Date().toISOString();
      const toolResult = asRecord(actionRecord?.result) ?? {};
      const toolName =
        asOptionalString(pendingAction.request.toolName) ??
        asOptionalString(inlineApproval.toolName) ??
        asOptionalString(actionRecord?.toolName) ??
        "tool.invoke";
      let childTrace: ChatTurnTraceRecord;
      try {
        childTrace = this.ctx.storage.chatTurnTraces.get(inlineApproval.turnId);
      } catch (error) {
        throw new Error(`Chat turn ${inlineApproval.turnId} is unavailable for failed approval materialization.`, {
          cause: error,
        });
      }
      const outputText = buildFailedApprovedToolActionOutput(toolName, toolResult, failure);
      const childMaterialized = this.failChatTurnFromApprovedAction({
        trace: childTrace,
        outputText,
        now,
        approvalId: effect.approvalId,
        actionRecord,
        failure,
        toolName,
        toolResult,
        resolvedBy: asOptionalString(effect.payload.resolvedBy) ?? "operator",
      });
      if (!childMaterialized) {
        return;
      }
      queuedDurableProjection =
        this.enqueueChatMaterializationProjection(
          effect,
          {
            operationId: `chat.approval.failed-materialized:${effect.effectId}:${childMaterialized.turnId}`,
            occurredAt: now,
            payload: {
              type: "chat_thread_approval_failed_materialized",
              sessionId: childMaterialized.sessionId,
              turnId: childMaterialized.turnId,
              activeLeafTurnId: childMaterialized.turnId,
              approvalId: effect.approvalId,
              failureKind: failure.kind,
            },
            options: {
              eventClass: "operational_signal",
              eventAuthority: "retained_stream",
              links: {
                sessionId: childMaterialized.sessionId,
                turnId: childMaterialized.turnId,
                approvalId: effect.approvalId,
                ...(childMaterialized.durable?.runId ? { runId: childMaterialized.durable.runId } : {}),
              },
            },
          },
          testFallbackProjections,
        ) || queuedDurableProjection;
      const parentMaterialized = this.materializeDelegationParentsFromFailedChild({
        childTrace,
        outputText,
        now,
        approvalId: effect.approvalId,
        failure,
      });
      if (parentMaterialized) {
        queuedDurableProjection =
          this.enqueueDelegationParentMaterializationProjection(
            effect,
            parentMaterialized,
            now,
            testFallbackProjections,
          ) || queuedDurableProjection;
      }
      completeMaterialization();
    });
    if (queuedDurableProjection) {
      this.requestObservabilityEffectProcessing();
    }
    this.publishTestFallbackProjections(testFallbackProjections);
  }

  private failChatTurnFromApprovedAction(input: {
    trace: ChatTurnTraceRecord;
    outputText: string;
    now: string;
    approvalId: string;
    actionRecord?: Record<string, unknown>;
    failure: ToolDomainExecutionFailure;
    toolName: string;
    toolResult: Record<string, unknown>;
    resolvedBy: string;
  }): ChatTurnTraceRecord | undefined {
    const materializedTrace = runApprovalEffectTransaction(this.ctx.storage, () => {
      const durableStatus = this.completeDurableRunIfPresent(input.trace.durable?.runId, {
        now: input.now,
        outputText: input.outputText,
        terminalStatus: "failed",
        lastError: input.failure.message,
        postCommit: {
          approvalId: input.approvalId,
          turnId: input.trace.turnId,
          traceStatus: "failed",
        },
        checkpointState: {
          approvalId: input.approvalId,
          turnId: input.trace.turnId,
          outputText: input.outputText,
          approvedAction: input.actionRecord,
          failureKind: input.failure.kind,
          manualReconciliationRequired: input.failure.manualReconciliationRequired,
        },
      });
      if (durableStatus && durableStatus !== "failed") {
        throw new Error(
          `Durable Chat run ${input.trace.durable?.runId ?? "unknown"} is already ${durableStatus}; failed approval materialization cannot replace it.`,
        );
      }
      const currentTrace = this.ctx.storage.chatTurnTraces.get(input.trace.turnId);
      if (isChatTurnTerminalStatus(currentTrace.status) && currentTrace.status !== "failed") {
        throw new Error(
          `Canonical Chat turn ${currentTrace.turnId} is already ${currentTrace.status}; failed approval materialization cannot replace it.`,
        );
      }
      if (
        durableStatus === "failed" &&
        currentTrace.status === "failed" &&
        hasCanonicalAssistantMessage(this.ctx.storage, currentTrace)
      ) {
        return currentTrace;
      }
      const inlineApproval = this.ctx.storage.chatInlineApprovals.get(input.approvalId);
      if (!inlineApproval || inlineApproval.turnId !== currentTrace.turnId) {
        throw new Error(`Inline approval ${input.approvalId} no longer links to Chat turn ${currentTrace.turnId}.`);
      }
      const toolRun = this.ctx.storage.chatToolRuns
        .listByTurn(currentTrace.turnId)
        .find((candidate) => candidate.approvalId === input.approvalId);
      if (toolRun && toolRun.status !== "failed") {
        const settlement = buildToolEffectEvidence({ potential: "unknown", phase: "dispatch_failed" });
        this.ctx.storage.chatToolRuns.patch(toolRun.toolRunId, {
          status: "failed",
          effectPotential: "unknown",
          effectDisposition: settlement.disposition,
          effectOutcomeKind: settlement.outcomeKind,
          effectEvidence: settlement.evidence,
          failureGuidance:
            "Approved execution may have changed state. Inspect external or runtime state before retry; automatic replay is suppressed.",
          result: input.toolResult,
          error: input.failure.message,
          finishedAt: input.now,
        });
      }
      this.ctx.storage.chatInlineApprovals.upsert({
        approvalId: inlineApproval.approvalId,
        sessionId: inlineApproval.sessionId,
        turnId: inlineApproval.turnId,
        kind: inlineApproval.kind,
        toolName: inlineApproval.toolName ?? input.toolName,
        status: "approved",
        reason: inlineApproval.reason,
        riskLevel: inlineApproval.riskLevel,
        details: inlineApproval.details,
        expiresAt: inlineApproval.expiresAt,
        resolvedBy: input.resolvedBy,
        resolvedAt: input.now,
      });
      const assistantMessageId = currentTrace.assistantMessageId ?? `assistant-approved-${currentTrace.turnId}`;
      this.ctx.storage.chatMessages.upsert(
        {
          messageId: assistantMessageId,
          sessionId: currentTrace.sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: input.outputText,
          timestamp: input.now,
        },
        input.now,
      );
      this.ctx.storage.chatTurnTraces.patch(currentTrace.turnId, {
        assistantMessageId,
        status: "failed",
        finishedAt: input.now,
        completion: {
          status: "interrupted",
          repaired: false,
          repair: { applied: false },
        },
        failure: {
          failureClass: "tool_failed",
          message: input.failure.message,
          retryable: false,
        },
        durable: currentTrace.durable?.runId
          ? {
              ...currentTrace.durable,
              status: "failed",
              checkpointKind: "run_failed",
            }
          : currentTrace.durable,
      });
      return currentTrace;
    });
    if (!materializedTrace) {
      throw new Error(`Failed approval materialization did not commit Chat turn ${input.trace.turnId}.`);
    }
    return materializedTrace;
  }

  private completeChatTurnFromApprovedAction(input: {
    trace: ChatTurnTraceRecord;
    outputText: string;
    now: string;
    approvalId: string;
    actionRecord?: Record<string, unknown>;
  }): ChatTurnTraceRecord | undefined {
    const materializedTrace = runApprovalEffectTransaction(this.ctx.storage, () => {
      const durableStatus = this.completeDurableRunIfPresent(input.trace.durable?.runId, {
        now: input.now,
        outputText: input.outputText,
        postCommit: {
          approvalId: input.approvalId,
          turnId: input.trace.turnId,
          traceStatus: "completed",
        },
        checkpointState: {
          approvalId: input.approvalId,
          turnId: input.trace.turnId,
          outputText: input.outputText,
          approvedAction: input.actionRecord,
        },
      });
      if (durableStatus && durableStatus !== "completed") {
        return undefined;
      }
      const currentTrace = this.ctx.storage.chatTurnTraces.get(input.trace.turnId);
      if (isChatTurnTerminalStatus(currentTrace.status) && currentTrace.status !== "completed") {
        return undefined;
      }
      if (
        durableStatus === "completed" &&
        currentTrace.status === "completed" &&
        hasCanonicalAssistantMessage(this.ctx.storage, currentTrace)
      ) {
        return currentTrace;
      }
      const assistantMessageId = currentTrace.assistantMessageId ?? `assistant-approved-${currentTrace.turnId}`;
      const message: ChatMessageRecord = {
        messageId: assistantMessageId,
        sessionId: currentTrace.sessionId,
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: input.outputText,
        timestamp: input.now,
      };
      this.ctx.storage.chatMessages.upsert(message, input.now);
      const durable = currentTrace.durable?.runId
        ? {
            ...currentTrace.durable,
            status: "completed" as const,
            checkpointKind: "run_completed" as const,
          }
        : currentTrace.durable;
      const tracePatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
        assistantMessageId,
        status: "completed",
        finishedAt: input.now,
        completion: {
          ...(currentTrace.completion ?? {}),
          status: "complete",
          repaired: Boolean(currentTrace.completion?.repaired),
          repair: currentTrace.completion?.repair ?? { applied: false },
        },
        durable,
      };
      (tracePatch as unknown as { failure: null }).failure = null;
      this.ctx.storage.chatTurnTraces.patch(currentTrace.turnId, tracePatch);
      return currentTrace;
    });
    if (!materializedTrace) {
      return undefined;
    }
    return materializedTrace;
  }

  private completeDurableRunIfPresent(
    runId: string | undefined,
    input: {
      now: string;
      outputText: string;
      checkpointState: Record<string, unknown>;
      postCommit?: ApprovalMaterializationPostCommitInput;
      terminalStatus?: "completed" | "failed";
      lastError?: string;
    },
  ): DurableRunRecord["status"] | undefined {
    if (!runId) {
      return undefined;
    }
    const terminalStatus = input.terminalStatus ?? "completed";
    const checkpointKind = terminalStatus === "failed" ? "run_failed" : "run_completed";
    const run = this.ctx.storage.durableRuns.getRun(runId);
    if (isTerminalDurableRunStatus(run.status) && run.status !== terminalStatus) {
      return run.status;
    }
    if (run.status !== "waiting" && run.status !== terminalStatus) {
      return run.status;
    }
    let finalized = false;
    try {
      runApprovalEffectTransaction(this.ctx.storage, () => {
        const latest = lockApprovalMaterializationRun(this.ctx.storage, runId);
        if (latest.status !== "waiting" && latest.status !== terminalStatus) {
          return;
        }
        const transitioning = latest.status === "waiting";
        const existingReceipt = readApprovalMaterializedPostCommitReceipt(latest.metadata);
        const matchingReceipt = Boolean(
          input.postCommit && approvalMaterializationReceiptMatches(existingReceipt, input.postCommit),
        );
        const linkedTrace = input.postCommit
          ? lockApprovalMaterializationTrace(this.ctx.storage, input.postCommit.turnId)
          : undefined;
        if (input.postCommit && linkedTrace) {
          if (linkedTrace.durable?.runId !== runId) {
            throw new Error(`Canonical Chat turn ${linkedTrace.turnId} no longer links to durable run ${runId}.`);
          }
          if (
            isChatTurnTerminalStatus(linkedTrace.status) &&
            linkedTrace.status !== input.postCommit.traceStatus &&
            !(matchingReceipt && linkedTrace.status === input.postCommit.traceStatus)
          ) {
            throw new Error(
              `Canonical Chat turn ${linkedTrace.turnId} is already ${linkedTrace.status}; approval materialization cannot replace that terminal state.`,
            );
          }
        }
        if (latest.status === terminalStatus && input.postCommit && !existingReceipt) {
          throw new Error(
            `Durable run ${runId} is ${terminalStatus} without an approval materialization receipt; refusing to replace canonical output.`,
          );
        }
        if (latest.status === terminalStatus && existingReceipt && !matchingReceipt) {
          throw buildApprovalMaterializationConflictError(runId, existingReceipt, input.postCommit);
        }
        if (!transitioning && (!input.postCommit || matchingReceipt)) {
          finalized = true;
          return;
        }
        const outputSummary = summarizeText(input.outputText);
        const assistantMessageId =
          linkedTrace?.assistantMessageId ?? `assistant-approved-${input.postCommit?.turnId ?? runId}`;
        let metadata: Record<string, unknown> =
          mergeCanonicalDurableChatTerminalOutputMetadata(
            latest.metadata,
            terminalStatus === "completed"
              ? { assistantMessageId, outputText: input.outputText, outputSummary }
              : undefined,
          ) ?? {};
        let checkpointState = buildApprovalTerminalCheckpointState(
          input.checkpointState,
          terminalStatus,
          assistantMessageId,
          input.outputText,
          outputSummary,
        );
        if (input.postCommit && !matchingReceipt) {
          const generationId = randomUUID();
          const parentPayload = requireExactApprovalChatParentAuthority(
            this.ctx.storage,
            latest,
            linkedTrace,
            input.postCommit.turnId,
          );
          const postCommitEligibility = this.deps.resolvePostCommitEligibility?.(parentPayload.sessionId);
          if (!postCommitEligibility) {
            throw new Error(`Durable run ${runId} cannot freeze approval post-commit eligibility.`);
          }
          metadata = resetChatTurnRuntimeTransitionMetadata(metadata);
          const includeAutonomous = latest.metadata?.autonomousAdmission !== undefined;
          metadata = markTerminalChatPostCommitPending(
            metadata,
            input.now,
            input.postCommit.traceStatus,
            postCommitEligibility,
            generationId,
            { includeAutonomous },
          );
          const authority = buildChatTurnRuntimeAuthoritySeal({
            runId,
            turnId: input.postCommit.turnId,
            transitionKind: "terminal",
            durableStatus: terminalStatus,
            traceStatus: input.postCommit.traceStatus,
            transitionAt: input.now,
            postCommitGenerationId: generationId,
            postCommitEligibility,
            ...(terminalStatus === "completed"
              ? {
                  terminalOutput: {
                    assistantMessageId,
                    outputText: input.outputText,
                    outputSummary,
                  },
                }
              : {}),
            requiredFinalizers:
              terminalStatus === "completed" && includeAutonomous ? ["autonomous", "general"] : ["general"],
          });
          metadata = withChatTurnRuntimeAuthority(metadata, authority);
          checkpointState = withChatTurnRuntimeAuthorityCheckpoint(checkpointState, authority);
          metadata[APPROVAL_MATERIALIZED_POST_COMMIT_METADATA_KEY] = {
            version: 1,
            approvalId: input.postCommit.approvalId,
            turnId: input.postCommit.turnId,
            traceStatus: input.postCommit.traceStatus,
            generationId,
            requestedAt: input.now,
            ...(input.postCommit.materializationKey !== undefined
              ? { materializationKey: requireApprovalMaterializationKey(input.postCommit.materializationKey) }
              : {}),
          };
        }
        this.ctx.storage.durableRuns.updateRun({
          runId,
          status: terminalStatus,
          updatedAt: input.now,
          finishedAt: input.now,
          clearLease: true,
          ...(terminalStatus === "failed"
            ? { lastError: input.lastError ?? "Approved tool action failed." }
            : { clearLastError: true }),
          expectedVersion: latest.version,
          metadata,
        });
        if (transitioning) {
          this.ctx.storage.durableRuns.createCheckpoint({
            runId,
            checkpointKind,
            state: checkpointState,
            createdAt: input.now,
          });
          this.deps.recordDurableTimelineEvent?.(runId, checkpointKind, checkpointState);
        }
        finalized = true;
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        throw error;
      }
      const latest = this.ctx.storage.durableRuns.getRun(runId);
      if (isTerminalDurableRunStatus(latest.status)) {
        if (latest.status === terminalStatus && input.postCommit) {
          const receipt = readApprovalMaterializedPostCommitReceipt(latest.metadata);
          if (approvalMaterializationReceiptMatches(receipt, input.postCommit)) {
            return latest.status;
          }
          if (receipt) {
            throw buildApprovalMaterializationConflictError(runId, receipt, input.postCommit, error);
          }
          throw error;
        }
        return latest.status;
      }
      throw error;
    }
    return finalized ? terminalStatus : this.ctx.storage.durableRuns.getRun(runId).status;
  }

  private materializeDelegationParentsFromApprovedChild(input: {
    childTrace: ChatTurnTraceRecord;
    outputText: string;
    now: string;
    approvalId: string;
  }): DelegationParentMaterialization | undefined {
    const parents = this.ctx.storage.chatDelegationSteps.listParentsByChildSessionIds([input.childTrace.sessionId]);
    const parent = parents.get(input.childTrace.sessionId);
    if (!parent) {
      return;
    }
    if (!this.lockDelegationApprovalAggregate(parent.runId, parent.stepId)) {
      return;
    }
    const finishedAt = input.now;
    const materialized = this.ctx.storage.chatDelegationSteps.materializeApprovalOutcome({
      stepId: parent.stepId,
      expectedChildSessionId: input.childTrace.sessionId,
      expectedChildTurnId: input.childTrace.turnId,
      status: "completed",
      output: input.outputText,
      summary: summarizeText(input.outputText, 180),
      durableRunId: input.childTrace.durable?.runId,
      citations: input.childTrace.citations ?? [],
      finishedAt,
    });
    if (materialized.outcome === "rejected") {
      return;
    }
    return this.reconcileDelegationRun(parent.parentSessionId, parent.runId, input.now, input.approvalId);
  }

  private materializeDelegationParentsFromFailedChild(input: {
    childTrace: ChatTurnTraceRecord;
    outputText: string;
    now: string;
    approvalId: string;
    failure: ToolDomainExecutionFailure;
  }): DelegationParentMaterialization | undefined {
    const parents = this.ctx.storage.chatDelegationSteps.listParentsByChildSessionIds([input.childTrace.sessionId]);
    const parent = parents.get(input.childTrace.sessionId);
    if (!parent) {
      return;
    }
    if (!this.lockDelegationApprovalAggregate(parent.runId, parent.stepId)) {
      return;
    }
    const materialized = this.ctx.storage.chatDelegationSteps.materializeApprovalOutcome({
      stepId: parent.stepId,
      expectedChildSessionId: input.childTrace.sessionId,
      expectedChildTurnId: input.childTrace.turnId,
      status: "failed",
      summary: summarizeText(input.outputText, 180),
      error: input.failure.message,
      failureGuidance:
        input.failure.kind === "manual_reconciliation"
          ? "Verify the external system before retrying; the approved action may have taken effect."
          : "Inspect the tool failure and retry only after the underlying issue is resolved.",
      durableRunId: input.childTrace.durable?.runId,
      citations: input.childTrace.citations ?? [],
      finishedAt: input.now,
    });
    if (materialized.outcome === "rejected") {
      return;
    }
    return this.reconcileDelegationRun(parent.parentSessionId, parent.runId, input.now, input.approvalId);
  }

  private lockDelegationApprovalAggregate(runId: string, stepId: string): boolean {
    try {
      this.ctx.storage.chatDelegationRuns.getForUpdate(runId);
      return this.ctx.storage.chatDelegationSteps
        .listByRunForUpdate(runId)
        .some((candidate) => candidate.stepId === stepId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return false;
      }
      throw error;
    }
  }

  private reconcileDelegationRun(
    parentSessionId: string,
    runId: string,
    now: string,
    approvalId: string,
  ): DelegationParentMaterialization | undefined {
    let run;
    try {
      run = this.ctx.storage.chatDelegationRuns.getForUpdate(runId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return;
      }
      throw error;
    }
    const steps = this.ctx.storage.chatDelegationSteps.listByRunForUpdate(runId);
    if (steps.length === 0) {
      return;
    }
    const stitchedOutput = buildDelegationStitchedOutput(steps);
    const status = deriveDelegationRunStatus(steps);
    const finalSummary = summarizeText(stitchedOutput);
    const citations = dedupeCitations(steps.flatMap((step) => step.citations ?? []));
    this.ctx.storage.chatDelegationRuns.patch(runId, {
      status,
      finalSummary,
      stitchedOutput,
      citations,
      ...(status === "running" ? {} : { finishedAt: now }),
    });
    if (run.executionPlanId) {
      try {
        const plan = this.ctx.storage.chatExecutionPlans.get(run.executionPlanId);
        const nextSteps = reconcileExecutionPlanSteps(plan.steps, steps);
        this.ctx.storage.chatExecutionPlans.patch(run.executionPlanId, {
          status: status === "running" ? "running" : status === "completed" ? "completed" : status,
          summary: finalSummary,
          steps: nextSteps,
          ...(status === "running" ? {} : { finishedAt: now }),
        });
      } catch {
        // The delegation run remains canonical if the optional execution-plan projection is missing.
      }
    }
    const listedParentTrace = this.ctx.storage.chatTurnTraces
      .listBySession(parentSessionId)
      .find((trace) => trace.orchestration?.runId === runId);
    if (status === "running") {
      if (listedParentTrace && !isChatTurnTerminalStatus(listedParentTrace.status)) {
        this.ctx.storage.chatTurnTraces.patch(listedParentTrace.turnId, {
          status: "running",
          orchestration: listedParentTrace.orchestration
            ? {
                ...listedParentTrace.orchestration,
                status: "running",
                finalSummary,
                steps: steps.map((step) => ({
                  stepId: step.stepId,
                  role: step.role,
                  label: step.label,
                  index: step.index,
                  status: step.status,
                  providerId: step.providerId,
                  model: step.model,
                  startedAt: step.startedAt,
                  finishedAt: step.finishedAt,
                  durationMs: step.durationMs,
                  summary: step.summary,
                  error: step.error,
                })),
              }
            : listedParentTrace.orchestration,
        });
      }
      return;
    }
    if (!listedParentTrace) {
      return;
    }
    const materializedParentTrace = runApprovalEffectTransaction(this.ctx.storage, () => {
      const parentStatus = status === "failed" ? "failed" : status === "partial" ? "partial" : "completed";
      const expectedParentDurableStatus = parentStatus === "failed" ? "failed" : "completed";
      const parentFailureMessage = steps.find((step) => step.status === "failed")?.error ?? "Delegated action failed.";
      const committedParentDurableStatus = this.completeDurableRunIfPresent(listedParentTrace.durable?.runId, {
        now,
        outputText: stitchedOutput,
        terminalStatus: expectedParentDurableStatus,
        ...(expectedParentDurableStatus === "failed" ? { lastError: parentFailureMessage } : {}),
        postCommit: {
          approvalId,
          turnId: listedParentTrace.turnId,
          traceStatus: parentStatus,
          materializationKey: buildDelegationParentApprovalMaterializationKey(runId, listedParentTrace.turnId),
        },
        checkpointState: {
          approvalId,
          turnId: listedParentTrace.turnId,
          outputText: stitchedOutput,
          delegationRunId: runId,
        },
      });
      if (committedParentDurableStatus && committedParentDurableStatus !== expectedParentDurableStatus) {
        return undefined;
      }
      const parentTrace = this.ctx.storage.chatTurnTraces.get(listedParentTrace.turnId);
      if (isChatTurnTerminalStatus(parentTrace.status) && parentTrace.status !== parentStatus) {
        return undefined;
      }
      if (
        committedParentDurableStatus === expectedParentDurableStatus &&
        parentTrace.status === parentStatus &&
        hasCanonicalAssistantMessage(this.ctx.storage, parentTrace)
      ) {
        return parentTrace;
      }
      const assistantMessageId = parentTrace.assistantMessageId ?? `assistant-approved-${parentTrace.turnId}`;
      this.ctx.storage.chatMessages.upsert(
        {
          messageId: assistantMessageId,
          sessionId: parentTrace.sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: stitchedOutput,
          timestamp: now,
        },
        now,
      );
      const parentTracePatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
        assistantMessageId,
        status: parentStatus,
        finishedAt: now,
        completion: {
          ...(parentTrace.completion ?? {}),
          status: parentStatus === "failed" ? "interrupted" : "complete",
          repaired: Boolean(parentTrace.completion?.repaired),
          repair: parentTrace.completion?.repair ?? { applied: false },
        },
        orchestration: parentTrace.orchestration
          ? {
              ...parentTrace.orchestration,
              status,
              finalSummary,
              steps: steps.map((step) => ({
                stepId: step.stepId,
                role: step.role,
                label: step.label,
                index: step.index,
                status: step.status,
                providerId: step.providerId,
                model: step.model,
                startedAt: step.startedAt,
                finishedAt: step.finishedAt,
                durationMs: step.durationMs,
                summary: step.summary,
                error: step.error,
              })),
            }
          : parentTrace.orchestration,
        durable: parentTrace.durable?.runId
          ? {
              ...parentTrace.durable,
              status: expectedParentDurableStatus,
              checkpointKind: expectedParentDurableStatus === "failed" ? "run_failed" : "run_completed",
            }
          : parentTrace.durable,
      };
      if (status === "failed") {
        parentTracePatch.failure = {
          failureClass: "tool_failed",
          message: parentFailureMessage,
          retryable: false,
        };
      } else {
        (parentTracePatch as unknown as { failure: null }).failure = null;
      }
      this.ctx.storage.chatTurnTraces.patch(parentTrace.turnId, parentTracePatch);
      return parentTrace;
    });
    if (!materializedParentTrace) {
      return undefined;
    }
    return { trace: materializedParentTrace, runId };
  }

  private enqueueDelegationParentMaterializationProjection(
    effect: ApprovalEffectRecord,
    materialized: DelegationParentMaterialization,
    occurredAt: string,
    testFallbackProjections: ChatMaterializationProjection[],
  ): boolean {
    return this.enqueueChatMaterializationProjection(
      effect,
      {
        operationId: `chat.delegation.approval.materialized:${effect.effectId}:${materialized.runId}`,
        occurredAt,
        payload: {
          type: "chat_thread_delegation_approval_materialized",
          sessionId: materialized.trace.sessionId,
          turnId: materialized.trace.turnId,
          activeLeafTurnId: materialized.trace.turnId,
          approvalId: effect.approvalId,
          delegationRunId: materialized.runId,
        },
        options: {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            sessionId: materialized.trace.sessionId,
            turnId: materialized.trace.turnId,
            approvalId: effect.approvalId,
            runId: materialized.runId,
            ...(materialized.trace.durable?.runId ? { durableRunId: materialized.trace.durable.runId } : {}),
          },
        },
      },
      testFallbackProjections,
    );
  }

  private enqueueChatMaterializationProjection(
    effect: ApprovalEffectRecord,
    projection: ChatMaterializationProjection,
    testFallbackProjections: ChatMaterializationProjection[],
  ): boolean {
    const approvalEffects = this.ctx.storage.approvalEffects as Storage["approvalEffects"] & {
      upsertObservabilityBatch?: Storage["approvalEffects"]["upsertObservabilityBatch"];
    };
    if (typeof approvalEffects.upsertObservabilityBatch !== "function") {
      if (process.env.NODE_ENV === "test") {
        testFallbackProjections.push(projection);
        return false;
      }
      throw new Error("Chat approval materialization is missing its durable realtime projection outbox");
    }
    approvalEffects.upsertObservabilityBatch({
      approvalId: effect.approvalId,
      occurredAt: projection.occurredAt,
      attribution: captureApprovalObservabilityAttribution(),
      items: [
        {
          operationId: projection.operationId,
          delivery: {
            kind: "realtime",
            eventType: "chat_thread_updated",
            source: "chat",
            payload: projection.payload,
            options: projection.options,
          },
        },
      ],
    });
    return true;
  }

  private publishTestFallbackProjections(projections: readonly ChatMaterializationProjection[]): void {
    if (projections.length === 0) {
      return;
    }
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Chat approval materialization projection fallback is test-only");
    }
    for (const projection of projections) {
      this.ctx.publishRealtime("chat_thread_updated", "chat", projection.payload, projection.options);
    }
  }

  private async handleApprovalAfterHooks(effect: ApprovalEffectRecord): Promise<void> {
    try {
      const approval = this.ctx.storage.approvals.get(effect.approvalId);
      const payload = effect.payload;
      const decision = asDecision(payload.decision);
      const resolvedBy = asOptionalString(payload.resolvedBy) ?? approval.resolvedBy ?? "system";
      const workspaceId = this.deps.resolveApprovalHookWorkspaceId({
        approvalId: approval.approvalId,
        ...(approval.payload ?? {}),
        workspaceId:
          typeof approval.linkage?.workspaceId === "string" && approval.linkage.workspaceId.trim()
            ? approval.linkage.workspaceId.trim()
            : approval.payload.workspaceId,
        sessionId:
          typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
            ? approval.linkage.sessionId.trim()
            : approval.payload.sessionId,
      });
      this.deps.enqueueAfterHooks({
        workspaceId,
        trigger: "approval.resolve.after",
        entityType: "approval",
        entityId: approval.approvalId,
        payload: {
          approval,
          decision,
          resolvedBy,
        },
      });
      this.deps.enqueueAfterHooks({
        workspaceId,
        trigger: "approval.response.after",
        entityType: "approval",
        entityId: approval.approvalId,
        payload: {
          approval,
          decision,
          resolvedBy,
          deliveryChannel: typeof payload.deliveryChannel === "string" ? payload.deliveryChannel : null,
        },
      });
      runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
        const completed = this.ctx.storage.approvalEffects.completeEffect(
          effect.effectId,
          this.workerId,
          effect.version,
          {
            result: {
              workspaceId,
              enqueued: true,
            },
          },
        );
        if (!completed) {
          throw new Error(`Approval hook effect ${effect.effectId} lost its completion lease.`);
        }
      });
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        signalKind: "approval_after_hooks",
        approvalId: effect.approvalId,
      });
    }
  }

  private async handleApprovalResolutionSignals(effect: ApprovalEffectRecord): Promise<void> {
    try {
      const recordSignals = this.deps.recordApprovalResolutionSignals;
      if (!recordSignals) {
        throw new Error("Approval resolution signal delivery is not configured.");
      }
      const approval = this.ctx.storage.approvals.get(effect.approvalId);
      // Improvement and activation owners can cross filesystem/process boundaries.
      // Let their own idempotency/compensation commit before terminalizing this
      // effect; a crash in between replays the deterministic owner on retry.
      recordSignals(approval);
      runClaimedApprovalEffectTransaction(this.ctx.storage, effect, this.workerId, () => {
        const completed = this.ctx.storage.approvalEffects.completeEffect(
          effect.effectId,
          this.workerId,
          effect.version,
          {
            result: {
              delivered: true,
              approvalId: approval.approvalId,
              status: approval.status,
            },
          },
        );
        if (!completed) {
          throw new Error(`Approval resolution signal effect ${effect.effectId} lost its completion lease.`);
        }
      });
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        signalKind: "approval_resolution",
        approvalId: effect.approvalId,
      });
    }
  }

  private async handleApprovalObservability(effect: ApprovalEffectRecord): Promise<void> {
    let envelope: ApprovalObservabilityEnvelope;
    try {
      envelope = parseApprovalObservabilityEnvelope(effect.payload);
    } catch (error) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.observabilityWorkerId, effect.version, {
        lastError: error instanceof Error ? error.message : String(error),
        result: {
          deliveryState: "invalid_envelope",
          operationId: effect.targetId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    if (envelope.predecessorDeliveryId) {
      const predecessor = this.ctx.storage.approvalEffects.getByIdempotencyKey(envelope.predecessorDeliveryId);
      if (!predecessor || predecessor.status !== "completed") {
        this.deferClaimedEffectForRetry(
          effect,
          this.observabilityWorkerId,
          new Error(`Approval observability predecessor ${envelope.predecessorDeliveryId} is not complete.`),
          {
            deliveryState: "blocked_on_predecessor",
            deliveryKind: envelope.delivery.kind,
            deliveryId: envelope.deliveryId,
            operationId: envelope.operationId,
            predecessorDeliveryId: envelope.predecessorDeliveryId,
          },
          APPROVAL_OBSERVABILITY_PREDECESSOR_RETRY_MS,
        );
        return;
      }
    }

    try {
      const delivery = envelope.delivery;
      if (delivery.kind === "audit") {
        await this.ctx.storage.audit.append(delivery.stream, delivery.payload, {
          deliveryId: envelope.deliveryId,
          occurredAt: envelope.occurredAt,
          attribution: envelope.attribution,
        });
      } else {
        this.ctx.publishRealtime(
          delivery.eventType,
          delivery.source,
          {
            ...delivery.payload,
            [APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY]: {
              deliveryId: envelope.deliveryId,
              occurredAt: envelope.occurredAt,
              attribution: envelope.attribution,
            },
          },
          delivery.options,
        );
      }
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.observabilityWorkerId,
        effect.version,
        {
          result: {
            delivered: true,
            deliveryState: "delivered",
            deliveryKind: delivery.kind,
            deliveryId: envelope.deliveryId,
            operationId: envelope.operationId,
            occurredAt: envelope.occurredAt,
          },
        },
      );
      if (!completed) {
        throw new Error(`Approval observability effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.observabilityWorkerId, error, {
        deliveryState: "retry_scheduled",
        deliveryKind: envelope.delivery.kind,
        deliveryId: envelope.deliveryId,
        operationId: envelope.operationId,
      });
    }
  }

  private deferClaimedEffectForRetry(
    effect: ApprovalEffectRecord,
    workerId: string,
    error: unknown,
    result: Record<string, unknown>,
    retryDelayOverrideMs?: number,
  ): ApprovalEffectRecord | undefined {
    const now = new Date();
    const retryDelayMs =
      retryDelayOverrideMs ??
      Math.min(
        APPROVAL_OBSERVABILITY_RETRY_BASE_MS * 2 ** Math.min(20, Math.max(0, effect.attemptCount - 1)),
        APPROVAL_OBSERVABILITY_RETRY_MAX_MS,
      );
    const errorMessage = error instanceof Error ? error.message : String(error);
    const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
    const deferred = this.ctx.storage.approvalEffects.deferEffectForRetry(effect.effectId, workerId, effect.version, {
      lastError: errorMessage,
      retryAt,
      updatedAt: now.toISOString(),
      result: {
        ...result,
        delivered: false,
        attemptCount: effect.attemptCount,
        error: errorMessage,
        retryAt,
        retryDelayMs,
      },
    });
    if (!deferred) {
      const current = this.ctx.storage.approvalEffects.get(effect.effectId);
      if (current.status === "completed") {
        return current;
      }
      throw new Error(`Approval effect ${effect.effectId} lost its lease while scheduling retry.`, { cause: error });
    }
    return deferred;
  }

  private resolveLinkedTurnWakeTarget(approval: ApprovalRequest): { turnId: string; runId: string } | undefined {
    const linkageTurnId =
      typeof approval.linkage?.turnId === "string" && approval.linkage.turnId.trim()
        ? approval.linkage.turnId.trim()
        : undefined;
    const inlineApproval = this.ctx.storage.chatInlineApprovals.get(approval.approvalId);
    const inlineTurnId = inlineApproval?.turnId;
    const turnId = linkageTurnId ?? inlineTurnId;
    if (!turnId) {
      return undefined;
    }
    const linkageSessionId =
      typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
        ? approval.linkage.sessionId.trim()
        : undefined;
    const expectedSessionId = linkageSessionId ?? inlineApproval?.sessionId;
    try {
      const trace = this.ctx.storage.chatTurnTraces.get(turnId);
      if (expectedSessionId && trace.sessionId !== expectedSessionId) {
        return undefined;
      }
      const runId = trace.durable?.runId?.trim();
      if (!runId) {
        return undefined;
      }
      return { turnId, runId };
    } catch {
      return undefined;
    }
  }

  private resolveDelegationParentWakeTargets(
    approval: ApprovalRequest,
  ): Array<{ turnId: string; runId: string; childSessionId: string; delegationRunId: string }> {
    const childSessionId =
      typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
        ? approval.linkage.sessionId.trim()
        : undefined;
    if (!childSessionId) {
      return [];
    }
    try {
      const parentByChildSession = this.ctx.storage.chatDelegationSteps.listParentsByChildSessionIds(
        [childSessionId],
        approval.linkage?.workspaceId,
      );
      const parent = parentByChildSession.get(childSessionId);
      if (!parent) {
        return [];
      }
      return this.ctx.storage.chatTurnTraces
        .listBySession(parent.parentSessionId)
        .filter((trace) => trace.orchestration?.runId === parent.runId)
        .map((trace) => ({
          turnId: trace.turnId,
          runId: trace.durable?.runId?.trim() ?? "",
          childSessionId,
          delegationRunId: parent.runId,
        }))
        .filter((target) => Boolean(target.runId));
    } catch {
      return [];
    }
  }

  private resolveOrchestrationParentWakeTargets(
    approval: ApprovalRequest,
  ): Array<{ orchestrationRunId: string; durableRunId: string }> {
    const orchestrationRunId =
      typeof approval.linkage?.runId === "string" && approval.linkage.runId.trim()
        ? approval.linkage.runId.trim()
        : undefined;
    if (!orchestrationRunId) {
      return [];
    }
    try {
      const run = this.ctx.storage.orchestration.getRun(orchestrationRunId);
      const approvalWorkspaceId = normalizeApprovalWorkspaceId(approval);
      if (approvalWorkspaceId !== normalizeOrchestrationRunWorkspaceId(run.workspaceId)) {
        return [];
      }
      if (!run.durableRunId?.trim()) {
        return [];
      }
      if (run.executionState !== "paused_for_approval") {
        return [];
      }
      return [{ orchestrationRunId, durableRunId: run.durableRunId.trim() }];
    } catch {
      return [];
    }
  }

  private ensurePollLoop(): void {
    if (this.pollTimer || this.workerStopped) {
      return;
    }
    const scheduleNext = () => {
      if (this.workerStopped) {
        return;
      }
      const jitter = Math.floor(Math.random() * APPROVAL_EFFECT_POLL_JITTER_MS);
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        if (this.workerStopped) {
          return;
        }
        this.requestEffectProcessing();
        scheduleNext();
      }, APPROVAL_EFFECT_POLL_MIN_MS + jitter);
    };
    scheduleNext();
  }

  private buildAlreadyRunningWakeProof(effect: ApprovalEffectRecord): Record<string, unknown> | undefined {
    const pendingAction = this.ctx.storage.pendingApprovalActions?.find(effect.approvalId);
    const executedOutcome =
      typeof pendingAction?.result?.outcome === "string" ? pendingAction.result.outcome : undefined;
    if (pendingAction?.resolutionStatus === "executed" || executedOutcome === "executed") {
      return {
        proofSource: "pending_approval_action",
        proofStatus: pendingAction?.resolutionStatus ?? executedOutcome ?? "executed",
        actionType: pendingAction?.actionType,
      };
    }

    try {
      const trace = this.ctx.storage.chatTurnTraces?.get(effect.targetId) as
        | {
            assistantMessageId?: string;
            status?: string;
            durable?: { status?: string; checkpointKind?: string };
          }
        | undefined;
      if (
        trace?.assistantMessageId ||
        trace?.status === "completed" ||
        trace?.durable?.status === "completed" ||
        trace?.durable?.checkpointKind === "run_completed"
      ) {
        return {
          proofSource: "chat_turn_trace",
          proofStatus: trace?.durable?.status ?? trace?.status ?? "completed",
          checkpointKind: trace?.durable?.checkpointKind,
        };
      }
    } catch {
      // no proof available from chat traces
    }

    return undefined;
  }
}

function runApprovalEffectTransaction<T>(storage: ApprovalEffectsServiceContext["storage"], callback: () => T): T {
  const transaction = (storage as { runImmediateTransaction?: <R>(work: () => R) => R }).runImmediateTransaction;
  if (transaction) {
    return transaction.call(storage, callback) as T;
  }
  if (process.env.NODE_ENV === "test") {
    return callback();
  }
  throw new Error("Approval effect durable completion is missing immediate transaction ownership");
}

function runClaimedApprovalEffectTransaction<T>(
  storage: ApprovalEffectsServiceContext["storage"],
  effect: ApprovalEffectRecord,
  workerId: string,
  callback: () => T,
): T {
  return runApprovalEffectTransaction(storage, () => {
    const approvalEffects = storage.approvalEffects;
    const lockFreshClaim = approvalEffects?.lockFreshClaimForUpdate;
    if (typeof lockFreshClaim !== "function") {
      if (process.env.NODE_ENV === "test") {
        return callback();
      }
      throw new Error("Approval effect materialization is missing its database claim lock");
    }
    const locked = lockFreshClaim.call(approvalEffects, effect.effectId, workerId, effect.version);
    if (!locked) {
      throw new Error(`Approval effect ${effect.effectId} lost its materialization lease.`);
    }
    return callback();
  });
}

function lockApprovalMaterializationRun(
  storage: ApprovalEffectsServiceContext["storage"],
  runId: string,
): DurableRunRecord {
  const durableRuns = storage.durableRuns as Storage["durableRuns"] & {
    getRunForUpdate?: (currentRunId: string) => DurableRunRecord;
  };
  if (typeof durableRuns.getRunForUpdate === "function") {
    return durableRuns.getRunForUpdate(runId);
  }
  if (process.env.NODE_ENV === "test") {
    return durableRuns.getRun(runId);
  }
  throw new Error("Approval materialization is missing durable-run row-lock ownership");
}

function lockApprovalMaterializationTrace(
  storage: ApprovalEffectsServiceContext["storage"],
  turnId: string,
): ChatTurnTraceRecord | undefined {
  const chatTurnTraces = storage.chatTurnTraces as
    | (Storage["chatTurnTraces"] & {
        getForUpdate?: (currentTurnId: string) => ChatTurnTraceRecord;
      })
    | undefined;
  if (typeof chatTurnTraces?.getForUpdate === "function") {
    return chatTurnTraces.getForUpdate(turnId);
  }
  if (process.env.NODE_ENV === "test") {
    return chatTurnTraces?.get(turnId);
  }
  throw new Error("Approval materialization is missing Chat-turn row-lock ownership");
}

function hasCanonicalAssistantMessage(
  storage: ApprovalEffectsServiceContext["storage"],
  trace: ChatTurnTraceRecord,
): boolean {
  if (!trace.assistantMessageId) {
    return false;
  }
  const chatMessages = storage.chatMessages as Storage["chatMessages"] & {
    get?: (messageId: string) => ChatMessageRecord | undefined;
  };
  if (typeof chatMessages.get !== "function") {
    return false;
  }
  const message = chatMessages.get(trace.assistantMessageId);
  return message?.role === "assistant" && message.sessionId === trace.sessionId;
}

function readApprovalMaterializedPostCommitReceipt(
  metadata: Record<string, unknown> | undefined,
): ApprovalMaterializedPostCommitReceipt | undefined {
  const raw = metadata?.[APPROVAL_MATERIALIZED_POST_COMMIT_METADATA_KEY];
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Durable approval post-commit receipt is malformed.");
  }
  const approvalId = asOptionalString((raw as Record<string, unknown>).approvalId);
  const turnId = asOptionalString((raw as Record<string, unknown>).turnId);
  if (!approvalId || !turnId) {
    throw new Error("Durable approval post-commit receipt is incomplete.");
  }
  const materializationKeyRaw = (raw as Record<string, unknown>).materializationKey;
  const materializationKey = asOptionalString(materializationKeyRaw);
  if (materializationKeyRaw !== undefined && !materializationKey) {
    throw new Error("Durable approval post-commit receipt has an invalid materialization identity.");
  }
  const traceStatusRaw = (raw as Record<string, unknown>).traceStatus;
  const traceStatus = asOptionalString(traceStatusRaw);
  if (
    traceStatusRaw !== undefined &&
    (!traceStatus || !isChatTurnTerminalStatus(traceStatus as ChatTurnTraceRecord["status"]))
  ) {
    throw new Error("Durable approval post-commit receipt has an invalid trace status.");
  }
  return {
    approvalId,
    turnId,
    ...(traceStatus ? { traceStatus: traceStatus as ChatTurnTraceRecord["status"] } : {}),
    ...(materializationKey ? { materializationKey } : {}),
  };
}

function approvalMaterializationReceiptMatches(
  receipt: ApprovalMaterializedPostCommitReceipt | undefined,
  requested: ApprovalMaterializationPostCommitInput,
): boolean {
  if (!receipt || receipt.turnId !== requested.turnId) {
    return false;
  }
  if ((receipt.traceStatus ?? "completed") !== requested.traceStatus) {
    return false;
  }
  const requestedMaterializationKey =
    requested.materializationKey === undefined
      ? undefined
      : requireApprovalMaterializationKey(requested.materializationKey);
  if (requestedMaterializationKey) {
    return receipt.materializationKey
      ? receipt.materializationKey === requestedMaterializationKey
      : receipt.approvalId === requested.approvalId;
  }
  return !receipt.materializationKey && receipt.approvalId === requested.approvalId;
}

function buildApprovalMaterializationConflictError(
  runId: string,
  receipt: ApprovalMaterializedPostCommitReceipt,
  requested: ApprovalMaterializationPostCommitInput | undefined,
  cause?: unknown,
): Error {
  if (receipt.materializationKey || requested?.materializationKey) {
    return new Error(
      `Durable run ${runId} was already materialized under a different materialization identity by approval ${receipt.approvalId} for turn ${receipt.turnId}.`,
      cause === undefined ? undefined : { cause },
    );
  }
  return new Error(
    `Durable run ${runId} was already materialized by approval ${receipt.approvalId} for turn ${receipt.turnId}.`,
    cause === undefined ? undefined : { cause },
  );
}

function requireApprovalMaterializationKey(value: string): string {
  const materializationKey = value.trim();
  if (!materializationKey) {
    throw new Error("Approval materialization identity must be a non-empty string.");
  }
  return materializationKey;
}

function buildDelegationParentApprovalMaterializationKey(delegationRunId: string, parentTurnId: string): string {
  return `delegation-parent:${encodeURIComponent(delegationRunId)}:${encodeURIComponent(parentTurnId)}`;
}

function isExpiredApprovalRequest(approval: ApprovalRequest): boolean {
  if (!approval.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  if (approval.resolvedAt) {
    const resolvedAt = Date.parse(approval.resolvedAt);
    if (Number.isFinite(resolvedAt)) {
      return resolvedAt > expiresAt;
    }
  }
  // Resolution effects consume a persisted terminal decision. Unresolved
  // expiry is owned and reconciled by ApprovalRepository against DB time; a
  // Gateway host clock must not suppress effects before that owner resolves it.
  return false;
}

function buildApprovedToolActionOutput(toolName: string, result: Record<string, unknown>): string {
  const title = asOptionalString(result.title);
  const path =
    asOptionalString(result.path) ?? asOptionalString(result.filePath) ?? asOptionalString(result.outputPath);
  const slideCount = typeof result.slideCount === "number" ? result.slideCount : undefined;
  const format = asOptionalString(result.format);
  const lines = [`Approved tool action completed: \`${toolName}\`.`];
  const details = [
    title ? `title: ${title}` : undefined,
    path ? `path: ${path}` : undefined,
    slideCount !== undefined ? `slideCount: ${slideCount}` : undefined,
    format ? `format: ${format}` : undefined,
    ...Object.entries(result)
      .filter(([key, value]) => {
        if (key === "title" || key === "path" || key === "filePath" || key === "outputPath") {
          return false;
        }
        if (key === "slideCount" || key === "format") {
          return false;
        }
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      })
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${String(value)}`),
  ].filter((value): value is string => Boolean(value));
  if (details.length > 0) {
    lines.push("", "Result:", ...details.map((detail) => `- ${detail}`));
  }
  return lines.join("\n");
}

function buildFailedApprovedToolActionOutput(
  toolName: string,
  result: Record<string, unknown>,
  failure: ToolDomainExecutionFailure,
): string {
  const lines =
    failure.kind === "manual_reconciliation"
      ? [
          `Approved tool action requires manual reconciliation: \`${toolName}\`.`,
          "The external outcome is unknown. Verify the target system before retrying this action.",
        ]
      : [`Approved tool action failed: \`${toolName}\`.`];
  lines.push("", `Failure: ${failure.message}`);
  const details = Object.entries(result)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${String(value)}`);
  if (details.length > 0) {
    lines.push("", "Recorded result:", ...details.map((detail) => `- ${detail}`));
  }
  return lines.join("\n");
}

function readApprovedActionExecutionFailure(
  result: ToolInvokeResult | undefined,
): ToolDomainExecutionFailure | undefined {
  if (!result) {
    return undefined;
  }
  const domainResult = asRecord(result.result);
  const domainFailure = domainResult ? readToolDomainExecutionFailure(domainResult, result.policyReason) : undefined;
  if (domainFailure) {
    return domainFailure;
  }
  if (result.outcome !== "executed") {
    return {
      message: result.policyReason || `Approved tool action reported ${result.outcome}.`,
      kind: "failed",
      manualReconciliationRequired: false,
    };
  }
  return undefined;
}

function readStoredApprovedActionExecutionFailure(
  actionRecord: Record<string, unknown> | undefined,
): ToolDomainExecutionFailure | undefined {
  if (!actionRecord) {
    return undefined;
  }
  const outcome = asOptionalString(actionRecord.outcome);
  const policyReason =
    asOptionalString(actionRecord.policyReason) ??
    asOptionalString(actionRecord.reason) ??
    asOptionalString(actionRecord.error) ??
    "Approved action could not execute.";
  const executionRecovery = asRecord(actionRecord.executionRecovery);
  if (
    actionRecord.manualReconciliationRequired === true ||
    executionRecovery?.disposition === "manual_reconciliation"
  ) {
    return {
      message: policyReason,
      kind: "manual_reconciliation",
      manualReconciliationRequired: true,
    };
  }
  const result = asRecord(actionRecord.result);
  const domainFailure = result ? readToolDomainExecutionFailure(result, policyReason) : undefined;
  if (domainFailure) {
    return domainFailure;
  }
  if (outcome && outcome !== "executed") {
    return {
      message: policyReason,
      kind: "failed",
      manualReconciliationRequired: false,
    };
  }
  if (outcome !== "executed") {
    return asOptionalString(actionRecord.reason) || asOptionalString(actionRecord.error)
      ? {
          message: policyReason,
          kind: "failed",
          manualReconciliationRequired: false,
        }
      : undefined;
  }
  return undefined;
}

function buildDelegationStitchedOutput(steps: ChatDelegationStepRecord[]): string {
  return steps
    .map((step) => {
      const body =
        step.status === "completed"
          ? (step.output ?? "(delegate returned no output)")
          : step.status === "running" || step.status === "pending"
            ? `WAITING: ${step.output ?? "Delegate is still running."}`
            : step.status === "cancelled"
              ? `CANCELLED: ${step.error ?? step.output ?? "Delegate was cancelled."}`
              : step.status === "skipped"
                ? `SKIPPED: ${step.error ?? "Dependency did not complete."}`
                : [
                    `FAILED: ${step.error ?? "Delegate failed without an error message."}`,
                    step.output?.trim() && step.output.trim() !== step.error?.trim()
                      ? `Partial output:\n${step.output.trim()}`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join("\n\n");
      return `### ${toTitleCase(step.role)}\n${body}`;
    })
    .join("\n\n")
    .trim();
}

function deriveDelegationRunStatus(steps: ChatDelegationStepRecord[]): ChatDelegationRunStatus {
  const activeSteps = steps.filter((step) => step.status === "running" || step.status === "pending").length;
  if (activeSteps > 0) {
    return "running";
  }
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  if (completedSteps === steps.length) {
    return "completed";
  }
  const failedStepsWithPartialOutput = steps.filter(
    (step) => step.status === "failed" && Boolean(step.output?.trim()),
  ).length;
  return completedSteps > 0 || failedStepsWithPartialOutput > 0 ? "partial" : "failed";
}

function reconcileExecutionPlanSteps(
  planSteps: ChatExecutionPlanStepRecord[],
  delegationSteps: ChatDelegationStepRecord[],
): ChatExecutionPlanStepRecord[] {
  return planSteps.map((planStep) => {
    const delegationStep = delegationSteps.find(
      (candidate) =>
        candidate.childTurnId === planStep.childTurnId ||
        candidate.childSessionId === planStep.childSessionId ||
        candidate.index === planStep.index,
    );
    if (!delegationStep) {
      return planStep;
    }
    return {
      ...planStep,
      status: mapDelegationStatusToExecutionPlanStatus(delegationStep.status),
      summary: delegationStep.summary,
      error: delegationStep.error,
      startedAt: planStep.startedAt ?? delegationStep.startedAt,
      finishedAt: delegationStep.finishedAt,
      childRunId: planStep.childRunId,
      durableRunId: delegationStep.durableRunId,
      childSessionId: delegationStep.childSessionId,
      childTurnId: delegationStep.childTurnId,
    };
  });
}

function mapDelegationStatusToExecutionPlanStatus(
  status: ChatDelegationStepRecord["status"],
): ChatExecutionPlanStepRecord["status"] {
  if (status === "pending" || status === "running" || status === "completed" || status === "failed") {
    return status;
  }
  return status === "cancelled" ? "cancelled" : "failed";
}

function dedupeCitations(citations: ChatCitationRecord[]): ChatCitationRecord[] {
  const seen = new Set<string>();
  const result: ChatCitationRecord[] = [];
  for (const citation of citations) {
    const key = citation.citationId || citation.url;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(citation);
  }
  return result;
}

function summarizeText(value: string, maxLength = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : normalized;
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function deriveApprovalResolutionEffectsResult(
  effects: ApprovalEffectRecord[] | undefined,
): ApprovalResolutionEffectsResult | undefined {
  if (!effects || effects.length === 0) {
    return undefined;
  }
  const approvalWaitDurableRunId = effects.find((effect) => effect.effectKind === "approval_wait_wake")?.targetId;
  const proactiveRunIds = effects
    .filter(
      (effect) =>
        effect.effectKind === "proactive_run_wake" &&
        effect.status === "completed" &&
        String(effect.result.outcome ?? "") === "woke",
    )
    .map((effect) => effect.targetId);
  const chatTurnEffect = effects.find((effect) => effect.effectKind === "linked_chat_turn_wake");
  const chatTurnResume: ApprovalChatTurnResumeResult = chatTurnEffect
    ? {
        resumed: chatTurnEffect.status === "completed" && String(chatTurnEffect.result.outcome ?? "") === "woke",
        turnId: asOptionalString(chatTurnEffect.result.turnId) ?? chatTurnEffect.targetId,
        durableRunId: asOptionalString(chatTurnEffect.result.runId) ?? asOptionalString(chatTurnEffect.payload.runId),
        wakeOutcome: asWakeOutcome(chatTurnEffect.result.outcome),
      }
    : { resumed: false };
  return {
    approvalWaitDurableRunId,
    proactiveRunIds,
    chatTurnResume,
  };
}

function buildWakePayload(approval: ApprovalRequest, input: ApprovalResolveInput): Record<string, unknown> {
  return {
    eventKey: "approval.resolved",
    correlationId: approval.approvalId,
    payload: {
      approvalId: approval.approvalId,
      status: approval.status,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
    },
  };
}

function buildWakeResultRecord(
  result: DurableWakeResult,
  effect: ApprovalEffectRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    approvalId: effect.approvalId,
    effectKind: effect.effectKind,
    targetId: effect.targetId,
    runId: result.runId,
    eventKey: result.eventKey,
    correlationId: result.correlationId,
    outcome: result.outcome,
    operatorStatus: classifyWakeOperatorStatus(result),
    detail: result.detail,
    ...extra,
  };
}

function classifyWakeOperatorStatus(
  result: DurableWakeResult,
): "woke" | "skipped" | "already_running" | "missing_run" | "terminal_run" | "failed" {
  if (result.outcome === "woke") {
    return "woke";
  }
  if (result.outcome === "failed") {
    return "failed";
  }
  if (result.run?.status === "running") {
    return "already_running";
  }
  if (
    result.run?.status === "completed" ||
    result.run?.status === "failed" ||
    result.run?.status === "cancelled" ||
    result.run?.status === "dead_lettered"
  ) {
    return "terminal_run";
  }
  if (!result.run && result.outcome === "skipped_not_waiting") {
    return "missing_run";
  }
  return "skipped";
}

function buildRecoveredWakeResult(
  result: DurableWakeResult,
  resultRecord: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (result.outcome !== "skipped_not_waiting") {
    return undefined;
  }
  if (result.run?.status !== "queued") {
    return undefined;
  }
  return {
    ...resultRecord,
    outcome: "woke",
    operatorStatus: "woke",
    reconciled: true,
    reconciledFrom: "skipped_not_waiting",
    observedRunStatus: result.run.status,
  };
}

function buildExplicitNonWakeResult(
  result: DurableWakeResult,
  resultRecord: Record<string, unknown>,
  proof: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (result.outcome !== "skipped_not_waiting" || result.run?.status !== "running") {
    return undefined;
  }
  return {
    ...resultRecord,
    outcome: "already_running_unverified",
    operatorStatus: "already_running",
    reconciled: false,
    observedRunStatus: result.run.status,
    ...(proof ? { proof } : {}),
  };
}

function isTerminalDurableRunStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
}

function toolInvokeResultToRecord(result?: ToolInvokeResult, actionType?: string): Record<string, unknown> {
  return {
    actionType,
    outcome: result?.outcome ?? "blocked",
    policyReason: result?.policyReason ?? "Approved action could not execute.",
    auditEventId: result?.auditEventId,
    approvalId: result?.approvalId,
    result: result?.result,
  };
}

function mapDecisionToInboxState(
  decision: ApprovalResolveInput["decision"],
): Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited"> {
  if (decision === "approve") {
    return "approved";
  }
  if (decision === "reject") {
    return "rejected";
  }
  return "edited";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireObservabilityIdentifier(value: unknown, fieldName: string): string {
  const identifier = asOptionalString(value);
  if (!identifier) {
    throw new Error(`Approval observability ${fieldName} must be a non-empty string.`);
  }
  return identifier;
}

function captureApprovalObservabilityAttribution(): ApprovalObservabilityAttribution | undefined {
  const attribution = getRequestAttribution();
  if (!attribution) {
    return undefined;
  }
  const captured = Object.fromEntries(
    Object.entries(attribution).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as ApprovalObservabilityAttribution;
  return Object.keys(captured).length > 0 ? captured : undefined;
}

function parseApprovalObservabilityEnvelope(value: unknown): ApprovalObservabilityEnvelope {
  const envelope = asRecord(value);
  if (!envelope || envelope.schemaVersion !== "approval_observability.v1") {
    throw new Error("Approval observability envelope version is unsupported.");
  }
  const deliveryId = requireObservabilityIdentifier(envelope.deliveryId, "deliveryId");
  const operationId = requireObservabilityIdentifier(envelope.operationId, "operationId");
  const occurredAt = requireObservabilityIdentifier(envelope.occurredAt, "occurredAt");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("Approval observability occurredAt must be an ISO timestamp.");
  }
  if (typeof envelope.orderIndex !== "number" || !Number.isInteger(envelope.orderIndex) || envelope.orderIndex < 1) {
    throw new Error("Approval observability orderIndex must be a positive integer.");
  }
  const predecessorDeliveryId = asOptionalString(envelope.predecessorDeliveryId);
  const attribution = parseApprovalObservabilityAttribution(envelope.attribution);
  return {
    schemaVersion: "approval_observability.v1",
    deliveryId,
    operationId,
    occurredAt,
    orderIndex: envelope.orderIndex,
    ...(predecessorDeliveryId ? { predecessorDeliveryId } : {}),
    ...(attribution ? { attribution } : {}),
    delivery: parseApprovalObservabilityDelivery(envelope.delivery),
  };
}

function parseApprovalObservabilityAttribution(value: unknown): ApprovalObservabilityAttribution | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const keys = [
    "correlationId",
    "traceId",
    "originSurface",
    "actorId",
    "deviceId",
    "grantId",
    "companionSessionId",
  ] as const;
  const attribution = Object.fromEntries(
    keys.flatMap((key) => {
      const entry = asOptionalString(record[key]);
      return entry ? [[key, entry]] : [];
    }),
  ) as ApprovalObservabilityAttribution;
  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

function parseApprovalObservabilityDelivery(value: unknown): ApprovalObservabilityDelivery {
  const delivery = asRecord(value);
  if (!delivery) {
    throw new Error("Approval observability delivery must be an object.");
  }
  if (delivery.kind === "audit") {
    const stream = delivery.stream;
    if (stream !== "tool_invocations" && stream !== "policy_blocks" && stream !== "approvals" && stream !== "hooks") {
      throw new Error("Approval observability audit stream is unsupported.");
    }
    const payload = asRecord(delivery.payload);
    if (!payload) {
      throw new Error("Approval observability audit payload must be an object.");
    }
    return { kind: "audit", stream, payload };
  }
  if (delivery.kind === "realtime") {
    const eventType = asOptionalString(delivery.eventType);
    const source = asOptionalString(delivery.source);
    const payload = asRecord(delivery.payload);
    if (!eventType || !source || !payload) {
      throw new Error("Approval observability realtime delivery requires eventType, source, and an object payload.");
    }
    const options = delivery.options === undefined ? undefined : asRecord(delivery.options);
    if (delivery.options !== undefined && !options) {
      throw new Error("Approval observability realtime options must be an object when provided.");
    }
    return {
      kind: "realtime",
      eventType,
      source,
      payload,
      options: options as Extract<ApprovalObservabilityDelivery, { kind: "realtime" }>["options"],
    };
  }
  throw new Error("Approval observability delivery kind is unsupported.");
}

function normalizeApprovalWorkspaceId(approval: ApprovalRequest): string {
  return asOptionalString(approval.linkage?.workspaceId) ?? asOptionalString(approval.payload.workspaceId) ?? "default";
}

function normalizeOrchestrationRunWorkspaceId(workspaceId: unknown): string {
  return asOptionalString(workspaceId) ?? "default";
}

function asDecision(value: unknown): ApprovalResolveInput["decision"] {
  return value === "reject" || value === "edit" ? value : "approve";
}

function asApprovalStatus(value: unknown): ApprovalRequest["status"] {
  if (value === "approved" || value === "rejected" || value === "edited") {
    return value;
  }
  return "pending";
}

function asWakeOutcome(value: unknown): DurableWakeResult["outcome"] | undefined {
  return typeof value === "string" ? (value as DurableWakeResult["outcome"]) : undefined;
}
