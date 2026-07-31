/**
 * Chat turn dispatch helpers.
 *
 * Routes prepared chat turns through the narrowed runtime host without
 * depending on the full gateway facade.
 */

import { randomUUID } from "node:crypto";
import { CHAT_TURN_ACTIVE_STATUSES, NotFoundError } from "@goatcitadel/contracts";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
/* eslint-disable max-lines -- Chat dispatch keeps provider, durable, integration, and ownership boundaries co-located for auditability. */
import type {
  ChatCitationRecord,
  ChatMessageRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionBindingRecord,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  ChatTurnCancelledError,
  dedupeChatCitations,
  patchChatTurnTraceIfStatus,
  readDurableCancellation,
  readDurableRecoveryInterruption,
  splitIntoChunks,
  tryPatchChatTurnTraceIfStatus,
} from "./chat-turn-helpers.js";
import {
  ChatTurnStreamRegistrationMismatchError,
  type ActiveChatTurnStreamExecution,
} from "./chat-turn-execution-registry.js";
import {
  isPersistableChatStreamChunk,
  type ChatStreamMutationLifecycle,
  type InspectableChatStreamChunk,
  type PreparedAgentChatTurnDispatchOptions,
  type PreparedChatExecutionPlanResolution,
} from "./chat-turn-types.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import { resolvePreparedTurnMode, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { persistInitialChatTurnTrace, persistPreparedChatCapabilityAdmission } from "./chat-durable-run-service.js";
import * as chatTurnStreamService from "./chat-turn-stream-service.js";
import type {
  ChatTurnDurableRunOwner,
  ChatTurnIntegrationDispatch,
  ChatTurnStreamLifecycleControl,
} from "./chat-turn-runtime-collaborators.js";
import { DurableWorkerInterruptionError } from "./durable-run-service.js";
import { trackBackgroundTask } from "./background-scheduler.js";

export interface ChatTurnDispatchHost
  extends
    chatTurnStreamService.ChatTurnStreamHost,
    ChatTurnDurableRunOwner,
    ChatTurnIntegrationDispatch,
    ChatTurnStreamLifecycleControl {
  readonly storage: chatTurnStreamService.ChatTurnStreamHost["storage"] &
    Pick<Storage, "durableRuns" | "runImmediateTransaction" | "sessionMutationAdmissions">;
  updateActiveLeafOrThrow(sessionId: string, previousActiveTurnId: string | undefined, nextActiveTurnId: string): void;
}

export interface IntegrationDeliveryEvidence {
  status?: string;
  deliveryStatus?: string;
  deliveryId?: string;
  providerMessageId?: string;
  idempotencyKey?: string;
}

export class IntegrationDeliveryPostCommitError extends Error {
  public readonly mutationCommitted = true;

  public constructor(
    public readonly turnId: string,
    public readonly deliveryEvidence: IntegrationDeliveryEvidence,
    cause: unknown,
  ) {
    super(
      `Integration delivery for chat turn ${turnId} committed, but local bookkeeping failed. Do not retry this send; reconcile the turn from delivery evidence.`,
      { cause },
    );
    this.name = "IntegrationDeliveryPostCommitError";
  }
}

export function isDurableExecutionEnabled(host: ChatTurnDispatchHost): boolean {
  return (
    host.config.assistant.durable.enabled &&
    host.config.assistant.durable.executionEnabled &&
    host.isFeatureEnabled("durableKernelV1Enabled")
  );
}

export function shouldUseDurableExecution(
  host: ChatTurnDispatchHost,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  requireDurableExecution = false,
): boolean {
  const carriesRoutedContext = chatTurnCarriesRoutedContext(prepared, input);
  if (!isDurableExecutionEnabled(host)) {
    if (carriesRoutedContext) {
      throw new Error("Routed Chat context requires durable execution to be enabled.");
    }
    if (requireDurableExecution) {
      throw new Error("Deterministic delegated Chat execution requires durable execution to be enabled.");
    }
    return false;
  }
  if (requireDurableExecution) {
    return true;
  }
  if (carriesRoutedContext) {
    return true;
  }
  if (prepared.normalized.normalizationProfile === "quick_web") {
    return false;
  }
  const mode = resolvePreparedTurnMode(prepared);
  if (mode === "chat" || mode === "cowork" || mode === "code") {
    return true;
  }
  if (mode !== undefined || !host.config.assistant.durable.chatAutoPromoteEnabled) {
    return false;
  }
  const webMode = prepared.normalized.webMode ?? prepared.prefs.webMode;
  if (webMode === "deep") {
    return true;
  }
  if (prepared.autonomy.reflectionMode === "on" || prepared.prefs.reflectionMode === "on") {
    return true;
  }
  const content = prepared.content.toLowerCase();
  return (
    content.includes("http://") ||
    content.includes("https://") ||
    content.includes("browser.navigate") ||
    content.includes("browser.extract") ||
    content.includes("http.get") ||
    content.includes("http.post") ||
    /\b(fetch|scrape|extract|browse|navigate|research|look up|find on the web|http get|http post)\b/i.test(content) ||
    Boolean(input.attachments?.length)
  );
}

