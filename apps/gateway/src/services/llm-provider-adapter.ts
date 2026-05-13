import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiStyle,
  LlmProviderConfig,
} from "@goatcitadel/contracts";
import type { Dispatcher } from "undici";

export interface LlmProviderResolution {
  provider: LlmProviderConfig;
  apiKey?: string;
}

export interface LlmProviderRequestTarget {
  url: string;
  headers: Record<string, string>;
  dispatcher?: Dispatcher;
}

export interface LlmProviderAdapterHost {
  buildRequestTarget(
    resolved: LlmProviderResolution,
    purpose: "chat" | "responses" | "messages" | "models",
    endpointUrl: string,
  ): LlmProviderRequestTarget;
}

export interface LlmProviderAdapter {
  readonly apiStyle: LlmApiStyle;

  chatCompletions(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    host: LlmProviderAdapterHost,
  ): Promise<ChatCompletionResponse>;

  chatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    host: LlmProviderAdapterHost,
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
