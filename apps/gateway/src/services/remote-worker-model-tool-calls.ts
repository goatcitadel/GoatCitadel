import {
  REMOTE_WORKER_CHAT_MAX_TOOL_CALLS,
  normalizeRemoteWorkerInferenceToolCalls,
  type ChatCompletionResponseChoice,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";

/** The canonical provider adapter has already normalized provider wire shapes.
 * Retain only complete calls to the exact frozen model-facing definitions. */
export function readRemoteWorkerModelToolCalls(
  choice: ChatCompletionResponseChoice | undefined,
  tools: readonly Record<string, unknown>[] | undefined,
): readonly RemoteWorkerInferenceToolCall[] | undefined {
  const raw = choice?.message?.tool_calls;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    if (choice?.finish_reason === "tool_calls") throw new Error("Worker model tool calls are missing.");
    return undefined;
  }
  if (!Array.isArray(raw) || ["length", "content_filter"].includes(choice?.finish_reason ?? ""))
    throw new Error("Worker model tool calls are incomplete.");
  if (raw.length > REMOTE_WORKER_CHAT_MAX_TOOL_CALLS)
    throw new Error("Worker model tool calls exceed their count bound.");
  const allowedNames = new Set(
    (tools ?? []).map((tool) => (tool.function as Record<string, unknown> | undefined)?.name),
  );
  return normalizeRemoteWorkerInferenceToolCalls(
    raw.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Worker model returned an invalid tool call.");
      const call = value as Record<string, unknown>;
      const fn = call.function as Record<string, unknown> | undefined;
      if (call.type !== "function" || !fn || !allowedNames.has(fn.name))
        throw new Error("Worker model selected an unadmitted tool definition.");
      return { callId: call.id, modelToolName: fn.name, argumentsJson: fn.arguments };
    }),
  );
}
