import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiStyle,
  ModelUsageAttributionContext,
  ModelUsageOutputCapEvidenceFormat,
  ModelUsageTransportRetryReason,
  LlmProviderConfig,
} from "@goatcitadel/contracts";
import type { ModelUsageAttemptHandle } from "@goatcitadel/gateway-core";
import type { Dispatcher } from "undici";

export interface LlmProviderResolution {
  provider: LlmProviderConfig;
  apiKey?: string;
}

export interface LlmOutputCapRecoveryState {
  /** Original caller request, retained while the transport cap is reduced. */
  requestedOutputTokenCap?: number;
  /** Provider-specific hard floor below which a recovery retry would invalidate request semantics. */
  minimumEffectiveOutputTokenCap?: number;
  /** One logical budget follows compatible request-shape retries. */
  retriesRemaining: number;
  recoverySourceEventId?: string;
  providerAvailableTokens?: number;
  providerMinimumTokens?: number;
  requestInputEstimate?: number;
  configuredContextWindowTokens?: number;
  safetyMarginTokens?: number;
  evidenceFormat?: ModelUsageOutputCapEvidenceFormat;
}

export interface LlmTransportRetryState {
  parentEventId: string;
  reason: ModelUsageTransportRetryReason;
}

export interface LlmProviderRequestTarget {
  url: string;
  headers: Record<string, string>;
  dispatcher?: Dispatcher;
}

export interface LlmProviderJsonRequestInput {
  resolved: LlmProviderResolution;
  model: string;
  requestedProviderId?: string;
  requestedModelId?: string;
  attribution: ModelUsageAttributionContext;
  transportAttemptIndex: number;
  target: LlmProviderRequestTarget;
  payload: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  outputCapRecovery?: LlmOutputCapRecoveryState;
  transportRetry?: LlmTransportRetryState;
}

export interface LlmTrackedJsonDispatch {
  response: Response;
  usage?: ModelUsageAttemptHandle;
  priorModelUsageEventIds?: string[];
  lastTransportAttemptIndex?: number;
  effectivePayload: Record<string, unknown>;
  outputCapRetriesRemaining: number;
  logicalRequestedOutputTokenCap?: number;
  minimumEffectiveOutputTokenCap?: number;
}

export interface LlmProviderAdapterHost {
  buildRequestTarget(
    resolved: LlmProviderResolution,
    purpose: "chat" | "responses" | "messages" | "models",
    endpointUrl: string,
  ): LlmProviderRequestTarget;
  postJsonRequest(input: LlmProviderJsonRequestInput): Promise<LlmTrackedJsonDispatch>;
  retryOutputCapFailure(
    input: LlmProviderJsonRequestInput & {
      dispatched: LlmTrackedJsonDispatch;
      providerErrorText: string;
      /** Structured provider failure retained for usage/cost settlement before retry. */
      providerFailureEvidence?: unknown;
    },
  ): Promise<LlmTrackedJsonDispatch | undefined>;
}

export interface LlmProviderAdapter {
  readonly apiStyle: LlmApiStyle;

  chatCompletions(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    host: LlmProviderAdapterHost,
    attribution?: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;

  chatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    host: LlmProviderAdapterHost,
    attribution?: ModelUsageAttributionContext,
  ): AsyncGenerator<Record<string, unknown>>;
}

export type LlmProviderAdapterRegistry = ReadonlyMap<LlmApiStyle, LlmProviderAdapter>;

export function createLlmProviderAdapterRegistry(adapters: readonly LlmProviderAdapter[]): LlmProviderAdapterRegistry {
  const registry = new Map<LlmApiStyle, LlmProviderAdapter>();
  for (const adapter of adapters) {
    registry.set(adapter.apiStyle, adapter);
  }
  return registry;
}