function chatTurnCarriesRoutedContext(
  prepared: PreparedAgentChatTurn,
  input: Partial<ChatSendMessageRequest>,
): boolean {
  const request = input as Partial<ChatSendMessageRequest> & { contextRefs?: unknown };
  const preparedWithSnapshot = prepared as PreparedAgentChatTurn & { routedContextSnapshot?: unknown };
  return (
    (Object.prototype.hasOwnProperty.call(request, "contextRefs") && request.contextRefs !== undefined) ||
    preparedWithSnapshot.routedContextSnapshot !== undefined
  );
}

function assertIntegrationTurnHasNoRoutedContext(
  prepared: PreparedAgentChatTurn,
  input: Partial<ChatSendMessageRequest>,
): void {
  if (chatTurnCarriesRoutedContext(prepared, input)) {
    throw new Error(
      "Routed Chat context requires an LLM binding with durable admission and cannot use integration delivery.",
    );
  }
}

export async function consumePreparedAgentChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  options?: PreparedAgentChatTurnDispatchOptions,
): Promise<ChatSendMessageResponse> {
  let assistantMessage: ChatMessageRecord | undefined;
  let trace: ChatTurnTraceRecord | undefined;
  let citations: ChatCitationRecord[] = [];
  const useDurableExecution = shouldUseDurableExecution(host, prepared, input, options?.requireDurableExecution);
  let launchedDurableRunId: string | undefined;
  if (useDurableExecution) {
    launchedDurableRunId = launchPreparedAgentChatTurnStream(
      host,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
      options,
    );
  } else {
    options?.assertDispatchOwnership?.();
    const admit = () => {
      persistPreparedChatCapabilityAdmission(host.storage, prepared);
      persistInitialChatTurnTrace({ chatTurnTraces: host.storage.chatTurnTraces }, prepared, input);
      activatePreparedAlternativeBranch(host, prepared);
    };
    host.storage.runImmediateTransaction(admit);
    options?.mutationLifecycle?.markCommitted();
  }
  // Wire the external abort signal to both the in-process turn controller
  // (used by the inline orchestration path that registers via
  // `beginActiveChatTurnExecution`) and, when running durable, the
  // durable-kernel cancel API. For durable runs the worker may execute on
  // another node; calling `cancelDurableChatRun` is a soft cancel that
  // tells the kernel to stop, while aborting the local controller lets
  // the parent's await-loop bail out promptly via `ChatTurnCancelledError`.
  const detachAbortListener = bindConsumeAbortToTurn(host, prepared.turnId, launchedDurableRunId, options?.abortSignal);
  try {
    const source: AsyncGenerator<InspectableChatStreamChunk> = useDurableExecution
      ? host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
          liveTail: true,
          returnOnDurableInterrupt: true,
        })
      : chatTurnStreamService.streamPreparedAgentChatTurn(
          host,
          sessionId,
          input,
          prepared,
          threadEventType,
          resolvedOrchestration,
          options?.abortSignal ? { abortSignal: options.abortSignal } : undefined,
        );
    for await (const chunk of source) {
      if (chunk.type === "message_done") {
        assistantMessage = {
          messageId: chunk.messageId,
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: chunk.content,
          timestamp: new Date().toISOString(),
        };
      } else if (chunk.type === "trace_update") {
        trace = chunk.trace;
      } else if (chunk.type === "citation") {
        citations = dedupeChatCitations([...citations, chunk.citation]);
      }
    }
    const dedupedTraceCitations = dedupeChatCitations(trace?.citations ?? []);
    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "llm",
      model: trace?.model ?? input.model ?? prepared.prefs.model,
      turnId: prepared.turnId,
      trace: trace ? { ...trace, citations: dedupedTraceCitations } : trace,
      citations: dedupeChatCitations(citations),
      routing: trace?.routing,
    };
  } finally {
    detachAbortListener?.();
  }
}

