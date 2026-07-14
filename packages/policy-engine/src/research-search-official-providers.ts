import type {
  ResearchSearchOfficialProvider,
  ResearchSearchProviderAttempt,
  ResearchSearchRequest,
  ResearchSearchResponse,
  ResearchSearchResult,
} from "@goatcitadel/contracts";
import { redactSecretText } from "@goatcitadel/contracts";
import { assertHostAllowed, assertNotPrivateOrReservedHost, fetchAllowlisted } from "./sandbox/network-guard.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const PARALLEL_ENDPOINT = "https://api.parallel.ai/v1/search";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src", "source"]);

const PROVIDER_ENV_ALIASES: Record<ResearchSearchOfficialProvider, readonly string[]> = {
  brave: ["GOATCITADEL_SEARCH_BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
  parallel: ["GOATCITADEL_SEARCH_PARALLEL_API_KEY", "PARALLEL_API_KEY"],
};

export interface OfficialResearchSearchOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  additionalAllowlists?: string[][];
  now?: () => Date;
}

export interface OfficialResearchSearchSelectionInput {
  query?: unknown;
  backend?: unknown;
  providers?: unknown;
  engine?: unknown;
  engines?: unknown;
  mode?: unknown;
}

interface ProviderResult {
  attempt: ResearchSearchProviderAttempt;
  results: ResearchSearchResult[];
  outboundRequestMade: boolean;
}

