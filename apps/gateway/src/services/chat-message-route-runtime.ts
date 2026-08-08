import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChatMessageRecord,
  ChatThreadSystemNoticeRecord,
  ChatTimerRecord,
  ChatTurnTraceRecord,
  ChatThreadResponse,
  ChatUserInputPromptAnswerResponse,
  ChatUserInputPromptResponse,
  ContextManifestDetail,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { canonicalJsonString, ConflictError, ValidationError } from "@goatcitadel/contracts";
import type {
  DurableChatRuntimeConfigurationReceipt,
  DurableChatUserInputAdmissionIdentity,
  DurableChatUserInputResponderAuthSource,
  ReserveDurableChatSecureConfigurationOutcome,
  AsyncStorage as Storage,
} from "@goatcitadel/storage";
import { buildChatThreadResponse, resolveNewestLeafTurnId } from "./chat-thread-utils.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";
import type { DurableRunService } from "./durable-run-service.js";
import { parseDurableChatTurnPayload } from "./durable-execution-service.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY,
  HEARTBEAT_DECISION_RECEIPT_METADATA_KEY,
  buildHeartbeatDecisionReceipt,
  hashChatTurnRuntimeAuthorityValue,
  hashHeartbeatDecisionUtf8,
  readChatTurnRuntimeAuthoritySeal,
  verifyAutonomousChatAdmissionRunMetadata,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
} from "./chat-durable-runtime-authority.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import { projectChatMessageForPublic, projectChatTurnTraceForPublic } from "./chat-secret-projection.js";
import {
  buildWorkspaceFileDownloadHref,
  getExecutedWorkspaceFileWriteReceipt,
  mergeWorkspaceFileDownloadContent,
} from "./chat-turn-agent-runner/artifact-write-helpers.js";
import { MAX_INLINE_FILE_DOWNLOAD_BYTES } from "./files-route-service.js";

export interface ChatThreadLoadOptions {
  includeDecisionTrace?: boolean;
  /** Internal only: keeps retained system runs out of Chat branch hydration. */
  isConversationTrace?: (trace: ChatTurnTraceRecord) => boolean;
}

export interface ChatMessageRouteRuntimeHost {
  readonly config?: {
    rootDir: string;
    assistant: { workspaceDir: string };
  };
  readonly storage: Storage;
  readonly durableRunService: Pick<DurableRunService, "getDurableRun" | "requestRunProcessing">;
  getSession(sessionId: string): unknown | Promise<unknown>;
  loadChatTurnSessionState(sessionId: string, options?: ChatThreadLoadOptions): Promise<ChatTurnSessionState>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
  configureRuntimeTarget?(input: {
    targetId: string;
    secret: string;
    requestId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    actorId: string;
    expiresAt: string;
    operatorId?: string;
    authActorSource?: ChatUserInputPromptResponder["authActorSource"];
    runId?: string;
    taskId?: string;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    approvedAction?: {
      approvalId: string;
      toolRunId: string;
      promptId: string;
    };
  }): Promise<{
    targetId: string;
    provider: string;
    revision: string;
    scopeRef: string;
  }>;
  getRuntimeConfigurationScopeRef?(targetId: string): string;
  finalizeRuntimeConfiguration?(requestId: string): void | Promise<void>;
  rollbackRuntimeConfiguration?(requestId: string): Promise<void>;
}

export interface ChatUserInputPromptResponder {
  actorId: string;
  authActorSource: DurableChatUserInputResponderAuthSource;
}

export async function getChatThread(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  options: ChatThreadLoadOptions = {},
): Promise<ChatThreadResponse> {
  await runtime.getSession(sessionId);
  const state = await runtime.loadChatTurnSessionState(sessionId, {
    includeDecisionTrace: options.includeDecisionTrace === true,
  });
  return await buildChatThreadFromState(runtime, sessionId, state);
}

