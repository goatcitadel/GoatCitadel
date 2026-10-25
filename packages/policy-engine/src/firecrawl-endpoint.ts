import { normalizeFirecrawlApiKeyEnvName } from "./safe-env-name.js";

/** The operator's Firecrawl connection, supplied by the host at evaluation and execution time. */
export interface FirecrawlOperatorEndpoint {
  baseUrl: string;
  apiKeyEnv?: string;
}

const DEFAULT_FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";

/**
 * Pins a Firecrawl-backed tool call to the operator endpoint. Arguments may repeat the configured
 * base URL or key variable, but a different one is refused: otherwise a model could aim Firecrawl
 * requests, and the API key sent with them, at any other allowlisted host.
 *
 * Returns undefined when the host supplies no operator endpoint (library and test hosts), so those
 * callers keep the argument and environment fallbacks.
 */
export function pinFirecrawlEndpoint(
  args: Record<string, unknown> | undefined,
  operator: FirecrawlOperatorEndpoint | undefined,
): { baseUrl: string; apiKeyEnv: string } | undefined {
  if (!operator) {
    return undefined;
  }
  const baseUrl = operator.baseUrl.trim();
  const apiKeyEnv = normalizeFirecrawlApiKeyEnvName(operator.apiKeyEnv) ?? DEFAULT_FIRECRAWL_API_KEY_ENV;
  const requestedBaseUrl = suppliedArgument(args?.firecrawlBaseUrl);
  if (requestedBaseUrl !== undefined && !sameFirecrawlEndpoint(requestedBaseUrl, baseUrl)) {
    throw new Error(operatorOwnedMessage("firecrawlBaseUrl"));
  }
  const requestedApiKeyEnv = suppliedArgument(args?.firecrawlApiKeyEnv);
  if (requestedApiKeyEnv !== undefined && normalizeFirecrawlApiKeyEnvName(requestedApiKeyEnv) !== apiKeyEnv) {
    throw new Error(operatorOwnedMessage("firecrawlApiKeyEnv"));
  }
  return { baseUrl, apiKeyEnv };
}

function operatorOwnedMessage(argument: string): string {
  return `${argument} comes from the operator's Firecrawl settings and cannot be changed by a tool call; retry without it to use the configured Firecrawl endpoint.`;
}

/** A blank value counts as absent; any other non-string value is compared as text, so it never matches. */
function suppliedArgument(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).trim();
  return text || undefined;
}

/** Same rule as the Gateway keychain lookup: origin and path, ignoring case and trailing slashes. */
function sameFirecrawlEndpoint(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const normalized = normalize(left);
  return normalized !== undefined && normalized === normalize(right);
}
