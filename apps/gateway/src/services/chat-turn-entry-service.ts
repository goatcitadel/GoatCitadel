/* eslint-disable max-lines -- Public-entry helpers stay co-located so chat-turn intake, validation, and persistence remain auditable in one module. */
/**
 * Chat turn public-entry helpers.
 *
 * Public agent chat-turn entry points over the narrowed chat runtime host.
 */

import { createHash, randomUUID } from "node:crypto";
import type { TurnRuntime } from "@goatcitadel/orchestration";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatCancelTurnResponse,
  ChatMode,
  ChatSessionBindingRecord,
  ChatTurnBranchKind,
  ChatMessageRecord,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatTurnTraceRecord,
  DurableRunRecord,
  GatewayEventInput,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { ConflictError, isChatTurnActiveStatus, isChatTurnTerminalStatus, NotFoundError } from "@goatcitadel/contracts";
import type {
  SessionAutonomyPrefsRecord,
  SessionMutationAdmissionRecord,
  AsyncStorage as Storage,
} from "@goatcitadel/storage";
import { looksLowConfidenceResponse } from "./learned-memory-utils.js";
import {
  preflightChatRoute,
  resolveChatRouteDescriptor,
  type ChatRouteResolutionDependencies,
} from "./chat-route-resolution.js";
import {
  buildEmptyAssistantTurnFallbackText,
  ChatTurnCancelledError,
  dedupeChatCitations,
  detectDelegationRoles,
  inferDegradedAssistantTurnFailure,
  patchChatTurnTraceIfStatus,
} from "./chat-turn-helpers.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import {
  enforcePreparedRoutedContextOrchestrationBypass,
  resolvePreparedTurnMode,
  type ChatTurnPrepHost,
  type PreparedAgentChatTurn,
} from "./chat-turn-prep-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import { shouldRegisterSubagentFanoutExecutor } from "./chat-subagent-fanout-service.js";
import { createTurnSubagentFanoutExecutor } from "./chat-turn-stream-service.js";
import { applySurfaceRoutingPreflight } from "./surface-router-entry.js";
import type { SurfaceClassification } from "./surface-router-heuristics.js";
import type { SurfaceRouteRequest } from "./surface-router-service.js";
import type { SurfaceRouteOverrideSignalInput } from "./improvement-service.js";
import {
  assertExternalCompanionAdmissionContext,
  ActiveTurnNotPreemptibleError,
  computeChatTurnAdmissionMaterialSha256,
  resolveChatTurnAdmissionActorId,
  type AuthenticatedOperatorAdmissionContext,
  type ChatTurnAdmissionActor,
  type DecisionCommittedHeartbeatRecoveryIdentity,
  type ExternalCompanionAdmissionContext,
} from "./session-control-service.js";
import type { ActiveTurnAdmission, ChatStreamMutationLifecycle } from "./chat-turn-types.js";
import { persistInitialChatTurnTrace, persistPreparedChatCapabilityAdmission } from "./chat-durable-run-service.js";
import type {
  ChatTurnActiveExecutionControl,
  ChatTurnAdmissionControl,
  ChatTurnLeaseControl,
  ChatTurnMemorySideEffects,
  ChatTurnRealtimeEmitter,
  ChatTurnStreamLifecycleControl,
  ChatTurnTranscriptIngress,
} from "./chat-turn-runtime-collaborators.js";

type ChatTurnProactiveTriggerInput = {
  source?: "scheduler" | "manual" | "chat";
  reason?: string;
  prefs?: SessionAutonomyPrefsRecord;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
};

type ChatTurnEntryStorage = ChatTurnPrepHost["storage"] &
  chatTurnDispatchService.ChatTurnDispatchHost["storage"] &
  Pick<Storage, "chatReflectionAttempts" | "chatSessionBindings">;

export interface AgentChatTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface AgentChatTurnRequestOptions {
  abortSignal?: AbortSignal;
  onChildDurableRunLaunched?: (runId: string) => Promise<void>;
  turnIdentity?: AgentChatTurnIdentity;
  /** Pre-admitted authority used only by deterministic internal callers/recovery. */
  turnAdmission?: ActiveTurnAdmission;
  assertDispatchOwnership?: () => Promise<void>;
  /** Present only on authenticated operator HTTP route calls. */
  authenticatedOperator?: AuthenticatedOperatorAdmissionContext;
  /**
   * Present only when a bound external `session_control_client` controller sends
   * through the canonical route. Mutually exclusive with `authenticatedOperator`.
   */
  externalCompanion?: ExternalCompanionAdmissionContext;
}

export interface OperatorChatTurnRequestOptions {
  authenticatedOperator?: AuthenticatedOperatorAdmissionContext;
}

export interface OperatorChatTurnStreamRequestOptions extends OperatorChatTurnRequestOptions {
  abortSignal?: AbortSignal;
  mutationLifecycle?: ChatStreamMutationLifecycle;
  /**
   * Present only when a bound external `session_control_client` controller sends
   * through the canonical streaming route. Mutually exclusive with `authenticatedOperator`.
   */
  externalCompanion?: ExternalCompanionAdmissionContext;
}

export interface ChatTurnEntryHost
  extends
    Omit<ChatTurnPrepHost, "storage">,
    Omit<
      chatTurnDispatchService.ChatTurnDispatchHost,
      | "storage"
      | "turnRuntime"
      | keyof ChatTurnActiveExecutionControl
      | keyof ChatTurnLeaseControl
      | keyof ChatTurnMemorySideEffects
      | keyof ChatTurnRealtimeEmitter
      | keyof ChatTurnStreamLifecycleControl
      | keyof ChatTurnTranscriptIngress
    >,
    ChatTurnAdmissionControl,
    ChatTurnActiveExecutionControl,
    ChatTurnLeaseControl,
    ChatTurnMemorySideEffects,
    ChatTurnRealtimeEmitter,
    ChatTurnStreamLifecycleControl,
    ChatTurnTranscriptIngress {
  readonly storage: ChatTurnEntryStorage;
  readonly turnRuntime: Pick<TurnRuntime, "run" | "runStream">;
  recoverDecisionCommittedHeartbeat(identity: DecisionCommittedHeartbeatRecoveryIdentity): Promise<void>;
  reconcileTerminalChatAdmission(activeAdmission: SessionMutationAdmissionRecord): Promise<boolean>;
  prepareAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: {
      branchKind?: ChatTurnBranchKind;
      sourceTurnId?: string;
      parentTurnId?: string;
      existingUserMessage?: ChatMessageRecord;
      ingestUserMessage?: boolean;
      userMessageId?: string;
      turnId?: string;
      assistantMessageId?: string;
      mutationLifecycle?: ChatStreamMutationLifecycle;
      turnAdmission?: ActiveTurnAdmission;
    },
  ): Promise<PreparedAgentChatTurn>;
  requireChatTurnContext(
    sessionId: string,
    turnId: string,
  ): Promise<{
    trace: ChatTurnTraceRecord;
    userMessage: ChatMessageRecord;
    assistantMessage?: ChatMessageRecord;
  }>;
  collectCapabilityUpgradeSuggestions(input: {
    sessionId: string;
    content: string;
    assistantText: string;
    trace?: ChatTurnTraceRecord;
  }): Promise<ChatCapabilityUpgradeSuggestion[]>;
  collectSpecialistCandidateSuggestions(input: {
    sessionId: string;
    mode: NonNullable<PreparedAgentChatTurn["normalized"]["mode"]> | PreparedAgentChatTurn["prefs"]["mode"];
    content: string;
    capabilitySuggestions: ChatCapabilityUpgradeSuggestion[];
    trace: ChatTurnTraceRecord;
  }): Promise<ChatSpecialistCandidateSuggestionRecord[]>;
  isReplayScratchSession(sessionId: string): Promise<boolean>;
  triggerChatSessionProactive(sessionId: string, input?: ChatTurnProactiveTriggerInput): Promise<ProactiveRunRecord>;
  // Optional surface-router hooks — provided by the composition root when the auto-router is wired up.
  surfaceRouter?: { route(req: SurfaceRouteRequest): Promise<SurfaceClassification> };
  readChatSessionMode?(sessionId: string): Promise<ChatMode | undefined>;
  persistChatSessionMode?(sessionId: string, mode: ChatMode): Promise<void>;
  recordSurfaceRouteOverrideSignal?(input: SurfaceRouteOverrideSignalInput): Promise<void>;
}

export interface ChatTurnResumeHost {
  readonly storage: {
    readonly chatTurnTraces: {
      get(turnId: string): Promise<Pick<ChatTurnTraceRecord, "sessionId">>;
    };
  };
  streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
      returnOnDurableInterrupt?: boolean;
    },
  ): AsyncGenerator<ChatStreamChunk>;
}

export type ChatTurnPreflightHost = ChatTurnEntryHost & ChatRouteResolutionDependencies;

interface EntryOperatorAdmissionInput {
  sessionId: string;
  turnId: string;
  request: ChatSendMessageRequest;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
}

interface EntrySendAdmissionContext {
  authenticatedOperator?: AuthenticatedOperatorAdmissionContext;
  externalCompanion?: ExternalCompanionAdmissionContext;
}