export async function selectChatBranchTurn(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
): Promise<ChatThreadResponse> {
  await runtime.getSession(sessionId);
  const loadOptions: ChatThreadLoadOptions = {};
  const state = await runtime.loadChatTurnSessionState(sessionId, loadOptions);
  const target = state.traces.find((trace) => trace.turnId === turnId && state.messagesById.has(trace.userMessageId));
  if (!target) {
    throw new Error(`Chat turn ${turnId} not found in session ${sessionId}`);
  }
  if (await hasExactSystemHeartbeatRunIdentity(runtime, target)) {
    throw new Error(`Chat turn ${turnId} not found in session ${sessionId}`);
  }
  const newestLeafTurnId = resolveNewestLeafTurnId(
    turnId,
    new Map(
      state.traces.map((trace) => [
        trace.turnId,
        {
          turnId: trace.turnId,
          startedAtMs: Date.parse(trace.startedAt) || 0,
        },
      ]),
    ),
    state.childrenByTurnId,
  );
  await runtime.storage.chatSessionBranchState.setActiveLeaf(sessionId, newestLeafTurnId);
  const nextState = await runtime.loadChatTurnSessionState(sessionId, loadOptions);
  await runtime.publishRealtime(
    "chat_thread_updated",
    "chat",
    {
      type: "chat_thread_branch_selected",
      sessionId,
      turnId,
      activeLeafTurnId: newestLeafTurnId,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: {
        sessionId,
        turnId,
      },
    },
  );
  return await buildChatThreadFromState(runtime, sessionId, {
    ...nextState,
    activeLeafTurnId: newestLeafTurnId,
  });
}

export async function getTurnContextManifestForSession(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
): Promise<ContextManifestDetail | undefined> {
  const normalizedSessionId = sessionId.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  if (!normalizedTurnId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "turnId" });
  }
  const trace = await runtime.storage.chatTurnTraces.get(normalizedTurnId);
  if (trace.sessionId !== normalizedSessionId) {
    throw new Error(`Chat turn ${normalizedTurnId} does not belong to session ${normalizedSessionId}`);
  }
  return await runtime.storage.contextManifests.maybeGetDetailByTurn(normalizedTurnId);
}