function bindConsumeAbortToTurn(
  host: ChatTurnDispatchHost,
  turnId: string,
  durableRunId: string | undefined,
  externalSignal: AbortSignal | undefined,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  const fire = (): void => {
    // Soft-cancel the durable kernel run first so the worker stops
    // promptly; the failure handler in `executePreparedAgentChatTurnBackground`
    // then settles the trace. Cancellation faults are swallowed because the
    // parent's local controller abort below still ensures this caller
    // returns control to its parent.
    if (durableRunId && host.cancelDurableChatRun) {
      try {
        host.cancelDurableChatRun(durableRunId, "abort_signal");
      } catch {
        // best effort: cancel API may reject if the run already terminated
      }
    }
    // Abort the in-process controller registered by `beginActiveChatTurnExecution`
    // so `streamPreparedAgentChatTurn` and the orchestration's nested calls
    // observe the abort and bail out via `ChatTurnCancelledError`.
    const active = host.getActiveChatTurnExecution(turnId);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort();
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

export async function executePreparedAgentChatTurnBackground(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  durableRunId: string | undefined,
  resolvedOrchestration: PreparedChatExecutionPlanResolution | undefined,
  options: {
    streamRegistration: ActiveChatTurnStreamExecution;
    skipMessageStart?: boolean;
    abortSignal?: AbortSignal;
    durableLeaseOwnerId?: string;
    mutationLifecycle?: ChatStreamMutationLifecycle;
  },
): Promise<void> {
  let preserveForDurableRecovery = false;
  let authoritativeAccountingFault: Error | undefined;
  let authoritativeAccountingFinalTrace: ChatTurnTraceRecord | undefined;
  const canonicalWriteFence = buildDurableChatCanonicalWriteFence(host, prepared, durableRunId, options);
  try {
    for await (const rawChunk of chatTurnStreamService.streamPreparedAgentChatTurn(
      host,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
      {
        ...options,
        ...(canonicalWriteFence ? { canonicalWriteFence } : {}),
        ...(durableRunId ? { deferGeneralPostCommit: true } : {}),
      },
    )) {
      const chunk =
        rawChunk.type === "trace_update" && durableRunId
          ? {
              ...rawChunk,
              trace: {
                ...rawChunk.trace,
                durable: {
                  runId: durableRunId,
                  status: host.storage.durableRuns.getRun(durableRunId).status,
                  checkpointKind: rawChunk.trace.durable?.checkpointKind ?? "run_started",
                },
              },
            }
          : rawChunk;
      if (isPersistableChatStreamChunk(chunk)) {
        host.persistChatStreamChunk(chunk, durableRunId, options.streamRegistration);
      }
    }
  } catch (error) {
    if (error instanceof ChatTurnStreamRegistrationMismatchError) {
      throw error;
    }
    if (isAuthoritativeModelUsageAccountingError(error)) {
      const accountingError = error as Error;
      authoritativeAccountingFault = accountingError;
      const operatorMessage = `${accountingError.message}. Same-generation retry is blocked; reconcile canonical model usage state before continuing.`;
      // The accounting error is the canonical failure. Trace/realtime
      // projection is valuable evidence, but a storage outage here must not
      // replace that exact error and accidentally make the turn retryable.
      try {
        options.streamRegistration.requireActive(prepared.turnId);
        host.recordDevDiagnostic({
          level: "warn",
          category: "chat",
          event: "chat.dispatch.accounting_persistence_failed",
          message: "Chat turn stopped on an authoritative model-usage accounting fault",
          sessionId,
          turnId: prepared.turnId,
          runId: durableRunId,
          taskId: prepared.content ? `chat-turn:${prepared.turnId}` : undefined,
          providerId: input.providerId ?? prepared.prefs.providerId,
          modelId: input.model ?? prepared.prefs.model,
          runtimeKind: "chat.dispatch",
          runtimeStatus: "failed",
          runtimeError: {
            name: accountingError.name,
            message: accountingError.message,
            retryable: false,
          },
          context: {
            durableRunId,
            sameGenerationRetryBlocked: true,
            reconciliationRequired: true,
            accountingErrorName: accountingError.name,
          },
        });
        let accountingFailureResult: ReturnType<typeof tryPatchChatTurnTraceIfStatus> | undefined;
        try {
          const currentTrace = host.storage.chatTurnTraces.get(prepared.turnId);
          const accountingFailurePatch: Partial<ChatTurnTraceRecord> = {
            status: "failed",
            finishedAt: new Date().toISOString(),
            failure: {
              failureClass: "unknown",
              message: operatorMessage,
              retryable: false,
              provider: {
                type: "model_usage_accounting_authoritative",
                message: accountingError.message,
              },
            },
            completion: {
              finishReason: currentTrace.completion?.finishReason,
              status: "interrupted",
              repaired: Boolean(currentTrace.completion?.repaired),
            },
          };
          // Carry the failed projection in memory before touching storage. If
          // the patch itself fails, durable finalization must never infer
          // completion from the stale running trace it can still read.
          authoritativeAccountingFinalTrace = {
            ...currentTrace,
            ...accountingFailurePatch,
          } as ChatTurnTraceRecord;
          accountingFailureResult = tryPatchChatTurnTraceIfStatus(
            host.storage.chatTurnTraces,
            prepared.turnId,
            CHAT_TURN_ACTIVE_STATUSES,
            accountingFailurePatch,
          );
          if (accountingFailureResult.patched) {
            authoritativeAccountingFinalTrace = accountingFailureResult.trace;
          }
        } catch (lookupError) {
          if (!(lookupError instanceof NotFoundError)) {
            throw lookupError;
          }
        }
        if (accountingFailureResult?.patched) {
          host.persistChatStreamChunk(
            {
              type: "trace_update",
              sessionId,
              turnId: prepared.turnId,
              trace: host.createHydratedChatTurnTrace(prepared.turnId, accountingFailureResult.trace),
            },
            durableRunId,
            options.streamRegistration,
          );
        }
        if (!accountingFailureResult || accountingFailureResult.patched) {
          host.persistChatStreamChunk(
            {
              type: "error",
              sessionId,
              turnId: prepared.turnId,
              error: operatorMessage,
            },
            durableRunId,
            options.streamRegistration,
          );
        }
      } catch (projectionError) {
        // eslint-disable-next-line no-console
        console.error("Failed to project authoritative model-usage accounting fault", projectionError);
      }
      throw error;
    }
    const cancellation = readDurableCancellation(options.abortSignal, error);
    if (cancellation) {
      preserveForDurableRecovery = true;
      options.streamRegistration.requireActive(prepared.turnId);
      let cancellationResult: ReturnType<typeof tryPatchChatTurnTraceIfStatus> | undefined;
      try {
        const currentTrace = host.storage.chatTurnTraces.get(prepared.turnId);
        cancellationResult = tryPatchChatTurnTraceIfStatus(
          host.storage.chatTurnTraces,
          prepared.turnId,
          CHAT_TURN_ACTIVE_STATUSES,
          {
            status: "cancelled",
            finishedAt: new Date().toISOString(),
            completion: {
              finishReason: currentTrace.completion?.finishReason,
              status: "interrupted",
              repaired: Boolean(currentTrace.completion?.repaired),
            },
            ...(durableRunId
              ? {
                  durable: {
                    runId: durableRunId,
                    status: "cancelled",
                    checkpointKind: "run_cancelled",
                  },
                }
              : {}),
          },
        );
      } catch (lookupError) {
        if (!(lookupError instanceof NotFoundError)) {
          throw lookupError;
        }
      }
      if (cancellationResult?.patched) {
        host.persistChatStreamChunk(
          {
            type: "trace_update",
            sessionId,
            turnId: prepared.turnId,
            trace: host.createHydratedChatTurnTrace(prepared.turnId, cancellationResult.trace),
          },
          durableRunId,
          options.streamRegistration,
        );
      }
      throw cancellation;
    }
    if (isExactSystemHeartbeatApprovalBlock(prepared, durableRunId, error)) {
      options.streamRegistration.requireActive(prepared.turnId);
      const currentTrace = host.storage.chatTurnTraces.get(prepared.turnId);
      tryPatchChatTurnTraceIfStatus(host.storage.chatTurnTraces, prepared.turnId, CHAT_TURN_ACTIVE_STATUSES, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        failure: {
          failureClass: "approval_required",
          message: "System heartbeat tool execution was blocked because interactive approval is forbidden.",
          retryable: false,
        },
        completion: {
          finishReason: currentTrace.completion?.finishReason,
          status: "interrupted",
          repaired: Boolean(currentTrace.completion?.repaired),
        },
      });
      return;
    }
    const interruption = readDurableRecoveryInterruption(options.abortSignal, error);
    if (interruption) {
      preserveForDurableRecovery = true;
      throw interruption;
    }
    options.streamRegistration.requireActive(prepared.turnId);
    host.recordDevDiagnostic({
      level: "warn",
      category: "chat",
      event: "chat.dispatch.background_failed",
      message: "Chat turn background execution failed",
      sessionId,
      turnId: prepared.turnId,
      runId: durableRunId,
      taskId: prepared.content ? `chat-turn:${prepared.turnId}` : undefined,
      providerId: input.providerId ?? prepared.prefs.providerId,
      modelId: input.model ?? prepared.prefs.model,
      runtimeKind: "chat.dispatch",
      runtimeStatus: "failed",
      runtimeError: {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : "Chat stream execution failed.",
        retryable: true,
      },
      context: {
        error: error instanceof Error ? error.message : "Chat stream execution failed.",
        durableRunId,
      },
    });
    let failureResult: ReturnType<typeof tryPatchChatTurnTraceIfStatus> | undefined;
    try {
      const currentTrace = host.storage.chatTurnTraces.get(prepared.turnId);
      failureResult = tryPatchChatTurnTraceIfStatus(
        host.storage.chatTurnTraces,
        prepared.turnId,
        CHAT_TURN_ACTIVE_STATUSES,
        {
          status: "failed",
          finishedAt: new Date().toISOString(),
          failure: {
            failureClass: "unknown",
            message: error instanceof Error ? error.message : "Chat stream execution failed.",
            retryable: true,
            recommendedAction: "retry",
          },
          completion: {
            finishReason: currentTrace.completion?.finishReason,
            status: "interrupted",
            repaired: Boolean(currentTrace.completion?.repaired),
          },
        },
      );
    } catch (lookupError) {
      if (!(lookupError instanceof NotFoundError)) {
        throw lookupError;
      }
    }
    if (failureResult?.patched) {
      host.persistChatStreamChunk(
        {
          type: "trace_update",
          sessionId,
          turnId: prepared.turnId,
          trace: host.createHydratedChatTurnTrace(prepared.turnId, failureResult.trace),
        },
        durableRunId,
        options.streamRegistration,
      );
    }
    if (!failureResult || failureResult.patched) {
      host.persistChatStreamChunk(
        {
          type: "error",
          sessionId,
          turnId: prepared.turnId,
          error: error instanceof Error ? error.message : "Chat stream execution failed.",
        },
        durableRunId,
        options.streamRegistration,
      );
    }
  } finally {
    let finalizationFailure: { error: unknown } | undefined;
    try {
      if (options.streamRegistration.isActive()) {
        let finalTrace = authoritativeAccountingFinalTrace;
        if (!finalTrace) {
          try {
            const storedFinalTrace = host.storage.chatTurnTraces.get(prepared.turnId);
            finalTrace = authoritativeAccountingFault
              ? ({
                  ...storedFinalTrace,
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                  failure: {
                    failureClass: "unknown",
                    message: `${authoritativeAccountingFault.message}. Same-generation retry is blocked; reconcile canonical model usage state before continuing.`,
                    retryable: false,
                    provider: {
                      type: "model_usage_accounting_authoritative",
                      message: authoritativeAccountingFault.message,
                    },
                  },
                  completion: {
                    finishReason: storedFinalTrace.completion?.finishReason,
                    status: "interrupted",
                    repaired: Boolean(storedFinalTrace.completion?.repaired),
                  },
                } as ChatTurnTraceRecord)
              : storedFinalTrace;
          } catch (error) {
            if (!(error instanceof NotFoundError)) {
              // eslint-disable-next-line no-console
              console.error("Failed to load chat turn trace during stream finalization", error);
            }
          }
        }
        if (durableRunId && finalTrace && !preserveForDurableRecovery) {
          try {
            host.finalizeDurableChatRun(durableRunId, prepared, finalTrace, options.durableLeaseOwnerId);
          } catch (error) {
            finalizationFailure = { error };
          }
        }
        try {
          options.streamRegistration.complete();
          setTimeout(() => options.streamRegistration.close(), 30_000);
        } catch (error) {
          finalizationFailure ??= { error };
        }
      }
    } catch (error) {
      finalizationFailure = { error };
    }
    if (finalizationFailure) {
      if (!authoritativeAccountingFault) await Promise.reject(finalizationFailure.error);
      // eslint-disable-next-line no-console
      console.error(
        "Failed to finalize chat stream after authoritative model-usage accounting fault",
        finalizationFailure.error,
      );
    }
  }
}

function isExactSystemHeartbeatApprovalBlock(
  prepared: PreparedAgentChatTurn,
  durableRunId: string | undefined,
  error: unknown,
): boolean {
  const posture = prepared.serverOnlyPosture;
  return Boolean(
    error instanceof Error &&
    (error.name === "SystemHeartbeatToolInvocationBlockedError" ||
      error.name === "SystemHeartbeatApprovalRequiredError") &&
    durableRunId &&
    posture?.kind === "system_heartbeat" &&
    posture.actorId === "system-heartbeat" &&
    posture.operation === "chat_system_heartbeat" &&
    posture.durableRunId === durableRunId,
  );
}

export function buildDurableChatCanonicalWriteFence(
  host: ChatTurnDispatchHost,
  prepared: PreparedAgentChatTurn,
  durableRunId: string | undefined,
  options: {
    streamRegistration?: ActiveChatTurnStreamExecution;
    durableLeaseOwnerId?: string;
  },
): chatTurnStreamService.ChatTurnCanonicalWriteFence | undefined {
  const admission = prepared.turnAdmission;
  const assertActiveAdmission = (): void => {
    try {
      host.sessionControlRuntimeOwner.assertActiveTurnWrite(admission!);
    } catch (error) {
      if (
        durableRunId &&
        prepared.serverOnlyPosture?.kind === "system_heartbeat" &&
        prepared.serverOnlyPosture.actorId === "system-heartbeat" &&
        prepared.serverOnlyPosture.operation === "chat_system_heartbeat" &&
        prepared.serverOnlyPosture.durableRunId === durableRunId
      ) {
        const interruption = new DurableWorkerInterruptionError(
          "lease_lost",
          "System heartbeat canonical write authority was superseded.",
        );
        interruption.cause = error;
        throw interruption;
      }
      throw error;
    }
  };
  if (!durableRunId) {
    if (!admission) {
      return undefined;
    }
    return <T>(work: () => T): T =>
      host.storage.runImmediateTransaction(() => {
        assertActiveAdmission();
        const result = work();
        assertActiveAdmission();
        return result;
      });
  }
  if (!admission) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has no immutable mutation admission.`);
  }
  if (!options.streamRegistration) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has no active stream registration.`);
  }
  const expectedLeaseOwnerId = options.durableLeaseOwnerId?.trim();
  return <T>(work: () => T): T => {
    options.streamRegistration!.requireActive(prepared.turnId);
    return host.storage.runImmediateTransaction(() => {
      const requireFreshLease = () => {
        options.streamRegistration!.requireActive(prepared.turnId);
        if (
          !expectedLeaseOwnerId ||
          !host.storage.durableRuns.lockFreshActiveLeaseForUpdate(durableRunId, expectedLeaseOwnerId)
        ) {
          throw new DurableWorkerInterruptionError(
            "lease_lost",
            `Durable Chat worker lost canonical write ownership for run ${durableRunId}; ` +
              `lease ${expectedLeaseOwnerId ?? "missing"} is no longer active.`,
          );
        }
      };
      assertActiveAdmission();
      requireFreshLease();
      const result = work();
      assertActiveAdmission();
      requireFreshLease();
      return result;
    });
  };
}