async function admitEntryOperatorChatTurn(
  host: ChatTurnEntryHost,
  input: EntryOperatorAdmissionInput,
  authenticatedOperator?: AuthenticatedOperatorAdmissionContext,
): Promise<ActiveTurnAdmission> {
  if (!authenticatedOperator) {
    return await host.sessionControlRuntimeOwner.admitOperatorChatTurn(input);
  }
  try {
    return await host.sessionControlRuntimeOwner.admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery(
      { ...input, authenticatedOperator },
      (identity) => host.recoverDecisionCommittedHeartbeat(identity),
      (activeAdmission) => host.reconcileTerminalChatAdmission(activeAdmission),
    );
  } catch (error) {
    if (error instanceof ActiveTurnNotPreemptibleError) {
      host.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.turn.recovery_noop",
        message: "Skipped heartbeat preemption because the canonical active turn is not a heartbeat",
        sessionId: input.sessionId,
        turnId: input.turnId,
        context: {
          recoveryOutcome: error.recoveryOutcome,
          activeAdmissionId: error.activeAdmission.admissionId,
          activeTurnId: error.activeAdmission.turnId,
          activeActorKind: error.activeAdmission.actorKind,
          activeOperation: error.activeAdmission.operation,
          correlationId: input.correlationId,
        },
      });
    }
    throw error;
  }
}

/**
 * Send-only admission dispatcher. An external `session_control_client` controller
 * enters the *same* canonical admission — carrying its bound companion/device/
 * client identity, presented control-token hash, `send` capability, and control
 * generation — so the durable authority CASes generation, binding, token,
 * liveness, and capability before any side effect and the resulting admission is
 * fenced identically to an operator turn at every late recheck. Operator sends
 * keep their exact prior path unchanged. Retry/edit deliberately never reach
 * this dispatcher; external v1 has no retry/edit/undo/steer capability.
 */
async function admitEntrySendChatTurn(
  host: ChatTurnEntryHost,
  input: EntryOperatorAdmissionInput,
  context: EntrySendAdmissionContext,
): Promise<ActiveTurnAdmission> {
  if (!context.externalCompanion) {
    return await admitEntryOperatorChatTurn(host, input, context.authenticatedOperator);
  }
  if (context.authenticatedOperator) {
    throw new ConflictError({
      message: "A Chat send cannot be attributed to both an authenticated operator and an external controller.",
    });
  }
  const companion = assertExternalCompanionAdmissionContext(context.externalCompanion);
  // Drop the operator-derived actorId; external admission carries the raw
  // authenticated companion binding as its actor instead.
  const { actorId: _operatorActorId, ...actorlessInput } = input;
  const actor: ChatTurnAdmissionActor = {
    actorKind: "external_companion",
    actorId: companion.companionSessionId,
    companionSessionId: companion.companionSessionId,
    deviceGrantId: companion.deviceGrantId,
    clientInstanceId: companion.clientInstanceId,
    principalPurpose: "session_control_client",
    tokenHashSha256: companion.tokenHashSha256,
    requiredCapability: "send",
    expectedGeneration: companion.expectedGeneration,
  };
  return await host.sessionControlRuntimeOwner.admitChatTurn({ ...actorlessInput, actor });
}

function resolveEntrySendAdmissionActorId(
  input: ChatSendMessageRequest,
  externalCompanion: ExternalCompanionAdmissionContext | undefined,
): string {
  return externalCompanion ? externalCompanion.companionSessionId : resolveTurnAdmissionActorId(input);
}

export async function agentSendChatMessage(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  options?: AgentChatTurnRequestOptions,
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "agent-send", async () => {
    const canonicalResponse = options?.turnIdentity
      ? await loadCanonicalAgentTurnResponse(host, sessionId, input, options.turnIdentity)
      : undefined;
    if (canonicalResponse) {
      return canonicalResponse;
    }
    const turnIdentity =
      options?.turnIdentity ??
      ({
        turnId: randomUUID(),
        userMessageId: randomUUID(),
        assistantMessageId: `assistant-${randomUUID()}`,
      } satisfies AgentChatTurnIdentity);
    const admissionActorId = resolveEntrySendAdmissionActorId(input, options?.externalCompanion);
    const turnAdmission =
      options?.turnAdmission ??
      (await admitEntrySendChatTurn(
        host,
        {
          sessionId,
          turnId: turnIdentity.turnId,
          request: input,
          actorId: admissionActorId,
          idempotencyKey: `chat-turn-admit:${turnIdentity.turnId}`,
          correlationId: turnIdentity.turnId,
        },
        {
          authenticatedOperator: options?.authenticatedOperator,
          externalCompanion: options?.externalCompanion,
        },
      ));
    assertEntryTurnAdmission(turnAdmission, sessionId, turnIdentity.turnId, input);
    const admissionHeartbeat = host.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
    let terminalEntryResponse: ChatSendMessageResponse | undefined;
    let entryCompletedNormally = false;
    try {
      await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
      await options?.assertDispatchOwnership?.();
      input = await applySurfaceRoutingPreflight(
        createAdmissionGuardedSurfaceHost(host, turnAdmission, admissionHeartbeat),
        sessionId,
        input,
        (error) => {
          host.recordDevDiagnostic({
            level: "warn",
            category: "chat",
            event: "chat.surface_router.failed",
            message: "Surface auto-router failed; continuing with the provided/default mode",
            sessionId,
            context: { error: error instanceof Error ? error.message : String(error) },
          });
        },
      );
      await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
      const requireDurableExecution = Boolean(options?.turnIdentity && input.policyRunId?.trim());
      const binding = await resolveAdmissionFencedChatSessionBinding(
        host,
        turnAdmission,
        admissionHeartbeat,
        sessionId,
        turnAdmission.identity.workspaceId,
      );
      if (requireDurableExecution && binding.transport !== "llm") {
        throw new Error("Deterministic delegated Chat execution requires an LLM session binding.");
      }
      const routeDescriptor = await resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
        action: "send",
        providerId: input.providerId,
        model: input.model,
        mode: input.mode,
        webMode: input.webMode,
        thinkingLevel: input.thinkingLevel,
        speedMode: input.speedMode,
        subagentPolicy: input.subagentPolicy,
        prefsOverride: input.prefsOverride,
      });
      host.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.turn.start",
        message: "Starting mission chat turn",
        sessionId,
        providerId: input.providerId,
        modelId: input.model,
        context: {
          mode: input.mode,
          webMode: input.webMode,
          thinkingLevel: input.thinkingLevel,
          speedMode: input.speedMode,
          subagentPolicy: input.subagentPolicy,
          routePreflight: {
            requestedProviderId: routeDescriptor.requestedProviderId,
            requestedModel: routeDescriptor.requestedModel,
            effectiveProviderId: routeDescriptor.effectiveProviderId,
            effectiveModel: routeDescriptor.effectiveModel,
            selectionSource: routeDescriptor.selectionSource,
            fallbackPolicy: routeDescriptor.fallbackPolicy,
          },
        },
      });
      const prepared = await host.prepareAgentChatTurn(sessionId, input, {
        branchKind: "append",
        turnId: turnIdentity.turnId,
        userMessageId: turnIdentity.userMessageId,
        assistantMessageId: turnIdentity.assistantMessageId,
        turnAdmission,
      });
      await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
      const useDurableExecution = await chatTurnDispatchService.shouldUseDurableExecution(
        host,
        prepared,
        input,
        requireDurableExecution,
      );
      if (binding.transport !== "llm") {
        await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
        await options?.assertDispatchOwnership?.();
        terminalEntryResponse = await chatTurnDispatchService.sendPreparedIntegrationChatTurn(
          host,
          sessionId,
          input,
          prepared,
          binding,
          "chat_thread_turn_appended",
          { abortSignal: options?.abortSignal },
        );
        assertWaitingResponseHasDurableOwner(turnAdmission, terminalEntryResponse);
        entryCompletedNormally = true;
        return terminalEntryResponse;
      }
      const routedContextOrchestrationBypassed = enforcePreparedRoutedContextOrchestrationBypass(prepared);
      const modeOrchestration =
        requireDurableExecution || routedContextOrchestrationBypassed
          ? undefined
          : await host.resolvePreparedTurnOrchestration(prepared);
      if (modeOrchestration) {
        host.recordDevDiagnostic({
          level: "info",
          category: "orchestration",
          event: "chat.orchestration.selected",
          message: "Routing mission chat turn through orchestration",
          sessionId,
          turnId: prepared.turnId,
        });
        await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
        terminalEntryResponse = await chatTurnDispatchService.consumePreparedAgentChatTurn(
          host,
          sessionId,
          input,
          prepared,
          "chat_thread_turn_appended",
          modeOrchestration,
          {
            abortSignal: options?.abortSignal,
            onChildDurableRunLaunched: options?.onChildDurableRunLaunched,
            assertDispatchOwnership: options?.assertDispatchOwnership,
            durableRunId: options?.turnIdentity
              ? buildDeterministicAgentDurableRunId(options.turnIdentity.turnId)
              : undefined,
            requireDurableExecution,
          },
        );
        assertWaitingResponseHasDurableOwner(turnAdmission, terminalEntryResponse);
        entryCompletedNormally = true;
        return terminalEntryResponse;
      }
      if (requireDurableExecution || useDurableExecution) {
        await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
        terminalEntryResponse = await chatTurnDispatchService.consumePreparedAgentChatTurn(
          host,
          sessionId,
          input,
          prepared,
          "chat_thread_turn_appended",
          undefined,
          {
            abortSignal: options?.abortSignal,
            onChildDurableRunLaunched: options?.onChildDurableRunLaunched,
            assertDispatchOwnership: options?.assertDispatchOwnership,
            durableRunId: options?.turnIdentity
              ? buildDeterministicAgentDurableRunId(options.turnIdentity.turnId)
              : undefined,
            requireDurableExecution,
          },
        );
        assertWaitingResponseHasDurableOwner(turnAdmission, terminalEntryResponse);
        entryCompletedNormally = true;
        return terminalEntryResponse;
      }
      await assertEntryAdmissionActive(host, turnAdmission, admissionHeartbeat);
      terminalEntryResponse = await runAgentSendChatMessageLlmPath(host, sessionId, input, prepared, options);
      assertWaitingResponseHasDurableOwner(turnAdmission, terminalEntryResponse);
      entryCompletedNormally = true;
      return terminalEntryResponse;
    } finally {
      admissionHeartbeat.stop();
      if (turnAdmission.requestClaim) {
        await host.sessionControlRuntimeOwner.closeTurnWrite({
          admission: turnAdmission,
          status:
            entryCompletedNormally && terminalEntryResponse?.trace?.status !== "cancelled" ? "completed" : "cancelled",
          actorId: admissionActorId,
          idempotencyKey: `chat-turn-close:${turnIdentity.turnId}`,
          correlationId: turnIdentity.turnId,
        });
      }
    }
  });
}