export async function answerChatUserInputPrompt(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
  promptId: string,
  response: ChatUserInputPromptResponse,
  responder: ChatUserInputPromptResponder,
): Promise<ChatUserInputPromptAnswerResponse> {
  await runtime.getSession(sessionId);
  const trace = await runtime.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  const durableRunId = trace.durable?.runId;
  if (!durableRunId) {
    throw new ConflictError({
      message: `Chat turn ${turnId} cannot be resumed because it is not linked to a durable run.`,
    });
  }
  const durableRun = await runtime.durableRunService.getDurableRun(durableRunId);
  const durablePayload = parseDurableChatTurnPayload(durableRun);
  if (!durablePayload) {
    throw new ConflictError({
      message: `Durable run ${durableRunId} is missing a valid chat turn payload.`,
    });
  }
  if (durablePayload.sessionId !== sessionId || durablePayload.turnId !== turnId) {
    throw new ConflictError({
      message: `Durable run ${durableRunId} belongs to a different Chat turn admission.`,
    });
  }
  const admissionIdentity = {
    admissionId: durablePayload.admissionId,
    sessionIncarnationId: durablePayload.sessionIncarnationId,
    workspaceId: durablePayload.workspaceId,
    sessionId: durablePayload.sessionId,
    turnId: durablePayload.turnId,
    aggregateRevision: durablePayload.admissionAggregateRevision,
    controllerGeneration: durablePayload.admissionControllerGeneration,
    materialSha256: durablePayload.admissionMaterialSha256,
  };

  // Preserve specific request feedback while the turn is still waiting. Once a
  // seal exists the trace is intentionally running/terminal and storage owns
  // exact replay validation, so these checks must not reject a legitimate
  // retry before the immutable seal is consulted.
  let durableResponse: Exclude<ChatUserInputPromptResponse, { kind: "secure_configuration" }>;
  let appliedRuntimeConfigurationRequestId: string | undefined;
  let runtimeConfigurationReceipt: DurableChatRuntimeConfigurationReceipt | undefined;
  let secureReservation: ReserveDurableChatSecureConfigurationOutcome | undefined;
  if (trace.status === "waiting_for_user_input") {
    const prompt = trace.pendingUserInput;
    if (!prompt || prompt.promptId !== promptId) {
      throw new ValidationError({ message: `Prompt ${promptId} is not active for chat turn ${turnId}.` });
    }
    const secureConfiguration = prompt.secureConfiguration;
    if (secureConfiguration) {
      if (response.kind !== "secure_configuration") {
        throw new ValidationError({ message: `Prompt ${promptId} expects a secure configuration response.` });
      }
      const admittedResponderId = durablePayload.requestActor.authActorId ?? durablePayload.requestActor.actorId;
      if (
        responder.actorId !== admittedResponderId ||
        (durablePayload.requestActor.authActorSource !== undefined &&
          responder.authActorSource !== durablePayload.requestActor.authActorSource)
      ) {
        throw new ConflictError({
          message: `Secure configuration prompt ${promptId} must be answered by the operator authority that created it.`,
        });
      }
      const securePromptExpiresAt = prompt.expiresAt ? Date.parse(prompt.expiresAt) : Number.NaN;
      if (!Number.isFinite(securePromptExpiresAt) || securePromptExpiresAt <= Date.now()) {
        throw new ValidationError({ message: `Secure configuration prompt ${promptId} has expired.` });
      }
      if (!runtime.configureRuntimeTarget) {
        throw new ConflictError({ message: "Secure runtime configuration is unavailable on this Gateway." });
      }
      const scopeRef = runtime.getRuntimeConfigurationScopeRef?.(secureConfiguration.targetId);
      if (!scopeRef) {
        throw new ConflictError({ message: "Secure runtime configuration scope is unavailable on this Gateway." });
      }
      secureReservation = await runtime.storage.sessionMutationAdmissions.reserveDurableChatSecureConfiguration({
        admissionIdentity,
        durableRunId,
        expectedWaitingRunVersion: durableRun.version,
        promptId,
        targetId: secureConfiguration.targetId,
        scopeRef,
        responder,
      });
      if (secureReservation.disposition !== "reserved") {
        throw new ConflictError({
          message: `Secure configuration prompt ${promptId} is already being applied by another request.`,
        });
      }
      try {
        runtimeConfigurationReceipt = await runtime.configureRuntimeTarget({
          targetId: secureConfiguration.targetId,
          secret: response.secret,
          requestId: promptId,
          workspaceId: durablePayload.workspaceId,
          sessionId,
          turnId,
          actorId: responder.actorId,
          expiresAt: prompt.expiresAt!,
          operatorId: durablePayload.requestActor.operatorId ?? responder.actorId,
          authActorSource: responder.authActorSource,
          runId: durableRunId,
          ...(durablePayload.request.policyTaskId ? { taskId: durablePayload.request.policyTaskId } : {}),
          ...(durablePayload.request.permissionProfileId
            ? { permissionProfileId: durablePayload.request.permissionProfileId }
            : {}),
          ...(durablePayload.request.localOperatorOverrideId
            ? { localOperatorOverrideId: durablePayload.request.localOperatorOverrideId }
            : {}),
          ...(secureConfiguration.approvedAction ? { approvedAction: secureConfiguration.approvedAction } : {}),
        });
      } catch (error) {
        if (isSafeToReleaseSecureReservation(secureReservation, error)) {
          await releaseSecureConfigurationReservation(
            runtime,
            secureReservation,
            admissionIdentity,
            durableRunId,
            promptId,
            responder,
          );
        }
        throw error;
      }
      appliedRuntimeConfigurationRequestId = promptId;
      durableResponse = secureConfigurationCompletedResponse(runtimeConfigurationReceipt);
    } else if (prompt.kind !== response.kind) {
      throw new ValidationError({ message: `Prompt ${promptId} expects a ${prompt.kind} response.` });
    } else if (response.kind === "single_select") {
      const validOptionIds = new Set((prompt.options ?? []).map((option) => option.optionId));
      if (!validOptionIds.has(response.optionId)) {
        throw new ValidationError({ message: `Option ${response.optionId} is not valid for prompt ${promptId}.` });
      }
      durableResponse = response;
    } else if (response.kind === "text" && response.text.trim().length === 0) {
      throw new ValidationError({ message: `Prompt ${promptId} requires non-empty text.` });
    } else if (response.kind === "text") {
      durableResponse = { kind: "text", text: response.text.trim() };
    } else {
      throw new ValidationError({ message: `Prompt ${promptId} does not accept secure configuration.` });
    }
  } else if (response.kind === "secure_configuration") {
    // A response-delivery retry may arrive after the one-time prompt settled.
    // Replay only the exact durable, secret-free receipt. The newly supplied
    // bytes are intentionally ignored and never compared, hashed, persisted,
    // or sent back through the runtime configuration owner.
    const recordedResponse = durablePayload.userInputResponses?.find((candidate) => candidate.promptId === promptId);
    if (recordedResponse?.response.kind !== "text" || !recordedResponse.runtimeConfigurationReceipt) {
      throw new ConflictError({
        message: `Secure configuration prompt ${promptId} was already consumed or is no longer active.`,
      });
    }
    durableResponse = recordedResponse.response;
    runtimeConfigurationReceipt = recordedResponse.runtimeConfigurationReceipt;
  } else {
    durableResponse = response.kind === "text" ? { kind: "text", text: response.text.trim() } : response;
  }

  let outcome;
  try {
    outcome = await runtime.storage.sessionMutationAdmissions.resolveDurableChatUserInput({
      admissionIdentity,
      durableRunId,
      expectedWaitingRunVersion: secureReservation?.run.version ?? durableRun.version,
      promptId,
      eventKey: "chat.user_input.resolved",
      correlationId: promptId,
      responder,
      response: durableResponse,
      ...(runtimeConfigurationReceipt ? { runtimeConfigurationReceipt } : {}),
    });
  } catch (error) {
    if (appliedRuntimeConfigurationRequestId) {
      await runtime.rollbackRuntimeConfiguration?.(appliedRuntimeConfigurationRequestId);
      if (secureReservation && isSafeToReleaseSecureReservation(secureReservation)) {
        await releaseSecureConfigurationReservation(
          runtime,
          secureReservation,
          admissionIdentity,
          durableRunId,
          promptId,
          responder,
        );
      }
    }
    throw error;
  }
  if (appliedRuntimeConfigurationRequestId) {
    await runtime.finalizeRuntimeConfiguration?.(appliedRuntimeConfigurationRequestId);
  }
  if (outcome.run.status === "queued") {
    runtime.durableRunService.requestRunProcessing(durableRunId);
  }
  if (outcome.disposition === "resolved") {
    runtime.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.user_input_prompt.answered",
      message: "Resolved pending chat user-input prompt",
      sessionId,
      turnId,
      context: {
        promptId,
        responseKind: response.kind,
        runStatus: outcome.run.status,
      },
    });
    await runtime.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_user_input_answered",
        sessionId,
        turnId,
        promptId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId,
          turnId,
        },
      },
    );
  }
  return {
    ok: true,
    sessionId,
    turnId,
    promptId,
    resumed: true,
    resumedTurnId: turnId,
    resumedRunId: durableRunId,
    ...(outcome.disposition === "replayed" ? { replayed: true } : {}),
    ...(runtimeConfigurationReceipt ? { runtimeConfigurationReceipt } : {}),
  };
}