export function launchPreparedAgentChatTurnStream(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  options?: PreparedAgentChatTurnDispatchOptions,
): string | undefined {
  const backgroundTasks = host.backgroundTasks;
  const durableRequested = shouldUseDurableExecution(host, prepared, input, options?.requireDurableExecution);
  options?.assertDispatchOwnership?.();
  const durableRun = host.beginDurableChatRun(prepared, input, threadEventType, {
    mutationLifecycle: options?.mutationLifecycle,
    runId: options?.durableRunId,
  });
  const streamRegistration = host.registerActiveChatTurnStream(sessionId, prepared.turnId, durableRun?.runId, {
    ...(durableRun ? { reservation: true } : {}),
  });
  const admissionWriteFence = buildDurableChatCanonicalWriteFence(host, prepared, durableRun?.runId, {
    streamRegistration,
  });
  recordChatDispatchDiagnosticSafely(host, {
    level: "info",
    category: "chat",
    event: "chat.dispatch.stream_registered",
    message: "Registered active chat turn stream before dispatch",
    sessionId,
    turnId: prepared.turnId,
    runId: durableRun?.runId,
    taskId: `chat-turn:${prepared.turnId}`,
    providerId: input.providerId ?? prepared.prefs.providerId,
    modelId: input.model ?? prepared.prefs.model,
    runtimeKind: "chat.dispatch",
    runtimeStatus: "started",
    context: {
      durableRequested,
      durableRunId: durableRun?.runId,
      threadEventType,
    },
  });
  if (!durableRun && !durableRequested) {
    const admit = () => {
      persistPreparedChatCapabilityAdmission(host.storage, prepared);
      persistInitialChatTurnTrace({ chatTurnTraces: host.storage.chatTurnTraces }, prepared, input);
      activatePreparedAlternativeBranch(host, prepared);
    };
    if (admissionWriteFence) {
      admissionWriteFence(admit);
    } else if (typeof host.storage.runImmediateTransaction === "function") {
      host.storage.runImmediateTransaction(admit);
    } else {
      if (prepared.capabilityProfile) {
        throw new Error("Chat capability admission requires a storage transaction boundary.");
      }
      admit();
    }
    options?.mutationLifecycle?.markCommitted();
  }
  if (durableRun) {
    options?.onChildDurableRunLaunched?.(durableRun.runId);
    return durableRun.runId;
  }
  if (durableRequested) {
    if (
      admissionWriteFence
        ? admissionWriteFence(() => persistDurableUnavailableFailure(host, sessionId, prepared, streamRegistration))
        : persistDurableUnavailableFailure(host, sessionId, prepared, streamRegistration)
    ) {
      options?.mutationLifecycle?.markCommitted();
    }
    return undefined;
  }
  const task = executePreparedAgentChatTurnBackground(
    host,
    sessionId,
    input,
    prepared,
    threadEventType,
    undefined,
    resolvedOrchestration,
    {
      streamRegistration,
      ...(options?.mutationLifecycle ? { mutationLifecycle: options.mutationLifecycle } : {}),
    },
  );
  trackBackgroundTask(backgroundTasks, task);
  return undefined;
}

