// Shared by the Anthropic API-key and Claude Code subscription templates, newest first.
// Older ids stay listed while Anthropic still serves them; the live model probe stays authoritative.
const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";
const CLAUDE_KNOWN_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4",
  "claude-opus-4",
] as const;

interface ProviderModelDefaults {
  defaultModel: string;
  knownModels?: string[];
}

// Order also breaks ties for unqualified model IDs shared by more than one provider.
export const providerModelDefaults = {
  openai: {
    defaultModel: "gpt-5.4",
    knownModels: [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5-mini",
      "gpt-4.1-mini",
      "gpt-4o-mini",
      "chat-latest",
    ],
  },
  "openai-codex": {
    defaultModel: "gpt-6-sol",
    knownModels: [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ],
  },
  anthropic: {
    defaultModel: CLAUDE_DEFAULT_MODEL,
    knownModels: [...CLAUDE_KNOWN_MODELS],
  },
  "claude-code": {
    defaultModel: CLAUDE_DEFAULT_MODEL,
    knownModels: [...CLAUDE_KNOWN_MODELS],
  },
  "claude-code-cli": {
    defaultModel: "claude-sonnet-5-5",
    knownModels: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  },
  bedrock: {
    defaultModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    knownModels: [
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.amazon.nova-pro-v1:0",
      "us.meta.llama4-maverick-17b-instruct-v1:0",
    ],
  },
  google: {
    defaultModel: "models/gemini-2.5-flash",
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
  vertex: {
    defaultModel: "google/gemini-2.5-flash",
    knownModels: ["google/gemini-2.5-flash", "google/gemini-2.5-pro"],
  },
  fireworks: {
    defaultModel: "accounts/fireworks/models/kimi-k2p6",
    knownModels: ["accounts/fireworks/models/kimi-k2p6"],
  },
  minimax: {
    defaultModel: "MiniMax-M2.7",
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
  vercel: {
    defaultModel: "openai/gpt-5.4",
    knownModels: ["openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-4.1-mini", "openai/gpt-oss-120b"],
  },
  lmstudio: {
    defaultModel: "local-model",
  },
  ollama: {
    defaultModel: "llama3.1",
  },
  llamacpp: {
    defaultModel: "gemma-4-local",
    knownModels: ["gemma-4-local", "gemma-4", "gemma-4-it"],
  },
  localai: {
    defaultModel: "local-model",
  },
  "genie-ir20": {
    defaultModel: "IBM-Granite",
  },
  openrouter: {
    defaultModel: "openai/gpt-5.4",
    knownModels: [
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
      "zai/glm-5v-turbo",
    ],
  },
  mistral: {
    defaultModel: "mistral-small-latest",
    knownModels: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"],
  },
  deepseek: {
    defaultModel: "deepseek-v4-pro",
    knownModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  },
  glm: {
    defaultModel: "glm-5",
    knownModels: ["glm-5", "glm-5-air", "glm-5-flash", "glm-5-turbo", "glm-5v-turbo"],
  },
  moonshot: {
    defaultModel: "kimi-k2.6",
    knownModels: ["kimi-k2.6", "kimi-k2", "kimi-1"],
  },
  perplexity: {
    defaultModel: "sonar",
    knownModels: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"],
  },
  huggingface: {
    defaultModel: "openai/gpt-oss-120b",
  },
} satisfies Record<string, ProviderModelDefaults>;

export type BuiltinProviderId = keyof typeof providerModelDefaults;

export function findProviderModelDefaults(providerId: string): ProviderModelDefaults | undefined {
  return Object.hasOwn(providerModelDefaults, providerId)
    ? providerModelDefaults[providerId as BuiltinProviderId]
    : undefined;
}

const FOREIGN_MODEL_PROVIDER_IDS = new Set([
  "openrouter",
  "vercel",
  "huggingface",
  "lmstudio",
  "ollama",
  "llamacpp",
  "localai",
  "genie-ir20",
  "fireworks",
]);

// Cloud aggregators/routers that forward requests to third-party model hosts.
// The ultimate host is obscured from GoatCitadel, which matters for data-
// sensitivity routing (see citadel-model-routing.ts): an aggregator must never
// satisfy a prefer_local/local_only posture. Deliberately NOT the same set as
// FOREIGN_MODEL_PROVIDER_IDS, which also contains local engines.
const AGGREGATOR_PROVIDER_IDS = new Set(["openrouter", "vercel", "huggingface"]);

export function isAggregatorProvider(providerId: string): boolean {
  return AGGREGATOR_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

const MODEL_PREFIX_PROVIDER_IDS: Record<string, string> = {
  anthropic: "anthropic",
  "claude-code": "claude-code",
  "claude-code-cli": "claude-code-cli",
  google: "google",
  openai: "openai",
  "openai-codex": "openai-codex",
  zai: "glm",
};

export function providerAllowsForeignModelIds(providerId: string): boolean {
  return FOREIGN_MODEL_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export function providerRecognizesModelId(providerId: string, modelId: string): boolean {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (!normalizedProviderId || !normalizedModelId) {
    return false;
  }

  const providerPrefix = normalizedModelId.split("/", 1)[0]?.trim().toLowerCase();
  if (normalizedModelId.includes("/") && providerPrefix && MODEL_PREFIX_PROVIDER_IDS[providerPrefix]) {
    if (normalizedProviderId === "vertex" && providerPrefix === "google") {
      return true;
    }
    return MODEL_PREFIX_PROVIDER_IDS[providerPrefix] === normalizedProviderId;
  }

  const template = findProviderModelDefaults(normalizedProviderId);
  return template?.defaultModel === normalizedModelId || template?.knownModels?.includes(normalizedModelId) === true;
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

  for (const [providerId, template] of Object.entries(providerModelDefaults)) {
    if (providerAllowsForeignModelIds(providerId)) {
      continue;
    }
    // The local CLI transport is opt-in: a bare Claude model id must never route to it
    // or take ownership away from the Anthropic / Claude Code providers.
    if (providerId === "claude-code-cli") {
      continue;
    }
    const modelDefaults: ProviderModelDefaults = template;
    if (modelDefaults.defaultModel === normalizedModelId || modelDefaults.knownModels?.includes(normalizedModelId)) {
      return providerId;
    }
  }

  return undefined;
}