function secureConfigurationCompletedResponse(receipt: {
  targetId: string;
  provider: string;
  revision: string;
  scopeRef: string;
}): { kind: "text"; text: string } {
  return {
    kind: "text",
    text:
      "Secure runtime configuration completed and passed its live probe. " +
      `Target ${receipt.targetId} (${receipt.provider}) is active at revision ${receipt.revision} ` +
      `for installation scope ${receipt.scopeRef}. ` +
      "The credential was stored in the OS keychain and excluded from Chat context.",
  };
}

function isSafeToReleaseSecureReservation(
  outcome: ReserveDurableChatSecureConfigurationOutcome,
  error?: unknown,
): boolean {
  if (outcome.disposition !== "reserved" || outcome.reservation.reclaimedAt || outcome.requiresTargetReconciliation) {
    return false;
  }
  if (!error || typeof error !== "object") return true;
  const details = "details" in error && error.details && typeof error.details === "object" ? error.details : undefined;
  return !(details && "manualReconciliationRequired" in details && details.manualReconciliationRequired === true);
}

async function releaseSecureConfigurationReservation(
  runtime: ChatMessageRouteRuntimeHost,
  outcome: ReserveDurableChatSecureConfigurationOutcome,
  admissionIdentity: DurableChatUserInputAdmissionIdentity,
  durableRunId: string,
  promptId: string,
  responder: ChatUserInputPromptResponder,
): Promise<void> {
  await runtime.storage.sessionMutationAdmissions.releaseDurableChatSecureConfiguration({
    reservationId: outcome.reservation.reservationId,
    admissionIdentity,
    durableRunId,
    promptId,
    targetId: outcome.reservation.targetId,
    scopeRef: outcome.reservation.scopeRef,
    expectedReservedRunVersion: outcome.run.version,
    responder,
  });
}

