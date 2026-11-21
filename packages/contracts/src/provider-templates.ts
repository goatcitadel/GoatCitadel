import type {
  LlmApiStyle,
  LlmProviderAuthMode,
  LlmProviderCapabilities,
  LlmProviderGoogleCloudConfig,
  ProviderProfile,
} from "./llm.js";

import { providerModelDefaults, type BuiltinProviderId } from "./provider-model-routing.js";
export {
  findProviderModelDefaults,
  inferProviderForModelId,
  isAggregatorProvider,
  providerAllowsForeignModelIds,
  providerRecognizesModelId,
} from "./provider-model-routing.js";

export interface ProviderTemplateDefinition {
  providerId: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiStyle?: LlmApiStyle;
  authMode?: LlmProviderAuthMode;
  googleCloud?: LlmProviderGoogleCloudConfig;
  capabilities?: Partial<LlmProviderCapabilities>;
  knownModels?: string[];
}

const connectionTemplates = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiStyle: "openai-responses",
  },
  "openai-codex": {
    label: "OpenAI Codex (ChatGPT OAuth)",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiStyle: "openai-codex-responses",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiStyle: "anthropic-messages",
  },
  "claude-code": {
    label: "Claude Code (Claude subscription)",
    baseUrl: "https://api.anthropic.com/v1",
    apiStyle: "anthropic-messages",
  },
  "claude-code-cli": {
    label: "Claude Code CLI (local login)",
    baseUrl: "https://api.anthropic.com/v1",
    apiStyle: "claude-code-cli",
    authMode: "claude-code-cli-login",
    capabilities: {
      vision: false,
      audio: false,
      video: false,
      toolCalling: false,
      jsonMode: false,
      reasoning: true,
    },
  },
  bedrock: {
    label: "Amazon Bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    apiStyle: "bedrock-messages",
    authMode: "aws-bedrock-api-key",
  },
  google: {
    label: "Google (compatible endpoint)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiStyle: "openai-chat-completions",
  },
  vertex: {
    label: "Google Vertex AI",
    baseUrl:
      "https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/endpoints/openapi",
    apiStyle: "openai-chat-completions",
    authMode: "google-adc",
    googleCloud: { location: "us-central1", endpointId: "openapi" },
    capabilities: { reasoning: true, reasoningEfforts: ["low", "medium", "high"] },
  },
  fireworks: {
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiStyle: "openai-chat-completions",
  },
  minimax: {
    label: "MiniMax (compatible endpoint)",
    baseUrl: "https://api.minimax.io/v1",
    apiStyle: "openai-chat-completions",
  },
  vercel: {
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiStyle: "openai-chat-completions",
  },
  lmstudio: {
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiStyle: "openai-chat-completions",
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiStyle: "openai-chat-completions",
  },
  llamacpp: {
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiStyle: "openai-chat-completions",
  },
  localai: {
    label: "LocalAI",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiStyle: "openai-chat-completions",
  },
  "genie-ir20": {
    label: "Genie IR20 (Tailnet)",
    baseUrl: "http://100.64.0.4:8910/v1",
    apiStyle: "openai-chat-completions",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiStyle: "openai-chat-completions",
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiStyle: "openai-chat-completions",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiStyle: "openai-chat-completions",
  },
  glm: {
    label: "GLM (Z.AI)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiStyle: "openai-chat-completions",
  },
  moonshot: {
    label: "Moonshot (Kimi API)",
    baseUrl: "https://api.moonshot.ai/v1",
    apiStyle: "openai-chat-completions",
  },
  perplexity: {
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    apiStyle: "openai-chat-completions",
  },
  huggingface: {
    label: "HuggingFace Inference",
    baseUrl: "https://router.huggingface.co/v1",
    apiStyle: "openai-chat-completions",
  },
} satisfies Record<BuiltinProviderId, Omit<ProviderTemplateDefinition, "providerId" | "defaultModel" | "knownModels">>;

export const providerTemplates: readonly ProviderTemplateDefinition[] = Object.entries(providerModelDefaults).map(
  ([providerId, models]) => ({ providerId, ...connectionTemplates[providerId as BuiltinProviderId], ...models }),
);

export const builtinProviderProfiles: readonly ProviderProfile[] = providerTemplates.map((template) => ({
  profileId: `builtin:${template.providerId}`,
  providerId: template.providerId,
  label: template.label,
  source: "builtin",
  status: "builtin",
  baseUrl: template.baseUrl,
  apiStyle: template.apiStyle ?? "openai-chat-completions",
  defaultModel: template.defaultModel,
  authMode: template.authMode,
  googleCloud: template.googleCloud,
  capabilities: template.capabilities,
  knownModels: template.knownModels,
  modelDiscovery: resolveBuiltinModelDiscovery(template.providerId),
}));

export function findProviderTemplate(providerId: string): ProviderTemplateDefinition | undefined {
  return providerTemplates.find((template) => template.providerId === providerId);
}

export function findBuiltinProviderProfile(providerId: string): ProviderProfile | undefined {
  return builtinProviderProfiles.find((profile) => profile.providerId === providerId);
}

function resolveBuiltinModelDiscovery(providerId: string): ProviderProfile["modelDiscovery"] {
  if (providerId === "openrouter") {
    return {
      type: "openrouter",
      url: "https://openrouter.ai/api/v1/models",
      refreshIntervalHours: 24,
    };
  }
  return { type: "none" };
}