function resolveTurnAdmissionActorId(input: ChatSendMessageRequest): string {
  return resolveChatTurnAdmissionActorId(input);
}

function createEntryTurnIdentity(): AgentChatTurnIdentity {
  return {
    turnId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: `assistant-${randomUUID()}`,
  };
}

async function closeEntryRequestAdmission(
  host: ChatTurnEntryHost,
  admission: ActiveTurnAdmission,
  heartbeat: import("./session-control-runtime-owner.js").TurnAdmissionHeartbeatHandle,
  actorId: string,
  terminalStatus: ChatTurnTraceRecord["status"] | undefined,
  completedNormally: boolean,
): Promise<void> {
  heartbeat.stop();
  if (!admission.requestClaim) return;
  await host.sessionControlRuntimeOwner.closeTurnWrite({
    admission,
    status: completedNormally && terminalStatus !== "cancelled" ? "completed" : "cancelled",
    actorId,
    idempotencyKey: `chat-turn-close:${admission.identity.turnId}`,
    correlationId: admission.identity.turnId,
  });
}

function assertEntryTurnAdmission(
  admission: ActiveTurnAdmission,
  sessionId: string,
  turnId: string,
  request: ChatSendMessageRequest,
): void {
  if (
    admission.identity.sessionId !== sessionId ||
    admission.identity.turnId !== turnId ||
    admission.identity.materialSha256 !== computeChatTurnAdmissionMaterialSha256(request)
  ) {
    throw new Error("The admitted Chat turn identity does not match the entry request.");
  }
}

async function assertEntryAdmissionActive(
  host: ChatTurnEntryHost,
  admission: ActiveTurnAdmission,
  heartbeat: import("./session-control-runtime-owner.js").TurnAdmissionHeartbeatHandle,
): Promise<void> {
  heartbeat.assertHealthy();
  await host.sessionControlRuntimeOwner.assertActiveTurnWrite(admission);
}

function assertWaitingResponseHasDurableOwner(admission: ActiveTurnAdmission, response: ChatSendMessageResponse): void {
  const waiting = Boolean(
    response.trace &&
    (["waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"].includes(response.trace.status) ||
      response.trace.failure?.failureClass === "approval_required"),
  );
  if (waiting && admission.requestClaim) {
    throw new Error("A waiting Chat turn must transfer mutation authority to a durable run before returning.");
  }
}

function captureStreamTerminalStatus(
  chunk: ChatStreamChunk,
  current: ChatTurnTraceRecord["status"] | undefined,
): ChatTurnTraceRecord["status"] | undefined {
  if (chunk.type === "trace_update") return chunk.trace.status;
  if (chunk.type === "approval_required") return "waiting_for_approval";
  if (chunk.type === "user_input_required") return "waiting_for_user_input";
  if (chunk.type === "error") return "failed";
  return current;
}

function assertWaitingStreamHasDurableOwner(
  admission: ActiveTurnAdmission,
  terminalStatus: ChatTurnTraceRecord["status"] | undefined,
): void {
  if (
    terminalStatus &&
    ["waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"].includes(terminalStatus) &&
    admission.requestClaim
  ) {
    throw new Error("A waiting streamed Chat turn must transfer mutation authority to a durable run before returning.");
  }
}

function createAdmissionGuardedSurfaceHost(
  host: ChatTurnEntryHost,
  admission: ActiveTurnAdmission,
  heartbeat: import("./session-control-runtime-owner.js").TurnAdmissionHeartbeatHandle,
) {
  return {
    surfaceRouter: host.surfaceRouter,
    readChatSessionMode: host.readChatSessionMode,
    persistChatSessionMode: host.persistChatSessionMode
      ? async (sessionId: string, mode: ChatMode) => {
          heartbeat.assertHealthy();
          await host.storage.runImmediateTransaction(async () => {
            await assertEntryAdmissionActive(host, admission, heartbeat);
            await host.persistChatSessionMode?.(sessionId, mode);
            await assertEntryAdmissionActive(host, admission, heartbeat);
          });
        }
      : undefined,
    recordSurfaceRouteOverrideSignal: host.recordSurfaceRouteOverrideSignal
      ? async (input: SurfaceRouteOverrideSignalInput) => {
          heartbeat.assertHealthy();
          await host.storage.runImmediateTransaction(async () => {
            await assertEntryAdmissionActive(host, admission, heartbeat);
            await host.recordSurfaceRouteOverrideSignal?.(input);
            await assertEntryAdmissionActive(host, admission, heartbeat);
          });
        }
      : undefined,
    normalizeWorkspaceId: (workspaceId?: string) => host.normalizeWorkspaceId(workspaceId),
    storage: {
      ...host.storage,
      chatSessionMeta: {
        ensure: async (targetSessionId: string) => {
          heartbeat.assertHealthy();
          return await host.storage.runImmediateTransaction(async () => {
            await assertEntryAdmissionActive(host, admission, heartbeat);
            const meta = await host.storage.chatSessionMeta.get(targetSessionId);
            if (!meta) {
              throw new Error(`Chat session not found: ${targetSessionId}`);
            }
            await assertEntryAdmissionActive(host, admission, heartbeat);
            return meta;
          });
        },
      },
    },
  };
}

async function resolveAdmissionFencedChatSessionBinding(
  host: ChatTurnEntryHost,
  admission: ActiveTurnAdmission,
  heartbeat: import("./session-control-runtime-owner.js").TurnAdmissionHeartbeatHandle,
  sessionId: string,
  workspaceId: string,
): Promise<ChatSessionBindingRecord> {
  heartbeat.assertHealthy();
  return await host.storage.runImmediateTransaction(async () => {
    await assertEntryAdmissionActive(host, admission, heartbeat);
    const resolved =
      (await host.storage.chatSessionBindings.get(sessionId)) ??
      (await host.storage.chatSessionBindings.upsert({
        sessionId,
        workspaceId,
        transport: "llm",
        writable: true,
      }));
    const persisted = await host.storage.chatSessionBindings.get(sessionId);
    if (!persisted || !sameChatSessionBindingIdentity(resolved, persisted)) {
      throw new Error(`Chat session binding ${sessionId} changed during admitted turn routing.`);
    }
    await assertEntryAdmissionActive(host, admission, heartbeat);
    return persisted;
  });
}

function sameChatSessionBindingIdentity(left: ChatSessionBindingRecord, right: ChatSessionBindingRecord): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.transport === right.transport &&
    left.connectionId === right.connectionId &&
    left.target === right.target &&
    left.writable === right.writable &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

