import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { LlmDispatchGuardRejectedError, type LlmDispatchGuard } from "./llm-dispatch-guard.js";
import type { LlmCompletionHost } from "./llm-completion-host.js";

const VALIDATOR = Symbol("admitted-chat-explicit-context-validator");
type Validator = (request: ChatCompletionRequest) => Promise<void>;
type BoundRequest = ChatCompletionRequest & { [VALIDATOR]?: Validator };
type Port = LlmCompletionHost["llmService"];

/** The live owner installs this server-only callback. JSON cannot create it. */
export function bindChatExplicitContextValidator(
  request: ChatCompletionRequest,
  validator: Validator,
): ChatCompletionRequest {
  const bound: BoundRequest = { ...request, [VALIDATOR]: validator };
  return bound;
}

async function guardFor(request: ChatCompletionRequest): Promise<LlmDispatchGuard | undefined> {
  const validator = (request as BoundRequest)[VALIDATOR];
  if (!validator) return undefined;
  const check = async (effective: ChatCompletionRequest) => {
    try {
      await validator(effective);
    } catch (error) {
      throw error instanceof LlmDispatchGuardRejectedError ? error : new LlmDispatchGuardRejectedError(error);
    }
  };
  await check(request);
  return async (dispatch) => {
    if (
      dispatch.attribution.sessionId !== request.memory?.sessionId ||
      dispatch.attribution.turnId !== request.memory?.turnId ||
      dispatch.attribution.durableRunId !== request.memory?.runId ||
      typeof dispatch.effectiveOutputTokenCap !== "number" ||
      !Number.isSafeInteger(dispatch.effectiveOutputTokenCap) ||
      dispatch.effectiveOutputTokenCap < 1 ||
      request.max_tokens === undefined ||
      dispatch.effectiveOutputTokenCap > request.max_tokens
    ) {
      throw new LlmDispatchGuardRejectedError(
        new Error("Explicit context transport attribution or output budget changed."),
      );
    }
    await check({
      ...request,
      providerId: dispatch.route.providerId,
      model: dispatch.route.modelId,
      max_tokens: dispatch.effectiveOutputTokenCap,
    });
  };
}

export async function runWithChatExplicitContext<T>(
  port: Port,
  request: ChatCompletionRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const guard = await guardFor(request);
  if (!guard) return operation();
  if (!port.runWithDispatchGuard)
    throw new LlmDispatchGuardRejectedError(new Error("Explicit context dispatch guard is unavailable."));
  return port.runWithDispatchGuard(guard, operation);
}

export async function* streamWithChatExplicitContext<T>(
  port: Port,
  request: ChatCompletionRequest,
  operation: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const guard = await guardFor(request);
  if (!guard) {
    yield* operation();
    return;
  }
  if (!port.streamWithDispatchGuard)
    throw new LlmDispatchGuardRejectedError(new Error("Explicit context dispatch guard is unavailable."));
  yield* port.streamWithDispatchGuard(guard, operation);
}
