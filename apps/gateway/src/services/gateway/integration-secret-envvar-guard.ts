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
  // Gateway/infra secrets - broadly scoped, never an integration credential.
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

export function isPermittedIntegrationSecretEnvVarName(envName: string): boolean {
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
  return true;
}