async function loadCanonicalAgentTurnResponse(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  identity: AgentChatTurnIdentity,
): Promise<ChatSendMessageResponse | undefined> {
  try {
    const context = await requireEntryChatTurnContext(host, sessionId, identity.turnId);
    assertDeterministicTurnTrace(context.trace, sessionId, identity);
    assertDeterministicUserMessage(context.userMessage, sessionId, input, identity);
    if (context.assistantMessage && context.assistantMessage.messageId !== identity.assistantMessageId) {
      throw new Error(`Canonical agent turn ${identity.turnId} has an unexpected assistant message identity.`);
    }
    return {
      sessionId,
      userMessage: context.userMessage,
      assistantMessage: context.assistantMessage,
      transport: "llm",
      model: context.trace.model,
      turnId: context.trace.turnId,
      trace: context.trace,
      citations: context.trace.citations,
      routing: context.trace.routing,
    };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

function requireEntryChatTurnContext(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
): Promise<{
  trace: ChatTurnTraceRecord;
  userMessage: ChatMessageRecord;
  assistantMessage?: ChatMessageRecord;
}> {
  return host.requireChatTurnContext(sessionId, turnId);
}

function assertDeterministicTurnTrace(
  trace: ChatTurnTraceRecord,
  sessionId: string,
  identity: AgentChatTurnIdentity,
): void {
  if (
    trace.turnId !== identity.turnId ||
    trace.sessionId !== sessionId ||
    trace.userMessageId !== identity.userMessageId ||
    (trace.assistantMessageId !== undefined && trace.assistantMessageId !== identity.assistantMessageId)
  ) {
    throw new Error(`Canonical agent turn ${identity.turnId} does not match its deterministic identity.`);
  }
}

function assertDeterministicUserMessage(
  message: ChatMessageRecord,
  sessionId: string,
  input: ChatSendMessageRequest,
  identity: AgentChatTurnIdentity,
): void {
  if (
    message.messageId !== identity.userMessageId ||
    message.sessionId !== sessionId ||
    message.role !== "user" ||
    message.content.trim() !== input.content.trim()
  ) {
    throw new Error(`Canonical agent turn ${identity.turnId} has a conflicting deterministic user message.`);
  }
}

export function buildDeterministicAgentDurableRunId(turnId: string): string {
  const digest = createHash("sha256").update(`agent-turn:${turnId}`).digest("hex").slice(0, 32);
  return `durable-chat-${digest}`;
}

async function runAgentSendChatMessageLlmPath(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  options?: AgentChatTurnRequestOptions,
): Promise<ChatSendMessageResponse> {
  const controller = host.beginActiveChatTurnExecution(sessionId, prepared.turnId, "agent-send");
  const externalAbortListener = bindExternalAbortToController(options?.abortSignal, controller);
  const mode = resolvePreparedTurnMode(prepared);
  // R3-8: expose the turn-scoped `agent.fanout` executor for the lifetime of
  // this buffered turn. Gated on the turn's own eligibility so a delegated
  // child (floored to subagentPolicy "off") never holds a live executor.
  // Rebound to the retry turn on the reflection path (turn attribution) and
  // disposed in the finally below.
  const subagentFanoutExecutorOptions = {
    signal: controller.signal,
    operatorId: input.operatorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    fullWebAccess: input.fullWebAccess,
  };
  let disposeSubagentFanout = shouldRegisterSubagentFanoutExecutor(
    prepared,
    subagentFanoutExecutorOptions.permissionProfileId,
  )
    ? host.subagentFanout?.register(
        sessionId,
        createTurnSubagentFanoutExecutor(host, prepared, subagentFanoutExecutorOptions),
      )
    : undefined;
  try {
    await options?.assertDispatchOwnership?.();
    const admit = async () => {
      await persistPreparedChatCapabilityAdmission(host.storage, prepared);
      await persistInitialChatTurnTrace({ chatTurnTraces: host.storage.chatTurnTraces }, prepared, input);
    };
    if (typeof host.storage.runImmediateTransaction === "function") {
      await host.storage.runImmediateTransaction(admit);
    } else {
      if (prepared.capabilityProfile) {
        throw new Error("Chat capability admission requires a storage transaction boundary.");
      }
      await admit();
    }
    let turnId = prepared.turnId;
    let turnResult = await host.turnRuntime.run({
      sessionId,
      turnId,
      userMessageId: prepared.userEventId,
      ...(prepared.parentDelegationStepId ? { parentDelegationStepId: prepared.parentDelegationStepId } : {}),
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
      content: prepared.content,
      mode: prepared.capabilityProfile?.selection.mode ?? mode,
      providerId:
        prepared.capabilityProfile?.selection.effectiveProviderId ?? input.providerId ?? prepared.prefs.providerId,
      model: prepared.capabilityProfile?.selection.effectiveModel ?? input.model ?? prepared.prefs.model,
      webMode: prepared.capabilityProfile?.selection.webMode ?? prepared.normalized.webMode ?? prepared.prefs.webMode,
      memoryMode:
        prepared.capabilityProfile?.selection.memory.mode ??
        prepared.normalized.memoryMode ??
        prepared.prefs.memoryMode,
      retrievalMode: prepared.capabilityProfile?.selection.memory.retrievalMode ?? prepared.autonomy.retrievalMode,
      thinkingLevel:
        prepared.capabilityProfile?.selection.thinkingLevel ??
        prepared.normalized.thinkingLevel ??
        prepared.prefs.thinkingLevel,
      speedMode:
        prepared.capabilityProfile?.selection.speedMode ?? prepared.normalized.speedMode ?? prepared.prefs.speedMode,
      subagentPolicy:
        prepared.capabilityProfile?.selection.subagentPolicy ??
        prepared.normalized.subagentPolicy ??
        prepared.prefs.subagentPolicy,
      normalizationProfile: prepared.normalized.normalizationProfile,
      toolAutonomy: prepared.capabilityProfile?.selection.toolAutonomy ?? prepared.effectiveToolAutonomy,
      operatorId: prepared.capabilityProfile ? prepared.capabilityProfile.identity.operatorId : input.operatorId,
      authActorId: prepared.capabilityProfile ? prepared.capabilityProfile.identity.authActorId : input.authActorId,
      authActorSource: prepared.capabilityProfile
        ? prepared.capabilityProfile.identity.authActorSource
        : input.authActorSource,
      permissionProfileId: prepared.capabilityProfile?.governance.permission.profileId ?? input.permissionProfileId,
      localOperatorOverrideId: prepared.capabilityProfile
        ? prepared.capabilityProfile.governance.permission.localOperatorOverrideId
        : input.localOperatorOverrideId,
      policyRunId: input.policyRunId,
      policyTaskId: input.policyTaskId,
      fullWebAccess: input.fullWebAccess,
      historyMessages: prepared.history,
      outputMessageId: prepared.assistantMessageId,
      modelRouter: prepared.modelRouterDecision,
      signal: controller.signal,
      capabilityProfile: prepared.capabilityProfile,
      capabilityProfileContent: prepared.capabilityProfileContent,
      compactionDimensionHash: prepared.compactionDimensionHash,
    });
    await assertChatTurnCompletionWritable(host, prepared.turnId, controller.signal, [turnResult.turnTrace.status]);
    let reflectionTrace: ChatTurnTraceRecord["reflection"] = {
      attempted: false,
      attemptCount: 0,
      outcome: "not_needed",
    };

    const shouldAttemptReflection =
      prepared.autonomy.reflectionMode === "on" &&
      !prepared.capabilityProfile &&
      prepared.prefs.planningMode !== "advisory" &&
      !controller.signal.aborted &&
      !turnResult.requiresApproval &&
      (turnResult.turnTrace.status === "failed" || looksLowConfidenceResponse(turnResult.assistantContent));

    if (shouldAttemptReflection) {
      const retryTurnId = randomUUID();
      const retryReason =
        turnResult.turnTrace.status === "failed" ? "tool failure or completion failure" : "low confidence response";
      reflectionTrace = {
        attempted: true,
        attemptCount: 1,
        reason: retryReason,
        outcome: "still_failed",
      };
      await host.storage.chatReflectionAttempts.create({
        attemptId: randomUUID(),
        turnId: retryTurnId,
        sessionId,
        reason: retryReason,
        outcome: "still_failed",
        attemptCount: 1,
        strategy: "single retry with alternate tool/query strategy",
        error: turnResult.turnTrace.status === "failed" ? turnResult.assistantContent.slice(0, 500) : null,
      });

      const retryHistory = prepared.history;
      const retryPrompt = `${prepared.content}\n\nRetry guidance: last attempt was incomplete. Use a different approach or tool and be explicit about limits.`;
      // R3-8: rebind the fan-out executor to the retry turn so any
      // agent.fanout work during the retry is attributed to the retry turn's
      // id (child runIds and delegated diagnostics derive from
      // prepared.turnId), not the failed original.
      if (shouldRegisterSubagentFanoutExecutor(prepared, subagentFanoutExecutorOptions.permissionProfileId)) {
        disposeSubagentFanout?.();
        disposeSubagentFanout = host.subagentFanout?.register(
          sessionId,
          createTurnSubagentFanoutExecutor(host, { ...prepared, turnId: retryTurnId }, subagentFanoutExecutorOptions),
        );
      }
      const retryResult = await host.turnRuntime.run({
        sessionId,
        turnId: retryTurnId,
        userMessageId: prepared.userEventId,
        ...(prepared.parentDelegationStepId ? { parentDelegationStepId: prepared.parentDelegationStepId } : {}),
        parentTurnId: prepared.parentTurnId,
        branchKind: "retry",
        sourceTurnId: turnId,
        content: retryPrompt,
        mode,
        providerId: input.providerId ?? prepared.prefs.providerId,
        model: input.model ?? prepared.prefs.model,
        webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
        memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
        retrievalMode: prepared.autonomy.retrievalMode,
        thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
        speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
        subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
        normalizationProfile: prepared.normalized.normalizationProfile,
        toolAutonomy: prepared.effectiveToolAutonomy,
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
        policyRunId: input.policyRunId,
        policyTaskId: input.policyTaskId,
        fullWebAccess: input.fullWebAccess,
        historyMessages: retryHistory,
        outputMessageId: prepared.assistantMessageId,
        modelRouter: prepared.modelRouterDecision,
        signal: controller.signal,
        compactionDimensionHash: prepared.compactionDimensionHash,
      });
      await assertChatTurnCompletionWritable(host, retryTurnId, controller.signal, [retryResult.turnTrace.status]);
      if (retryResult.turnTrace.status === "completed" && retryResult.assistantContent.trim().length > 0) {
        turnId = retryTurnId;
        turnResult = retryResult;
        reflectionTrace = {
          attempted: true,
          attemptCount: 1,
          reason: retryReason,
          outcome: "recovered",
        };
      }
    }

    const dedupedTurnCitations = dedupeChatCitations([
      ...(prepared.threadKnowledgeCitations ?? []),
      ...(turnResult.turnTrace.citations ?? []),
    ]);
    const persistedTurnFailure =
      turnResult.turnTrace.failure ?? inferDegradedAssistantTurnFailure(turnResult.assistantContent);
    if (turnResult.requiresApproval || turnResult.turnTrace.status === "cancelled") {
      let traceWithMeta: ChatTurnTraceRecord = await host.storage.chatTurnTraces.patch(turnId, {
        retrieval: prepared.retrievalTrace,
        reflection: reflectionTrace,
        proactive: {
          runId: prepared.autonomy.lastProactiveRunId,
          mode: prepared.autonomy.proactiveMode,
        },
        guidance: {
          workspaceId: prepared.workspaceId,
          globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
          workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
          truncated: prepared.resolvedGuidance.truncated,
        },
        citations: dedupedTurnCitations,
        failure: persistedTurnFailure,
      });
      const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
        sessionId,
        content: prepared.content,
        assistantText: turnResult.assistantContent,
        trace: {
          ...traceWithMeta,
          toolRuns: await host.storage.chatToolRuns.listByTurn(turnId),
        },
      });
      if (capabilityUpgradeSuggestions.length > 0) {
        traceWithMeta = await host.storage.chatTurnTraces.patch(turnId, {
          capabilityUpgradeSuggestions,
        });
      }
      await host.recordCapabilityGapFromTrace({
        sessionId,
        turnId,
        content: prepared.content,
        trace: {
          ...traceWithMeta,
          citations: dedupedTurnCitations,
          toolRuns: await host.storage.chatToolRuns.listByTurn(turnId),
        },
      });
      if (turnResult.turnTrace.status !== "cancelled") {
        await host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        await host.publishRealtime(
          "chat_thread_updated",
          "chat",
          {
            type: "chat_thread_turn_appended",
            sessionId,
            turnId,
            activeLeafTurnId: turnId,
          },
          buildChatTurnRealtimeOptions({ sessionId, turnId }),
        );
      }
      return {
        sessionId,
        userMessage: prepared.userMessage,
        assistantMessage: undefined,
        transport: "llm",
        model: turnResult.assistantModel,
        turnId,
        trace: {
          ...traceWithMeta,
          citations: dedupedTurnCitations,
          toolRuns: await host.storage.chatToolRuns.listByTurn(turnId),
        },
        citations: dedupedTurnCitations,
        routing: turnResult.turnTrace.routing,
      };
    }

    const assistantText =
      turnResult.assistantContent.trim().length > 0
        ? turnResult.assistantContent
        : buildEmptyAssistantTurnFallbackText();
    const assistantUsage = withCostAttribution(turnResult.usage, {
      providerId: turnResult.turnTrace.routing.effectiveProviderId ?? input.providerId ?? prepared.prefs.providerId,
      model:
        turnResult.turnTrace.routing.effectiveModel ?? turnResult.assistantModel ?? input.model ?? prepared.prefs.model,
    });
    const assistantEventId = prepared.assistantMessageId;
    const storage = host.storage;
    const finalTraceStatus = turnResult.turnTrace.status === "failed" ? "failed" : "completed";
    const finalTracePatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
      assistantMessageId: assistantEventId,
      status: finalTraceStatus,
      finishedAt: new Date().toISOString(),
      retrieval: prepared.retrievalTrace,
      reflection: reflectionTrace,
      proactive: {
        runId: prepared.autonomy.lastProactiveRunId,
        mode: prepared.autonomy.proactiveMode,
      },
      guidance: {
        workspaceId: prepared.workspaceId,
        globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
        workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
        truncated: prepared.resolvedGuidance.truncated,
      },
      citations: dedupedTurnCitations,
      failure: persistedTurnFailure,
    };
    const completionOwnerStatuses = [
      ...new Set(["running", turnResult.turnTrace.status]),
    ] as ChatTurnTraceRecord["status"][];
    let trace: ChatTurnTraceRecord | undefined;
    await assertChatTurnCompletionWritable(host, turnId, controller.signal, completionOwnerStatuses);
    await host.ingestEvent(
      randomUUID(),
      {
        eventId: assistantEventId,
        route: prepared.route,
        actor: {
          type: "agent",
          id: "assistant",
        },
        message: {
          role: "assistant",
          content: assistantText,
        },
        ...(input.policyTaskId ? { taskId: input.policyTaskId } : {}),
        usage:
          assistantUsage || (turnResult.modelUsageEventIds?.length ?? 0) > 0
            ? {
                ...assistantUsage,
                ...(turnResult.modelUsageEventIds?.length
                  ? {
                      canonicalUsageEventIds: turnResult.modelUsageEventIds,
                      canonicalUsageOwner: {
                        workspaceId: prepared.workspaceId,
                        sessionId,
                        turnId,
                      },
                    }
                  : {}),
              }
            : undefined,
      },
      {
        onCommit: async () => {
          trace = await patchChatTurnTraceIfStatus(
            storage.chatTurnTraces,
            turnId,
            completionOwnerStatuses,
            finalTracePatch,
          );
        },
      },
    );
    trace ??= await patchChatTurnTraceIfStatus(
      storage.chatTurnTraces,
      turnId,
      completionOwnerStatuses,
      finalTracePatch,
    );
    const assistantMessage: ChatMessageRecord = {
      messageId: assistantEventId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      sourceAuthority: "agent_proposed",
      content: assistantText,
      timestamp: new Date().toISOString(),
    };
    let hydratedTrace: ChatTurnTraceRecord = {
      ...trace,
      citations: dedupedTurnCitations,
      toolRuns: await storage.chatToolRuns.listByTurn(turnId),
    };
    const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
      sessionId,
      content: prepared.content,
      assistantText,
      trace: hydratedTrace,
    });
    const specialistCandidateSuggestions = await host.collectSpecialistCandidateSuggestions({
      sessionId,
      mode,
      content: prepared.content,
      capabilitySuggestions: capabilityUpgradeSuggestions,
      trace: hydratedTrace,
    });
    if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
      hydratedTrace = await storage.chatTurnTraces.patch(turnId, {
        capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
        specialistCandidateSuggestions: specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
      });
      hydratedTrace = {
        ...hydratedTrace,
        toolRuns: await storage.chatToolRuns.listByTurn(turnId),
      };
    }
    await host.recordCapabilityGapFromTrace({
      sessionId,
      turnId,
      content: prepared.content,
      trace: hydratedTrace,
    });

    // Learned-memory promotion and commitments are production-dark on this
    // compatibility path. Canonical Chat completion owns governed post-commit
    // work through admitted durable children.
    await host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
    await host.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_turn_appended",
        sessionId,
        turnId,
        activeLeafTurnId: turnId,
      },
      buildChatTurnRealtimeOptions({ sessionId, turnId }),
    );
    const delegationDetection = detectDelegationRoles(prepared.content);
    if (
      !(await host.isReplayScratchSession(sessionId)) &&
      prepared.prefs.planningMode !== "advisory" &&
      delegationDetection.length > 1
    ) {
      await host.triggerChatSessionProactive(sessionId, {
        source: "chat",
        reason: "Detected multi-role phrasing; generated delegation suggestion.",
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
      });
    }

    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "llm",
      model: turnResult.assistantModel,
      turnId,
      trace: hydratedTrace,
      citations: hydratedTrace.citations,
      routing: hydratedTrace.routing,
    };
  } finally {
    disposeSubagentFanout?.();
    externalAbortListener?.();
    host.endActiveChatTurnExecution(prepared.turnId, controller);
  }
}

