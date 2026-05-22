import type { ResearchSearchEngine, ResearchSearchRequest, ResearchSearchResponse } from "@goatcitadel/contracts";

const DEFAULT_ENGINES: ResearchSearchEngine[] = [
  "google",
  "bing",
  "duckduckgo",
  "brave",
  "startpage",
  "ecosia",
  "qwant",
  "wolframalpha",
];

const BLOCKED_ENGINE_ALIASES = new Map<string, string>([
  ["baidu", "Baidu is excluded from the GoatCitadel global search broker."],
  ["360", "360 Search is excluded from the GoatCitadel global search broker."],
  ["so", "360 Search is excluded from the GoatCitadel global search broker."],
  ["sogou", "Sogou is excluded from the GoatCitadel global search broker."],
  ["wechat", "WeChat search is excluded from the GoatCitadel global search broker."],
  ["weixin", "WeChat search is excluded from the GoatCitadel global search broker."],
  ["shenma", "Shenma is excluded from the GoatCitadel global search broker."],
  ["googlehk", "Google HK is excluded from the GoatCitadel global search broker."],
  ["google_hk", "Google HK is excluded from the GoatCitadel global search broker."],
  ["bingcn", "Bing CN is excluded from the GoatCitadel global search broker."],
  ["bing_cn", "Bing CN is excluded from the GoatCitadel global search broker."],
]);

const API_ENV_BY_ENGINE: Record<ResearchSearchEngine, string[]> = {
  google: ["GOATCITADEL_SEARCH_GOOGLE_API_KEY", "GOOGLE_SEARCH_API_KEY"],
  bing: ["GOATCITADEL_SEARCH_BING_API_KEY", "BING_SEARCH_API_KEY"],
  duckduckgo: ["GOATCITADEL_SEARCH_DUCKDUCKGO_API_KEY"],
  brave: ["GOATCITADEL_SEARCH_BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
  startpage: ["GOATCITADEL_SEARCH_STARTPAGE_API_KEY"],
  ecosia: ["GOATCITADEL_SEARCH_ECOSIA_API_KEY"],
  qwant: ["GOATCITADEL_SEARCH_QWANT_API_KEY"],
  wolframalpha: ["GOATCITADEL_SEARCH_WOLFRAMALPHA_APP_ID", "WOLFRAM_ALPHA_APP_ID"],
};

export class ResearchSearchBrokerService {
  public search(input: ResearchSearchRequest): ResearchSearchResponse {
    const query = input.query.trim();
    const requested = input.engines?.length ? input.engines : DEFAULT_ENGINES;
    const engines = Array.from(new Set(requested.filter(isAllowedEngine)));
    const blocked = requested
      .map((engine) => normalizeEngineName(String(engine)))
      .filter((engine) => BLOCKED_ENGINE_ALIASES.has(engine));
    const generatedAt = new Date().toISOString();
    const engineStatuses = engines.map((engine) => ({
      engine,
      status: hasConfiguredApi(engine) ? ("degraded" as const) : ("unavailable" as const),
      message: hasConfiguredApi(engine)
        ? "Official API credentials are configured, but live broker execution is not enabled in this advisory pass."
        : "No configured official API provider is available; GoatCitadel will not scrape this engine.",
    }));
    const warnings = [
      "Search broker is advisory-only until an official provider adapter is configured and enabled.",
      "No scraping fallback was attempted.",
      ...blocked.map((engine) => BLOCKED_ENGINE_ALIASES.get(engine)).filter((value): value is string => Boolean(value)),
    ];
    return {
      query,
      generatedAt,
      results: [],
      engineStatuses,
      warnings,
    };
  }
}

export interface ResearchSearchRoutePort {
  search(input: ResearchSearchRequest): ResearchSearchResponse;
}

export class ResearchSearchRouteService {
  public constructor(private readonly port: ResearchSearchRoutePort) {}

  public search(input: ResearchSearchRequest): ResearchSearchResponse {
    return this.port.search(input);
  }
}

function isAllowedEngine(value: unknown): value is ResearchSearchEngine {
  return DEFAULT_ENGINES.includes(value as ResearchSearchEngine);
}

function normalizeEngineName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "");
}

function hasConfiguredApi(engine: ResearchSearchEngine): boolean {
  return API_ENV_BY_ENGINE[engine].some((envName) => Boolean(process.env[envName]?.trim()));
}
