export interface ProviderTemplateDefinition {
  providerId: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  knownModels?: string[];
}

export const providerTemplates = [
  {
    providerId: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4-mini",
  },
  {
    providerId: "anthropic",
    label: "Anthropic (compatible endpoint)",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
  },
  {
    providerId: "google",
    label: "Google (compatible endpoint)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "models/gemini-2.5-flash",
  },
  {
    providerId: "minimax",
    label: "MiniMax (compatible endpoint)",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.5",
  },
  {
    providerId: "vercel",
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    defaultModel: "openai/gpt-5.4-mini",
  },
  {
    providerId: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "local-model",
  },
  {
    providerId: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama3.1",
  },
  {
    providerId: "localai",
    label: "LocalAI",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "local-model",
  },
  {
    providerId: "npu-local",
    label: "NPU Local Sidecar",
    baseUrl: "http://127.0.0.1:11440/v1",
    defaultModel: "phi-3.5-mini-instruct",
  },
  {
    providerId: "genie-ir20",
    label: "Genie IR20 (Tailnet)",
    baseUrl: "http://100.64.0.4:8910/v1",
    defaultModel: "IBM-Granite",
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.4-mini",
  },
  {
    providerId: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  {
    providerId: "glm",
    label: "GLM (Z.AI)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5",
    knownModels: ["glm-5", "glm-5-air", "glm-5-flash", "glm-5-turbo"],
  },
  {
    providerId: "moonshot",
    label: "Moonshot (Kimi API)",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.5",
  },
  {
    providerId: "perplexity",
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
  },
  {
    providerId: "huggingface",
    label: "HuggingFace Inference",
    baseUrl: "https://router.huggingface.co/v1",
    defaultModel: "openai/gpt-oss-120b",
  },
] as const satisfies readonly ProviderTemplateDefinition[];

export function findProviderTemplate(providerId: string): ProviderTemplateDefinition | undefined {
  return providerTemplates.find((template) => template.providerId === providerId);
}
