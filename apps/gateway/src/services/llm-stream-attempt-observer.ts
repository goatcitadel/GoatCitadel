import type { LlmCompletionHost } from "./llm-completion-host.js";

/** Measures LlmService attempts, not HTTP dispatch or first visible text. */
export function createLlmStreamAttemptObserver(
  host: Pick<LlmCompletionHost, "recordDevDiagnostic">,
  input: { completionStartedAt: number; sessionId?: string; taskId?: string },
) {
  let providerAttempt = 0;
  // This is the LlmService boundary, not an HTTP dispatch timestamp. Provider
  // guards/auth/transport setup may still run before the network request.
  return (providerId: string, modelId: string, fallback: boolean) => {
    const attempt = ++providerAttempt;
    const startedAt = Date.now();
    host.recordDevDiagnostic({
      level: "debug",
      category: "chat",
      event: "chat.completion_stream.provider_attempt.start",
      message: "Starting prepared LlmService stream attempt",
      sessionId: input.sessionId,
      taskId: input.taskId,
      providerId,
      modelId,
      runtimeKind: "model.call",
      runtimeStatus: "started",
      context: {
        timingBoundary: "llm_service_attempt_start",
        attempt,
        fallback,
        elapsedSinceCompletionStartMs: Math.max(0, startedAt - input.completionStartedAt),
      },
    });
    return () =>
      host.recordDevDiagnostic({
        level: "debug",
        category: "chat",
        event: "chat.completion_stream.provider_attempt.first_chunk",
        message: "Received first LlmService stream chunk (may contain control or usage data)",
        sessionId: input.sessionId,
        taskId: input.taskId,
        providerId,
        modelId,
        runtimeKind: "model.call",
        runtimeStatus: "started",
        context: {
          timingBoundary: "llm_service_first_chunk",
          attempt,
          fallback,
          elapsedSinceAttemptStartMs: Math.max(0, Date.now() - startedAt),
        },
      });
  };
}