async function buildChatThreadFromState(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  state: ChatTurnSessionState,
): Promise<ChatThreadResponse> {
  const heartbeatTurnIds = new Set(
    (
      await Promise.all(
        state.traces.map(async (trace) =>
          (await hasExactSystemHeartbeatRunIdentity(runtime, trace)) ? trace.turnId : undefined,
        ),
      )
    ).filter((turnId): turnId is string => Boolean(turnId)),
  );
  const renderableTraces = state.traces.filter(
    (trace) => state.messagesById.has(trace.userMessageId) && !heartbeatTurnIds.has(trace.turnId),
  );
  const heartbeatNotices = (
    await Promise.all(
      state.traces
        .filter((trace) => heartbeatTurnIds.has(trace.turnId))
        .map(async (trace) => await projectExactSystemHeartbeatNotice(runtime, sessionId, state, trace)),
    )
  ).filter((notice): notice is ChatThreadSystemNoticeRecord => Boolean(notice));
  const timerNotices = (
    await Promise.all(
      (await runtime.storage.chatTimers.listFiredBySession(sessionId)).map(
        async (timer) => await projectChatTimerNotice(runtime, sessionId, timer),
      ),
    )
  ).filter((notice): notice is ChatThreadSystemNoticeRecord => Boolean(notice));
  const systemNotices = [...heartbeatNotices, ...timerNotices];
  const generatedArtifactsByTurnId = await runtime.storage.chatGeneratedArtifacts.listByTurnIds(
    renderableTraces.map((trace) => trace.turnId),
  );
  const workspaceFileRootDir = runtime.config
    ? path.resolve(runtime.config.rootDir, runtime.config.assistant.workspaceDir)
    : undefined;
  const turns = await Promise.all(
    renderableTraces.map(async (trace) => {
      const assistantMessage = projectChatMessageForPublic(
        trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
      );
      return {
        trace: projectChatTurnTraceForPublic(trace),
        userMessage: state.messagesById.get(trace.userMessageId),
        assistantMessage: await projectAssistantWorkspaceFileDownloads(assistantMessage, trace, workspaceFileRootDir),
        generatedArtifacts: (generatedArtifactsByTurnId.get(trace.turnId) ?? []).map(
          chatGeneratedArtifactService.buildGeneratedArtifactReference,
        ),
      };
    }),
  );
  return buildChatThreadResponse({
    sessionId,
    activeLeafTurnId: state.activeLeafTurnId,
    systemNotices,
    turns,
  });
}

