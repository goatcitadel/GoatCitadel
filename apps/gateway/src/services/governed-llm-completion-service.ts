import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import type { LlmCompletionHost } from "./llm-completion-host.js";
import type { LlmService } from "./llm-service.js";
import type { LlmDispatchGuard } from "./llm-dispatch-guard.js";
import { createChatCompletion, createChatCompletionStream } from "./llm-completion-service.js";

export interface GovernedLlmCompletionHost extends LlmCompletionHost {
  readonly llmService: LlmCompletionHost["llmService"] &
    Pick<LlmService, "runWithDispatchGuard" | "streamWithDispatchGuard">;
}

/** Preserve the canonical memory, hook and retry pipeline under the same
 * server-owned dispatch authority, including its nested utility model calls. */
export function createGovernedChatCompletion(
  host: GovernedLlmCompletionHost,
  request: ChatCompletionRequest,
  attribution: ModelUsageAttributionContext,
  guard: LlmDispatchGuard,
): Promise<ChatCompletionResponse> {
  return host.llmService.runWithDispatchGuard(guard, () => createChatCompletion(host, request, attribution));
}

/** Preparation and deferred provider iteration both execute under authority;
 * returning the generator never transfers that authority to its consumer. */
export function createGovernedChatCompletionStream(
  host: GovernedLlmCompletionHost,
  request: ChatCompletionRequest,
  attribution: ModelUsageAttributionContext,
  guard: LlmDispatchGuard,
): AsyncGenerator<Record<string, unknown>> {
  return host.llmService.streamWithDispatchGuard(guard, async function* () {
    yield* await createChatCompletionStream(host, request, attribution);
  });
}
