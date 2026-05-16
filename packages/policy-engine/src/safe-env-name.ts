const SAFE_ENV_KEY_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const FIRECRAWL_API_KEY_ENV_NAMES = new Set(["FIRECRAWL_API_KEY", "FIRECRAWL_KEY", "GOATCITADEL_FIRECRAWL_API_KEY"]);

export function normalizeSafeEnvKeyName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return SAFE_ENV_KEY_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function normalizeSafeEnvKeyNames(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const value of values) {
    const key = normalizeSafeEnvKeyName(value);
    if (key) {
      normalized.add(key);
    }
  }
  return [...normalized];
}

export function normalizeFirecrawlApiKeyEnvName(value: unknown): string | undefined {
  const key = normalizeSafeEnvKeyName(value);
  return key && FIRECRAWL_API_KEY_ENV_NAMES.has(key) ? key : undefined;
}
