import type { LlmApiStyle } from "./llm.js";

export interface ProviderTemplateDefinition {
  providerId: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiStyle?: LlmApiStyle;
  knownModels?: string[];
}

export const providerTemplates: readonly ProviderTemplateDefinition[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    apiStyle: "openai-responses",
    knownModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
  },
  {
    providerId: "openai-codex",
    label: "OpenAI Codex (ChatGPT OAuth)",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    defaultModel: "gpt-5.5",
    apiStyle: "openai-codex-responses",
    knownModels: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini"],
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    apiStyle: "anthropic-messages",
    knownModels: ["claude-sonnet-4-6", "claude-sonnet-4", "claude-opus-4"],
  },
  {
    providerId: "claude-code",
    label: "Claude Code (Claude subscription)",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    apiStyle: "anthropic-messages",
    knownModels: ["claude-sonnet-4-6", "claude-sonnet-4", "claude-opus-4"],
  },
  {
    providerId: "google",
    label: "Google (compatible endpoint)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "models/gemini-2.5-flash",
    apiStyle: "openai-chat-completions",
    knownModels: [
      "models/gemini-2.5-flash",
      "models/gemini-2.5-flash-lite",
      "models/gemini-2.5-pro",
      "models/gemini-flash-latest",
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
      "gemini-2.5-flash-image",
    ],
  },
  {
    providerId: "minimax",
    label: "MiniMax (compatible endpoint)",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    apiStyle: "openai-chat-completions",
    knownModels: [
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
  },
  {
    providerId: "vercel",
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    defaultModel: "openai/gpt-5.4",
    apiStyle: "openai-chat-completions",
    knownModels: ["openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-4.1-mini", "openai/gpt-oss-120b"],
  },
  {
    providerId: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "local-model",
    apiStyle: "openai-chat-completions",
  },
  {
    providerId: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama3.1",
    apiStyle: "openai-chat-completions",
  },
  {
    providerId: "llamacpp",
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "gemma-4-local",
    apiStyle: "openai-chat-completions",
    knownModels: ["gemma-4-local", "gemma-4", "gemma-4-it"],
  },
  {
    providerId: "localai",
    label: "LocalAI",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "local-model",
    apiStyle: "openai-chat-completions",
  },
  {
    providerId: "npu-local",
    label: "NPU Local Sidecar",
    baseUrl: "http://127.0.0.1:11440/v1",
    defaultModel: "phi-3.5-mini-instruct",
    apiStyle: "openai-chat-completions",
  },
  {
    providerId: "genie-ir20",
    label: "Genie IR20 (Tailnet)",
    baseUrl: "http://100.64.0.4:8910/v1",
    defaultModel: "IBM-Granite",
    apiStyle: "openai-chat-completions",
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.4",
    apiStyle: "openai-chat-completions",
    knownModels: [
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
      "zai/glm-5v-turbo",
    ],
  },
  {
    providerId: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    apiStyle: "openai-chat-completions",
    knownModels: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"],
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-pro",
    apiStyle: "openai-chat-completions",
    knownModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  },
  {
    providerId: "glm",
    label: "GLM (Z.AI)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5",
    apiStyle: "openai-chat-completions",
    knownModels: ["glm-5", "glm-5-air", "glm-5-flash", "glm-5-turbo", "glm-5v-turbo"],
  },
  {
    providerId: "moonshot",
    label: "Moonshot (Kimi API)",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    apiStyle: "openai-chat-completions",
    knownModels: ["kimi-k2.6", "kimi-k2", "kimi-1"],
  },
  {
    providerId: "perplexity",
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
    apiStyle: "openai-chat-completions",
    knownModels: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"],
  },
  {
    providerId: "xai",
    label: "xAI Grok (SuperGrok OAuth)",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.3",
    apiStyle: "openai-chat-completions",
    knownModels: ["grok-4.3", "grok-4.2", "grok-4-mini"],
  },
  {
    providerId: "huggingface",
    label: "HuggingFace Inference",
    baseUrl: "https://router.huggingface.co/v1",
    defaultModel: "openai/gpt-oss-120b",
    apiStyle: "openai-chat-completions",
  },
];

const FOREIGN_MODEL_PROVIDER_IDS = new Set([
  "openrouter",
  "vercel",
  "huggingface",
  "lmstudio",
  "ollama",
  "llamacpp",
  "localai",
  "npu-local",
  "genie-ir20",
]);

const MODEL_PREFIX_PROVIDER_IDS: Record<string, string> = {
  anthropic: "anthropic",
  "claude-code": "claude-code",
  google: "google",
  openai: "openai",
  "openai-codex": "openai-codex",
  zai: "glm",
};

export function findProviderTemplate(providerId: string): ProviderTemplateDefinition | undefined {
  return providerTemplates.find((template) => template.providerId === providerId);
}

export function providerAllowsForeignModelIds(providerId: string): boolean {
  return FOREIGN_MODEL_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export function inferProviderForModelId(modelId: string): string | undefined {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return undefined;
  }

  const providerPrefix = normalizedModelId.split("/", 1)[0]?.trim().toLowerCase();
  if (providerPrefix && MODEL_PREFIX_PROVIDER_IDS[providerPrefix]) {
    return MODEL_PREFIX_PROVIDER_IDS[providerPrefix];
  }

  for (const template of providerTemplates) {
    if (providerAllowsForeignModelIds(template.providerId)) {
      continue;
    }
    if (template.defaultModel === normalizedModelId || template.knownModels?.includes(normalizedModelId)) {
      return template.providerId;
    }
  }

  return undefined;
}
