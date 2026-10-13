import type { ChatCompletionRequest, ModelUsageAttributionContext } from "@goatcitadel/contracts";
import { runWithChatExplicitContext, streamWithChatExplicitContext } from "./chat-explicit-context-authority.js";
import { LlmDispatchGuardRejectedError, type LlmDispatchGuard } from "./llm-dispatch-guard.js";
import type { LlmCompletionHost } from "./llm-completion-host.js";

const CHECK = Symbol("admitted-chat-feature-dispatch-check");
type BoundRequest = ChatCompletionRequest & {
  [CHECK]?: {
    check: () => Promise<void>;
    sessionId: string;
    turnId: string;
    runId: string;
    allowedRoutes?: ReadonlyArray<Readonly<{ providerId: string; model: string }>>;
  };
};
type Transport = LlmCompletionHost["llmService"];
interface ChatFeatureDispatchPort extends Transport {
  chatCompletions(...args: Parameters<Transport["chatCompletions"]>): ReturnType<Transport["chatCompletions"]>;
  chatCompletionsStream(
    ...args: Parameters<Transport["chatCompletionsStream"]>
  ): ReturnType<Transport["chatCompletionsStream"]>;
  runWithDispatchGuard?: Transport["runWithDispatchGuard"];
  streamWithDispatchGuard?: Transport["streamWithDispatchGuard"];
}

/** Keep the fallback guard outside admission/context guards, as at transport. */
export async function dispatchAdmittedChatCompletion(
  port: ChatFeatureDispatchPort,
  authorityRequest: ChatCompletionRequest,
  dispatchRequest: ChatCompletionRequest,
  attribution: ModelUsageAttributionContext,
  fallbackGuard?: LlmDispatchGuard,
) {
  const dispatch = () =>
    runWithAdmittedChatDispatch(port, authorityRequest, () => port.chatCompletions(dispatchRequest, attribution));
  if (!fallbackGuard) return dispatch();
  const guardedDispatch = port.runWithDispatchGuard?.bind(port);
  if (!guardedDispatch)
    throw new LlmDispatchGuardRejectedError(new Error("Fallback network dispatch guard is unavailable."));
  return guardedDispatch(fallbackGuard, dispatch);
}

/** Guard scope belongs to iteration, including cancellation before first output. */
export async function* streamAdmittedChatCompletion(
  port: ChatFeatureDispatchPort,
  authorityRequest: ChatCompletionRequest,
  dispatchRequest: ChatCompletionRequest,
  attribution: ModelUsageAttributionContext,
  fallbackGuard?: LlmDispatchGuard,
) {
  const dispatch = () =>
    streamWithAdmittedChatDispatch(port, authorityRequest, () =>
      port.chatCompletionsStream(dispatchRequest, attribution),
    );
  if (!fallbackGuard) {
    yield* dispatch();
    return;
  }
  const guardedDispatch = port.streamWithDispatchGuard?.bind(port);
  if (!guardedDispatch)
    throw new LlmDispatchGuardRejectedError(new Error("Fallback network dispatch guard is unavailable."));
  yield* guardedDispatch(fallbackGuard, dispatch);
}

/** Process-local authority survives internal spreads, but cannot be supplied in JSON. */
export function bindChatFeatureDispatchCheck(
  request: ChatCompletionRequest,
  binding: NonNullable<BoundRequest[typeof CHECK]>,
): ChatCompletionRequest {
  if (!binding.sessionId || !binding.turnId || !binding.runId || typeof binding.check !== "function") {
    throw new LlmDispatchGuardRejectedError(new Error("Admitted feature dispatch requires canonical Chat identity."));
  }
  const bound: BoundRequest = {
    ...request,
    [CHECK]: Object.freeze({
      ...binding,
      ...(binding.allowedRoutes
        ? { allowedRoutes: Object.freeze(binding.allowedRoutes.map((route) => Object.freeze({ ...route }))) }
        : {}),
    }),
  };
  return bound;
}

function guardFor(request: ChatCompletionRequest): LlmDispatchGuard | undefined {
  const binding = (request as BoundRequest)[CHECK];
  if (!binding) return undefined;
  return async (dispatch) => {
    try {
      if (
        request.signal?.aborted ||
        request.memory?.sessionId !== binding.sessionId ||
        request.memory?.turnId !== binding.turnId ||
        request.memory?.runId !== binding.runId ||
        dispatch.attribution.sessionId !== binding.sessionId ||
        dispatch.attribution.turnId !== binding.turnId ||
        dispatch.attribution.durableRunId !== binding.runId
      ) {
        throw new Error("Admitted feature dispatch identity changed or the turn was cancelled.");
      }
      if (
        binding.allowedRoutes &&
        !binding.allowedRoutes.some(
          (route) => route.providerId === dispatch.route.providerId && route.model === dispatch.route.modelId,
        )
      ) {
        throw new Error("Admitted feature provider route changed before transport dispatch.");
      }
      // This executes for each actual transport attempt, after asynchronous hooks.
      await binding.check();
    } catch (error) {
      throw error instanceof LlmDispatchGuardRejectedError ? error : new LlmDispatchGuardRejectedError(error);
    }
  };
}

export async function runWithAdmittedChatDispatch<T>(
  port: ChatFeatureDispatchPort,
  request: ChatCompletionRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const guard = guardFor(request);
  const contextual = () => runWithChatExplicitContext(port, request, operation);
  if (!guard) return contextual();
  if (!port.runWithDispatchGuard)
    throw new LlmDispatchGuardRejectedError(new Error("Admitted feature transport guard is unavailable."));
  return port.runWithDispatchGuard(guard, contextual);
}

export async function* streamWithAdmittedChatDispatch<T>(
  port: ChatFeatureDispatchPort,
  request: ChatCompletionRequest,
  operation: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const guard = guardFor(request);
  const contextual = () => streamWithChatExplicitContext(port, request, operation);
  if (!guard) {
    yield* contextual();
    return;
  }
  if (!port.streamWithDispatchGuard)
    throw new LlmDispatchGuardRejectedError(new Error("Admitted feature transport guard is unavailable."));
  yield* port.streamWithDispatchGuard(guard, contextual);
}