class ProviderExecutionError extends Error {
  public constructor(
    message: string,
    public readonly status: ResearchSearchProviderAttempt["status"],
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export async function executeOfficialResearchSearch(
  input: ResearchSearchRequest,
  options: OfficialResearchSearchOptions = {},
): Promise<ResearchSearchResponse> {
  const query = input.query.trim();
  if (!query || query.length > 512) {
    throw new Error("Research search query must contain between 1 and 512 characters.");
  }
  const mode = input.mode ?? "quick";
  const requestedProviders = resolveOfficialSearchProviders(input);
  const maxResults = normalizeMaxResults(input.maxResults, mode === "quick" ? 5 : 10);
  const now = options.now ?? (() => new Date());
  const overallController = new AbortController();
  const overallTimeout = setTimeout(
    () => overallController.abort(new Error("official search timed out")),
    mode === "quick" ? 10_000 : 15_000,
  );
  const forwardAbort = () => overallController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const sensitiveQuery = isSensitiveOfficialSearchQuery(query);
    const providerResults = sensitiveQuery
      ? requestedProviders.map((provider) =>
          blockedProviderResult(provider, now, "Search query contains secret-like or private-network content."),
        )
      : mode === "research"
        ? await Promise.all(
            requestedProviders.map((provider) =>
              executeProvider(provider, input, maxResults, overallController.signal, options, now, 12_000),
            ),
          )
        : await executeQuickProviders(requestedProviders, input, maxResults, overallController.signal, options, now);

    const attempts = providerResults.map((entry) => entry.attempt);
    const successfulProviders = attempts
      .filter((attempt) => attempt.status === "succeeded")
      .map((attempt) => attempt.provider);
    const results = mergeAndRankResults(
      providerResults.flatMap((entry) => entry.results),
      maxResults,
    );
    const fallbackUsed =
      mode === "quick" &&
      attempts.length > 1 &&
      successfulProviders.length > 0 &&
      successfulProviders[0] !== requestedProviders[0];
    const warnings: string[] = [];
    if (requestedProviders.length === 0) {
      warnings.push("No supported official provider was requested; only Brave and Parallel are executable.");
    }
    if (successfulProviders.length > 0) {
      warnings.push("External search request usage persistence is deferred; no cost value was recorded.");
    }
    if (attempts.some((attempt) => attempt.status !== "succeeded")) {
      warnings.push("One or more official search providers did not complete successfully.");
    }

    return {
      query: sensitiveQuery ? "[redacted-sensitive-query]" : query,
      generatedAt: now().toISOString(),
      mode,
      routing: {
        country: "US",
        searchLanguage: "en",
        requestedProviders,
        attemptedProviders: attempts.map((attempt) => attempt.provider),
        successfulProviders,
        fallbackUsed,
        partial: successfulProviders.length > 0 && successfulProviders.length < attempts.length,
      },
      providerAttempts: attempts,
      execution: {
        kind: "executed",
        executableTool: "browser.search",
        requiredBackend: "official",
        guidance: "Official provider execution occurred through the governed browser.search tool path.",
      },
      accounting: {
        scope: "response_local",
        persistence: "not_persisted",
        cost: "unknown",
        outboundRequests: providerResults
          .filter((entry) => entry.outboundRequestMade)
          .map((entry) => ({ provider: entry.attempt.provider, requestCount: 1 as const })),
      },
      results,
      engineStatuses: attempts.map((attempt) => ({
        engine: attempt.provider,
        status:
          attempt.status === "succeeded"
            ? "ready"
            : attempt.status === "blocked"
              ? "blocked"
              : attempt.status === "unavailable"
                ? "unavailable"
                : "degraded",
        message: attempt.message,
      })),
      warnings,
    };
  } finally {
    clearTimeout(overallTimeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function isOfficialResearchSearchInvocation(input: OfficialResearchSearchSelectionInput): boolean {
  const backend = typeof input.backend === "string" ? input.backend.trim().toLowerCase() : undefined;
  const engine = typeof input.engine === "string" ? input.engine.trim().toLowerCase() : undefined;
  return backend === "official" || engine === "brave" || engine === "parallel" || Array.isArray(input.providers);
}

export function resolveOfficialSearchProviders(
  input: OfficialResearchSearchSelectionInput,
): ResearchSearchOfficialProvider[] {
  let selected: unknown[];
  if (Array.isArray(input.providers)) {
    selected = input.providers;
  } else {
    const engine = typeof input.engine === "string" ? input.engine.trim().toLowerCase() : undefined;
    if (engine === "brave" || engine === "parallel") {
      selected = [engine];
    } else if (Array.isArray(input.engines)) {
      selected = input.engines;
    } else {
      selected = input.mode === "research" ? ["brave", "parallel"] : ["brave"];
    }
  }
  return Array.from(
    new Set(
      selected
        .map((provider) => (typeof provider === "string" ? provider.trim().toLowerCase() : undefined))
        .filter(
          (provider): provider is ResearchSearchOfficialProvider => provider === "brave" || provider === "parallel",
        ),
    ),
  );
}

export function canonicalizeResearchResultUrl(value: string): string | undefined {
  if (!value || value.length > 2048) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  try {
    assertNotPrivateOrReservedHost(url.toString());
  } catch {
    return undefined;
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (url.port === "443") {
    url.port = "";
  }
  const sorted = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    );
  url.search = "";
  for (const [key, value] of sorted) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

function normalizeMaxResults(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(20, Math.max(1, Math.floor(value)));
}

async function executeQuickProviders(
  providers: ResearchSearchOfficialProvider[],
  input: ResearchSearchRequest,
  maxResults: number,
  signal: AbortSignal,
  options: OfficialResearchSearchOptions,
  now: () => Date,
): Promise<ProviderResult[]> {
  const output: ProviderResult[] = [];
  for (const provider of providers) {
    const result = await executeProvider(provider, input, maxResults, signal, options, now, 8_000);
    output.push(result);
    if (result.attempt.status === "succeeded") {
      break;
    }
  }
  return output;
}

async function executeProvider(
  provider: ResearchSearchOfficialProvider,
  input: ResearchSearchRequest,
  maxResults: number,
  signal: AbortSignal,
  options: OfficialResearchSearchOptions,
  now: () => Date,
  timeoutMs: number,
): Promise<ProviderResult> {
  const started = now();
  let outboundRequestMade = false;
  const apiKey = resolveProviderApiKey(provider, options.env ?? process.env);
  if (!apiKey) {
    return completedProviderResult(
      provider,
      started,
      now(),
      "unavailable",
      [],
      false,
      undefined,
      undefined,
      "Official provider credential is not configured.",
    );
  }
  try {
    const markOutboundRequest = () => {
      outboundRequestMade = true;
    };
    const raw =
      provider === "brave"
        ? await fetchBrave(
            input,
            maxResults,
            apiKey,
            signal,
            options.additionalAllowlists,
            timeoutMs,
            markOutboundRequest,
          )
        : await fetchParallel(input, apiKey, signal, options.additionalAllowlists, timeoutMs, markOutboundRequest);
    const completed = now();
    const results = normalizeProviderResults(provider, raw, completed.toISOString(), maxResults);
    if (results.length === 0 && raw.length > 0) {
      throw new ProviderExecutionError("Provider returned no valid HTTPS public results.", "invalid_response");
    }
    return completedProviderResult(provider, started, completed, "succeeded", results, outboundRequestMade);
  } catch (error) {
    const completed = now();
    const normalized = normalizeProviderError(error, signal);
    return completedProviderResult(
      provider,
      started,
      completed,
      normalized.status,
      [],
      outboundRequestMade,
      normalized.httpStatus,
      normalized.retryAfterMs,
      normalized.message,
    );
  }
}

async function fetchBrave(
  input: ResearchSearchRequest,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  additionalAllowlists: string[][] | undefined,
  timeoutMs: number,
  onOutboundRequest: () => void,
): Promise<Array<Record<string, unknown>>> {
  const endpoint = new URL(BRAVE_ENDPOINT);
  endpoint.searchParams.set("q", input.query.trim());
  endpoint.searchParams.set("count", String(maxResults));
  endpoint.searchParams.set("country", "US");
  endpoint.searchParams.set("search_lang", "en");
  const freshness = toBraveFreshness(input.freshness);
  if (freshness) {
    endpoint.searchParams.set("freshness", freshness);
  }
  const response = await fetchProvider(
    endpoint.toString(),
    ["api.search.brave.com"],
    additionalAllowlists,
    timeoutMs,
    { method: "GET", signal, headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
    onOutboundRequest,
  );
  const payload = asRecord(await parseProviderJson(response));
  const web = asRecord(payload.web);
  if (!Array.isArray(web.results)) {
    throw new ProviderExecutionError("Brave response omitted web results.", "invalid_response");
  }
  return web.results.filter(isRecord);
}

async function fetchParallel(
  input: ResearchSearchRequest,
  apiKey: string,
  signal: AbortSignal,
  additionalAllowlists: string[][] | undefined,
  timeoutMs: number,
  onOutboundRequest: () => void,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetchProvider(
    PARALLEL_ENDPOINT,
    ["api.parallel.ai"],
    additionalAllowlists,
    timeoutMs,
    {
      method: "POST",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ objective: input.query.trim(), search_queries: [input.query.trim().slice(0, 200)] }),
    },
    onOutboundRequest,
  );
  const payload = asRecord(await parseProviderJson(response));
  if (!Array.isArray(payload.results)) {
    throw new ProviderExecutionError("Parallel response omitted results.", "invalid_response");
  }
  return payload.results.filter(isRecord);
}

async function fetchProvider(
  endpoint: string,
  allowlist: string[],
  additionalAllowlists: string[][] | undefined,
  timeoutMs: number,
  init: RequestInit,
  onOutboundRequest: () => void,
): Promise<Response> {
  for (const additionalAllowlist of additionalAllowlists ?? []) {
    assertHostAllowed(endpoint, additionalAllowlist);
  }
  onOutboundRequest();
  const response = await fetchAllowlisted(endpoint, {
    allowlist,
    additionalAllowlists,
    timeoutMs,
    bodyReadTimeoutMs: timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    init,
  });
  if (response.ok) {
    return response;
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (response.status === 429) {
    throw new ProviderExecutionError(
      "Official search provider rate limited the request.",
      "rate_limited",
      429,
      retryAfterMs,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderExecutionError(
      "Official search provider rejected the credential or request.",
      "blocked",
      response.status,
    );
  }
  throw new ProviderExecutionError(
    "Official search provider request failed.",
    "upstream_error",
    response.status,
    retryAfterMs,
  );
}

async function parseProviderJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderExecutionError(
      `Official search provider returned invalid JSON: ${safeMessage(error)}`,
      "invalid_response",
    );
  }
}

function normalizeProviderResults(
  provider: ResearchSearchOfficialProvider,
  raw: Array<Record<string, unknown>>,
  retrievedAt: string,
  maxResults: number,
): ResearchSearchResult[] {
  const output: ResearchSearchResult[] = [];
  for (const [index, entry] of raw.entries()) {
    const url = canonicalizeResearchResultUrl(asString(entry.url) ?? "");
    const title = truncate(asString(entry.title)?.trim() ?? "", 240);
    if (!url || !title) {
      continue;
    }
    const snippet = truncate(resolveSnippet(entry), 1000) || undefined;
    const publishedAt = normalizePublishedAt(entry.publishedAt ?? entry.publish_date ?? entry.page_age ?? entry.age);
    output.push({
      title,
      url,
      snippet,
      engine: provider,
      provider,
      contributingProviders: [provider],
      providerRank: index + 1,
      publishedAt,
      retrievedAt,
      confidence: authorityConfidence(url),
      citations: [{ title, url, retrievedAt }],
    });
    if (output.length >= maxResults) {
      break;
    }
  }
  return output;
}

function mergeAndRankResults(results: ResearchSearchResult[], maxResults: number): ResearchSearchResult[] {
  const byUrl = new Map<string, ResearchSearchResult>();
  for (const result of results) {
    const existing = byUrl.get(result.url);
    if (!existing) {
      byUrl.set(result.url, result);
      continue;
    }
    const providers = Array.from(
      new Set([...(existing.contributingProviders ?? []), ...(result.contributingProviders ?? [])]),
    ).sort(providerOrder);
    existing.contributingProviders = providers;
    existing.confidence = Math.max(existing.confidence, result.confidence);
    existing.providerRank = Math.min(
      existing.providerRank ?? Number.MAX_SAFE_INTEGER,
      result.providerRank ?? Number.MAX_SAFE_INTEGER,
    );
    existing.citations = Array.from(
      new Map([...existing.citations, ...result.citations].map((citation) => [citation.url, citation])).values(),
    );
  }
  return [...byUrl.values()]
    .sort((left, right) => {
      const authority = authorityTier(left.url) - authorityTier(right.url);
      if (authority !== 0) return authority;
      const support = (right.contributingProviders?.length ?? 0) - (left.contributingProviders?.length ?? 0);
      if (support !== 0) return support;
      const provider = providerOrder(left.provider ?? "parallel", right.provider ?? "parallel");
      if (provider !== 0) return provider;
      const rank = (left.providerRank ?? Number.MAX_SAFE_INTEGER) - (right.providerRank ?? Number.MAX_SAFE_INTEGER);
      return rank !== 0 ? rank : left.url.localeCompare(right.url);
    })
    .slice(0, maxResults);
}

function completedProviderResult(
  provider: ResearchSearchOfficialProvider,
  started: Date,
  completed: Date,
  status: ResearchSearchProviderAttempt["status"],
  results: ResearchSearchResult[],
  outboundRequestMade: boolean,
  httpStatus?: number,
  retryAfterMs?: number,
  message?: string,
): ProviderResult {
  return {
    attempt: {
      provider,
      status,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      latencyMs: Math.max(0, completed.getTime() - started.getTime()),
      resultCount: results.length,
      httpStatus,
      retryAfterMs,
      message: message ? truncate(safeMessage(message), 240) : undefined,
    },
    results,
    outboundRequestMade,
  };
}

function blockedProviderResult(
  provider: ResearchSearchOfficialProvider,
  now: () => Date,
  message: string,
): ProviderResult {
  const timestamp = now();
  return completedProviderResult(provider, timestamp, timestamp, "blocked", [], false, undefined, undefined, message);
}

function normalizeProviderError(
  error: unknown,
  signal: AbortSignal,
): Pick<ResearchSearchProviderAttempt, "status" | "httpStatus" | "retryAfterMs"> & { message: string } {
  if (error instanceof ProviderExecutionError) {
    return {
      status: error.status,
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
      message: safeMessage(error),
    };
  }
  const message = safeMessage(error);
  if (signal.aborted || /timed out|abort/i.test(message)) {
    return { status: "timed_out", message: "Official search provider request timed out." };
  }
  if (/response body exceeded/i.test(message)) {
    return { status: "invalid_response", message: "Official search provider response exceeded the allowed size." };
  }
  if (/allowlist|private|reserved|redirect/i.test(message)) {
    return { status: "blocked", message };
  }
  return { status: "upstream_error", message };
}

function resolveProviderApiKey(provider: ResearchSearchOfficialProvider, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of PROVIDER_ENV_ALIASES[provider]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function isSensitiveOfficialSearchQuery(query: string): boolean {
  return (
    redactSecretText(query).redactionCount > 0 ||
    /\b(?:localhost|metadata\.google\.internal|169\.254\.169\.254|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(query) ||
    /\b[a-z0-9-]+\.(?:local|internal|lan|corp|home)\b/i.test(query) ||
    /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(query) ||
    /(?:^|\s)(?:https?:\/\/)?\[?::1\]?(?=$|[\s/:)])/i.test(query) ||
    /(?:^|\s)(?:https?:\/\/)?\[?(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):[0-9a-f:]+\]?(?=$|[\s/:)])/i.test(query) ||
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S{8,}/i.test(query) ||
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/.test(query)
  );
}

function resolveSnippet(entry: Record<string, unknown>): string {
  const direct = asString(entry.description) ?? asString(entry.snippet);
  if (direct) return direct.trim();
  if (Array.isArray(entry.excerpts)) {
    return entry.excerpts
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .trim();
  }
  return "";
}

function normalizePublishedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function toBraveFreshness(value: ResearchSearchRequest["freshness"]): string | undefined {
  if (value === "day") return "pd";
  if (value === "week") return "pw";
  if (value === "month") return "pm";
  return undefined;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = new Date(value).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function authorityTier(value: string): number {
  const url = new URL(value);
  if (url.hostname.endsWith(".gov")) return 0;
  if (url.hostname.endsWith(".edu") || /\/(?:docs?|documentation|reference)(?:\/|$)/i.test(url.pathname)) return 1;
  return 2;
}

function authorityConfidence(value: string): number {
  const tier = authorityTier(value);
  return tier === 0 ? 0.95 : tier === 1 ? 0.85 : 0.65;
}

function providerOrder(left: ResearchSearchOfficialProvider, right: ResearchSearchOfficialProvider): number {
  return (left === "brave" ? 0 : 1) - (right === "brave" ? 0 : 1);
}

function safeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return redactSecretText(raw).value;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new ProviderExecutionError("Official search provider returned an invalid object.", "invalid_response");
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
