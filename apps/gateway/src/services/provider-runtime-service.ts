import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  LlmApiStyle,
  LlmModelPreviewRequest,
  LlmModelPreviewResponse,
  LlmModelRecord,
  LlmProviderRequestConfig,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";

export interface ProviderRuntimeConfigDetails extends LlmRuntimeConfig {
  providerConfigs: unknown[];
}

export interface UpdateProviderRuntimeConfigInput {
  activeProviderId?: string;
  activeModel?: string;
  upsertProvider?: {
    providerId: string;
    label?: string;
    baseUrl?: string;
    apiStyle?: LlmApiStyle;
    defaultModel?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    persistSecretToSecureStore?: boolean;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
  };
}

export interface ProviderRuntime {
  listProviders(): LlmRuntimeConfig["providers"];
  getConfigWithDetails(): ProviderRuntimeConfigDetails;
  updateConfig(input: UpdateProviderRuntimeConfigInput): LlmRuntimeConfig;
  listModels(providerId?: string): Promise<LlmModelRecord[]>;
  previewModels(input: LlmModelPreviewRequest): Promise<LlmModelPreviewResponse>;
  generateImage(input: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  createChatCompletion(input: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

export type ProviderRuntimeHost = ProviderRuntime;

export function createProviderRuntime(host: ProviderRuntimeHost): ProviderRuntime {
  return {
    listProviders: () => host.listProviders(),
    getConfigWithDetails: () => host.getConfigWithDetails(),
    updateConfig: (input) => host.updateConfig(input),
    listModels: (providerId) => host.listModels(providerId),
    previewModels: (input) => host.previewModels(input),
    generateImage: (input) => host.generateImage(input),
    createChatCompletion: (input) => host.createChatCompletion(input),
  };
}