function persistDurableUnavailableFailure(
  host: ChatTurnDispatchHost,
  sessionId: string,
  prepared: PreparedAgentChatTurn,
  streamRegistration: ActiveChatTurnStreamExecution,
): boolean {
  let mutationCommitted = false;
  try {
    recordChatDispatchDiagnosticSafely(host, {
      level: "warn",
      category: "chat",
      event: "chat.dispatch.durable_unavailable",
      message: "Durable chat dispatch failed before provider execution",
      sessionId,
      turnId: prepared.turnId,
      taskId: `chat-turn:${prepared.turnId}`,
      providerId: prepared.prefs.providerId,
      modelId: prepared.prefs.model,
      runtimeKind: "chat.dispatch",
      runtimeStatus: "failed",
      runtimeError: {
        message: "Durable execution could not start for this shipped operator surface.",
        retryable: false,
      },
      context: {
        failureClass: "durable_unavailable",
        providerCallStarted: false,
      },
    });
    let currentTrace: ChatTurnTraceRecord;
    try {
      currentTrace = host.storage.chatTurnTraces.get(prepared.turnId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
      return false;
    }
    const failureResult = tryPatchChatTurnTraceIfStatus(
      host.storage.chatTurnTraces,
      prepared.turnId,
      CHAT_TURN_ACTIVE_STATUSES,
      {
        status: "failed",
        finishedAt: new Date().toISOString(),
        failure: {
          failureClass: "unknown",
          message: "Durable execution could not start for this shipped operator surface.",
          retryable: false,
          recommendedAction: "check_gateway_connection",
        },
        completion: {
          finishReason: currentTrace.completion?.finishReason ?? "error",
          status: "interrupted",
          repaired: Boolean(currentTrace.completion?.repaired),
        },
      },
    );
    if (failureResult.patched) {
      mutationCommitted = true;
      host.persistChatStreamChunk(
        {
          type: "trace_update",
          sessionId,
          turnId: prepared.turnId,
          trace: host.createHydratedChatTurnTrace(prepared.turnId, failureResult.trace),
        },
        undefined,
        streamRegistration,
      );
      host.persistChatStreamChunk(
        {
          type: "error",
          sessionId,
          turnId: prepared.turnId,
          error: "durable_unavailable: shipped Chat/Cowork/Code sends must allocate a durable run before execution.",
        },
        undefined,
        streamRegistration,
      );
    }
    return mutationCommitted;
  } finally {
    streamRegistration.complete();
    setTimeout(() => streamRegistration.close(), 30_000);
  }
}

export async function sendPreparedIntegrationChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: Partial<ChatSendMessageRequest>,
  prepared: PreparedAgentChatTurn,
  binding: ChatSessionBindingRecord,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  options?: { abortSignal?: AbortSignal; mutationLifecycle?: ChatStreamMutationLifecycle },
): Promise<ChatSendMessageResponse> {
  assertIntegrationTurnHasNoRoutedContext(prepared, input);
  const startedAt = new Date().toISOString();
  const storage = host.storage;
  const controller = host.beginActiveChatTurnExecution(sessionId, prepared.turnId, "integration-send");
  const detachAbortListener = bindAbortSignalToController(options?.abortSignal, controller);
  let deliveryCommitted = false;
  let deliveryEvidence: IntegrationDeliveryEvidence = {};
  let traceCreated = false;
  const canonicalWriteFence = buildDurableChatCanonicalWriteFence(host, prepared, undefined, {});
  const fencedWrite = <T>(work: () => T): T => (canonicalWriteFence ? canonicalWriteFence(work) : work());
  try {
    const admit = () => {
      persistPreparedChatCapabilityAdmission(storage, prepared);
      storage.chatTurnTraces.create({
        turnId: prepared.turnId,
        sessionId,
        userMessageId: prepared.userEventId,
        parentTurnId: prepared.parentTurnId,
        branchKind: prepared.branchKind,
        sourceTurnId: prepared.sourceTurnId,
        status: "running",
        mode: resolvePreparedTurnMode(prepared),
        webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
        memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
        thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
        speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
        subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
        effectiveToolAutonomy: prepared.effectiveToolAutonomy,
        model: prepared.capabilityProfile?.selection.effectiveModel ?? input.model ?? prepared.prefs.model,
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
        },
        startedAt,
      });
      activatePreparedAlternativeBranch(host, prepared);
    };
    if (canonicalWriteFence) {
      canonicalWriteFence(admit);
    } else if (typeof storage.runImmediateTransaction === "function") {
      storage.runImmediateTransaction(admit);
    } else {
      if (prepared.capabilityProfile) {
        throw new Error("Chat capability admission requires a storage transaction boundary.");
      }
      admit();
    }
    traceCreated = true;
    options?.mutationLifecycle?.markCommitted();
    assertIntegrationCompletionWritable(host, prepared.turnId, controller.signal, deliveryCommitted);
    if (!binding.connectionId || !binding.target) {
      throw new Error("Integration binding is missing connectionId or target");
    }
    if (!binding.writable) {
      throw new Error("Session binding is not writable");
    }
    fencedWrite(() => host.ensureSessionInternalToolGrant(sessionId, "channel.send", "system-integration-compose"));
    fencedWrite(() => undefined);
    const deliveryResult = host.requireExecutedToolResult(
      "channel.send",
      await host.commsSend({
        connectionId: binding.connectionId,
        target: binding.target,
        message: prepared.content,
        sessionId,
        workspaceId: prepared.workspaceId,
        agentId: input.operatorId ?? input.authActorId ?? "operator",
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        taskId: input.policyTaskId,
        runId: input.policyRunId,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
        surface: input.mode ?? resolvePreparedTurnMode(prepared),
        signal: controller.signal,
      }),
    );
    deliveryEvidence = readIntegrationDeliveryEvidence(deliveryResult);
    deliveryCommitted = true;
    assertIntegrationCompletionWritable(host, prepared.turnId, controller.signal, deliveryCommitted);
    const assistantContent = `Delivered via integration ${binding.connectionId} to ${binding.target}.`;
    const assistantMessageId = prepared.assistantMessageId;
    const completionPatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
      assistantMessageId,
      status: "completed",
      finishedAt: new Date().toISOString(),
      retrieval: prepared.retrievalTrace,
      reflection: {
        attempted: false,
        attemptCount: 0,
        outcome: "not_needed",
      },
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
      citations: [],
    };
    let trace: ChatTurnTraceRecord | undefined;
    await host.ingestEvent(
      randomUUID(),
      {
        eventId: assistantMessageId,
        route: prepared.route,
        actor: {
          type: "system",
          id: "integration",
        },
        message: {
          role: "assistant",
          content: assistantContent,
        },
      },
      {
        onCommit: () => {
          trace = fencedWrite(() =>
            patchChatTurnTraceIfStatus(storage.chatTurnTraces, prepared.turnId, ["running"], completionPatch),
          );
        },
      },
    );
    trace ??= fencedWrite(() =>
      patchChatTurnTraceIfStatus(storage.chatTurnTraces, prepared.turnId, ["running", "completed"], completionPatch),
    );
    const assistantMessage: ChatMessageRecord = {
      messageId: assistantMessageId,
      sessionId,
      role: "assistant",
      actorType: "system",
      actorId: "integration",
      content: assistantContent,
      timestamp: new Date().toISOString(),
    };
    const hydratedTrace: ChatTurnTraceRecord = {
      ...trace,
      toolRuns: [],
      citations: [],
    };
    fencedWrite(() => host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, prepared.turnId));
    host.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: threadEventType,
        sessionId,
        turnId: prepared.turnId,
        activeLeafTurnId: prepared.turnId,
      },
      buildChatTurnRealtimeOptions({ sessionId, turnId: prepared.turnId }),
    );
    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "integration",
      turnId: prepared.turnId,
      trace: hydratedTrace,
      citations: [],
      routing: hydratedTrace.routing,
    };
  } catch (error) {
    if (!traceCreated) {
      throw error;
    }
    let currentTrace: ChatTurnTraceRecord | undefined;
    try {
      currentTrace = storage.chatTurnTraces.get(prepared.turnId);
    } catch {
      currentTrace = undefined;
    }
    if (controller.signal.aborted || currentTrace?.status === "cancelled") {
      if (currentTrace?.status !== "cancelled") {
        host.markChatTurnCancelled(sessionId, prepared.turnId);
      }
      if (deliveryCommitted) {
        throw new IntegrationDeliveryPostCommitError(prepared.turnId, deliveryEvidence, error);
      }
      throw error;
    }
    if (deliveryCommitted) {
      try {
        tryPatchChatTurnTraceIfStatus(storage.chatTurnTraces, prepared.turnId, CHAT_TURN_ACTIVE_STATUSES, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          failure: {
            failureClass: "unknown",
            message: "Integration delivery committed, but local Chat bookkeeping requires reconciliation.",
            retryable: false,
            recommendedAction: "check_gateway_connection",
            provider: {
              status: deliveryEvidence.deliveryStatus ?? deliveryEvidence.status,
              responseId: deliveryEvidence.providerMessageId ?? deliveryEvidence.deliveryId,
              type: "integration_delivery_committed",
            },
          },
          retrieval: prepared.retrievalTrace,
          reflection: {
            attempted: false,
            attemptCount: 0,
            outcome: "not_needed",
          },
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
          citations: [],
        });
      } catch {
        // The external side effect is already canonical. Preserve committed
        // error truth even when the local reconciliation marker cannot write.
      }
      recordChatDispatchDiagnosticSafely(host, {
        level: "warn",
        category: "chat",
        event: "chat.integration_delivery.bookkeeping_failed",
        message: "Integration delivery committed before local Chat bookkeeping failed",
        sessionId,
        turnId: prepared.turnId,
        runtimeKind: "chat.integration_delivery",
        runtimeStatus: "failed",
        runtimeError: {
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
        context: {
          deliveryCommitted: true,
          reconciliationRequired: true,
          ...deliveryEvidence,
        },
      });
      throw new IntegrationDeliveryPostCommitError(prepared.turnId, deliveryEvidence, error);
    }
    fencedWrite(() =>
      tryPatchChatTurnTraceIfStatus(storage.chatTurnTraces, prepared.turnId, CHAT_TURN_ACTIVE_STATUSES, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        retrieval: prepared.retrievalTrace,
        reflection: {
          attempted: false,
          attemptCount: 0,
          outcome: "not_needed",
        },
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
        citations: [],
      }),
    );
    throw error;
  } finally {
    detachAbortListener?.();
    host.endActiveChatTurnExecution(prepared.turnId, controller);
  }
}

