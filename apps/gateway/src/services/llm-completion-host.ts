import type { ChatCompletionRequest, LlmRuntimeMeasurementRecord, MemoryContextPack } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { HooksService } from "./hooks-service.js";
import type { LlmService } from "./llm-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";

export interface LlmCompletionHost {
  readonly config: Pick<GatewayRuntimeConfig, "assistant">;
  readonly memoryLifecycleService: Pick<MemoryLifecycleService, "composeContext">;
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks" | "hasMutateHook">;
  readonly llmService: Pick<
    LlmService,
    "chatCompletions" | "chatCompletionsStream" | "getRuntimeConfig" | "resolveExecutionApiStyle"
  >;
  resolveMemoryWorkspaceRelativeDir(workspace: string | undefined, sessionId: string | undefined): string;
  resolveChatCompletionHookWorkspaceId(request: ChatCompletionRequest): string;
  persistContextManifestForCompletionRequest(input: {
    request: ChatCompletionRequest;
    memoryContext?: MemoryContextPack;
  }): void;
  recordLlmRuntimeMeasurement?(record: LlmRuntimeMeasurementRecord): void;
  resolveFallbackTargets(
    runtime: ReturnType<LlmService["getRuntimeConfig"]>,
    primaryProviderId: string,
    primaryModel: string,
  ): Array<{ providerId: string; model: string }>;
  recordDevDiagnostic(input: {
    level: "debug" | "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    providerId?: string;
    modelId?: string;
    durationMs?: number;
    runtimeKind?: string;
    runtimeStatus?: "started" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "degraded";
    runtimeError?: {
      name?: string;
      message: string;
      code?: string;
      retryable?: boolean;
    };
    context?: Record<string, unknown>;
  }): void;
  publishRealtime(channel: string, topic: string, payload: Record<string, unknown>): void;
}
