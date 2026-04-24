import type {
  ChatThreadResponse,
  ChatUserInputPromptAnswerResponse,
  ChatUserInputPromptResponse,
  ContextManifestDetail,
  DurableRunRecord,
  DurableWakeResult,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildChatThreadResponse, resolveNewestLeafTurnId } from "./chat-thread-utils.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";
import type { DurableRunService } from "./durable-run-service.js";
import { parseDurableChatTurnPayload } from "./durable-execution-service.js";
import type { DurableChatTurnExecutionPayload, DurableChatTurnUserInputResumeRecord } from "./chat-turn-types.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";

export interface ChatMessageRouteRuntimeHost {
  readonly storage: Storage;
  readonly durableRunService: Pick<DurableRunService, "getDurableRun" | "wakeDurableRun">;
  getSession(sessionId: string): unknown;
  loadChatTurnSessionState(sessionId: string): Promise<ChatTurnSessionState>;
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

export async function getChatThread(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
): Promise<ChatThreadResponse> {
  runtime.getSession(sessionId);
  const state = await runtime.loadChatTurnSessionState(sessionId);
  return buildChatThreadFromState(runtime, sessionId, state);
}

export async function selectChatBranchTurn(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
): Promise<ChatThreadResponse> {
  runtime.getSession(sessionId);
  const state = await runtime.loadChatTurnSessionState(sessionId);
  const target = state.traces.find((trace) => trace.turnId === turnId);
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
    ...state,
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
): Promise<ChatUserInputPromptAnswerResponse> {
  runtime.getSession(sessionId);
  const trace = runtime.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  if (trace.status !== "waiting_for_user_input") {
    throw new ValidationError({ message: `Chat turn ${turnId} is not waiting for user input.` });
  }
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

  const answeredAt = new Date().toISOString();
  const selectedOption =
    response.kind === "single_select"
      ? (prompt.options ?? []).find((option) => option.optionId === response.optionId)
      : undefined;
  const resumeRecord: DurableChatTurnUserInputResumeRecord = {
    promptId,
    kind: prompt.kind,
    title: prompt.title,
    question: prompt.question,
    answeredAt,
    response: response.kind === "text" ? { kind: "text", text: response.text.trim() } : response,
    ...(selectedOption
      ? {
          selectedOption: {
            optionId: selectedOption.optionId,
            label: selectedOption.label,
            description: selectedOption.description,
          },
        }
      : {}),
  };

  const updatedDurableRun = runtime.storage.durableRuns.updateRun({
    runId: durableRunId,
    status: durableRun.status,
    payload: durableChatTurnPayloadToRecord({
      ...durablePayload,
      userInputResponses: [
        ...(durablePayload.userInputResponses ?? []).filter((entry) => entry.promptId !== promptId),
        resumeRecord,
      ],
    }),
    expectedVersion: durableRun.version,
  });
  const wake = runtime.durableRunService.wakeDurableRun(durableRunId, {
    eventKey: "chat.user_input.resolved",
    correlationId: promptId,
    payload: {
      sessionId,
      turnId,
      promptId,
      answeredAt,
      response: userInputPromptResponseToRecord(resumeRecord.response),
    },
  });
  const resumed = isDurableRunResumed(wake, updatedDurableRun);
  if (!resumed) {
    throw new ConflictError({
      message:
        wake.detail ??
        `Durable run ${durableRunId} could not be resumed from ${wake.run?.status ?? updatedDurableRun.status}.`,
    });
  }

  runtime.storage.chatTurnTraces.patch(turnId, {
    status: "running",
    pendingUserInput: null,
  });
  runtime.recordDevDiagnostic({
    level: "info",
    category: "chat",
    event: "chat.user_input_prompt.answered",
    message: "Resolved pending chat user-input prompt",
    sessionId,
    turnId,
    context: {
      promptId,
      promptKind: prompt.kind,
      responseKind: response.kind,
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
  return {
    ok: true,
    sessionId,
    turnId,
    promptId,
    resumed,
    resumedTurnId: turnId,
    resumedRunId: durableRunId,
  };
}

function buildChatThreadFromState(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  state: ChatTurnSessionState,
): ChatThreadResponse {
  const generatedArtifactsByTurnId = runtime.storage.chatGeneratedArtifacts.listByTurnIds(
    state.traces.map((trace) => trace.turnId),
  );
  return buildChatThreadResponse({
    sessionId,
    activeLeafTurnId: state.activeLeafTurnId,
    turns: state.traces.map((trace) => ({
      trace,
      userMessage: state.messagesById.get(trace.userMessageId),
      assistantMessage: trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
      generatedArtifacts: (generatedArtifactsByTurnId.get(trace.turnId) ?? []).map(
        chatGeneratedArtifactService.buildGeneratedArtifactReference,
      ),
    })),
  });
}

function durableChatTurnPayloadToRecord(payload: DurableChatTurnExecutionPayload): Record<string, unknown> {
  return { ...payload };
}

function userInputPromptResponseToRecord(response: ChatUserInputPromptResponse): Record<string, unknown> {
  return response.kind === "text"
    ? { kind: "text", text: response.text }
    : { kind: "single_select", optionId: response.optionId };
}

function isDurableRunResumed(wake: DurableWakeResult, updatedDurableRun: DurableRunRecord): boolean {
  return (
    wake.outcome === "woke" ||
    wake.run?.status === "queued" ||
    wake.run?.status === "running" ||
    updatedDurableRun.status === "queued" ||
    updatedDurableRun.status === "running"
  );
}