function activatePreparedAlternativeBranch(host: ChatTurnDispatchHost, prepared: PreparedAgentChatTurn): void {
  if (prepared.branchKind !== "retry" && prepared.branchKind !== "edit") {
    return;
  }
  host.updateActiveLeafOrThrow(prepared.session.sessionId, prepared.branchSelectionBaseTurnId, prepared.turnId);
}

function recordChatDispatchDiagnosticSafely(
  host: Pick<ChatTurnDispatchHost, "recordDevDiagnostic">,
  input: Parameters<ChatTurnDispatchHost["recordDevDiagnostic"]>[0],
): void {
  try {
    host.recordDevDiagnostic(input);
  } catch {
    // Diagnostic sinks are observability-only and must never seize execution
    // or stream-cleanup ownership from the canonical Chat path.
    return;
  }
}

function readIntegrationDeliveryEvidence(result: unknown): IntegrationDeliveryEvidence {
  const evidence: IntegrationDeliveryEvidence = {};
  if (!result || typeof result !== "object") {
    return evidence;
  }
  for (const key of ["status", "deliveryStatus", "deliveryId", "providerMessageId", "idempotencyKey"] as const) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      evidence[key] = value.trim();
    }
  }
  return evidence;
}

function bindAbortSignalToController(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  const abort = (): void => controller.abort();
  if (externalSignal.aborted) {
    abort();
    return undefined;
  }
  externalSignal.addEventListener("abort", abort);
  return () => externalSignal.removeEventListener("abort", abort);
}

