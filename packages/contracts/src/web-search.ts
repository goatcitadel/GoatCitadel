/** Built-in browser search engines that `browser.search` can drive without an API key. */
export const WEB_SEARCH_NATIVE_ENGINES = ["duckduckgo", "bing", "google"] as const;

export type WebSearchNativeEngine = (typeof WEB_SEARCH_NATIVE_ENGINES)[number];

/** Default native engine order: the first entry is the default, the rest are the backup order. */
export const DEFAULT_WEB_SEARCH_ENGINE_ORDER: readonly WebSearchNativeEngine[] = ["duckduckgo", "bing", "google"];

export function isWebSearchNativeEngine(value: unknown): value is WebSearchNativeEngine {
  return typeof value === "string" && (WEB_SEARCH_NATIVE_ENGINES as readonly string[]).includes(value);
}

/**
 * Validates an operator engine order: one to three distinct known engines. Engines left out
 * are not used by `browser.search` or the Chat search fallback.
 */
export function isWebSearchEngineOrder(value: unknown): value is readonly WebSearchNativeEngine[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= WEB_SEARCH_NATIVE_ENGINES.length &&
    value.every(isWebSearchNativeEngine) &&
    new Set(value).size === value.length
  );
}

/** Returns a valid engine order, falling back to the default for missing or invalid input. */
export function normalizeWebSearchEngineOrder(value: unknown): WebSearchNativeEngine[] {
  if (!Array.isArray(value)) return [...DEFAULT_WEB_SEARCH_ENGINE_ORDER];
  const engines = [...new Set(value.map((item) => (typeof item === "string" ? item.trim().toLowerCase() : item)))];
  const known = engines.filter(isWebSearchNativeEngine);
  return known.length > 0 ? known : [...DEFAULT_WEB_SEARCH_ENGINE_ORDER];
}

/**
 * Engines to try for one search: an explicitly requested engine first when the operator allows it,
 * then the operator order. A requested engine outside the order is ignored.
 */
export function resolveWebSearchEngineCandidates(
  requestedEngine: unknown,
  engineOrder: unknown,
): WebSearchNativeEngine[] {
  const order = normalizeWebSearchEngineOrder(engineOrder);
  const requested = typeof requestedEngine === "string" ? requestedEngine.trim().toLowerCase() : "";
  if (!isWebSearchNativeEngine(requested) || !order.includes(requested)) return order;
  return [requested, ...order.filter((engine) => engine !== requested)];
}

/** Web-search credentials the Settings page can store in the OS keychain. */
export const WEB_SEARCH_CREDENTIAL_TARGET_IDS = ["search.firecrawl", "search.brave", "search.parallel"] as const;

export type WebSearchCredentialTargetId = (typeof WEB_SEARCH_CREDENTIAL_TARGET_IDS)[number];

export function isWebSearchCredentialTargetId(value: unknown): value is WebSearchCredentialTargetId {
  return typeof value === "string" && (WEB_SEARCH_CREDENTIAL_TARGET_IDS as readonly string[]).includes(value);
}

/** Runtime Change Plan operations owned by Settings › Web & Search. */
export type WebSearchRuntimeOperation =
  | {
      readonly operation: "web_search_configuration";
      /** Native engines in order: the first is the default, the rest are the backup order. */
      readonly config: { readonly engineOrder: readonly WebSearchNativeEngine[] };
    }
  | {
      /** The key itself enters only through the Gateway secure-input owner, never the plan. */
      readonly operation: "web_search_credential";
      readonly targetId: WebSearchCredentialTargetId;
      readonly action: "replace" | "remove";
    };

export function isWebSearchRuntimeOperation(value: unknown): value is WebSearchRuntimeOperation {
  if (!isRecord(value)) return false;
  if (value.operation === "web_search_configuration") {
    return (
      hasExactKeys(value, ["operation", "config"]) &&
      isRecord(value.config) &&
      hasExactKeys(value.config, ["engineOrder"]) &&
      isWebSearchEngineOrder(value.config.engineOrder)
    );
  }
  return (
    value.operation === "web_search_credential" &&
    hasExactKeys(value, ["operation", "targetId", "action"]) &&
    isWebSearchCredentialTargetId(value.targetId) &&
    (value.action === "replace" || value.action === "remove")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects any key outside `allowed`, so an extra field (such as a key value) fails the intent. */
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Secret-free credential projection. The key value never leaves the Gateway credential owner. */
export interface WebSearchCredentialStatus {
  readonly targetId: WebSearchCredentialTargetId;
  readonly label: string;
  /** The host the key is sent to. Firecrawl uses the configured base URL. */
  readonly endpointHost: string;
  readonly endpointAllowlisted: boolean;
  readonly keychainAvailable: boolean;
  readonly keychainConfigured: boolean;
  /** Environment variable names checked as the fallback, in order. */
  readonly envNames: readonly string[];
  readonly envConfigured: boolean;
  /** Which source a tool call would use right now. The keychain wins over the environment. */
  readonly activeSource: "keychain" | "env" | "none";
  readonly acquisitionUrl: string;
}

export interface WebSearchCredentialsResponse {
  readonly items: readonly WebSearchCredentialStatus[];
}

/** Result of a read-only Firecrawl reachability and key check. */
export interface FirecrawlConnectionCheck {
  readonly status: "ok" | "reachable" | "unauthorized" | "unreachable" | "blocked";
  readonly baseUrl: string;
  readonly checkedAt: string;
  readonly httpStatus?: number;
  readonly keySource: "keychain" | "env" | "none";
  /** Remaining credits when the hosted API reports them. */
  readonly remainingCredits?: number;
  readonly message: string;
}
