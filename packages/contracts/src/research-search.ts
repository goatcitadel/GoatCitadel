export type ResearchSearchEngine =
  | "google"
  | "bing"
  | "duckduckgo"
  | "brave"
  | "startpage"
  | "ecosia"
  | "qwant"
  | "wolframalpha";

export type ResearchSearchEngineStatus = "ready" | "degraded" | "unavailable" | "blocked";

export interface ResearchSearchRequest {
  query: string;
  engines?: ResearchSearchEngine[];
  maxResults?: number;
  freshness?: "any" | "day" | "week" | "month";
  workspaceId?: string;
}

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet?: string;
  engine: ResearchSearchEngine;
  retrievedAt: string;
  confidence: number;
  citations: Array<{
    title?: string;
    url: string;
    retrievedAt: string;
  }>;
}

export interface ResearchSearchResponse {
  query: string;
  generatedAt: string;
  results: ResearchSearchResult[];
  engineStatuses: Array<{
    engine: ResearchSearchEngine;
    status: ResearchSearchEngineStatus;
    message?: string;
  }>;
  warnings: string[];
}