async function assertChatTurnCompletionWritable(
  host: Pick<ChatTurnEntryHost, "storage">,
  turnId: string,
  signal: AbortSignal,
  allowedTerminalStatuses: readonly ChatTurnTraceRecord["status"][] = [],
): Promise<void> {
  if (signal.aborted) {
    throw new ChatTurnCancelledError(turnId);
  }
  let status: ChatTurnTraceRecord["status"];
  try {
    status = (await host.storage.chatTurnTraces.get(turnId)).status;
  } catch (error) {
    if (error instanceof NotFoundError) {
      // The turn runtime may not have persisted its trace yet. The abort
      // signal remains the completion fence in that compatibility case.
      return;
    }
    throw error;
  }
  if (status === "cancelled") {
    throw new ChatTurnCancelledError(turnId);
  }
  if (isChatTurnTerminalStatus(status) && !allowedTerminalStatuses.includes(status)) {
    throw new Error(`Chat turn ${turnId} completion lost lifecycle ownership to ${status}.`);
  }
}

function withCostAttribution(
  usage: GatewayEventInput["usage"] | undefined,
  attribution: { providerId?: string; model?: string },
): GatewayEventInput["usage"] {
  return {
    ...(usage ?? {}),
    ...(attribution.providerId ? { providerId: attribution.providerId } : {}),
    ...(attribution.model ? { model: attribution.model } : {}),
  };
}

