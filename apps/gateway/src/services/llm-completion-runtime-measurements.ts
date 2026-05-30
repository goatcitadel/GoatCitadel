import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmProviderSummary,
  LlmRuntimeMeasurementRecord,
} from "@goatcitadel/contracts";
import { buildLlmRuntimeMeasurementRecord, extractUsageFromStreamChunks } from "./llm-runtime-truth-service.js";

interface RuntimeMeasurementRecorder {
  recordLlmRuntimeMeasurement?(record: LlmRuntimeMeasurementRecord): void;
}

interface RuntimeMeasurementTarget {
  providerId: string;
  model: string;
  provider?: Pick<LlmProviderSummary, "providerId" | "baseUrl">;
  providers?: Array<Pick<LlmProviderSummary, "providerId" | "baseUrl">>;
}

interface RecordChatCompletionRuntimeMeasurementInput {
  recorder: RuntimeMeasurementRecorder;
  providerId: string;
  model: string;
  provider?: Pick<LlmProviderSummary, "providerId" | "baseUrl">;
  providers?: Array<Pick<LlmProviderSummary, "providerId" | "baseUrl">>;
  response?: ChatCompletionResponse;
  telemetryChunks?: Array<Record<string, unknown>>;
  stream: boolean;
  startedAt: number;
  completedAt: number;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  path: LlmRuntimeMeasurementRecord["provenance"]["path"];
  status: LlmRuntimeMeasurementRecord["status"];
  error?: string;
}

export function recordFailedChatRuntime(
  recorder: RuntimeMeasurementRecorder,
  request: ChatCompletionRequest,
  target: RuntimeMeasurementTarget,
  startedAt: number,
  completedAt: number,
  error?: string,
): void {
  recordChatCompletionRuntimeMeasurement({
    recorder,
    ...target,
    stream: false,
    startedAt,
    completedAt,
    sessionId: request.memory?.sessionId,
    taskId: request.memory?.taskId,
    runId: request.memory?.runId,
    path: "chat_completion",
    status: "failed",
    error,
  });
}

export function recordCompletedChatRuntime(
  recorder: RuntimeMeasurementRecorder,
  request: ChatCompletionRequest,
  target: RuntimeMeasurementTarget,
  response: ChatCompletionResponse,
  startedAt: number,
  completedAt: number,
): void {
  recordChatCompletionRuntimeMeasurement({
    recorder,
    ...target,
    response,
    stream: false,
    startedAt,
    completedAt,
    sessionId: request.memory?.sessionId,
    taskId: request.memory?.taskId,
    runId: request.memory?.runId,
    path: "chat_completion",
    status: "completed",
  });
}

export function recordStreamRuntime(
  recorder: RuntimeMeasurementRecorder,
  memoryInput: ChatCompletionRequest["memory"],
  target: RuntimeMeasurementTarget,
  telemetryChunks: Array<Record<string, unknown>>,
  startedAt: number,
  completedAt: number,
  status: Extract<LlmRuntimeMeasurementRecord["status"], "completed" | "failed" | "partial">,
  error?: string,
): void {
  recordChatCompletionRuntimeMeasurement({
    recorder,
    ...target,
    telemetryChunks,
    stream: true,
    startedAt,
    completedAt,
    sessionId: memoryInput?.sessionId,
    taskId: memoryInput?.taskId,
    runId: memoryInput?.runId,
    path: "chat_completion_stream",
    status,
    error,
  });
}

export function recordChatCompletionRuntimeMeasurement(input: RecordChatCompletionRuntimeMeasurementInput): void {
  input.recorder.recordLlmRuntimeMeasurement?.(
    buildLlmRuntimeMeasurementRecord({
      providerId: input.providerId,
      model: input.model,
      provider: input.provider ?? input.providers?.find((provider) => provider.providerId === input.providerId),
      response: input.response,
      usage: input.telemetryChunks ? extractUsageFromStreamChunks(input.telemetryChunks) : undefined,
      stream: input.stream,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      path: input.path,
      status: input.status,
      error: input.error,
    }),
  );
}
