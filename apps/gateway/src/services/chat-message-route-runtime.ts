import type {
  ChatThreadSystemNoticeRecord,
  ChatTurnTraceRecord,
  ChatThreadResponse,
  ChatUserInputPromptAnswerResponse,
  ChatUserInputPromptResponse,
  ContextManifestDetail,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { canonicalJsonString, ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { DurableChatUserInputResponderAuthSource, Storage } from "@goatcitadel/storage";
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

export interface ChatThreadLoadOptions {
  includeDecisionTrace?: boolean;
  /** Internal only: keeps retained system runs out of Chat branch hydration. */
  isConversationTrace?: (trace: ChatTurnTraceRecord) => boolean;
}

export interface ChatMessageRouteRuntimeHost {
  readonly storage: Storage;
  readonly durableRunService: Pick<DurableRunService, "getDurableRun" | "requestRunProcessing">;
  getSession(sessionId: string): unknown;
  loadChatTurnSessionState(sessionId: string, options?: ChatThreadLoadOptions): Promise<ChatTurnSessionState>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
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
  runtime.getSession(sessionId);
  const state = await runtime.loadChatTurnSessionState(sessionId, {
    includeDecisionTrace: options.includeDecisionTrace === true,
    isConversationTrace: (trace) => !hasExactSystemHeartbeatRunIdentity(runtime, trace),
  });
  return buildChatThreadFromState(runtime, sessionId, state);
}

export async function selectChatBranchTurn(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
): Promise<ChatThreadResponse> {
  runtime.getSession(sessionId);
  const loadOptions: ChatThreadLoadOptions = {
    isConversationTrace: (trace) => !hasExactSystemHeartbeatRunIdentity(runtime, trace),
  };
  const state = await runtime.loadChatTurnSessionState(sessionId, loadOptions);
  const target = state.traces.find(
    (trace) =>
      trace.turnId === turnId &&
      state.messagesById.has(trace.userMessageId) &&
      !hasExactSystemHeartbeatRunIdentity(runtime, trace),
  );
  if (!target) {
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
  runtime.storage.chatSessionBranchState.setActiveLeaf(sessionId, newestLeafTurnId);
  const nextState = await runtime.loadChatTurnSessionState(sessionId, loadOptions);
  runtime.publishRealtime(
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
  return buildChatThreadFromState(runtime, sessionId, {
    ...nextState,
    activeLeafTurnId: newestLeafTurnId,
  });
}

export function getTurnContextManifestForSession(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
): ContextManifestDetail | undefined {
  const normalizedSessionId = sessionId.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  if (!normalizedTurnId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "turnId" });
  }
  const trace = runtime.storage.chatTurnTraces.get(normalizedTurnId);
  if (trace.sessionId !== normalizedSessionId) {
    throw new Error(`Chat turn ${normalizedTurnId} does not belong to session ${normalizedSessionId}`);
  }
  return runtime.storage.contextManifests.maybeGetDetailByTurn(normalizedTurnId);
}

export async function answerChatUserInputPrompt(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
  promptId: string,
  response: ChatUserInputPromptResponse,
  responder: ChatUserInputPromptResponder,
): Promise<ChatUserInputPromptAnswerResponse> {
  runtime.getSession(sessionId);
  const trace = runtime.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  const durableRunId = trace.durable?.runId;
  if (!durableRunId) {
    throw new ConflictError({
      message: `Chat turn ${turnId} cannot be resumed because it is not linked to a durable run.`,
    });
  }
  const durableRun = runtime.durableRunService.getDurableRun(durableRunId);
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

  // Preserve specific request feedback while the turn is still waiting. Once a
  // seal exists the trace is intentionally running/terminal and storage owns
  // exact replay validation, so these checks must not reject a legitimate
  // retry before the immutable seal is consulted.
  if (trace.status === "waiting_for_user_input") {
    const prompt = trace.pendingUserInput;
    if (!prompt || prompt.promptId !== promptId) {
      throw new ValidationError({ message: `Prompt ${promptId} is not active for chat turn ${turnId}.` });
    }
    if (prompt.kind !== response.kind) {
      throw new ValidationError({ message: `Prompt ${promptId} expects a ${prompt.kind} response.` });
    }
    if (response.kind === "single_select") {
      const validOptionIds = new Set((prompt.options ?? []).map((option) => option.optionId));
      if (!validOptionIds.has(response.optionId)) {
        throw new ValidationError({ message: `Option ${response.optionId} is not valid for prompt ${promptId}.` });
      }
    } else if (response.text.trim().length === 0) {
      throw new ValidationError({ message: `Prompt ${promptId} requires non-empty text.` });
    }
  }

  const outcome = runtime.storage.sessionMutationAdmissions.resolveDurableChatUserInput({
    admissionIdentity: {
      admissionId: durablePayload.admissionId,
      sessionIncarnationId: durablePayload.sessionIncarnationId,
      workspaceId: durablePayload.workspaceId,
      sessionId: durablePayload.sessionId,
      turnId: durablePayload.turnId,
      aggregateRevision: durablePayload.admissionAggregateRevision,
      controllerGeneration: durablePayload.admissionControllerGeneration,
      materialSha256: durablePayload.admissionMaterialSha256,
    },
    durableRunId,
    expectedWaitingRunVersion: durableRun.version,
    promptId,
    eventKey: "chat.user_input.resolved",
    correlationId: promptId,
    responder,
    response: response.kind === "text" ? { kind: "text", text: response.text.trim() } : response,
  });
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
    runtime.publishRealtime(
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
  };
}

function buildChatThreadFromState(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  state: ChatTurnSessionState,
): ChatThreadResponse {
  const heartbeatTurnIds = new Set(
    state.traces.filter((trace) => hasExactSystemHeartbeatRunIdentity(runtime, trace)).map((trace) => trace.turnId),
  );
  const renderableTraces = state.traces.filter(
    (trace) => state.messagesById.has(trace.userMessageId) && !heartbeatTurnIds.has(trace.turnId),
  );
  const systemNotices = state.traces
    .filter((trace) => heartbeatTurnIds.has(trace.turnId))
    .map((trace) => projectExactSystemHeartbeatNotice(runtime, sessionId, state, trace))
    .filter((notice): notice is ChatThreadSystemNoticeRecord => Boolean(notice));
  const generatedArtifactsByTurnId = runtime.storage.chatGeneratedArtifacts.listByTurnIds(
    renderableTraces.map((trace) => trace.turnId),
  );
  return buildChatThreadResponse({
    sessionId,
    activeLeafTurnId: state.activeLeafTurnId,
    systemNotices,
    turns: renderableTraces.map((trace) => ({
      trace: projectChatTurnTraceForPublic(trace),
      userMessage: state.messagesById.get(trace.userMessageId),
      assistantMessage: projectChatMessageForPublic(
        trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
      ),
      generatedArtifacts: (generatedArtifactsByTurnId.get(trace.turnId) ?? []).map(
        chatGeneratedArtifactService.buildGeneratedArtifactReference,
      ),
    })),
  });
}

function hasExactSystemHeartbeatRunIdentity(runtime: ChatMessageRouteRuntimeHost, trace: ChatTurnTraceRecord): boolean {
  try {
    const runId = trace.durable?.runId?.trim();
    if (!runId) return false;
    const run = runtime.durableRunService.getDurableRun(runId);
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
function projectExactSystemHeartbeatNotice(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  state: ChatTurnSessionState,
  trace: ChatTurnTraceRecord,
): ChatThreadSystemNoticeRecord | undefined {
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

    const run = runtime.durableRunService.getDurableRun(runId);
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
      runtime.storage.chatMessages.get(heartbeatPayload.userMessageId)
    ) {
      return undefined;
    }
    verifyAutonomousChatAdmissionRunMetadata(run, { trace });

    const occurrence = runtime.storage.heartbeatOccurrences.find(heartbeatPayload.heartbeatOccurrenceId);
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

    const terminalHandoff = runtime.storage.sessionMutationAdmissions.findVerifiedTerminalTurnWriteHandoff({
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

    const checkpoint = runtime.storage.durableRuns.getLatestCheckpointByKind(runId, "run_completed");
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

    const message = runtime.storage.chatMessages.get(assistantMessageId);
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