function assertIntegrationCompletionWritable(
  host: Pick<ChatTurnDispatchHost, "storage">,
  turnId: string,
  signal: AbortSignal,
  deliveryCommitted: boolean,
): void {
  let status: ChatTurnTraceRecord["status"] | undefined;
  try {
    status = host.storage.chatTurnTraces.get(turnId).status;
  } catch {
    status = undefined;
  }
  if (signal.aborted || status === "cancelled") {
    if (deliveryCommitted) {
      throw new Error(
        `Chat turn ${turnId} was cancelled after integration delivery; the external delivery may already be committed.`,
      );
    }
    throw new ChatTurnCancelledError(turnId);
  }
  if (status && status !== "running") {
    throw new Error(`Chat turn ${turnId} integration completion lost lifecycle ownership to ${status}.`);
  }
}

export async function* streamPreparedIntegrationChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: Partial<ChatSendMessageRequest>,
  prepared: PreparedAgentChatTurn,
  binding: ChatSessionBindingRecord,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  options?: { abortSignal?: AbortSignal; mutationLifecycle?: ChatStreamMutationLifecycle },
): AsyncGenerator<ChatStreamChunkDraft> {
  assertIntegrationTurnHasNoRoutedContext(prepared, input);
  yield {
    type: "message_start",
    sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
    parentTurnId: prepared.parentTurnId,
    branchKind: prepared.branchKind,
    sourceTurnId: prepared.sourceTurnId,
  };
  const response = await sendPreparedIntegrationChatTurn(
    host,
    sessionId,
    input,
    prepared,
    binding,
    threadEventType,
    options,
  );
  const content = response.assistantMessage?.content ?? "";
  for (const delta of splitIntoChunks(content, 120)) {
    yield {
      type: "delta",
      sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      delta,
    };
  }
  yield {
    type: "message_done",
    sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
    content,
    repaired: Boolean(response.trace?.completion?.repaired),
  };
  yield {
    type: "trace_update",
    sessionId,
    turnId: prepared.turnId,
    trace: response.trace!,
  };
  yield {
    type: "done",
    sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
  };
}
