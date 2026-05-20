const VALID_INGESTION_SOURCE_TYPES = new Set<string>(["file", "url", "text"]);
const VALID_INGESTION_BACKENDS = new Set<string>(["native", "firecrawl"]);

export type IngestionSourceType = "file" | "url" | "text";
export type IngestionBackendName = "native" | "firecrawl";

export function parseIngestionSourceType(value: unknown): IngestionSourceType {
  if (typeof value !== "string" || !VALID_INGESTION_SOURCE_TYPES.has(value)) {
    throw new Error(`sourceType must be one of file|url|text (got ${JSON.stringify(value)})`);
  }
  return value as IngestionSourceType;
}

export function parseIngestionBackend(value: unknown): IngestionBackendName {
  if (value === undefined || value === null) {
    return "native";
  }
  if (typeof value !== "string" || !VALID_INGESTION_BACKENDS.has(value)) {
    throw new Error(`backend must be one of native|firecrawl (got ${JSON.stringify(value)})`);
  }
  return value as IngestionBackendName;
}