function bindExternalAbortToController(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  if (externalSignal.aborted) {
    controller.abort();
    return undefined;
  }
  const onAbort = (): void => {
    controller.abort();
  };
  externalSignal.addEventListener("abort", onAbort);
  return () => {
    externalSignal.removeEventListener("abort", onAbort);
  };
}

export async function* agentSendChatMessageStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  options?: OperatorChatTurnStreamRequestOptions,
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "agent-send/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      const turnIdentity = createEntryTurnIdentity();
      const admissionActorId = resolveEntrySendAdmissionActorId(input, options?.externalCompanion);
      const turnAdmission = await admitEntrySendChatTurn(
        host,
        {
          sessionId,
          turnId: turnIdentity.turnId,
          request: input,
          actorId: admissionActorId,
          idempotencyKey: `chat-turn-admit:${turnIdentity.turnId}`,
          correlationId: turnIdentity.turnId,
        },
        {
          authenticatedOperator: options?.authenticatedOperator,
          externalCompanion: options?.externalCompanion,
        },
      );
      assertEntryTurnAdmission(turnAdmission, sessionId, turnIdentity.turnId, input);
      const heartbeat = host.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
      let completedNormally = false;
      let terminalStatus: ChatTurnTraceRecord["status"] | undefined;
      try {
        input = await applySurfaceRoutingPreflight(
          createAdmissionGuardedSurfaceHost(host, turnAdmission, heartbeat),
          sessionId,
          input,
          (error) => {
            host.recordDevDiagnostic({
              level: "warn",
              category: "chat",
              event: "chat.surface_router.failed",
              message: "Surface auto-router failed; continuing with the provided/default mode",
              sessionId,
              context: { error: error instanceof Error ? error.message : String(error) },
            });
          },
        );
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        const binding = await resolveAdmissionFencedChatSessionBinding(
          host,
          turnAdmission,
          heartbeat,
          sessionId,
          turnAdmission.identity.workspaceId,
        );
        host.recordDevDiagnostic({
          level: "info",
          category: "chat",
          event: "chat.stream.start",
          message: "Starting streamed mission chat turn",
          sessionId,
          providerId: input.providerId,
          modelId: input.model,
          context: {
            mode: input.mode,
            webMode: input.webMode,
            thinkingLevel: input.thinkingLevel,
            speedMode: input.speedMode,
            subagentPolicy: input.subagentPolicy,
          },
        });
        const routeDescriptor = await resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
          action: "send",
          providerId: input.providerId,
          model: input.model,
          mode: input.mode,
          webMode: input.webMode,
          thinkingLevel: input.thinkingLevel,
          speedMode: input.speedMode,
          subagentPolicy: input.subagentPolicy,
          prefsOverride: input.prefsOverride,
        });
        host.recordDevDiagnostic({
          level: "info",
          category: "chat",
          event: "chat.stream.preflight",
          message: "Resolved streamed send routing before execution",
          sessionId,
          providerId: routeDescriptor.effectiveProviderId,
          modelId: routeDescriptor.effectiveModel,
          context: {
            selectionSource: routeDescriptor.selectionSource,
            fallbackPolicy: routeDescriptor.fallbackPolicy,
          },
        });
        const prepared = await host.prepareAgentChatTurn(sessionId, input, {
          branchKind: "append",
          turnId: turnIdentity.turnId,
          userMessageId: turnIdentity.userMessageId,
          assistantMessageId: turnIdentity.assistantMessageId,
          turnAdmission,
          ...(options?.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
        });
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        if (binding.transport !== "llm") {
          const integrationOptions =
            options?.abortSignal || options?.mutationLifecycle
              ? {
                  ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
                  ...(options.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
                }
              : undefined;
          const stream = integrationOptions
            ? chatTurnDispatchService.streamPreparedIntegrationChatTurn(
                host,
                sessionId,
                input,
                prepared,
                binding,
                "chat_thread_turn_appended",
                integrationOptions,
              )
            : chatTurnDispatchService.streamPreparedIntegrationChatTurn(
                host,
                sessionId,
                input,
                prepared,
                binding,
                "chat_thread_turn_appended",
              );
          for await (const chunk of host.withEphemeralStreamEnvelope(stream)) {
            terminalStatus = captureStreamTerminalStatus(chunk, terminalStatus);
            yield chunk;
          }
          assertWaitingStreamHasDurableOwner(turnAdmission, terminalStatus);
          completedNormally = true;
          return;
        }
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        const durableRunId = await (options?.mutationLifecycle
          ? chatTurnDispatchService.launchPreparedAgentChatTurnStream(
              host,
              sessionId,
              input,
              prepared,
              "chat_thread_turn_appended",
              undefined,
              { mutationLifecycle: options.mutationLifecycle },
            )
          : chatTurnDispatchService.launchPreparedAgentChatTurnStream(
              host,
              sessionId,
              input,
              prepared,
              "chat_thread_turn_appended",
            ));
        if (!turnAdmission.requestClaim) heartbeat.stop();
        const detachAbortListener = bindStreamAbortToTurn(host, prepared.turnId, durableRunId, options?.abortSignal);
        try {
          for await (const chunk of host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
            liveTail: true,
            ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
          })) {
            terminalStatus = captureStreamTerminalStatus(chunk, terminalStatus);
            yield chunk;
          }
          assertWaitingStreamHasDurableOwner(turnAdmission, terminalStatus);
          completedNormally = true;
        } finally {
          detachAbortListener?.();
        }
      } finally {
        await closeEntryRequestAdmission(
          host,
          turnAdmission,
          heartbeat,
          admissionActorId,
          terminalStatus,
          completedNormally,
        );
      }
    })();
  });
}

export async function retryChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  overrides: Partial<ChatSendMessageRequest> = {},
  options?: OperatorChatTurnRequestOptions,
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "retry-turn", async () => {
    const current = await requireEntryChatTurnContext(host, sessionId, turnId);
    const request: ChatSendMessageRequest = {
      content: current.userMessage.content,
      attachments: current.userMessage.attachments?.map((item) => item.attachmentId),
      providerId: overrides.providerId,
      model: overrides.model,
      useMemory: overrides.useMemory,
      mode: overrides.mode,
      webMode: overrides.webMode,
      memoryMode: overrides.memoryMode,
      thinkingLevel: overrides.thinkingLevel,
      speedMode: overrides.speedMode,
      subagentPolicy: overrides.subagentPolicy,
      commandText: overrides.commandText,
      prefsOverride: overrides.prefsOverride,
      operatorId: overrides.operatorId,
      authActorId: overrides.authActorId,
      authActorSource: overrides.authActorSource,
      permissionProfileId: overrides.permissionProfileId,
      localOperatorOverrideId: overrides.localOperatorOverrideId,
      policyRunId: overrides.policyRunId,
      policyTaskId: overrides.policyTaskId,
      contextRefs: overrides.contextRefs,
    };
    const routeDescriptor = await resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
      action: "retry",
      turnId,
      providerId: request.providerId,
      model: request.model,
      mode: request.mode,
      webMode: request.webMode,
      thinkingLevel: request.thinkingLevel,
      speedMode: request.speedMode,
      subagentPolicy: request.subagentPolicy,
      prefsOverride: request.prefsOverride,
    });
    host.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turn.retry_preflight",
      message: "Resolved retry routing before execution",
      sessionId,
      turnId,
      providerId: routeDescriptor.effectiveProviderId,
      modelId: routeDescriptor.effectiveModel,
      context: {
        selectionSource: routeDescriptor.selectionSource,
        fallbackPolicy: routeDescriptor.fallbackPolicy,
      },
    });
    const turnIdentity = createEntryTurnIdentity();
    const admissionActorId = resolveTurnAdmissionActorId(request);
    const turnAdmission = await admitEntryOperatorChatTurn(
      host,
      {
        sessionId,
        turnId: turnIdentity.turnId,
        request,
        actorId: admissionActorId,
        idempotencyKey: `chat-turn-admit:${turnIdentity.turnId}`,
        correlationId: turnIdentity.turnId,
      },
      options?.authenticatedOperator,
    );
    const heartbeat = host.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
    let response: ChatSendMessageResponse | undefined;
    let completedNormally = false;
    try {
      await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
      const binding = await resolveAdmissionFencedChatSessionBinding(
        host,
        turnAdmission,
        heartbeat,
        sessionId,
        turnAdmission.identity.workspaceId,
      );
      const prepared = await host.prepareAgentChatTurn(sessionId, request, {
        branchKind: "retry",
        turnId: turnIdentity.turnId,
        userMessageId: current.userMessage.messageId,
        assistantMessageId: turnIdentity.assistantMessageId,
        sourceTurnId: turnId,
        parentTurnId: current.trace.parentTurnId,
        existingUserMessage: current.userMessage,
        ingestUserMessage: false,
        turnAdmission,
      });
      await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
      response =
        binding.transport !== "llm"
          ? await chatTurnDispatchService.sendPreparedIntegrationChatTurn(
              host,
              sessionId,
              request,
              prepared,
              binding,
              "chat_thread_turn_retried",
            )
          : await chatTurnDispatchService.consumePreparedAgentChatTurn(
              host,
              sessionId,
              request,
              prepared,
              "chat_thread_turn_retried",
            );
      assertWaitingResponseHasDurableOwner(turnAdmission, response);
      completedNormally = true;
      return response;
    } finally {
      await closeEntryRequestAdmission(
        host,
        turnAdmission,
        heartbeat,
        admissionActorId,
        response?.trace?.status,
        completedNormally,
      );
    }
  });
}

