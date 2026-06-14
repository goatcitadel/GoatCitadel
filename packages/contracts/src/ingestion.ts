import type { ToolExecutionTrustLevel } from "./internal-tooling.js";

export interface IngestionBackend {
  backend: "native" | "firecrawl";
  cacheTtlSeconds: number;
  supportsSearch: boolean;
  keepsRawContentOutOfPrompt: boolean;
}

export interface FetchResult {
  backend: IngestionBackend["backend"];
  sourceType: "file" | "url" | "text";
  sourceRef: string;
  title?: string;
  rawText: string;
  normalizedText: string;
  contentType?: string;
  statusCode?: number;
  fetchedAt: string;
  fromCache: boolean;
  cacheExpiresAt?: string;
  parser?: {
    parserId: string;
    format: "text" | "html" | "pdf" | "docx" | "xlsx" | "csv";
    pageCount?: number;
    sheetNames?: string[];
    warnings?: string[];
  };
}

export interface ContextSourceAttribution {
  sourceType: "file" | "url" | "text" | "memory" | "mcp";
  sourceRef: string;
  title?: string;
  backend?: IngestionBackend["backend"];
  fetchedAt?: string;
  trustLevel?: ToolExecutionTrustLevel;
}

export interface NormalizedDocument {
  sourceType: "file" | "url" | "text";
  sourceRef: string;
  title: string;
  text: string;
  metadata: Record<string, unknown>;
  attribution: ContextSourceAttribution;
}

export interface RetrievedContextChunk {
  chunkId?: string;
  docId?: string;
  content: string;
  score: number;
  attribution: ContextSourceAttribution;
}
