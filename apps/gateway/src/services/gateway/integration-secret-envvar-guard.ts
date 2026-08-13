const PERMITTED_INTEGRATION_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;
const FORBIDDEN_INTEGRATION_ENV_NAMES = new Set<string>([
  // LLM provider keys - never resolvable as an integration secret because
  // an attacker-controlled connection config could otherwise exfiltrate
  // them in the Authorization header to the attacker's bridge URL.
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "REPLICATE_API_TOKEN",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "VOYAGE_API_KEY",
  "FIRECRAWL_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GLM_API_KEY",
  "MOONSHOT_API_KEY",
  // Gateway/infra secrets - broadly scoped, never an integration credential.
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

const FORBIDDEN_INTEGRATION_ENV_PREFIXES = ["GOATCITADEL_", "POSTGRES_", "AWS_"] as const;

const CATALOG_ENV_PREFIX_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "automation.gif-search": ["GIPHY_", "TENOR_"],
  "channel.imessage": ["PHOTON_"],
  "channel.qq": ["QQBOT_"],
};

const CATALOG_ENV_EXACT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "automation.camera-photo-video": ["LOCAL_AGENT_AUTH_TOKEN"],
  "automation.peekaboo-screen": ["LOCAL_AGENT_AUTH_TOKEN"],
  "platform.ios-canvas-camera-voice": ["LOCAL_AGENT_AUTH_TOKEN"],
  "platform.macos-menubar-voice": ["LOCAL_AGENT_AUTH_TOKEN"],
  "productivity.apple-notes": ["LOCAL_AGENT_AUTH_TOKEN"],
  "productivity.apple-reminders": ["LOCAL_AGENT_AUTH_TOKEN"],
  "productivity.bear": ["LOCAL_AGENT_AUTH_TOKEN"],
  "productivity.things3": ["LOCAL_AGENT_AUTH_TOKEN"],
};

export function isPermittedIntegrationSecretEnvVarName(envName: string, catalogId?: string): boolean {
  const normalized = envName.trim();
  if (!normalized || normalized.length > 128) {
    return false;
  }
  if (!PERMITTED_INTEGRATION_ENV_NAME_PATTERN.test(normalized)) {
    return false;
  }
  if (FORBIDDEN_INTEGRATION_ENV_NAMES.has(normalized.toUpperCase())) {
    return false;
  }
  const upperName = normalized.toUpperCase();
  if (FORBIDDEN_INTEGRATION_ENV_PREFIXES.some((prefix) => upperName.startsWith(prefix))) {
    return false;
  }

  const normalizedCatalogId = catalogId?.trim().toLowerCase();
  if (!normalizedCatalogId) {
    return false;
  }
  const catalogKey = normalizedCatalogId
    .split(".")
    .at(-1)
    ?.replace(/[^a-z0-9]+/gu, "_")
    .toUpperCase();
  if (!catalogKey) {
    return false;
  }
  const allowedPrefixes = [
    `${catalogKey}_`,
    `INTEGRATION_${catalogKey}_`,
    `${normalizedCatalogId.replace(/[^a-z0-9]+/gu, "_").toUpperCase()}_`,
    ...(CATALOG_ENV_PREFIX_ALIASES[normalizedCatalogId] ?? []),
  ];
  return (
    allowedPrefixes.some((prefix) => upperName.startsWith(prefix)) ||
    (CATALOG_ENV_EXACT_ALIASES[normalizedCatalogId] ?? []).includes(upperName)
  );
}
