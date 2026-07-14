import type { ResearchSearchEngine, ResearchSearchRequest, ResearchSearchResponse } from "@goatcitadel/contracts";
import { isSensitiveOfficialSearchQuery, resolveOfficialSearchProviders } from "@goatcitadel/policy-engine";

const BLOCKED_ENGINE_ALIASES = new Map<string, string>([
  ["baidu", "Baidu is excluded from the GoatCitadel US/global-English search broker."],
  ["360", "360 Search is excluded from the GoatCitadel US/global-English search broker."],
  ["so", "360 Search is excluded from the GoatCitadel US/global-English search broker."],
  ["sogou", "Sogou is excluded from the GoatCitadel US/global-English search broker."],
  ["wechat", "WeChat search is excluded from the GoatCitadel US/global-English search broker."],
  ["weixin", "WeChat search is excluded from the GoatCitadel US/global-English search broker."],
  ["shenma", "Shenma is excluded from the GoatCitadel US/global-English search broker."],
  ["googlehk", "Google HK is excluded from the GoatCitadel US/global-English search broker."],
  ["google_hk", "Google HK is excluded from the GoatCitadel US/global-English search broker."],
  ["bingcn", "Bing CN is excluded from the GoatCitadel US/global-English search broker."],
  ["bing_cn", "Bing CN is excluded from the GoatCitadel US/global-English search broker."],
]);
const LEGACY_ENGINES = new Set<ResearchSearchEngine>([
  "google",
  "bing",
  "duckduckgo",
  "brave",
  "startpage",
  "ecosia",
  "qwant",
  "wolframalpha",
  "parallel",
]);

/**
 * Operator-facing discovery endpoint. It intentionally never executes external
 * search: model/runtime execution has one governed owner, `browser.search`.
 */
export class ResearchSearchBrokerService {
  public async search(input: ResearchSearchRequest): Promise<ResearchSearchResponse> {
    const query = input.query.trim();
    const sensitiveQuery = isSensitiveOfficialSearchQuery(query);
    const mode = input.mode ?? "quick";
    const requestedProviders = resolveOfficialSearchProviders(input);
    const blockedWarnings = (input.engines ?? [])
      .map((engine) => normalizeEngineName(String(engine)))
      .map((engine) => BLOCKED_ENGINE_ALIASES.get(engine))
      .filter((value): value is string => Boolean(value));
    const unsupportedLegacyEngines = Array.from(
      new Set(
        (input.engines ?? []).filter(
          (engine): engine is ResearchSearchEngine =>
            LEGACY_ENGINES.has(engine as ResearchSearchEngine) && engine !== "brave" && engine !== "parallel",
        ),
      ),
    );

    return {
      query: sensitiveQuery ? "[redacted-sensitive-query]" : query,
      generatedAt: new Date().toISOString(),
      mode,
      routing: {
        country: "US",
        searchLanguage: "en",
        requestedProviders,
        attemptedProviders: [],
        successfulProviders: [],
        fallbackUsed: false,
        partial: false,
      },
      providerAttempts: [],
      execution: {
        kind: "advisory_only",
        executableTool: "browser.search",
        requiredBackend: "official",
        guidance: "Invoke browser.search with backend=official through the governed tool policy path.",
      },
      accounting: {
        scope: "response_local",
        persistence: "not_persisted",
        cost: "unknown",
        outboundRequests: [],
      },
      results: [],
      engineStatuses: [
        ...requestedProviders.map((provider) => ({
          engine: provider,
          status: "degraded" as const,
          message: "Advisory only. Invoke browser.search with backend=official for governed execution.",
        })),
        ...unsupportedLegacyEngines.map((engine) => ({
          engine,
          status: "unavailable" as const,
          message:
            "This compatibility engine has no executable official provider adapter; no scraping fallback is available.",
        })),
      ],
      warnings: [
        sensitiveQuery
          ? "Sensitive or internal query content was omitted; no external search was attempted."
          : "This endpoint is advisory-only and did not execute an external search.",
        ...unsupportedLegacyEngines.map((engine) => `${engine} has no executable official provider adapter.`),
        ...blockedWarnings,
      ],
    };
  }
}

export interface ResearchSearchRoutePort {
  search(input: ResearchSearchRequest): Promise<ResearchSearchResponse>;
}

export class ResearchSearchRouteService {
  public constructor(private readonly port: ResearchSearchRoutePort) {}

  public search(input: ResearchSearchRequest): Promise<ResearchSearchResponse> {
    return this.port.search(input);
  }
}

function normalizeEngineName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "");
}