export async function* retryChatTurnStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  overrides: Partial<ChatSendMessageRequest> = {},
  options?: OperatorChatTurnStreamRequestOptions,
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "retry-turn/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      const current = await requireEntryChatTurnContext(host, sessionId, turnId);
      const request: ChatSendMessageRequest = {
        content: current.userMessage.content,
        attachments: current.userMessage.attachments?.map((item) => item.attachmentId),
        providerId: overrides.providerId,
        model: overrides.model,
        useMemory: overrides.useMemory,
        mode: overrides.mode,
        webMode: overrides.webMode,
        memoryMode: overrides.memoryMode,
        thinkingLevel: overrides.thinkingLevel,
        speedMode: overrides.speedMode,
        subagentPolicy: overrides.subagentPolicy,
        commandText: overrides.commandText,
        prefsOverride: overrides.prefsOverride,
        operatorId: overrides.operatorId,
        authActorId: overrides.authActorId,
        authActorSource: overrides.authActorSource,
        permissionProfileId: overrides.permissionProfileId,
        localOperatorOverrideId: overrides.localOperatorOverrideId,
        policyRunId: overrides.policyRunId,
        policyTaskId: overrides.policyTaskId,
        contextRefs: overrides.contextRefs,
      };
      const turnIdentity = createEntryTurnIdentity();
      const admissionActorId = resolveTurnAdmissionActorId(request);
      const turnAdmission = await admitEntryOperatorChatTurn(
        host,
        {
          sessionId,
          turnId: turnIdentity.turnId,
          request,
          actorId: admissionActorId,
          idempotencyKey: `chat-turn-admit:${turnIdentity.turnId}`,
          correlationId: turnIdentity.turnId,
        },
        options?.authenticatedOperator,
      );
      assertEntryTurnAdmission(turnAdmission, sessionId, turnIdentity.turnId, request);
      const heartbeat = host.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
      let completedNormally = false;
      let terminalStatus: ChatTurnTraceRecord["status"] | undefined;
      try {
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        const binding = await resolveAdmissionFencedChatSessionBinding(
          host,
          turnAdmission,
          heartbeat,
          sessionId,
          turnAdmission.identity.workspaceId,
        );
        const routeDescriptor = await resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
          action: "retry",
          turnId,
          providerId: request.providerId,
          model: request.model,
          mode: request.mode,
          webMode: request.webMode,
          thinkingLevel: request.thinkingLevel,
          speedMode: request.speedMode,
          subagentPolicy: request.subagentPolicy,
          prefsOverride: request.prefsOverride,
        });
        host.recordDevDiagnostic({
          level: "info",
          category: "chat",
          event: "chat.turn.retry_stream_preflight",
          message: "Resolved streamed retry routing before execution",
          sessionId,
          turnId,
          providerId: routeDescriptor.effectiveProviderId,
          modelId: routeDescriptor.effectiveModel,
          context: {
            selectionSource: routeDescriptor.selectionSource,
            fallbackPolicy: routeDescriptor.fallbackPolicy,
          },
        });
        const prepared = await host.prepareAgentChatTurn(sessionId, request, {
          branchKind: "retry",
          turnId: turnIdentity.turnId,
          userMessageId: current.userMessage.messageId,
          assistantMessageId: turnIdentity.assistantMessageId,
          sourceTurnId: turnId,
          parentTurnId: current.trace.parentTurnId,
          existingUserMessage: current.userMessage,
          ingestUserMessage: false,
          turnAdmission,
          ...(options?.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
        });
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        if (binding.transport !== "llm") {
          const integrationOptions =
            options?.abortSignal || options?.mutationLifecycle
              ? {
                  ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
                  ...(options.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
                }
              : undefined;
          const stream = integrationOptions
            ? chatTurnDispatchService.streamPreparedIntegrationChatTurn(
                host,
                sessionId,
                request,
                prepared,
                binding,
                "chat_thread_turn_retried",
                integrationOptions,
              )
            : chatTurnDispatchService.streamPreparedIntegrationChatTurn(
                host,
                sessionId,
                request,
                prepared,
                binding,
                "chat_thread_turn_retried",
              );
          for await (const chunk of host.withEphemeralStreamEnvelope(stream)) {
            terminalStatus = captureStreamTerminalStatus(chunk, terminalStatus);
            yield chunk;
          }
          assertWaitingStreamHasDurableOwner(turnAdmission, terminalStatus);
          completedNormally = true;
          return;
        }
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        const durableRunId = await (options?.mutationLifecycle
          ? chatTurnDispatchService.launchPreparedAgentChatTurnStream(
              host,
              sessionId,
              request,
              prepared,
              "chat_thread_turn_retried",
              undefined,
              { mutationLifecycle: options.mutationLifecycle },
            )
          : chatTurnDispatchService.launchPreparedAgentChatTurnStream(
              host,
              sessionId,
              request,
              prepared,
              "chat_thread_turn_retried",
            ));
        if (!turnAdmission.requestClaim) heartbeat.stop();
        const detachAbortListener = bindStreamAbortToTurn(host, prepared.turnId, durableRunId, options?.abortSignal);
        try {
          for await (const chunk of host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
            liveTail: true,
            ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
          })) {
            terminalStatus = captureStreamTerminalStatus(chunk, terminalStatus);
            yield chunk;
          }
          assertWaitingStreamHasDurableOwner(turnAdmission, terminalStatus);
          completedNormally = true;
        } finally {
          detachAbortListener?.();
        }
      } finally {
        await closeEntryRequestAdmission(
          host,
          turnAdmission,
          heartbeat,
          admissionActorId,
          terminalStatus,
          completedNormally,
        );
      }
    })();
  });
}

export async function editChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
  options?: OperatorChatTurnRequestOptions,
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "edit-turn", async () => {
    const current = await requireEntryChatTurnContext(host, sessionId, turnId);
    const request: ChatSendMessageRequest = {
      ...input,
      attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
    };
    const routeDescriptor = await resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
      action: "edit",
      turnId,
      providerId: request.providerId,
      model: request.model,
      mode: request.mode,
      webMode: request.webMode,
      thinkingLevel: request.thinkingLevel,
      speedMode: request.speedMode,
      subagentPolicy: request.subagentPolicy,
      prefsOverride: request.prefsOverride,
    });
    host.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turn.edit_preflight",
      message: "Resolved edit routing before execution",
      sessionId,
      turnId,
      providerId: routeDescriptor.effectiveProviderId,
      modelId: routeDescriptor.effectiveModel,
      context: {
        selectionSource: routeDescriptor.selectionSource,
        fallbackPolicy: routeDescriptor.fallbackPolicy,
      },
    });
    const turnIdentity = createEntryTurnIdentity();
    const admissionActorId = resolveTurnAdmissionActorId(request);
    const turnAdmission = await admitEntryOperatorChatTurn(
      host,
      {
        sessionId,
        turnId: turnIdentity.turnId,
        request,
        actorId: admissionActorId,
        idempotencyKey: `chat-turn-admit:${turnIdentity.turnId}`,
        correlationId: turnIdentity.turnId,
      },
      options?.authenticatedOperator,
    );
    const heartbeat = host.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
    let response: ChatSendMessageResponse | undefined;
    let completedNormally = false;
    try {
      await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
      const binding = await resolveAdmissionFencedChatSessionBinding(
        host,
        turnAdmission,
        heartbeat,
        sessionId,
        turnAdmission.identity.workspaceId,
      );
      const prepared = await host.prepareAgentChatTurn(sessionId, request, {
        branchKind: "edit",
        turnId: turnIdentity.turnId,
        userMessageId: turnIdentity.userMessageId,
        assistantMessageId: turnIdentity.assistantMessageId,
        sourceTurnId: turnId,
        parentTurnId: current.trace.parentTurnId,
        turnAdmission,
      });
      await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
      response =
        binding.transport !== "llm"
          ? await chatTurnDispatchService.sendPreparedIntegrationChatTurn(
              host,
              sessionId,
              request,
              prepared,
              binding,
              "chat_thread_turn_edited",
            )
          : await chatTurnDispatchService.consumePreparedAgentChatTurn(
              host,
              sessionId,
              request,
              prepared,
              "chat_thread_turn_edited",
            );
      assertWaitingResponseHasDurableOwner(turnAdmission, response);
      completedNormally = true;
      return response;
    } finally {
      await closeEntryRequestAdmission(
        host,
        turnAdmission,
        heartbeat,
        admissionActorId,
        response?.trace?.status,
        completedNormally,
      );
    }
  });
}

