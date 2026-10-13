import { createHash } from "node:crypto";
import { canonicalJsonString, type ChatCompletionRequest } from "@goatcitadel/contracts";
import type { LlmCompletionHost } from "./llm-completion-host.js";

/** Measures the normalized request after context and hooks, not provider wire encoding. */
export function recordPreparedPromptDiagnostics(
  host: Pick<LlmCompletionHost, "recordDevDiagnostic">,
  request: ChatCompletionRequest,
  completionStartedAt: number,
): void {
  const messages = canonicalJsonString(request.messages);
  const schemas = canonicalJsonString(request.tools ?? []);
  const systemBlocks = request.messages.filter((message) => message.role === "system");
  host.recordDevDiagnostic({
    level: "debug",
    category: "chat",
    event: "chat.completion.prepared_prompt",
    message: "Measured normalized prompt and tool schemas after context preparation without retaining text",
    sessionId: request.memory?.sessionId,
    taskId: request.memory?.taskId,
    runId: request.memory?.runId,
    providerId: request.providerId,
    modelId: request.model,
    durationMs: Math.max(0, Date.now() - completionStartedAt),
    context: {
      timingBoundary: "normalized_request_prepared",
      promptSha256: sha(messages),
      schemasSha256: sha(schemas),
      promptBytes: Buffer.byteLength(messages, "utf8"),
      schemaBytes: Buffer.byteLength(schemas, "utf8"),
      estimatedPromptTokens: Math.ceil(Buffer.byteLength(messages, "utf8") / 3),
      estimatedSchemaTokens: Math.ceil(Buffer.byteLength(schemas, "utf8") / 3),
      tokenEstimateMethod: "utf8_bytes_divided_by_3",
      toolCount: request.tools?.length ?? 0,
      systemBlockCount: systemBlocks.length,
      systemBlockHashes: systemBlocks.slice(0, 128).map((message) => sha(canonicalJsonString(message.content))),
      systemBlockHashesTruncated: systemBlocks.length > 128,
    },
  });
}
function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