async function projectAssistantWorkspaceFileDownloads(
  assistantMessage: ChatMessageRecord | undefined,
  trace: ChatTurnTraceRecord,
  workspaceFileRootDir: string | undefined,
): Promise<ChatMessageRecord | undefined> {
  if (!assistantMessage || !workspaceFileRootDir) {
    return assistantMessage;
  }
  let content = assistantMessage.content;
  for (const toolRun of trace.toolRuns) {
    if (toolRun.sessionId !== trace.sessionId || toolRun.turnId !== trace.turnId) {
      continue;
    }
    const receipt = getExecutedWorkspaceFileWriteReceipt(toolRun);
    if (!receipt) {
      continue;
    }
    const verifiedPath = await resolveLiveWorkspaceDownloadPath(receipt.artifactPath, workspaceFileRootDir);
    if (!verifiedPath) {
      continue;
    }
    content = mergeWorkspaceFileDownloadContent(
      content,
      toolRun,
      buildWorkspaceFileDownloadHref(verifiedPath, workspaceFileRootDir),
    );
  }
  return content === assistantMessage.content ? assistantMessage : { ...assistantMessage, content };
}

async function resolveLiveWorkspaceDownloadPath(
  artifactPath: string,
  workspaceFileRootDir: string,
): Promise<string | undefined> {
  if (!path.isAbsolute(artifactPath)) {
    return undefined;
  }
  try {
    const [realWorkspaceRoot, realArtifactPath] = await Promise.all([
      fs.realpath(workspaceFileRootDir),
      fs.realpath(artifactPath),
    ]);
    const relativePath = path.relative(realWorkspaceRoot, realArtifactPath);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      return undefined;
    }
    const stat = await fs.stat(realArtifactPath);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_INLINE_FILE_DOWNLOAD_BYTES ? realArtifactPath : undefined;
  } catch {
    return undefined;
  }
}

async function projectChatTimerNotice(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  timer: ChatTimerRecord,
): Promise<ChatThreadSystemNoticeRecord | undefined> {
  try {
    if (
      timer.sessionId !== sessionId ||
      timer.status !== "fired" ||
      !timer.firedAt ||
      !timer.noticeMessageId ||
      !timer.notificationEventId
    ) {
      return undefined;
    }
    const message = await runtime.storage.chatMessages.get(timer.noticeMessageId);
    if (
      !message ||
      message.sessionId !== sessionId ||
      message.role !== "assistant" ||
      message.actorType !== "system" ||
      message.actorId !== "chat-timer" ||
      message.content !== timer.message
    ) {
      return undefined;
    }
    const projected = projectChatMessageForPublic(message);
    if (!projected) return undefined;
    return {
      kind: "timer_due",
      noticeId: timer.noticeMessageId,
      turnId: `timer:${timer.timerId}`,
      message: projected,
    };
  } catch {
    return undefined;
  }
}

async function hasExactSystemHeartbeatRunIdentity(
  runtime: ChatMessageRouteRuntimeHost,
  trace: ChatTurnTraceRecord,
): Promise<boolean> {
  try {
    const runId = trace.durable?.runId?.trim();
    if (!runId) return false;
    const run = await runtime.durableRunService.getDurableRun(runId);
    const payload = parseDurableChatTurnPayload(run) as
      | (NonNullable<ReturnType<typeof parseDurableChatTurnPayload>> & {
          heartbeatOccurrenceId?: unknown;
        })
      | undefined;
    if (
      !payload ||
      typeof payload.heartbeatOccurrenceId !== "string" ||
      !payload.heartbeatOccurrenceId.trim() ||
      payload.requestActor.actorKind !== "system" ||
      payload.requestActor.actorId !== "system-heartbeat"
    ) {
      return false;
    }
    verifyAutonomousChatAdmissionRunMetadata(run, { trace });
    return true;
  } catch {
    return false;
  }
}

/**
 * Projects only the exact, fully committed notifying heartbeat shape. Public
 * thread reads are fail-closed: malformed, partial, silent, or drifted
 * evidence is simply absent instead of being upgraded into a visible message.
 */
