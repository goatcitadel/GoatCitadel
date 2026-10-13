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
    const emit = (
      event: string,
      message: string,
      runtimeStatus: "started" | "running",
      context: Record<string, unknown>,
    ) => {
      host.recordDevDiagnostic({
        level: "debug",
        category: "chat",
        event: `chat.completion_stream.provider_attempt.${event}`,
        message,
        sessionId: input.sessionId,
        taskId: input.taskId,
        providerId,
        modelId,
        runtimeKind: "model.call",
        runtimeStatus,
        context: { attempt, fallback, ...context },
      });
    };
    emit("start", "Starting prepared LlmService stream attempt", "started", {
      timingBoundary: "llm_service_attempt_start",
      elapsedSinceCompletionStartMs: Math.max(0, startedAt - input.completionStartedAt),
    });
    let firstChunk = false;
    let firstUsefulOutput = false;
    return (chunk?: Record<string, unknown>) => {
      if (!firstChunk) {
        firstChunk = true;
        emit("first_chunk", "Received first LlmService stream chunk (may contain control or usage data)", "started", {
          timingBoundary: "llm_service_first_chunk",
          elapsedSinceAttemptStartMs: Math.max(0, Date.now() - startedAt),
        });
      }
      const outputKind = readUsefulOutputKind(chunk);
      if (firstUsefulOutput || !outputKind) return;
      firstUsefulOutput = true;
      emit(
        "first_useful_output",
        "Received first normalized model text or named tool call; downstream display may still be buffered",
        "running",
        {
          timingBoundary: "llm_service_first_useful_output",
          outputKind,
          elapsedSinceAttemptStartMs: Math.max(0, Date.now() - startedAt),
          elapsedSinceCompletionStartMs: Math.max(0, Date.now() - input.completionStartedAt),
        },
      );
    };
  };
}

function readUsefulOutputKind(chunk?: Record<string, unknown>): "text" | "tool_call" | undefined {
  if (!Array.isArray(chunk?.choices)) return undefined;
  for (const choice of chunk.choices) {
    if (!choice || typeof choice !== "object") continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object") continue;
    const value = delta as Record<string, unknown>;
    if (typeof value.content === "string" && value.content.trim()) return "text";
    if (
      Array.isArray(value.tool_calls) &&
      value.tool_calls.some(
        (tool) =>
          tool && typeof tool === "object" && typeof tool.function?.name === "string" && tool.function.name.trim(),
      )
    )
      return "tool_call";
  }
  return undefined;
}
