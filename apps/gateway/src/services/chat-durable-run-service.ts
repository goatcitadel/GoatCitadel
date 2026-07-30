/* eslint-disable max-lines -- Durable Chat finalization remains co-located until its authority contract is stable. */
import { randomUUID } from "node:crypto";
import type {
  ChatSendMessageRequest,
  ChatMessageRecord,
  ChatTurnTraceRecord,
  ChatTurnBranchKind,
  ChatRoutedContextSnapshotRecord,
  DurableCheckpointRecord,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunStatus,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import { canonicalJsonString, isDurableRunTerminal, NotFoundError } from "@goatcitadel/contracts";
import {
  type PostCommitChildAdmissionIdentity,
  type PostCommitEligibility,
  sealChatTurnCapabilityProfile,
  rebindChatRoutedContextSnapshot,
  verifyChatRoutedContextSnapshot,
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilitySkillBindings,
  type Storage,
} from "@goatcitadel/storage";
import {
  resolvePreparedTurnMode,
  upsertChatCapabilityProfileSystemInstruction,
  type PreparedAgentChatTurn,
} from "./chat-turn-prep-service.js";
import type { ChatStreamMutationLifecycle } from "./chat-turn-types.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY,
  HEARTBEAT_DECISION_RECEIPT_METADATA_KEY,
  buildHeartbeatDecisionReceipt,
  buildChatTurnRuntimeAuthoritySeal,
  hashChatTurnRuntimeAuthorityValue,
  readChatTurnRuntimeAuthoritySeal,
  readExactAutonomousChatPostCommitPendingMarker,
  readExactAutonomousChatPostCommitSettlement,
  readExactChatTurnAdmissionHandoff,
  readExactGeneralChatPostCommitPendingMarker,
  readExactGeneralChatPostCommitSettlement,
  readExactLinkedFinalizationPendingMarker,
  readExactLinkedFinalizationSettlement,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
  verifyAutonomousChatAdmissionRunMetadata,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
  type BuildChatTurnRuntimeAuthoritySealInput,
  type ChatTurnRuntimeAuthoritySealV1,
  type ExactHeartbeatDecision,
  type HeartbeatDecisionReceipt,
} from "./chat-durable-runtime-authority.js";
import { assertDurableRetryPolicyMatchesRun, DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";

export const AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY = "autonomousChatPostCommitPending";
export const GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY = "generalChatPostCommitPending";
export const GENERAL_CHAT_POST_COMMIT_EFFECTS = [
  "capability_gap",
  "learned_memory_user",
  "learned_memory_assistant",
  "commitments",
  "background_review",
  "memory_maintenance",
  "memory_prewarm",
  "realtime",
  "agent_end",
] as const;
export const GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS = [
  "commitments",
  "background_review",
  "memory_maintenance",
] as const;
const SYSTEM_HEARTBEAT_ACTOR_ID = "system-heartbeat" as const;
const SYSTEM_HEARTBEAT_POST_COMMIT_ELIGIBILITY: PostCommitEligibility = {
  version: 1,
  autonomyEnabledAtParentSettlement: false,
  evalIntegrityTurn: false,
  humanSession: false,
};
export type GeneralChatPostCommitEffect = (typeof GENERAL_CHAT_POST_COMMIT_EFFECTS)[number];
export type GeneralChatPostCommitDurableEffect = (typeof GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS)[number];
export type GeneralChatPostCommitDurableEffectInput =
  | {
      effect: "commitments";
      sessionId: string;
      workspaceId: string;
      turnId: string;
      autonomous: boolean;
    }
  | {
      effect: "background_review";
      sessionId: string;
      workspaceId: string;
      turnId: string;
      delegatedChild: boolean;
      autonomous: boolean;
    }
  | {
      effect: "memory_maintenance";
      sessionId: string;
      workspaceId: string;
      turnId: string;
      delegatedChild: boolean;
    };
export type GeneralChatPostCommitDurableEffectExecutionInput =
  | (Extract<GeneralChatPostCommitDurableEffectInput, { effect: "commitments" }> & {
      userText: string;
      assistantText: string;
      postCommitEligibility: PostCommitEligibility;
    })
  | (Extract<GeneralChatPostCommitDurableEffectInput, { effect: "background_review" }> & {
      userText: string;
      assistantText: string;
      postCommitEligibility: PostCommitEligibility;
    })
  | (Extract<GeneralChatPostCommitDurableEffectInput, { effect: "memory_maintenance" }> & {
      postCommitEligibility: PostCommitEligibility;
    });
export interface GeneralChatPostCommitEffectWorkflowPayload {
  version: "chat.post_commit.effect.v2";
  parentRunId: string;
  postCommitGenerationId: string;
  effect: GeneralChatPostCommitDurableEffect;
  traceStatus: ChatTurnTraceRecord["status"];
  input: GeneralChatPostCommitDurableEffectInput;
  childAdmission: PostCommitChildAdmissionIdentity;
  postCommitEligibility: PostCommitEligibility;
}
export interface AutonomousChatPostCommitPendingMarker {
  version: 1;
  generationId?: string;
  requestedAt: string;
  claimId?: string;
  claimExpiresAt?: string;
}
export interface GeneralChatPostCommitPendingMarker {
  version: 1;
  generationId: string;
  traceStatus: ChatTurnTraceRecord["status"];
  requestedAt: string;
  postCommitEligibility: PostCommitEligibility;
  completedEffects: GeneralChatPostCommitEffect[];
  durableEffectRunIds: Partial<Record<GeneralChatPostCommitDurableEffect, string>>;
}
export interface GeneralChatPostCommitProgress {
  generationId: string;
  requestedAt: string;
  targetTraceStatus: ChatTurnTraceRecord["status"];
  completedEffects: readonly GeneralChatPostCommitEffect[];
  /**
   * Runs one synchronous, same-database consumer under the parent row lock and
   * records its durable completion receipt in that transaction. This closes
   * the local commit gap for learned memory, capability facts, retained
   * realtime, and the existing idempotent hook enqueue.
   *
   * A callback that only starts process-local async work is not durable. The
   * memory prewarm remains explicitly best-effort cache warming; meaningful
   * async effects must use `enqueueDurableEffect` below.
   */
  runEffect(effect: GeneralChatPostCommitEffect, callback: () => void): boolean;
  /**
   * Commits the parent receipt first, then invokes an idempotent notification
   * publisher outside the transaction. Reconciliation republishes an existing
   * receipt so a crash between receipt commit and delivery cannot lose it.
   */
  publishEffect(effect: GeneralChatPostCommitEffect, callback: () => void): boolean;
  /**
   * Atomically creates a deterministic durable child run and records the
   * parent's enqueue receipt. Child execution is lease-governed and may be
   * retried after a crash, so provider-backed work is at-least-once rather
   * than exactly-once.
   */
  enqueueDurableEffect(input: GeneralChatPostCommitDurableEffectInput): string | undefined;
}

export type ChatDurableThreadEventType =
  | "chat_thread_turn_appended"
  | "chat_thread_turn_retried"
  | "chat_thread_turn_edited";

// Wake-event keys that the durable chat-turn parks register on `metadata.waitForEvent`.
// Each MUST exactly match the eventKey its real waker emits, or the parked run either
// resumes prematurely (loose key) or never resumes (wrong key):
//   - approval.resolved       — emitted by ApprovalEffectsService.wakeDurableRun
//                               (approval-resolution-effects-service.ts), correlationId = approvalId.
//   - chat.user_input.resolved — emitted by the user-input respond runtime
//                               (chat-message-route-runtime.ts), correlationId = promptId.
//   - chat.tool_wait.resolved  — SENTINEL. `waiting_for_tool` is a transient in-flight
//                               marker (see chat-turn-stream-service.ts); NO production
//                               path emits a keyed wake for it. Kept eventKey-only so an
//                               operator can still force-resume via the durable wake route,
//                               while blocking stray cross-type wakes.
const CHAT_APPROVAL_RESOLVED_WAKE_EVENT = "approval.resolved";
const CHAT_USER_INPUT_RESOLVED_WAKE_EVENT = "chat.user_input.resolved";
const CHAT_TOOL_WAIT_RESOLVED_WAKE_EVENT = "chat.tool_wait.resolved";

export interface CanonicalChatDurableWaitForEvent {
  eventKey: string;
  correlationId?: string;
}

/**
 * Resolve the wake contract for a chat turn that parked in a waiting state.
 *
 * The correlationId MUST match what the real waker supplies, and we NEVER guess
 * one: a wrong correlationId rejects a legitimate resume (worse than the loose
 * wake it replaces). When the identifier cannot be resolved from the trace we
 * fall back to eventKey-only so the run is still wakeable by its real waker.
 */
export function resolveCanonicalChatDurableWaitForEvent(trace: ChatTurnTraceRecord): CanonicalChatDurableWaitForEvent {
  if (trace.status === "waiting_for_approval") {
    // Mirror orchestration-phase-execution-service.ts: prefer the (hydration-only)
    // pendingApprovalSummary, then the persisted approval_required tool run.
    const approvalId =
      trace.pendingApprovalSummary?.approvalId ??
      trace.toolRuns.find((toolRun) => toolRun.status === "approval_required" && toolRun.approvalId)?.approvalId;
    return approvalId
      ? { eventKey: CHAT_APPROVAL_RESOLVED_WAKE_EVENT, correlationId: approvalId }
      : { eventKey: CHAT_APPROVAL_RESOLVED_WAKE_EVENT };
  }
  if (trace.status === "waiting_for_user_input") {
    const promptId = trace.pendingUserInput?.promptId;
    return promptId
      ? { eventKey: CHAT_USER_INPUT_RESOLVED_WAKE_EVENT, correlationId: promptId }
      : { eventKey: CHAT_USER_INPUT_RESOLVED_WAKE_EVENT };
  }
  // waiting_for_tool — eventKey-only sentinel (no real keyed waker exists).
  return { eventKey: CHAT_TOOL_WAIT_RESOLVED_WAKE_EVENT };
}

interface DurableRunStore {
  getRun?(runId: string): DurableRunRecord;
  getLatestCheckpointByKind?(
    runId: string,
    checkpointKind: DurableCheckpointRecord["checkpointKind"],
  ): DurableCheckpointRecord | undefined;
  lockFreshActiveLeaseForUpdate?(runId: string, expectedLeaseOwnerId: string): DurableRunRecord | undefined;
  updateRun(input: {
    runId: string;
    status?: DurableRunStatus;
    updatedAt?: string;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    lastError?: string;
    clearLastError?: boolean;
    clearLease?: boolean;
    metadata?: Record<string, unknown>;
    expectedVersion?: number;
  }): DurableRunRecord;
  createCheckpoint(input: {
    runId: string;
    checkpointKind: DurableCheckpointRecord["checkpointKind"];
    state: Record<string, unknown>;
    createdAt?: string;
  }): DurableCheckpointRecord;
}

interface ChatToolRunSummaryStore {
  listByTurn(turnId: string): Array<{
    toolRunId: string;
    toolName: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
}

interface ChatToolArtifactSummaryStore {
  listByTurn(turnId: string): Array<{
    artifactId: string;
    toolRunId?: string;
    toolName?: string;
    contentType?: string;
    byteLength?: number;
    storageRelPath?: string;
    snippet?: string;
  }>;
}

export interface ChatDurableRunBeginDeps {
  shouldUseDurableExecution: boolean;
  runImmediateTransaction?<T>(callback: () => T): T;
  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;
  buildDurablePayloadRecord(
    prepared: PreparedAgentChatTurn,
    input: ChatSendMessageRequest,
    threadEventType: ChatDurableThreadEventType,
    durableRunId: string,
  ): Record<string, unknown>;
  persistChatStreamChunk(
    chunk: {
      type: "message_start";
      sessionId: string;
      turnId: string;
      messageId: string;
      parentTurnId?: string;
      branchKind: ChatTurnBranchKind;
      sourceTurnId?: string;
    },
    durableRunId?: string,
  ): void;
  /** When present, the initial durable chat-turn trace is persisted through this store. */
  chatTurnTraces?: Pick<Storage["chatTurnTraces"], "get" | "create">;
  capabilityCatalogSnapshots?: Pick<Storage["capabilityCatalogSnapshots"], "create">;
  chatTurnCapabilityProfiles?: Pick<Storage["chatTurnCapabilityProfiles"], "create">;
  sessionMutationAdmissions?: Pick<Storage["sessionMutationAdmissions"], "bindCapabilityProfile">;
  routedContextSnapshots?: Pick<Storage["routedContextSnapshots"], "create">;
  skillLifecycle?: Pick<Storage["skillLifecycle"], "list">;
  assertTurnAdmissionWrite?(prepared: PreparedAgentChatTurn): void;
  bindTurnAdmissionToDurableRun?(prepared: PreparedAgentChatTurn, durableRunId: string): void;
  /** Selects retry/edit sibling branches inside the durable admission transaction. */
  activatePreparedBranch?(prepared: PreparedAgentChatTurn): void;
  onDurableRunCommitted?(run: DurableRunRecord): void;
  requestDurableRunProcessing(runId: string): void;
}

export interface ChatDurableRunFinalizeDeps {
  runImmediateTransaction<T>(callback: () => T): T;
  durableRuns: DurableRunStore;
  chatToolRuns: ChatToolRunSummaryStore;
  chatToolArtifacts: ChatToolArtifactSummaryStore;
  chatMessages?: Pick<{ get(messageId: string): ChatMessageRecord | undefined }, "get">;
  recordDurableTimelineEvent(
    durableRunId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
  chatTurnTraces: Pick<Storage["chatTurnTraces"], "patch">;
  resolvePostCommitEligibility(sessionId: string): PostCommitEligibility;
}

export function beginDurableChatRun(
  deps: ChatDurableRunBeginDeps,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  threadEventType: ChatDurableThreadEventType,
  options?: { mutationLifecycle?: ChatStreamMutationLifecycle; runId?: string },
): DurableRunRecord | undefined {
  const inputCarriesContextRefs = hasOwnRoutedContextRefs(input);
  const provisionalRoutedContextSnapshot = readPreparedRoutedContextSnapshot(prepared);
  if (!deps.shouldUseDurableExecution) {
    if (inputCarriesContextRefs || provisionalRoutedContextSnapshot) {
      throw new Error(`Chat turn ${prepared.turnId} cannot execute routed context without durable admission.`);
    }
    return undefined;
  }
  if (Boolean(deps.chatTurnCapabilityProfiles) !== Boolean(deps.capabilityCatalogSnapshots)) {
    throw new Error("Durable Chat capability admission stores are incompletely configured.");
  }
  if ((deps.chatTurnCapabilityProfiles || deps.capabilityCatalogSnapshots) && !deps.sessionMutationAdmissions) {
    throw new Error("Durable Chat capability profile binding store is not configured.");
  }
  if (
    (deps.chatTurnCapabilityProfiles || deps.capabilityCatalogSnapshots) &&
    (!prepared.capabilityProfile || !prepared.capabilityCatalogSnapshot)
  ) {
    throw new Error(`Durable Chat turn ${prepared.turnId} cannot be admitted without its capability profile.`);
  }
  const mode = resolvePreparedTurnMode(prepared);
  const runId = options?.runId ?? randomUUID();
  if (inputCarriesContextRefs && !provisionalRoutedContextSnapshot) {
    throw new Error(`Durable Chat turn ${prepared.turnId} cannot persist live routed-context references.`);
  }
  if (provisionalRoutedContextSnapshot) {
    assertPreparedRoutedContextSnapshotBinding(prepared, provisionalRoutedContextSnapshot);
  }
  if (provisionalRoutedContextSnapshot && !deps.runImmediateTransaction) {
    throw new Error(`Durable Chat turn ${prepared.turnId} requires atomic routed-context admission.`);
  }
  if (provisionalRoutedContextSnapshot && !deps.routedContextSnapshots) {
    throw new Error(`Durable Chat turn ${prepared.turnId} cannot persist its routed-context snapshot.`);
  }
  if (provisionalRoutedContextSnapshot && !deps.chatTurnTraces) {
    throw new Error(`Durable Chat turn ${prepared.turnId} cannot persist its routed-context trace binding.`);
  }
  if (prepared.capabilityProfile?.identity.durableRunId && prepared.capabilityProfile.identity.durableRunId !== runId) {
    throw new Error(`Durable Chat turn ${prepared.turnId} is already bound to another durable run.`);
  }
  if (prepared.turnAdmission && !deps.runImmediateTransaction) {
    throw new Error(`Durable Chat turn ${prepared.turnId} requires atomic mutation-admission binding.`);
  }
  let run!: DurableRunRecord;
  const admit = (beforeStreamPersist?: () => void) => {
    if (prepared.turnAdmission) {
      if (!deps.assertTurnAdmissionWrite) {
        throw new Error(`Durable Chat turn ${prepared.turnId} cannot verify its mutation admission.`);
      }
      deps.assertTurnAdmissionWrite(prepared);
    }
    if (prepared.capabilityProfile && !prepared.capabilityProfile.identity.durableRunId) {
      const { hashes: _hashes, ...draft } = prepared.capabilityProfile;
      prepared.capabilityProfile = sealChatTurnCapabilityProfile({
        ...draft,
        identity: {
          ...draft.identity,
          durableRunId: runId,
        },
      });
      prepared.history = upsertChatCapabilityProfileSystemInstruction(
        prepared.history ?? [],
        prepared.capabilityProfile,
      );
    }
    assertPreparedChatCapabilityAdmissionBindings(deps, prepared);
    if (prepared.capabilityProfile) {
      if (!deps.sessionMutationAdmissions) {
        throw new Error(`Durable Chat turn ${prepared.turnId} cannot bind its capability profile admission.`);
      }
      bindPreparedChatCapabilityProfileAdmission(
        { sessionMutationAdmissions: deps.sessionMutationAdmissions },
        prepared,
      );
    }
    if (prepared.capabilityCatalogSnapshot && deps.capabilityCatalogSnapshots) {
      prepared.capabilityCatalogSnapshot = deps.capabilityCatalogSnapshots.create(prepared.capabilityCatalogSnapshot);
    }
    if (prepared.capabilityProfile && deps.chatTurnCapabilityProfiles) {
      prepared.capabilityProfile = deps.chatTurnCapabilityProfiles.create(prepared.capabilityProfile);
    }
    let routedContextSnapshot: ChatRoutedContextSnapshotRecord | undefined;
    if (provisionalRoutedContextSnapshot) {
      if (!prepared.capabilityProfile || !deps.routedContextSnapshots) {
        throw new Error(`Durable Chat turn ${prepared.turnId} has an incomplete routed-context admission bundle.`);
      }
      routedContextSnapshot = rebindChatRoutedContextSnapshot(provisionalRoutedContextSnapshot, {
        profileId: prepared.capabilityProfile.profileId,
        profileHash: prepared.capabilityProfile.hashes.profileHash,
      });
      assertPreparedRoutedContextSnapshotBinding(prepared, routedContextSnapshot);
      routedContextSnapshot = deps.routedContextSnapshots.create(routedContextSnapshot);
      verifyChatRoutedContextSnapshot(routedContextSnapshot);
      assertPreparedRoutedContextSnapshotBinding(prepared, routedContextSnapshot);
      writePreparedRoutedContextSnapshot(prepared, routedContextSnapshot);
    }
    const durablePayload = buildDurableRoutedContextPayload(
      deps.buildDurablePayloadRecord(prepared, input, threadEventType, runId),
      routedContextSnapshot,
    );
    run = deps.createDurableRun({
      runId,
      workflowKey: "chat.turn.execute",
      payload: durablePayload,
      metadata: {
        surface: mode,
        autoPromoted: mode === "chat",
        objective: prepared.content,
        ...(prepared.capabilityProfile
          ? {
              capabilityProfileId: prepared.capabilityProfile.profileId,
              capabilityProfileHash: prepared.capabilityProfile.hashes.profileHash,
            }
          : {}),
      },
    });
    if (prepared.turnAdmission) {
      if (!deps.bindTurnAdmissionToDurableRun) {
        throw new Error(`Durable Chat turn ${prepared.turnId} cannot bind its mutation admission.`);
      }
      deps.bindTurnAdmissionToDurableRun(prepared, run.runId);
    }
    if (deps.chatTurnTraces) {
      persistInitialDurableChatTurnTrace({ chatTurnTraces: deps.chatTurnTraces }, prepared, input, run);
    }
    if (prepared.branchKind === "retry" || prepared.branchKind === "edit") {
      // A retry/edit's lineage parent is the source turn's parent, while its
      // branch-selection CAS must start from the leaf observed at preparation.
      // Claim the new sibling branch before scheduling any provider work. A
      // stale leaf therefore rolls this whole durable admission back instead
      // of producing output for a completion that can never commit.
      if (!deps.activatePreparedBranch) {
        throw new Error(`Durable Chat ${prepared.branchKind} turn ${prepared.turnId} cannot select its branch.`);
      }
      deps.activatePreparedBranch(prepared);
    }
    beforeStreamPersist?.();
    deps.persistChatStreamChunk(
      {
        type: "message_start",
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        messageId: prepared.assistantMessageId,
        parentTurnId: prepared.parentTurnId,
        branchKind: prepared.branchKind,
        sourceTurnId: prepared.sourceTurnId,
      },
      run.runId,
    );
  };
  if (deps.runImmediateTransaction) {
    deps.runImmediateTransaction(admit);
    options?.mutationLifecycle?.markCommitted();
  } else {
    // Compatibility for legacy/profile-less hosts: durable creation itself is
    // already committed before the first stream chunk is attempted.
    admit(() => options?.mutationLifecycle?.markCommitted());
  }
  deps.onDurableRunCommitted?.(run);
  deps.requestDurableRunProcessing(run.runId);
  return run;
}

type PreparedAgentChatTurnWithRoutedContext = PreparedAgentChatTurn & {
  routedContextSnapshot?: ChatRoutedContextSnapshotRecord;
};

function hasOwnRoutedContextRefs(input: ChatSendMessageRequest): boolean {
  const request = input as ChatSendMessageRequest & { contextRefs?: unknown };
  return Object.prototype.hasOwnProperty.call(request, "contextRefs") && request.contextRefs !== undefined;
}

function readPreparedRoutedContextSnapshot(
  prepared: PreparedAgentChatTurn,
): ChatRoutedContextSnapshotRecord | undefined {
  const snapshot = (prepared as PreparedAgentChatTurnWithRoutedContext).routedContextSnapshot;
  if (!snapshot) {
    return undefined;
  }
  verifyChatRoutedContextSnapshot(snapshot);
  return snapshot;
}

function writePreparedRoutedContextSnapshot(
  prepared: PreparedAgentChatTurn,
  snapshot: ChatRoutedContextSnapshotRecord,
): void {
  (prepared as PreparedAgentChatTurnWithRoutedContext).routedContextSnapshot = snapshot;
}

function assertPreparedRoutedContextSnapshotBinding(
  prepared: PreparedAgentChatTurn,
  snapshot: ChatRoutedContextSnapshotRecord,
): void {
  const profile = prepared.capabilityProfile;
  if (
    !profile ||
    snapshot.turnId !== prepared.turnId ||
    snapshot.sessionId !== prepared.session.sessionId ||
    snapshot.workspaceId !== prepared.workspaceId ||
    snapshot.capabilityProfileId !== profile.profileId ||
    snapshot.capabilityProfileHash !== profile.hashes.profileHash ||
    snapshot.budget.effectiveProviderId !== profile.selection.effectiveProviderId ||
    snapshot.budget.effectiveModel !== profile.selection.effectiveModel
  ) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has a mismatched routed-context snapshot.`);
  }
}

function buildDurableRoutedContextPayload(
  payload: Record<string, unknown>,
  snapshot: ChatRoutedContextSnapshotRecord | undefined,
): Record<string, unknown> {
  if (!snapshot) {
    return payload;
  }
  if (!payload.request || typeof payload.request !== "object" || Array.isArray(payload.request)) {
    throw new Error(`Durable Chat turn ${snapshot.turnId} produced a malformed routed-context payload.`);
  }
  const { contextRefs: _requestContextRefs, ...request } = payload.request as Record<string, unknown>;
  const { contextRefs: _topLevelContextRefs, ...withoutTopLevelRefs } = payload;
  const sanitized = {
    ...withoutTopLevelRefs,
    request,
    routedContextSnapshotId: snapshot.snapshotId,
    routedContextSnapshotHash: snapshot.snapshotHash,
  };
  assertDurablePayloadContainsNoRawRoutedContext(sanitized, snapshot.turnId);
  return sanitized;
}

function assertDurablePayloadContainsNoRawRoutedContext(payload: Record<string, unknown>, turnId: string): void {
  const forbiddenKeys = new Set([
    "contextrefs",
    "routedcontext",
    "routedcontextsnapshot",
    "routedcontextsources",
    "resolvedroutedcontextsources",
    "routedcontextentries",
    "routedcontexttext",
    "admittedtext",
    "sourcecontent",
  ]);
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) => forbiddenKeys.has(key.toLowerCase()) || visit(nested),
    );
  };
  if (visit(payload)) {
    throw new Error(`Durable Chat turn ${turnId} payload contains raw routed-context evidence.`);
  }
}

/**
 * Persist the initial "running" chat-turn trace for a freshly-begun durable run.
 * Idempotent: if a trace already exists for the turn (e.g. a retry re-entered the
 * durable path) it is left untouched.
 */
export function persistInitialDurableChatTurnTrace(
  deps: { chatTurnTraces: Pick<Storage["chatTurnTraces"], "get" | "create"> },
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  run: DurableRunRecord,
): void {
  persistInitialChatTurnTrace(deps, prepared, input, run);
}

/** Persist the immutable capability evidence before any provider/tool execution. */
export function persistPreparedChatCapabilityAdmission(
  deps: {
    capabilityCatalogSnapshots: Pick<Storage["capabilityCatalogSnapshots"], "create">;
    chatTurnCapabilityProfiles: Pick<Storage["chatTurnCapabilityProfiles"], "create">;
    sessionMutationAdmissions: Pick<Storage["sessionMutationAdmissions"], "bindCapabilityProfile">;
    skillLifecycle?: Pick<Storage["skillLifecycle"], "list">;
  },
  prepared: PreparedAgentChatTurn,
): void {
  if (Boolean(prepared.capabilityProfile) !== Boolean(prepared.capabilityCatalogSnapshot)) {
    throw new Error(`Chat turn ${prepared.turnId} has an incomplete capability admission bundle.`);
  }
  if (!prepared.capabilityProfile) {
    return;
  }
  if (!prepared.capabilityCatalogSnapshot) {
    throw new Error(`Chat turn ${prepared.turnId} has an incomplete capability admission bundle.`);
  }
  assertPreparedChatCapabilityAdmissionBindings(deps, prepared);
  bindPreparedChatCapabilityProfileAdmission(deps, prepared);
  prepared.capabilityCatalogSnapshot = deps.capabilityCatalogSnapshots.create(prepared.capabilityCatalogSnapshot);
  prepared.capabilityProfile = deps.chatTurnCapabilityProfiles.create(prepared.capabilityProfile);
}

function bindPreparedChatCapabilityProfileAdmission(
  deps: { sessionMutationAdmissions: Pick<Storage["sessionMutationAdmissions"], "bindCapabilityProfile"> },
  prepared: PreparedAgentChatTurn,
): void {
  const admission = prepared.turnAdmission;
  const profile = prepared.capabilityProfile;
  if (!admission || !profile) {
    throw new Error(`Chat turn ${prepared.turnId} capability admission requires an active turn-write admission.`);
  }
  const requestRuntimeClaim = admission.requestClaim
    ? {
        runtimeOwnerId: admission.requestClaim.runtimeOwnerId,
        leaseRevision: admission.requestClaim.leaseRevision,
      }
    : undefined;
  const durableClaim = admission.durableClaim
    ? {
        durableRunId: admission.durableClaim.durableRunId,
        leaseOwnerId: admission.durableClaim.leaseOwnerId,
        attemptCount: admission.durableClaim.attemptCount,
      }
    : undefined;
  if (!requestRuntimeClaim && !durableClaim) {
    throw new Error(`Chat turn ${prepared.turnId} capability admission has no active request or durable claim.`);
  }
  deps.sessionMutationAdmissions.bindCapabilityProfile({
    admissionId: admission.identity.admissionId,
    sessionIncarnationId: admission.identity.sessionIncarnationId,
    workspaceId: admission.identity.workspaceId,
    sessionId: admission.identity.sessionId,
    turnId: admission.identity.turnId,
    ...(requestRuntimeClaim ? { requestRuntimeClaim } : {}),
    ...(durableClaim ? { durableClaim } : {}),
    profileId: profile.profileId,
    profileHash: profile.hashes.profileHash,
    createdAt: profile.createdAt,
  });
}

function assertPreparedChatCapabilityAdmissionBindings(
  deps: {
    skillLifecycle?: Pick<Storage["skillLifecycle"], "list">;
  },
  prepared: PreparedAgentChatTurn,
): void {
  if (!prepared.capabilityProfile || !prepared.capabilityCatalogSnapshot) {
    return;
  }
  verifyChatTurnCapabilityCatalogBinding(prepared.capabilityProfile, prepared.capabilityCatalogSnapshot);
  if (prepared.capabilityProfile.selection.trustedSkills.length > 0 && !deps.skillLifecycle) {
    throw new Error(`Chat turn ${prepared.turnId} cannot verify its trusted skill lifecycle bindings.`);
  }
  verifyChatTurnCapabilitySkillBindings(prepared.capabilityProfile, deps.skillLifecycle?.list() ?? []);
}

/**
 * Persist the initial running trace that makes a streamed turn durable enough
 * for cancellation/idempotency ownership before its first SSE payload.
 */
export function persistInitialChatTurnTrace(
  deps: { chatTurnTraces: Pick<Storage["chatTurnTraces"], "get" | "create"> },
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  run?: DurableRunRecord,
): void {
  const routedContextSnapshot = readPreparedRoutedContextSnapshot(prepared);
  try {
    const existing = deps.chatTurnTraces.get(prepared.turnId);
    assertTraceRoutedContextBinding(existing, routedContextSnapshot);
    return;
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  deps.chatTurnTraces.create({
    turnId: prepared.turnId,
    sessionId: prepared.session.sessionId,
    userMessageId: prepared.userEventId,
    assistantMessageId: prepared.assistantMessageId,
    parentTurnId: prepared.parentTurnId,
    branchKind: prepared.branchKind,
    sourceTurnId: prepared.sourceTurnId,
    status: "running",
    mode: resolvePreparedTurnMode(prepared),
    model: prepared.capabilityProfile?.selection.effectiveModel ?? input.model ?? prepared.prefs.model,
    webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
    memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
    thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
    speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
    subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
    effectiveToolAutonomy: prepared.effectiveToolAutonomy,
    capabilitySnapshotId: prepared.capabilityProfile?.catalog.snapshotId,
    capabilityProfileId: prepared.capabilityProfile?.profileId,
    capabilityProfileHash: prepared.capabilityProfile?.hashes.profileHash,
    routing: {
      primaryProviderId:
        prepared.capabilityProfile?.selection.effectiveProviderId ?? input.providerId ?? prepared.prefs.providerId,
      primaryModel: prepared.capabilityProfile?.selection.effectiveModel ?? input.model ?? prepared.prefs.model,
      effectiveProviderId:
        prepared.capabilityProfile?.selection.effectiveProviderId ?? input.providerId ?? prepared.prefs.providerId,
      effectiveModel: prepared.capabilityProfile?.selection.effectiveModel ?? input.model ?? prepared.prefs.model,
      ...(routedContextSnapshot ? { routedContext: buildRoutedContextBindingReceipt(routedContextSnapshot) } : {}),
      modelRouter: prepared.modelRouterDecision,
    },
    ...(run
      ? {
          durable: {
            runId: run.runId,
            status: run.status,
          },
        }
      : {}),
  });
}

function buildRoutedContextBindingReceipt(snapshot: ChatRoutedContextSnapshotRecord) {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    sourceRequestHash: snapshot.sourceRequestHash,
    contentHash: snapshot.contentHash,
  };
}

function assertTraceRoutedContextBinding(
  trace: ChatTurnTraceRecord,
  snapshot: ChatRoutedContextSnapshotRecord | undefined,
): void {
  const binding = trace.routing.routedContext;
  if (!snapshot) {
    if (binding) {
      throw new Error(`Chat turn ${trace.turnId} has stale routed-context trace evidence.`);
    }
    return;
  }
  const expected = buildRoutedContextBindingReceipt(snapshot);
  if (
    !binding ||
    binding.snapshotId !== expected.snapshotId ||
    binding.snapshotHash !== expected.snapshotHash ||
    binding.sourceRequestHash !== expected.sourceRequestHash ||
    binding.contentHash !== expected.contentHash
  ) {
    throw new Error(`Chat turn ${trace.turnId} has a mismatched routed-context trace binding.`);
  }
}

/** Patch a chat-turn trace, tolerating a trace that was never created for the turn. */
function patchDurableTraceIfPresent(
  chatTurnTraces: Pick<Storage["chatTurnTraces"], "patch">,
  turnId: string,
  input: Parameters<Storage["chatTurnTraces"]["patch"]>[1],
): void {
  try {
    chatTurnTraces.patch(turnId, input);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
}

export function finalizeDurableChatRun(
  deps: ChatDurableRunFinalizeDeps,
  runId: string,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  expectedLeaseOwnerId?: string,
): void {
  const now = new Date().toISOString();
  const currentRun = deps.durableRuns.getRun?.(runId);
  const admittedPayload = currentRun
    ? requireExactAdmittedV2ChatFinalizeContext(currentRun, prepared, trace)
    : undefined;
  const heartbeatIdentity =
    currentRun && admittedPayload ? readExactSystemHeartbeatFinalizeIdentity(currentRun, admittedPayload) : undefined;
  if (currentRun && isDurableRunTerminal(currentRun.status)) {
    verifyTerminalDurableChatReplayAuthority(deps, currentRun, prepared, trace);
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
        checkpointKind: checkpointKindForTerminalDurableChatRunStatus(currentRun.status),
      },
    });
    return;
  }
  if (currentRun?.status === "waiting") {
    if (heartbeatIdentity && trace.status === "waiting_for_approval") {
      throw new Error(`System heartbeat ${runId} cannot retain waiting-for-approval authority.`);
    }
    verifyWaitingDurableChatReplayAuthority(deps, currentRun, prepared, trace);
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      durable: {
        runId,
        status: "waiting",
        checkpointKind: "run_waiting",
      },
    });
    return;
  }
  if (currentRun && currentRun.status !== "running") {
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
      },
    });
    return;
  }
  const lockCommittableRun = (): DurableRunRecord | undefined => {
    if (expectedLeaseOwnerId) {
      return deps.durableRuns.lockFreshActiveLeaseForUpdate?.(runId, expectedLeaseOwnerId);
    }
    const latest = deps.durableRuns.getRun?.(runId) ?? currentRun;
    return latest?.status === "running" ? latest : undefined;
  };
  const heartbeatApprovalBlocked = Boolean(heartbeatIdentity && trace.status === "waiting_for_approval");
  const effectiveTrace: ChatTurnTraceRecord = heartbeatApprovalBlocked
    ? {
        ...trace,
        status: "failed",
        finishedAt: now,
        failure: {
          failureClass: "approval_required",
          message: "System heartbeat tool execution requires an approval and was blocked.",
          retryable: false,
        },
        completion: {
          finishReason: trace.completion?.finishReason,
          status: "interrupted",
          repaired: Boolean(trace.completion?.repaired),
        },
      }
    : trace;
  const checkpointState = buildDurableCheckpointState(deps, prepared, effectiveTrace, {
    systemHeartbeat: Boolean(heartbeatIdentity),
  });
  const postCommitEligibility = heartbeatIdentity
    ? SYSTEM_HEARTBEAT_POST_COMMIT_ELIGIBILITY
    : deps.resolvePostCommitEligibility(prepared.session.sessionId);
  if (heartbeatApprovalBlocked) {
    assertNoSystemHeartbeatDecisionEvidence(currentRun!);
    runChatFinalizeTransaction(deps, () => {
      const latest = lockCommittableRun();
      if (!latest) return;
      const generationId = randomUUID();
      const terminalCheckpointState = Object.fromEntries(
        Object.entries({ ...checkpointState, currentStep: "failed" }).filter(
          ([key]) => key !== "assistantMessageId" && key !== "outputText" && key !== "outputSummary",
        ),
      );
      const pendingMetadata = markGeneralChatPostCommitPending(
        resetChatTurnRuntimeTransitionMetadata(
          mergeCanonicalDurableChatTerminalOutputMetadata(latest.metadata, undefined),
        ),
        now,
        "failed",
        postCommitEligibility,
        generationId,
      );
      const authority = buildAdmittedChatTransitionAuthority(latest, prepared, effectiveTrace, {
        turnId: prepared.turnId,
        transitionKind: "terminal",
        durableStatus: "failed",
        traceStatus: "failed",
        transitionAt: now,
        generationId,
        postCommitEligibility,
      });
      const metadata = withChatTurnRuntimeAuthority(pendingMetadata, authority);
      const anchoredCheckpointState = withChatTurnRuntimeAuthorityCheckpoint(terminalCheckpointState, authority);
      deps.durableRuns.updateRun({
        runId,
        status: "failed",
        updatedAt: now,
        finishedAt: now,
        clearLease: true,
        lastError: effectiveTrace.failure?.message,
        metadata,
        expectedVersion: latest.version,
      });
      deps.durableRuns.createCheckpoint({ runId, checkpointKind: "run_failed", state: anchoredCheckpointState });
      deps.recordDurableTimelineEvent(runId, "run_failed", anchoredCheckpointState);
      deps.chatTurnTraces.patch(prepared.turnId, {
        status: "failed",
        finishedAt: now,
        failure: effectiveTrace.failure,
        completion: effectiveTrace.completion,
        durable: { runId, status: "failed", checkpointKind: "run_failed" },
      });
    });
    return;
  }
  if (
    trace.status === "waiting_for_approval" ||
    trace.status === "waiting_for_user_input" ||
    trace.status === "waiting_for_tool"
  ) {
    const waitForEvent = resolveCanonicalChatDurableWaitForEvent(trace);
    runChatFinalizeTransaction(deps, () => {
      const latest = lockCommittableRun();
      if (!latest) return;
      const generationId = randomUUID();
      const transitionMetadata = resetChatTurnRuntimeTransitionMetadata(
        mergeCanonicalDurableChatTerminalOutputMetadata(latest.metadata, undefined),
      );
      const pendingMetadata = markGeneralChatPostCommitPending(
        { ...transitionMetadata, waitForEvent },
        now,
        trace.status,
        postCommitEligibility,
        generationId,
      );
      const authority = buildAdmittedChatTransitionAuthority(latest, prepared, trace, {
        turnId: prepared.turnId,
        transitionKind: "waiting",
        durableStatus: "waiting",
        traceStatus: trace.status,
        transitionAt: now,
        generationId,
        postCommitEligibility,
        waitForEvent,
      });
      const metadata = withChatTurnRuntimeAuthority(pendingMetadata, authority);
      const anchoredCheckpointState = withChatTurnRuntimeAuthorityCheckpoint(
        { ...checkpointState, waitForEvent },
        authority,
      );
      deps.durableRuns.updateRun({
        runId,
        status: "waiting",
        updatedAt: now,
        clearFinishedAt: true,
        clearLastError: true,
        clearLease: true,
        metadata,
        expectedVersion: latest.version,
      });
      deps.durableRuns.createCheckpoint({
        runId,
        checkpointKind: "run_waiting",
        state: anchoredCheckpointState,
      });
      deps.recordDurableTimelineEvent(runId, "run_waiting", anchoredCheckpointState);
      patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
        durable: {
          runId,
          status: "waiting",
          checkpointKind: "run_waiting",
        },
      });
    });
    return;
  }
  if (trace.status === "cancelled") {
    if (heartbeatIdentity) assertNoSystemHeartbeatDecisionEvidence(currentRun!);
    const checkpointKind: DurableCheckpointRecord["checkpointKind"] = "run_cancelled";
    runChatFinalizeTransaction(deps, () => {
      const latest = lockCommittableRun();
      if (!latest) return;
      const generationId = randomUUID();
      const pendingMetadata = markGeneralChatPostCommitPending(
        resetChatTurnRuntimeTransitionMetadata(
          mergeCanonicalDurableChatTerminalOutputMetadata(latest.metadata, undefined),
        ),
        now,
        trace.status,
        postCommitEligibility,
        generationId,
      );
      const authority = buildAdmittedChatTransitionAuthority(latest, prepared, trace, {
        turnId: prepared.turnId,
        transitionKind: "terminal",
        durableStatus: "cancelled",
        traceStatus: trace.status,
        transitionAt: now,
        generationId,
        postCommitEligibility,
      });
      const metadata = withChatTurnRuntimeAuthority(pendingMetadata, authority);
      const anchoredCheckpointState = withChatTurnRuntimeAuthorityCheckpoint(checkpointState, authority);
      deps.durableRuns.updateRun({
        runId,
        status: "cancelled",
        updatedAt: now,
        finishedAt: now,
        clearLease: true,
        lastError: "cancelled",
        metadata,
        expectedVersion: latest.version,
      });
      deps.durableRuns.createCheckpoint({
        runId,
        checkpointKind,
        state: anchoredCheckpointState,
      });
      deps.recordDurableTimelineEvent(runId, "run_cancelled", anchoredCheckpointState);
      patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
        durable: {
          runId,
          status: "cancelled",
          checkpointKind,
        },
      });
    });
    return;
  }
  const completionFailed = trace.completion ? trace.completion.status !== "complete" : false;
  const failed = trace.status === "failed" || completionFailed;
  const nextStatus: DurableRunStatus = failed ? "failed" : "completed";
  const terminalTraceStatus: ChatTurnTraceRecord["status"] = failed ? "failed" : trace.status;
  const checkpointKind: DurableCheckpointRecord["checkpointKind"] = failed ? "run_failed" : "run_completed";
  if (heartbeatIdentity && nextStatus !== "completed") assertNoSystemHeartbeatDecisionEvidence(currentRun!);
  if (
    heartbeatIdentity &&
    nextStatus === "completed" &&
    (terminalTraceStatus !== "completed" || !isExactSystemHeartbeatCompletion(trace.completion))
  ) {
    throw new Error(`System heartbeat ${runId} cannot authorize a partial, repaired, or incomplete decision.`);
  }
  const heartbeatDecision =
    heartbeatIdentity && nextStatus === "completed"
      ? requireExactSystemHeartbeatFinalizeDecision(currentRun!, heartbeatIdentity)
      : undefined;
  const terminalOutput =
    nextStatus === "completed" && (!heartbeatDecision || heartbeatDecision.decision.notify)
      ? readCanonicalDurableChatTerminalOutput(deps, prepared, trace, {
          systemHeartbeat: Boolean(heartbeatDecision),
        })
      : undefined;
  if (heartbeatDecision?.decision.notify && !terminalOutput) {
    throw new Error(`Notifying system heartbeat ${runId} has no exact normalized system message.`);
  }
  const baseTerminalCheckpointState = failed
    ? Object.fromEntries(
        Object.entries({ ...checkpointState, currentStep: "failed" }).filter(
          ([key]) => key !== "assistantMessageId" && key !== "outputText" && key !== "outputSummary",
        ),
      )
    : checkpointState;
  const terminalCheckpointState = heartbeatDecision
    ? {
        ...baseTerminalCheckpointState,
        [HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]: heartbeatDecision.receipt,
        [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: heartbeatDecision.rawOutput,
      }
    : baseTerminalCheckpointState;
  runChatFinalizeTransaction(deps, () => {
    const latest = lockCommittableRun();
    if (!latest) return;
    const generationId = randomUUID();
    const transitionMetadata = resetChatTurnRuntimeTransitionMetadata(
      mergeCanonicalDurableChatTerminalOutputMetadata(latest.metadata, terminalOutput),
    );
    const terminalMetadata = markGeneralChatPostCommitPending(
      transitionMetadata,
      now,
      terminalTraceStatus,
      postCommitEligibility,
      generationId,
    );
    const pendingMetadata =
      nextStatus === "completed" && latest.metadata?.autonomousAdmission !== undefined
        ? markAutonomousChatPostCommitPending(terminalMetadata, now, generationId)
        : terminalMetadata;
    const authority = buildAdmittedChatTransitionAuthority(latest, prepared, trace, {
      turnId: prepared.turnId,
      transitionKind: "terminal",
      durableStatus: nextStatus,
      traceStatus: terminalTraceStatus,
      transitionAt: now,
      generationId,
      postCommitEligibility,
      ...(terminalOutput ? { terminalOutput } : {}),
      ...(heartbeatDecision ? { heartbeatDecisionReceipt: heartbeatDecision.receipt } : {}),
    });
    const metadata = withChatTurnRuntimeAuthority(pendingMetadata, authority);
    const anchoredCheckpointState = withChatTurnRuntimeAuthorityCheckpoint(terminalCheckpointState, authority);
    deps.durableRuns.updateRun({
      runId,
      status: nextStatus,
      updatedAt: now,
      finishedAt: now,
      clearLease: true,
      metadata,
      ...(failed ? { lastError: trace.failure?.message ?? "Durable chat run failed." } : { clearLastError: true }),
      expectedVersion: latest.version,
    });
    deps.durableRuns.createCheckpoint({
      runId,
      checkpointKind,
      state: anchoredCheckpointState,
    });
    deps.recordDurableTimelineEvent(
      runId,
      failed ? "run_failed" : "run_completed",
      omitHeartbeatDecisionRawOutput(anchoredCheckpointState),
    );
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      ...(completionFailed ? { status: "failed" as const } : {}),
      durable: {
        runId,
        status: nextStatus,
        checkpointKind,
      },
    });
  });
}

function buildAdmittedChatTransitionAuthority(
  run: DurableRunRecord,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  input: Omit<BuildChatTurnRuntimeAuthoritySealInput, "runId" | "postCommitGenerationId" | "requiredFinalizers"> & {
    generationId: string;
  },
): ChatTurnRuntimeAuthoritySealV1 {
  const payload = requireExactAdmittedV2ChatFinalizeContext(run, prepared, trace);
  const autonomous = run.metadata?.autonomousAdmission !== undefined;
  if (autonomous) verifyAutonomousChatAdmissionRunMetadata(run, { trace });
  if (payload.turnId !== input.turnId) {
    throw new Error(`Durable Chat run ${run.runId} runtime authority does not match its admitted turn.`);
  }
  const requiredFinalizers =
    input.durableStatus === "completed" && autonomous ? (["autonomous", "general"] as const) : (["general"] as const);
  return buildChatTurnRuntimeAuthoritySeal({
    runId: run.runId,
    turnId: input.turnId,
    transitionKind: input.transitionKind,
    durableStatus: input.durableStatus,
    traceStatus: input.traceStatus,
    transitionAt: input.transitionAt,
    postCommitGenerationId: input.generationId,
    postCommitEligibility: input.postCommitEligibility,
    ...(input.waitForEvent ? { waitForEvent: input.waitForEvent } : {}),
    ...(input.terminalOutput ? { terminalOutput: input.terminalOutput } : {}),
    ...(input.linkedFinalization ? { linkedFinalization: input.linkedFinalization } : {}),
    ...(input.heartbeatDecisionReceipt ? { heartbeatDecisionReceipt: input.heartbeatDecisionReceipt } : {}),
    requiredFinalizers,
  });
}

type ExactAdmittedV2ChatFinalizePayload = {
  version: "chat.turn.execute.v2";
  admissionId: string;
  sessionIncarnationId: string;
  admissionMaterialSha256: string;
  effectiveRequestMaterialSha256: string;
  workspaceId: string;
  admissionAggregateRevision: number;
  admissionControllerGeneration: number;
  requestActor: Record<string, unknown>;
  request: Record<string, unknown>;
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  heartbeatOccurrenceId?: string;
  heartbeatClaimSha256?: string;
  heartbeatEvaluatedPolicySha256?: string;
  heartbeatFrozenObjectiveSha256?: string;
};

interface ExactSystemHeartbeatFinalizeIdentity {
  occurrenceId: string;
  claimSha256: string;
}

interface ExactSystemHeartbeatFinalizeDecision {
  rawOutput: string;
  decision: ExactHeartbeatDecision;
  receipt: HeartbeatDecisionReceipt;
}

function isExactSystemHeartbeatCompletion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const completion = value as Record<string, unknown>;
  return (
    Object.keys(completion).sort().join(",") === "repaired,status" &&
    completion.status === "complete" &&
    completion.repaired === false
  );
}

function readExactSystemHeartbeatFinalizeIdentity(
  run: DurableRunRecord,
  payload: ExactAdmittedV2ChatFinalizePayload,
): ExactSystemHeartbeatFinalizeIdentity | undefined {
  const heartbeatFields = [
    payload.heartbeatOccurrenceId,
    payload.heartbeatClaimSha256,
    payload.heartbeatEvaluatedPolicySha256,
    payload.heartbeatFrozenObjectiveSha256,
  ];
  const hasAnyHeartbeatField = heartbeatFields.some((value) => value !== undefined);
  if (!hasAnyHeartbeatField) {
    if (
      run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
      run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined
    ) {
      throw new Error(`Non-heartbeat Chat run ${run.runId} contains heartbeat decision evidence.`);
    }
    return undefined;
  }
  const requestActor = payload.requestActor;
  const autonomous = run.metadata?.autonomous;
  if (
    typeof payload.heartbeatOccurrenceId !== "string" ||
    !payload.heartbeatOccurrenceId.trim() ||
    typeof payload.heartbeatClaimSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.heartbeatClaimSha256) ||
    typeof payload.heartbeatEvaluatedPolicySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.heartbeatEvaluatedPolicySha256) ||
    typeof payload.heartbeatFrozenObjectiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.heartbeatFrozenObjectiveSha256) ||
    requestActor.actorKind !== "system" ||
    requestActor.actorId !== SYSTEM_HEARTBEAT_ACTOR_ID ||
    !autonomous ||
    typeof autonomous !== "object" ||
    Array.isArray(autonomous) ||
    (autonomous as Record<string, unknown>).kind !== "heartbeat" ||
    (autonomous as Record<string, unknown>).systemActorId !== SYSTEM_HEARTBEAT_ACTOR_ID
  ) {
    throw new Error(`Durable Chat run ${run.runId} has malformed system-heartbeat identity evidence.`);
  }
  return {
    occurrenceId: payload.heartbeatOccurrenceId,
    claimSha256: payload.heartbeatClaimSha256,
  };
}

function requireExactSystemHeartbeatFinalizeDecision(
  run: DurableRunRecord,
  identity: ExactSystemHeartbeatFinalizeIdentity,
): ExactSystemHeartbeatFinalizeDecision {
  const rawOutput = run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY];
  const observedReceipt = run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY];
  if (typeof rawOutput !== "string" || observedReceipt === undefined) {
    throw new Error(`Completed system heartbeat ${run.runId} has no exact decision evidence.`);
  }
  const expected = buildHeartbeatDecisionReceipt({
    occurrenceId: identity.occurrenceId,
    claimSha256: identity.claimSha256,
    rawOutput,
  });
  if (canonicalJsonString(observedReceipt) !== canonicalJsonString(expected.receipt)) {
    throw new Error(`Completed system heartbeat ${run.runId} decision receipt drifted from its raw output.`);
  }
  return { rawOutput, ...expected };
}

function assertNoSystemHeartbeatDecisionEvidence(run: DurableRunRecord): void {
  if (
    run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
    run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined
  ) {
    throw new Error(`Non-completed system heartbeat ${run.runId} contains decision evidence.`);
  }
}

function requireExactAdmittedV2ChatFinalizeContext(
  run: DurableRunRecord,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
): ExactAdmittedV2ChatFinalizePayload {
  const payload = run.payload as Partial<ExactAdmittedV2ChatFinalizePayload> | undefined;
  if (payload?.version !== "chat.turn.execute.v2") {
    throw new Error(
      `Durable Chat run ${run.runId} has no exact admitted v2 authority and is quarantined from finalization.`,
    );
  }
  if (run.workflowKey !== "chat.turn.execute") {
    throw new Error(`Durable run ${run.runId} carries a Chat v2 payload under the wrong workflow.`);
  }
  const admission = prepared.turnAdmission;
  const identity = admission?.identity;
  if (!admission || !identity) {
    throw new Error(`Durable Chat v2 run ${run.runId} has no exact admitted finalize context.`);
  }
  const request = payload.request;
  const requestActor = payload.requestActor;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error(`Durable Chat v2 run ${run.runId} has no canonical effective request.`);
  }
  if (!requestActor || typeof requestActor !== "object" || Array.isArray(requestActor)) {
    throw new Error(`Durable Chat v2 run ${run.runId} has no canonical request actor.`);
  }
  const exactIdentity =
    payload.admissionId === identity.admissionId &&
    payload.sessionIncarnationId === identity.sessionIncarnationId &&
    payload.admissionMaterialSha256 === identity.materialSha256 &&
    payload.workspaceId === identity.workspaceId &&
    payload.sessionId === identity.sessionId &&
    payload.turnId === identity.turnId &&
    payload.admissionAggregateRevision === identity.aggregateRevision &&
    payload.admissionControllerGeneration === identity.controllerGeneration;
  const exactPreparedBinding =
    prepared.workspaceId === identity.workspaceId &&
    prepared.session.sessionId === identity.sessionId &&
    prepared.turnId === identity.turnId &&
    prepared.userMessage.messageId === payload.userMessageId &&
    prepared.userMessage.sessionId === identity.sessionId &&
    prepared.assistantMessageId === payload.assistantMessageId;
  const exactTraceBinding =
    trace.turnId === identity.turnId &&
    trace.sessionId === identity.sessionId &&
    trace.userMessageId === payload.userMessageId &&
    trace.assistantMessageId === payload.assistantMessageId;
  const exactMaterialBinding =
    computeFrozenChatTurnAdmissionMaterialSha256(admission.admittedRequest) === payload.admissionMaterialSha256 &&
    computeEffectiveChatTurnRequestMaterialSha256(
      payload.admissionMaterialSha256,
      request as typeof admission.admittedRequest,
    ) === payload.effectiveRequestMaterialSha256 &&
    canonicalJsonString(requestActor) === canonicalJsonString(admission.requestActor);
  const durableClaim = admission.durableClaim;
  const exactDurableClaim =
    !durableClaim ||
    (durableClaim.durableRunId === run.runId &&
      durableClaim.attemptCount === run.attemptCount &&
      (!run.leaseOwnerId || durableClaim.leaseOwnerId === run.leaseOwnerId));
  if (!exactIdentity || !exactPreparedBinding || !exactTraceBinding || !exactMaterialBinding || !exactDurableClaim) {
    throw new Error(`Durable Chat v2 run ${run.runId} finalize context drifted from its admitted identity.`);
  }
  assertDurableRetryPolicyMatchesRun(run.metadata?.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
  if (
    run.metadata?.autonomousAdmission === undefined &&
    (run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
      run.metadata?.autonomousChatPostCommit !== undefined)
  ) {
    throw new Error(
      `Durable Chat v2 run ${run.runId} carries autonomous finalizer evidence without autonomous admission.`,
    );
  }
  return payload as ExactAdmittedV2ChatFinalizePayload;
}

export function resetChatTurnRuntimeTransitionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const reset = { ...(metadata ?? {}) };
  for (const key of [
    CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
    GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
    AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
    "generalChatPostCommit",
    "autonomousChatPostCommit",
    "linkedFinalizationPending",
    "linkedFinalization",
    "chatTurnAdmissionHandoff",
    "chatRetryExhaustionDeadLetterPending",
    "waitForEvent",
  ]) {
    delete reset[key];
  }
  return reset;
}

function verifyWaitingDurableChatReplayAuthority(
  deps: ChatDurableRunFinalizeDeps,
  run: DurableRunRecord,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
): void {
  const payload = requireExactAdmittedV2ChatFinalizeContext(run, prepared, trace);
  const heartbeatIdentity = readExactSystemHeartbeatFinalizeIdentity(run, payload);
  if (heartbeatIdentity) {
    assertNoSystemHeartbeatDecisionEvidence(run);
    if (trace.status === "waiting_for_approval") {
      throw new Error(`System heartbeat ${run.runId} cannot retain waiting-for-approval authority.`);
    }
  }
  const authority = readChatTurnRuntimeAuthoritySeal(run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
  if (
    !authority ||
    authority.material.transitionKind !== "waiting" ||
    authority.material.durableStatus !== "waiting" ||
    authority.material.runId !== run.runId ||
    authority.material.turnId !== payload.turnId ||
    authority.material.traceStatus !== trace.status ||
    canonicalJsonString(run.metadata?.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent)
  ) {
    throw new Error(`Durable Chat run ${run.runId} has no exact waiting replay authority.`);
  }
  const checkpoint = deps.durableRuns.getLatestCheckpointByKind?.(run.runId, "run_waiting");
  if (!checkpoint) {
    throw new Error(`Durable Chat run ${run.runId} has no exact latest waiting authority checkpoint.`);
  }
  verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
  if (
    canonicalJsonString(checkpoint.state.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent) ||
    checkpoint.state.currentStep !== authority.material.traceStatus
  ) {
    throw new Error(`Durable Chat run ${run.runId} waiting checkpoint drifted from its authority.`);
  }
  const staleMetadataKeys = [
    "outputText",
    "finalOutput",
    "outputSummary",
    "finalSummary",
    "outputMessageId",
    "outputTraceStatus",
  ];
  const staleCheckpointKeys = [
    "assistantMessageId",
    "outputText",
    "finalOutput",
    "outputSummary",
    "finalSummary",
    "outputMessageId",
    "outputTraceStatus",
  ];
  if (
    authority.material.terminalOutput ||
    authority.material.heartbeatDecisionReceipt !== undefined ||
    checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
    checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined ||
    staleMetadataKeys.some((key) => run.metadata?.[key] !== undefined) ||
    staleCheckpointKeys.some((key) => checkpoint.state[key] !== undefined)
  ) {
    throw new Error(`Durable Chat run ${run.runId} carries stale output evidence for a waiting replay.`);
  }
  if (
    run.metadata?.linkedFinalizationPending !== undefined ||
    run.metadata?.linkedFinalization !== undefined ||
    run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
    run.metadata?.autonomousChatPostCommit !== undefined ||
    run.metadata?.chatTurnAdmissionHandoff !== undefined
  ) {
    throw new Error(`Durable Chat run ${run.runId} carries terminal finalizer evidence while waiting.`);
  }
  const generalPending = readExactGeneralChatPostCommitPendingMarker(
    run.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
  );
  const generalSettlement = readExactGeneralChatPostCommitSettlement(run.metadata?.generalChatPostCommit);
  const matchingPending =
    generalPending &&
    generalPending.generationId === authority.material.postCommitGenerationId &&
    generalPending.traceStatus === authority.material.traceStatus &&
    generalPending.requestedAt === authority.material.transitionAt &&
    canonicalJsonString(generalPending.postCommitEligibility) ===
      canonicalJsonString(authority.material.postCommitEligibility);
  const matchingSettlement =
    generalSettlement &&
    generalSettlement.generationId === authority.material.postCommitGenerationId &&
    generalSettlement.traceStatus === authority.material.traceStatus &&
    generalSettlement.requestedAt === authority.material.transitionAt &&
    canonicalJsonString(generalSettlement.postCommitEligibility) ===
      canonicalJsonString(authority.material.postCommitEligibility) &&
    (generalSettlement.settlementStatus === "completed" ||
      generalSettlement.settlementStatus === "settled_with_failures") &&
    typeof generalSettlement.completedAt === "string";
  if (
    Boolean(generalPending) === Boolean(generalSettlement) ||
    (generalPending && !matchingPending) ||
    (generalSettlement && !matchingSettlement)
  ) {
    throw new Error(`Durable Chat run ${run.runId} general waiting finalizer drifted from its authority.`);
  }
}

function verifyTerminalDurableChatReplayAuthority(
  deps: ChatDurableRunFinalizeDeps,
  run: DurableRunRecord,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
): void {
  const payload = requireExactAdmittedV2ChatFinalizeContext(run, prepared, trace);
  if (run.metadata?.autonomousAdmission !== undefined) {
    verifyAutonomousChatAdmissionRunMetadata(run, { trace });
  }
  const authority = readChatTurnRuntimeAuthoritySeal(run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
  const semanticStatus = run.status === "dead_lettered" ? "failed" : run.status;
  if (
    !authority ||
    !(semanticStatus === "completed" || semanticStatus === "failed" || semanticStatus === "cancelled") ||
    authority.material.runId !== run.runId ||
    authority.material.turnId !== payload.turnId ||
    authority.material.durableStatus !== semanticStatus ||
    authority.material.traceStatus !== trace.status ||
    (authority.material.transitionKind === "linked_finalization" && semanticStatus !== "failed") ||
    (authority.material.transitionKind !== "terminal" && authority.material.transitionKind !== "linked_finalization")
  ) {
    throw new Error(`Durable Chat run ${run.runId} has no exact terminal replay authority.`);
  }
  const checkpointKind = checkpointKindForTerminalDurableChatRunStatus(run.status);
  const checkpoint = deps.durableRuns.getLatestCheckpointByKind?.(run.runId, checkpointKind);
  if (!checkpoint) {
    throw new Error(`Durable Chat run ${run.runId} has no exact latest terminal authority checkpoint.`);
  }
  verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
  verifyTerminalReplayOutputBinding(deps, run, prepared, trace, payload, authority, checkpoint);
  verifyTerminalReplayFinalizerPrefix(run, payload, authority);
}

function verifyTerminalReplayOutputBinding(
  deps: ChatDurableRunFinalizeDeps,
  run: DurableRunRecord,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  payload: ExactAdmittedV2ChatFinalizePayload,
  authority: ChatTurnRuntimeAuthoritySealV1,
  checkpoint: DurableCheckpointRecord,
): void {
  const metadata = run.metadata ?? {};
  const terminalOutput = authority.material.terminalOutput;
  const heartbeatIdentity = readExactSystemHeartbeatFinalizeIdentity(run, payload);
  if (heartbeatIdentity && authority.material.durableStatus !== "completed") {
    assertNoSystemHeartbeatDecisionEvidence(run);
    if (
      checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
      checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined ||
      authority.material.heartbeatDecisionReceipt !== undefined
    ) {
      throw new Error(`Failed system heartbeat ${run.runId} carries completed decision evidence.`);
    }
  }
  if (authority.material.durableStatus !== "completed") {
    const staleMetadataKeys = [
      "outputText",
      "finalOutput",
      "outputSummary",
      "finalSummary",
      "outputMessageId",
      "outputTraceStatus",
    ];
    const staleCheckpointKeys = [
      "assistantMessageId",
      "outputText",
      "finalOutput",
      "outputSummary",
      "finalSummary",
      "outputMessageId",
      "outputTraceStatus",
    ];
    if (
      terminalOutput ||
      staleMetadataKeys.some((key) => metadata[key] !== undefined) ||
      staleCheckpointKeys.some((key) => checkpoint.state[key] !== undefined)
    ) {
      throw new Error(`Durable Chat run ${run.runId} carries stale output evidence for a no-output replay.`);
    }
    return;
  }
  if (heartbeatIdentity) {
    if (authority.material.traceStatus !== "completed") {
      throw new Error(`System heartbeat ${run.runId} replay is not a fully completed decision.`);
    }
    const heartbeatDecision = requireExactSystemHeartbeatFinalizeDecision(run, heartbeatIdentity);
    if (
      canonicalJsonString(authority.material.heartbeatDecisionReceipt) !==
        canonicalJsonString(heartbeatDecision.receipt) ||
      canonicalJsonString(checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]) !==
        canonicalJsonString(heartbeatDecision.receipt) ||
      checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== heartbeatDecision.rawOutput ||
      canonicalJsonString(authority.material.postCommitEligibility) !==
        canonicalJsonString(SYSTEM_HEARTBEAT_POST_COMMIT_ELIGIBILITY)
    ) {
      throw new Error(`System heartbeat ${run.runId} replay decision evidence drifted from its authority.`);
    }
    const message = deps.chatMessages?.get(payload.assistantMessageId);
    if (!heartbeatDecision.decision.notify) {
      const outputKeys = [
        "outputText",
        "finalOutput",
        "outputSummary",
        "finalSummary",
        "outputMessageId",
        "outputTraceStatus",
      ];
      if (
        terminalOutput ||
        message ||
        outputKeys.some((key) => metadata[key] !== undefined) ||
        ["assistantMessageId", ...outputKeys].some((key) => checkpoint.state[key] !== undefined)
      ) {
        throw new Error(`Silent system heartbeat ${run.runId} replay contains visible output.`);
      }
      return;
    }
    const normalizedMessage = heartbeatDecision.decision.normalizedMessage;
    if (
      !terminalOutput ||
      terminalOutput.assistantMessageId !== payload.assistantMessageId ||
      terminalOutput.assistantMessageId !== prepared.assistantMessageId ||
      terminalOutput.assistantMessageId !== trace.assistantMessageId ||
      metadata.outputText !== normalizedMessage ||
      metadata.outputSummary !== normalizedMessage ||
      metadata.finalOutput !== normalizedMessage ||
      metadata.finalSummary !== normalizedMessage ||
      metadata.outputMessageId !== undefined ||
      metadata.outputTraceStatus !== undefined ||
      hashChatTurnRuntimeAuthorityValue(normalizedMessage) !== terminalOutput.outputTextSha256 ||
      hashChatTurnRuntimeAuthorityValue(normalizedMessage) !== terminalOutput.outputSummarySha256 ||
      checkpoint.state.assistantMessageId !== terminalOutput.assistantMessageId ||
      checkpoint.state.outputText !== normalizedMessage ||
      checkpoint.state.outputSummary !== normalizedMessage ||
      checkpoint.state.finalOutput !== undefined ||
      checkpoint.state.finalSummary !== undefined ||
      !message ||
      message.sessionId !== payload.sessionId ||
      message.role !== "assistant" ||
      message.actorType !== "system" ||
      message.actorId !== SYSTEM_HEARTBEAT_ACTOR_ID ||
      message.content !== normalizedMessage
    ) {
      throw new Error(`Notifying system heartbeat ${run.runId} replay output drifted from its authority.`);
    }
    return;
  }
  if (
    authority.material.heartbeatDecisionReceipt !== undefined ||
    checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
    checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined
  ) {
    throw new Error(`Non-heartbeat Chat run ${run.runId} authority contains heartbeat decision evidence.`);
  }
  const message = terminalOutput ? deps.chatMessages?.get(terminalOutput.assistantMessageId) : undefined;
  if (
    !terminalOutput ||
    terminalOutput.assistantMessageId !== payload.assistantMessageId ||
    terminalOutput.assistantMessageId !== prepared.assistantMessageId ||
    terminalOutput.assistantMessageId !== trace.assistantMessageId ||
    typeof metadata.outputText !== "string" ||
    typeof metadata.outputSummary !== "string" ||
    metadata.finalOutput !== metadata.outputText ||
    metadata.finalSummary !== metadata.outputSummary ||
    metadata.outputMessageId !== undefined ||
    metadata.outputTraceStatus !== undefined ||
    hashChatTurnRuntimeAuthorityValue(metadata.outputText) !== terminalOutput.outputTextSha256 ||
    hashChatTurnRuntimeAuthorityValue(metadata.outputSummary) !== terminalOutput.outputSummarySha256 ||
    checkpoint.state.assistantMessageId !== terminalOutput.assistantMessageId ||
    checkpoint.state.outputText !== metadata.outputText ||
    checkpoint.state.outputSummary !== metadata.outputSummary ||
    checkpoint.state.finalOutput !== undefined ||
    checkpoint.state.finalSummary !== undefined ||
    checkpoint.state.outputMessageId !== undefined ||
    checkpoint.state.outputTraceStatus !== undefined ||
    !message ||
    message.messageId !== terminalOutput.assistantMessageId ||
    message.sessionId !== payload.sessionId ||
    message.role !== "assistant" ||
    message.actorType !== "agent" ||
    message.content !== metadata.outputText
  ) {
    throw new Error(`Durable Chat run ${run.runId} terminal replay output drifted from its authority.`);
  }
}

type TerminalFinalizerPhase = "pending" | "settled";

function verifyTerminalReplayFinalizerPrefix(
  run: DurableRunRecord,
  payload: ExactAdmittedV2ChatFinalizePayload,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  const required = authority.material.requiredFinalizers;
  const phases = new Map<"linked" | "autonomous" | "general", TerminalFinalizerPhase>();
  const linkedPending = readExactLinkedFinalizationPendingMarker(metadata.linkedFinalizationPending);
  const linkedSettlement = readExactLinkedFinalizationSettlement(metadata.linkedFinalization);
  const autonomousPending = readExactAutonomousChatPostCommitPendingMarker(
    metadata[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
  );
  const autonomousSettlement = readExactAutonomousChatPostCommitSettlement(metadata.autonomousChatPostCommit);
  const generalPending = readExactGeneralChatPostCommitPendingMarker(
    metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
  );
  const generalSettlement = readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
  const linkedAuthority = authority.material.linkedFinalization;

  if (required.includes("linked")) {
    if (
      Boolean(linkedPending) === Boolean(linkedSettlement) ||
      (linkedPending &&
        (!linkedAuthority ||
          linkedPending.finalizationId !== linkedAuthority.finalizationId ||
          linkedPending.requestedAt !== linkedAuthority.requestedAt ||
          hashChatTurnRuntimeAuthorityValue(linkedPending.reason) !== linkedAuthority.reasonSha256)) ||
      (linkedSettlement &&
        (!linkedAuthority ||
          linkedSettlement.finalizationId !== linkedAuthority.finalizationId ||
          linkedSettlement.requestedAt !== linkedAuthority.requestedAt ||
          linkedSettlement.reasonSha256 !== linkedAuthority.reasonSha256))
    ) {
      throw new Error(`Durable Chat run ${run.runId} linked finalizer drifted from terminal authority.`);
    }
    phases.set("linked", linkedPending ? "pending" : "settled");
  } else if (linkedPending || linkedSettlement) {
    throw new Error(`Durable Chat run ${run.runId} carries stray linked finalizer evidence.`);
  }

  if (required.includes("autonomous")) {
    if (
      Boolean(autonomousPending) === Boolean(autonomousSettlement) ||
      (autonomousPending &&
        (autonomousPending.generationId !== authority.material.postCommitGenerationId ||
          autonomousPending.requestedAt !== authority.material.transitionAt)) ||
      (autonomousSettlement &&
        (autonomousSettlement.generationId !== authority.material.postCommitGenerationId ||
          autonomousSettlement.requestedAt !== authority.material.transitionAt))
    ) {
      throw new Error(`Durable Chat run ${run.runId} autonomous finalizer drifted from terminal authority.`);
    }
    phases.set("autonomous", autonomousPending ? "pending" : "settled");
  } else if (autonomousPending || autonomousSettlement) {
    throw new Error(`Durable Chat run ${run.runId} carries stray autonomous finalizer evidence.`);
  }

  if (!required.includes("general")) {
    throw new Error(`Durable Chat run ${run.runId} terminal authority omits its general finalizer.`);
  }
  const matchingGeneralPending =
    generalPending &&
    generalPending.generationId === authority.material.postCommitGenerationId &&
    generalPending.traceStatus === authority.material.traceStatus &&
    generalPending.requestedAt === authority.material.transitionAt &&
    canonicalJsonString(generalPending.postCommitEligibility) ===
      canonicalJsonString(authority.material.postCommitEligibility);
  const matchingGeneralSettlement =
    generalSettlement &&
    generalSettlement.generationId === authority.material.postCommitGenerationId &&
    generalSettlement.traceStatus === authority.material.traceStatus &&
    generalSettlement.requestedAt === authority.material.transitionAt &&
    canonicalJsonString(generalSettlement.postCommitEligibility) ===
      canonicalJsonString(authority.material.postCommitEligibility);
  const provisionalGeneralSettlement =
    matchingGeneralSettlement &&
    (generalSettlement.settlementStatus === "children_pending" ||
      generalSettlement.settlementStatus === "waiting_for_parent_finalization") &&
    generalSettlement.completedAt === undefined;
  const finalGeneralSettlement =
    matchingGeneralSettlement &&
    (generalSettlement.settlementStatus === "completed" ||
      generalSettlement.settlementStatus === "settled_with_failures") &&
    typeof generalSettlement.completedAt === "string";
  if (
    (!matchingGeneralPending && !finalGeneralSettlement) ||
    (generalPending && generalSettlement && !provisionalGeneralSettlement) ||
    (!generalPending && generalSettlement && !finalGeneralSettlement)
  ) {
    throw new Error(`Durable Chat run ${run.runId} general finalizer drifted from terminal authority.`);
  }
  phases.set("general", matchingGeneralPending ? "pending" : "settled");

  let observedPending = false;
  for (const finalizer of required) {
    const phase = phases.get(finalizer);
    if (!phase) throw new Error(`Durable Chat run ${run.runId} is missing ${finalizer} finalizer evidence.`);
    if (observedPending && phase === "settled") {
      throw new Error(`Durable Chat run ${run.runId} settled finalizers out of canonical order.`);
    }
    observedPending ||= phase === "pending";
  }

  const handoff = readExactChatTurnAdmissionHandoff(metadata.chatTurnAdmissionHandoff);
  if (observedPending) {
    if (handoff) throw new Error(`Durable Chat run ${run.runId} committed a handoff before finalizers settled.`);
    return;
  }
  if (!handoff || !generalSettlement || !finalGeneralSettlement) {
    throw new Error(`Durable Chat run ${run.runId} has no exact terminal admission handoff.`);
  }
  const childRunIds = [...new Set(Object.values(generalSettlement.durableEffectRunIds as Record<string, string>))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (
    handoff.admissionId !== payload.admissionId ||
    handoff.sessionIncarnationId !== payload.sessionIncarnationId ||
    handoff.turnId !== payload.turnId ||
    handoff.parentRunId !== run.runId ||
    handoff.postCommitGenerationId !== authority.material.postCommitGenerationId ||
    canonicalJsonString(handoff.childRunIds) !== canonicalJsonString(childRunIds) ||
    handoff.childRunIdsSha256 !== hashChatTurnRuntimeAuthorityValue(childRunIds)
  ) {
    throw new Error(`Durable Chat run ${run.runId} terminal handoff drifted from finalizer evidence.`);
  }
}

function runChatFinalizeTransaction<T>(deps: ChatDurableRunFinalizeDeps, callback: () => T): T {
  return deps.runImmediateTransaction(callback);
}

function omitHeartbeatDecisionRawOutput(state: Record<string, unknown>): Record<string, unknown> {
  const { [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: _rawOutput, ...publicState } = state;
  return publicState;
}

function checkpointKindForTerminalDurableChatRunStatus(
  status: DurableRunStatus,
): DurableCheckpointRecord["checkpointKind"] {
  if (status === "completed") {
    return "run_completed";
  }
  if (status === "cancelled") {
    return "run_cancelled";
  }
  return "run_failed";
}

function buildDurableCheckpointState(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatToolRuns" | "chatToolArtifacts" | "chatMessages">,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  options: { systemHeartbeat?: boolean } = {},
): Record<string, unknown> {
  const toolRuns = deps.chatToolRuns.listByTurn(prepared.turnId);
  const artifacts = deps.chatToolArtifacts.listByTurn(prepared.turnId).map((artifact) => ({
    artifactId: artifact.artifactId,
    toolRunId: artifact.toolRunId,
    toolName: artifact.toolName,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    storageRelPath: artifact.storageRelPath,
    snippet: artifact.snippet,
  }));
  const terminalOutput = readCanonicalDurableChatTerminalOutput(deps, prepared, trace, options);
  return {
    objective: prepared.content,
    currentStep: trace.status,
    attemptedTools: toolRuns.map((run) => ({
      toolRunId: run.toolRunId,
      toolName: run.toolName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    artifactPointers: artifacts,
    blocker: trace.failure?.message,
    nextAction: trace.failure?.recommendedAction,
    ...(terminalOutput
      ? {
          assistantMessageId: terminalOutput.assistantMessageId,
          outputText: terminalOutput.outputText,
          outputSummary: terminalOutput.outputSummary,
        }
      : {}),
  };
}

export interface CanonicalDurableChatTerminalOutput {
  assistantMessageId: string;
  outputText: string;
  outputSummary: string;
}

export function readCanonicalDurableChatTerminalOutput(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatMessages">,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  options: { systemHeartbeat?: boolean } = {},
): CanonicalDurableChatTerminalOutput | undefined {
  if (trace.status !== "completed" && trace.status !== "partial") {
    return undefined;
  }
  const messageId = prepared.assistantMessageId;
  if (!messageId) {
    return undefined;
  }
  if (trace.assistantMessageId !== undefined && trace.assistantMessageId !== messageId) {
    throw new Error(`Chat turn ${prepared.turnId} terminal trace points at a different assistant message.`);
  }
  const message = deps.chatMessages?.get(messageId);
  const expectedActorType = options.systemHeartbeat ? "system" : "agent";
  const expectedActorId = options.systemHeartbeat ? SYSTEM_HEARTBEAT_ACTOR_ID : undefined;
  if (
    !message ||
    message.messageId !== messageId ||
    message.sessionId !== prepared.session.sessionId ||
    message.role !== "assistant" ||
    message.actorType !== expectedActorType ||
    (expectedActorId !== undefined && message.actorId !== expectedActorId)
  ) {
    if (message) {
      throw new Error(`Chat turn ${prepared.turnId} terminal assistant message has invalid canonical linkage.`);
    }
    return undefined;
  }
  const content = message.content;
  if (!content.trim()) {
    return undefined;
  }
  return {
    assistantMessageId: messageId,
    outputText: content,
    outputSummary: options.systemHeartbeat ? content : summarizeDurableChatAssistantOutput(content),
  };
}

export function summarizeDurableChatAssistantOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

export function mergeCanonicalDurableChatTerminalOutputMetadata(
  metadata: Record<string, unknown> | undefined,
  output: CanonicalDurableChatTerminalOutput | undefined,
): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) };
  if (!output) {
    delete next.outputText;
    delete next.finalOutput;
    delete next.outputSummary;
    delete next.finalSummary;
    delete next.outputMessageId;
    delete next.outputTraceStatus;
    return Object.keys(next).length > 0 ? next : undefined;
  }
  delete next.outputMessageId;
  delete next.outputTraceStatus;
  return {
    ...next,
    outputText: output.outputText,
    finalOutput: output.outputText,
    outputSummary: output.outputSummary,
    finalSummary: output.outputSummary,
  };
}

function markAutonomousChatPostCommitPending(
  metadata: Record<string, unknown> | undefined,
  requestedAt: string,
  generationId: string,
): Record<string, unknown> | undefined {
  const autonomous = metadata?.autonomous;
  if (!autonomous || typeof autonomous !== "object" || Array.isArray(autonomous)) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    [AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
      version: 1,
      generationId,
      requestedAt,
    },
  };
}

export function markGeneralChatPostCommitPending(
  metadata: Record<string, unknown> | undefined,
  requestedAt: string,
  traceStatus: ChatTurnTraceRecord["status"],
  postCommitEligibility: PostCommitEligibility,
  generationId = randomUUID(),
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
      version: 1,
      generationId,
      traceStatus,
      requestedAt,
      postCommitEligibility,
      completedEffects: [],
      durableEffectRunIds: {},
    },
  };
}

export function markTerminalChatPostCommitPending(
  metadata: Record<string, unknown> | undefined,
  requestedAt: string,
  traceStatus: ChatTurnTraceRecord["status"],
  postCommitEligibility: PostCommitEligibility,
  generationId = randomUUID(),
  options: { includeAutonomous?: boolean } = {},
): Record<string, unknown> {
  const generalPending = markGeneralChatPostCommitPending(
    metadata,
    requestedAt,
    traceStatus,
    postCommitEligibility,
    generationId,
  );
  if ((traceStatus !== "completed" && traceStatus !== "partial") || options.includeAutonomous === false) {
    return generalPending;
  }
  return markAutonomousChatPostCommitPending(generalPending, requestedAt, generationId) ?? generalPending;
}

export function hasAutonomousChatPostCommitPending(run: DurableRunRecord): boolean {
  return readAutonomousChatPostCommitPendingMarker(run) !== undefined;
}

export function readAutonomousChatPostCommitPendingMarker(
  run: DurableRunRecord,
): AutonomousChatPostCommitPendingMarker | undefined {
  return readExactAutonomousChatPostCommitPendingMarker(
    run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
  );
}

export function hasGeneralChatPostCommitPending(run: DurableRunRecord): boolean {
  return readGeneralChatPostCommitPendingMarker(run) !== undefined;
}

export function readGeneralChatPostCommitPendingMarker(
  run: DurableRunRecord,
): GeneralChatPostCommitPendingMarker | undefined {
  const value = readExactGeneralChatPostCommitPendingMarker(
    run.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
  );
  if (!value) return undefined;
  return {
    ...value,
    generationId: value.generationId,
    traceStatus: value.traceStatus,
    requestedAt: value.requestedAt,
    postCommitEligibility: value.postCommitEligibility,
    completedEffects: value.completedEffects as GeneralChatPostCommitEffect[],
    durableEffectRunIds: value.durableEffectRunIds as Partial<Record<GeneralChatPostCommitDurableEffect, string>>,
  };
}

export function readGeneralChatPostCommitCompletedEffects(run: DurableRunRecord): GeneralChatPostCommitEffect[] {
  return readGeneralChatPostCommitPendingMarker(run)?.completedEffects ?? [];
}