export async function* editChatTurnStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
  options?: OperatorChatTurnStreamRequestOptions,
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "edit-turn/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      const current = await requireEntryChatTurnContext(host, sessionId, turnId);
      const request: ChatSendMessageRequest = {
        ...input,
        attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
      };
      const turnIdentity = createEntryTurnIdentity();
      const admissionActorId = resolveTurnAdmissionActorId(request);
      const turnAdmission = await admitEntryOperatorChatTurn(
        host,
        {
          sessionId,
          turnId: turnIdentity.turnId,
          request,
          actorId: admissionActorId,
          idempotencyKey: `chat-turn-admit:${turnIdentity.turnId}`,
          correlationId: turnIdentity.turnId,
        },
        options?.authenticatedOperator,
      );
      assertEntryTurnAdmission(turnAdmission, sessionId, turnIdentity.turnId, request);
      const heartbeat = host.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
      let completedNormally = false;
      let terminalStatus: ChatTurnTraceRecord["status"] | undefined;
      try {
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        const binding = await resolveAdmissionFencedChatSessionBinding(
          host,
          turnAdmission,
          heartbeat,
          sessionId,
          turnAdmission.identity.workspaceId,
        );
        const routeDescriptor = await resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
          action: "edit",
          turnId,
          providerId: request.providerId,
          model: request.model,
          mode: request.mode,
          webMode: request.webMode,
          thinkingLevel: request.thinkingLevel,
          speedMode: request.speedMode,
          subagentPolicy: request.subagentPolicy,
          prefsOverride: request.prefsOverride,
        });
        host.recordDevDiagnostic({
          level: "info",
          category: "chat",
          event: "chat.turn.edit_stream_preflight",
          message: "Resolved streamed edit routing before execution",
          sessionId,
          turnId,
          providerId: routeDescriptor.effectiveProviderId,
          modelId: routeDescriptor.effectiveModel,
          context: {
            selectionSource: routeDescriptor.selectionSource,
            fallbackPolicy: routeDescriptor.fallbackPolicy,
          },
        });
        const prepared = await host.prepareAgentChatTurn(sessionId, request, {
          branchKind: "edit",
          turnId: turnIdentity.turnId,
          userMessageId: turnIdentity.userMessageId,
          assistantMessageId: turnIdentity.assistantMessageId,
          sourceTurnId: turnId,
          parentTurnId: current.trace.parentTurnId,
          turnAdmission,
          ...(options?.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
        });
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        if (binding.transport !== "llm") {
          const integrationOptions =
            options?.abortSignal || options?.mutationLifecycle
              ? {
                  ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
                  ...(options.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
                }
              : undefined;
          const stream = integrationOptions
            ? chatTurnDispatchService.streamPreparedIntegrationChatTurn(
                host,
                sessionId,
                request,
                prepared,
                binding,
                "chat_thread_turn_edited",
                integrationOptions,
              )
            : chatTurnDispatchService.streamPreparedIntegrationChatTurn(
                host,
                sessionId,
                request,
                prepared,
                binding,
                "chat_thread_turn_edited",
              );
          for await (const chunk of host.withEphemeralStreamEnvelope(stream)) {
            terminalStatus = captureStreamTerminalStatus(chunk, terminalStatus);
            yield chunk;
          }
          assertWaitingStreamHasDurableOwner(turnAdmission, terminalStatus);
          completedNormally = true;
          return;
        }
        await assertEntryAdmissionActive(host, turnAdmission, heartbeat);
        const durableRunId = await (options?.mutationLifecycle
          ? chatTurnDispatchService.launchPreparedAgentChatTurnStream(
              host,
              sessionId,
              request,
              prepared,
              "chat_thread_turn_edited",
              undefined,
              { mutationLifecycle: options.mutationLifecycle },
            )
          : chatTurnDispatchService.launchPreparedAgentChatTurnStream(
              host,
              sessionId,
              request,
              prepared,
              "chat_thread_turn_edited",
            ));
        if (!turnAdmission.requestClaim) heartbeat.stop();
        const detachAbortListener = bindStreamAbortToTurn(host, prepared.turnId, durableRunId, options?.abortSignal);
        try {
          for await (const chunk of host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
            liveTail: true,
            ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
          })) {
            terminalStatus = captureStreamTerminalStatus(chunk, terminalStatus);
            yield chunk;
          }
          assertWaitingStreamHasDurableOwner(turnAdmission, terminalStatus);
          completedNormally = true;
        } finally {
          detachAbortListener?.();
        }
      } finally {
        await closeEntryRequestAdmission(
          host,
          turnAdmission,
          heartbeat,
          admissionActorId,
          terminalStatus,
          completedNormally,
        );
      }
    })();
  });
}

function bindStreamAbortToTurn(
  host: ChatTurnEntryHost,
  turnId: string,
  durableRunId: string | undefined,
  externalSignal: AbortSignal | undefined,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  const fire = (): void => {
    if (durableRunId) {
      // A passive SSE disconnect is not operator intent to cancel a durable Chat/Cowork/Code turn.
      // Explicit stop still flows through cancelChatTurn, which cancels the durable run with evidence.
      return;
    }
    const active = host.getActiveChatTurnExecution(turnId);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new ChatTurnCancelledError(turnId));
    }
  };
  if (externalSignal.aborted) {
    fire();
    return undefined;
  }
  externalSignal.addEventListener("abort", fire);
  return () => {
    externalSignal.removeEventListener("abort", fire);
  };
}

export async function cancelChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  cancelledBy?: string,
): Promise<ChatCancelTurnResponse> {
  const storage = host.storage;
  const cancelDurableChatRun = host.cancelDurableChatRun;
  let current: ChatTurnTraceRecord | undefined;
  try {
    current = await storage.chatTurnTraces.get(turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  const activeStream = host.getActiveChatTurnStream(turnId);
  const writableActiveStream = activeStream && !activeStream.completed ? activeStream : undefined;
  if (current?.sessionId !== undefined && current.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  if (!current) {
    if (!activeStream) {
      throw new NotFoundError({ entity: "Chat turn", id: turnId });
    }
    if (activeStream.sessionId !== sessionId) {
      throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
    }
  }
  const active = host.getActiveChatTurnExecution(turnId);
  if (active?.sessionId === sessionId && !active.controller.signal.aborted) {
    active.controller.abort(new ChatTurnCancelledError(turnId));
  }
  const durableRunId = current?.durable?.runId ?? activeStream?.runId;
  let durableCancellation: DurableRunRecord | undefined;
  let durableCancellationError: unknown;
  if (durableRunId && cancelDurableChatRun) {
    try {
      durableCancellation = await cancelDurableChatRun(durableRunId, cancelledBy ?? "operator");
    } catch (error) {
      durableCancellationError = error;
      try {
        durableCancellation = await storage.durableRuns.getRun(durableRunId);
      } catch {
        // Preserve the original cancellation error when canonical run truth is unavailable.
      }
    }
  }
  const durableTerminalWinner =
    durableCancellation &&
    (durableCancellation.status === "completed" ||
      durableCancellation.status === "failed" ||
      durableCancellation.status === "dead_lettered");
  if (durableCancellationError && !durableTerminalWinner && durableCancellation?.status !== "cancelled") {
    throw durableCancellationError;
  }
  const trace = await (durableTerminalWinner
    ? (async () => {
        try {
          return await storage.chatTurnTraces.get(turnId);
        } catch {
          if (current) {
            return current;
          }
          throw durableCancellationError ?? new Error(`Chat turn ${turnId} terminal projection is unavailable.`);
        }
      })()
    : host.markChatTurnCancelled(sessionId, turnId, cancelledBy));
  const durableTerminalProjectionAligned =
    !durableTerminalWinner ||
    (durableCancellation?.status === "completed" && trace.status === "completed") ||
    ((durableCancellation?.status === "failed" || durableCancellation?.status === "dead_lettered") &&
      trace.status === "failed");
  if (!durableTerminalProjectionAligned || (durableTerminalWinner && isChatTurnActiveStatus(trace.status))) {
    return {
      sessionId,
      turnId,
      cancelled: false,
      trace,
    };
  }
  await host.persistChatStreamChunk(
    {
      type: "trace_update",
      sessionId,
      turnId,
      trace,
    },
    durableRunId,
    writableActiveStream,
  );
  if (trace.assistantMessageId) {
    await host.persistChatStreamChunk(
      {
        type: "done",
        sessionId,
        turnId,
        messageId: trace.assistantMessageId,
      },
      durableRunId,
      writableActiveStream,
    );
  }
  if (writableActiveStream) {
    host.completeActiveChatTurnStream(turnId, writableActiveStream.registrationId);
    setTimeout(() => host.closeActiveChatTurnStream(turnId, writableActiveStream.registrationId), 30_000);
  }
  return {
    sessionId,
    turnId,
    cancelled: trace.status === "cancelled",
    trace,
  };
}

export async function routePreflight(
  host: ChatTurnPreflightHost,
  sessionId: string,
  input: RoutingPreflightRequest,
): Promise<RoutingPreflightResult> {
  return preflightChatRoute(host, sessionId, input);
}

export async function* resumeAgentChatTurnStream(
  host: ChatTurnResumeHost,
  sessionId: string,
  turnId: string,
  sinceEventId?: string,
  options?: { abortSignal?: AbortSignal },
): AsyncGenerator<ChatStreamChunk> {
  const trace = await host.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }

  // Durable-linked turns should resume from retained stream state first. Legacy
  // traces without durable linkage still flow through the same persisted stream
  // path as a compatibility fallback.
  yield* host.streamPersistedChatTurnEvents(sessionId, turnId, {
    sinceEventId,
    liveTail: true,
    ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
  });
}
