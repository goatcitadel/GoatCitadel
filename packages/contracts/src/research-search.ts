export type ResearchSearchEngine =
  | "google"
  | "bing"
  | "duckduckgo"
  | "brave"
  | "startpage"
  | "ecosia"
  | "qwant"
  | "wolframalpha"
  | "parallel";

export type ResearchSearchOfficialProvider = "brave" | "parallel";
export type ResearchSearchMode = "quick" | "research";

export type ResearchSearchEngineStatus = "ready" | "degraded" | "unavailable" | "blocked";
export type ResearchSearchProviderAttemptStatus =
  | "succeeded"
  | "unavailable"
  | "blocked"
  | "rate_limited"
  | "timed_out"
  | "invalid_response"
  | "upstream_error";

export interface ResearchSearchRequest {
  query: string;
  mode?: ResearchSearchMode;
  /** Preferred official providers. When present, this takes precedence over legacy `engines`. */
  providers?: ResearchSearchOfficialProvider[];
  /** Compatibility input. Only Brave and Parallel map to official provider execution. */
  engines?: ResearchSearchEngine[];
  maxResults?: number;
  freshness?: "any" | "day" | "week" | "month";
  workspaceId?: string;
}

export interface ResearchSearchCitation {
  title?: string;
  url: string;
  retrievedAt: string;
}

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet?: string;
  /** Compatibility field for existing consumers. Official results use their provider id. */
  engine: ResearchSearchEngine;
  provider?: ResearchSearchOfficialProvider;
  contributingProviders?: ResearchSearchOfficialProvider[];
  providerRank?: number;
  publishedAt?: string;
  retrievedAt: string;
  confidence: number;
  citations: ResearchSearchCitation[];
}

export interface ResearchSearchProviderAttempt {
  provider: ResearchSearchOfficialProvider;
  status: ResearchSearchProviderAttemptStatus;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  resultCount: number;
  httpStatus?: number;
  retryAfterMs?: number;
  message?: string;
}

export interface ResearchSearchRoutingEvidence {
  country: "US";
  searchLanguage: "en";
  requestedProviders: ResearchSearchOfficialProvider[];
  attemptedProviders: ResearchSearchOfficialProvider[];
  successfulProviders: ResearchSearchOfficialProvider[];
  fallbackUsed: boolean;
  partial: boolean;
}

export interface ResearchSearchExecutionDisposition {
  kind: "advisory_only" | "executed";
  executableTool: "browser.search";
  requiredBackend: "official";
  guidance: string;
}

export interface ResearchSearchAccountingDisposition {
  scope: "response_local";
  persistence: "not_persisted";
  cost: "unknown";
  outboundRequests: Array<{
    provider: ResearchSearchOfficialProvider;
    requestCount: 1;
  }>;
}

export interface ResearchSearchResponse {
  query: string;
  generatedAt: string;
  mode?: ResearchSearchMode;
  routing?: ResearchSearchRoutingEvidence;
  providerAttempts?: ResearchSearchProviderAttempt[];
  execution?: ResearchSearchExecutionDisposition;
  accounting?: ResearchSearchAccountingDisposition;
  results: ResearchSearchResult[];
  engineStatuses: Array<{
    engine: ResearchSearchEngine;
    status: ResearchSearchEngineStatus;
    message?: string;
  }>;
  warnings: string[];
}