async function projectExactSystemHeartbeatNotice(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  state: ChatTurnSessionState,
  trace: ChatTurnTraceRecord,
): Promise<ChatThreadSystemNoticeRecord | undefined> {
  try {
    const runId = trace.durable?.runId?.trim();
    const assistantMessageId = trace.assistantMessageId?.trim();
    if (
      !runId ||
      !assistantMessageId ||
      trace.sessionId !== sessionId ||
      trace.status !== "completed" ||
      trace.completion?.status !== "complete" ||
      trace.completion.repaired !== false ||
      Object.keys(trace.completion).sort().join(",") !== "repaired,status" ||
      trace.durable?.status !== "completed" ||
      trace.durable?.checkpointKind !== "run_completed" ||
      state.messagesById.has(trace.userMessageId) ||
      state.activeLeafTurnId === trace.turnId
    ) {
      return undefined;
    }

    const run = await runtime.durableRunService.getDurableRun(runId);
    if (run.runId !== runId || run.workflowKey !== "chat.turn.execute" || run.status !== "completed") {
      return undefined;
    }
    const payload = parseDurableChatTurnPayload(run);
    const heartbeatPayload = payload as
      | (NonNullable<typeof payload> & {
          heartbeatOccurrenceId: string;
          heartbeatClaimSha256: string;
          heartbeatEvaluatedPolicySha256: string;
          heartbeatFrozenObjectiveSha256: string;
        })
      | undefined;
    if (
      !heartbeatPayload ||
      heartbeatPayload.sessionId !== sessionId ||
      heartbeatPayload.turnId !== trace.turnId ||
      heartbeatPayload.userMessageId !== trace.userMessageId ||
      heartbeatPayload.assistantMessageId !== assistantMessageId ||
      heartbeatPayload.requestActor.actorKind !== "system" ||
      heartbeatPayload.requestActor.actorId !== "system-heartbeat" ||
      (await runtime.storage.chatMessages.get(heartbeatPayload.userMessageId))
    ) {
      return undefined;
    }
    verifyAutonomousChatAdmissionRunMetadata(run, { trace });

    const occurrence = await runtime.storage.heartbeatOccurrences.find(heartbeatPayload.heartbeatOccurrenceId);
    if (
      !occurrence ||
      occurrence.state !== "terminal" ||
      occurrence.terminalStatus !== "completed" ||
      !occurrence.terminalAt ||
      !occurrence.terminalHandoffSha256 ||
      !/^[a-f0-9]{64}$/u.test(occurrence.terminalHandoffSha256) ||
      occurrence.workspaceId !== heartbeatPayload.workspaceId ||
      occurrence.sessionId !== sessionId ||
      occurrence.sessionIncarnationId !== heartbeatPayload.sessionIncarnationId ||
      occurrence.admissionId !== heartbeatPayload.admissionId ||
      occurrence.admissionMaterialSha256 !== heartbeatPayload.admissionMaterialSha256 ||
      occurrence.aggregateRevision !== heartbeatPayload.admissionAggregateRevision ||
      occurrence.controllerGeneration !== heartbeatPayload.admissionControllerGeneration ||
      occurrence.systemActorId !== "system-heartbeat" ||
      occurrence.turnId !== heartbeatPayload.turnId ||
      occurrence.userMessageId !== heartbeatPayload.userMessageId ||
      occurrence.assistantMessageId !== heartbeatPayload.assistantMessageId ||
      occurrence.durableRunId !== runId ||
      occurrence.boundDurableRunId !== runId ||
      occurrence.claimSha256 !== heartbeatPayload.heartbeatClaimSha256 ||
      occurrence.evaluatedPolicySha256 !== heartbeatPayload.heartbeatEvaluatedPolicySha256 ||
      occurrence.frozenObjectiveSha256 !== heartbeatPayload.heartbeatFrozenObjectiveSha256 ||
      occurrence.capabilityProfileId !== heartbeatPayload.capabilityProfileId ||
      occurrence.capabilityProfileHash !== heartbeatPayload.capabilityProfileHash
    ) {
      return undefined;
    }

    const terminalHandoff = await runtime.storage.sessionMutationAdmissions.findVerifiedTerminalTurnWriteHandoff({
      admissionId: heartbeatPayload.admissionId,
      workspaceId: heartbeatPayload.workspaceId,
      sessionId,
      sessionIncarnationId: heartbeatPayload.sessionIncarnationId,
      turnId: heartbeatPayload.turnId,
      durableRunId: runId,
      userMessageId: heartbeatPayload.userMessageId,
      assistantMessageId: heartbeatPayload.assistantMessageId,
    });
    if (
      !terminalHandoff ||
      terminalHandoff.durableRunStatus !== "completed" ||
      terminalHandoff.traceStatus !== "completed" ||
      terminalHandoff.handoffSha256 !== occurrence.terminalHandoffSha256
    ) {
      return undefined;
    }

    const rawOutput = run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY];
    const observedReceipt = run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY];
    if (typeof rawOutput !== "string" || observedReceipt === undefined) {
      return undefined;
    }
    const expectedDecision = buildHeartbeatDecisionReceipt({
      occurrenceId: heartbeatPayload.heartbeatOccurrenceId,
      claimSha256: heartbeatPayload.heartbeatClaimSha256,
      rawOutput,
    });
    if (
      !expectedDecision.decision.notify ||
      canonicalJsonString(observedReceipt) !== canonicalJsonString(expectedDecision.receipt)
    ) {
      return undefined;
    }

    const authority = readChatTurnRuntimeAuthoritySeal(run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
    const terminalOutput = authority?.material.terminalOutput;
    if (
      !authority ||
      authority.material.runId !== runId ||
      authority.material.turnId !== trace.turnId ||
      authority.material.transitionKind !== "terminal" ||
      authority.material.durableStatus !== "completed" ||
      authority.material.traceStatus !== "completed" ||
      canonicalJsonString(authority.material.heartbeatDecisionReceipt) !==
        canonicalJsonString(expectedDecision.receipt) ||
      !terminalOutput ||
      terminalOutput.assistantMessageId !== assistantMessageId ||
      terminalOutput.outputTextSha256 !==
        hashChatTurnRuntimeAuthorityValue(expectedDecision.decision.normalizedMessage) ||
      terminalOutput.outputSummarySha256 !==
        hashChatTurnRuntimeAuthorityValue(expectedDecision.decision.normalizedMessage) ||
      expectedDecision.receipt.normalizedMessageSha256 !==
        hashHeartbeatDecisionUtf8(expectedDecision.decision.normalizedMessage) ||
      run.metadata?.outputText !== expectedDecision.decision.normalizedMessage ||
      run.metadata?.outputSummary !== expectedDecision.decision.normalizedMessage ||
      run.metadata?.finalOutput !== expectedDecision.decision.normalizedMessage ||
      run.metadata?.finalSummary !== expectedDecision.decision.normalizedMessage ||
      run.metadata?.outputMessageId !== undefined ||
      run.metadata?.outputTraceStatus !== undefined
    ) {
      return undefined;
    }

    const checkpoint = await runtime.storage.durableRuns.getLatestCheckpointByKind(runId, "run_completed");
    if (
      !checkpoint ||
      checkpoint.runId !== runId ||
      checkpoint.checkpointKind !== "run_completed" ||
      canonicalJsonString(checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]) !==
        canonicalJsonString(expectedDecision.receipt) ||
      checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== rawOutput ||
      checkpoint.state.assistantMessageId !== assistantMessageId ||
      checkpoint.state.outputText !== expectedDecision.decision.normalizedMessage ||
      checkpoint.state.outputSummary !== expectedDecision.decision.normalizedMessage ||
      checkpoint.state.finalOutput !== undefined ||
      checkpoint.state.finalSummary !== undefined
    ) {
      return undefined;
    }
    verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);

    const message = await runtime.storage.chatMessages.get(assistantMessageId);
    if (
      !message ||
      message.messageId !== assistantMessageId ||
      message.sessionId !== sessionId ||
      message.role !== "assistant" ||
      message.actorType !== "system" ||
      message.actorId !== "system-heartbeat" ||
      message.content !== expectedDecision.decision.normalizedMessage ||
      !Number.isFinite(Date.parse(message.timestamp))
    ) {
      return undefined;
    }

    const projectedMessage = projectChatMessageForPublic(message);
    if (!projectedMessage) return undefined;
    return {
      kind: "system_heartbeat",
      noticeId: assistantMessageId,
      turnId: trace.turnId,
      message: projectedMessage,
    };
  } catch {
    return undefined;
  }
}
