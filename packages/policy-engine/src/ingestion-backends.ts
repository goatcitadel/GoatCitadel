import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ContextSourceAttribution,
  FetchResult,
  IngestionBackend,
  NormalizedDocument,
  RetrievedContextChunk,
  ToolExecutionTrustLevel,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { stripHtmlNoiseTags, stripHtmlTags } from "./html-noise.js";

const DEFAULT_URL_CACHE_TTL_SECONDS = 3600;

interface FetchUrlResult {
  finalUrl: string;
  statusCode: number;
  contentType?: string;
  body: string;
}

export async function ingestDocumentViaBackend(input: {
  request: ToolInvokeRequest;
  storage: Storage;
  fetchUrl: (url: string) => Promise<FetchUrlResult>;
}): Promise<{
  backend: IngestionBackend;
  fetchResult: FetchResult;
  document: NormalizedDocument;
  chunksSaved: number;
  cached: boolean;
  chunks: RetrievedContextChunk[];
}> {
  const args = input.request.args;
  const sourceType = requiredString(args.sourceType, "sourceType") as "file" | "url" | "text";
  const source = requiredString(args.source, "source");
  const namespace = requiredString(args.namespace, "namespace");
  const backendName = normalizeBackend(args.backend);
  const cacheTtlSeconds =
    positiveInt(args.cacheTtlSeconds) ?? (sourceType === "url" ? DEFAULT_URL_CACHE_TTL_SECONDS : 0);
  const now = new Date();
  const cached = readCachedDocument({
    storage: input.storage,
    namespace,
    sourceType,
    source,
    backend: backendName,
    now,
  });
  if (cached && args.forceRefresh !== true) {
    return {
      backend: buildBackendDescriptor(backendName, cacheTtlSeconds),
      fetchResult: {
        backend: backendName,
        sourceType,
        sourceRef: source,
        title: cached.title,
        rawText: cached.text,
        normalizedText: cached.text,
        fetchedAt: now.toISOString(),
        fromCache: true,
        cacheExpiresAt: cached.cacheExpiresAt,
      },
      document: {
        sourceType,
        sourceRef: source,
        title: cached.title,
        text: cached.text,
        metadata: cached.metadata,
        attribution: cached.attribution,
      },
      chunksSaved: 0,
      cached: true,
      chunks: cached.chunks,
    };
  }

  const fetched = await fetchDocument({
    backend: backendName,
    request: input.request,
    fetchUrl: input.fetchUrl,
  });
  const title = optionalString(args.title) ?? fetched.title ?? `${sourceType}:${source.slice(0, 80)}`;
  const attribution: ContextSourceAttribution = {
    sourceType,
    sourceRef: source,
    title,
    backend: backendName,
    fetchedAt: fetched.fetchedAt,
    trustLevel: input.request.trustLevel ?? "trusted_workspace",
  };
  const metadata = {
    ...record(args.metadata),
    ingestion: {
      backend: backendName,
      sourceHash: stableHash(source),
      cacheExpiresAt: cacheTtlSeconds > 0 ? new Date(now.getTime() + cacheTtlSeconds * 1000).toISOString() : undefined,
      fetchedAt: fetched.fetchedAt,
      contentType: fetched.contentType,
      statusCode: fetched.statusCode,
      rawContentStored: false,
    },
  };
  const normalizedDocument: NormalizedDocument = {
    sourceType,
    sourceRef: source,
    title,
    text: fetched.normalizedText,
    metadata,
    attribution,
  };
  const chunking = record(args.chunking);
  const chunks = chunkText(
    fetched.normalizedText,
    positiveInt(chunking.targetChars) ?? 1200,
    positiveInt(chunking.overlapChars) ?? 180,
    positiveInt(chunking.maxChunks) ?? 400,
  );
  const doc = input.storage.knowledge.createDocument({
    namespace,
    sourceType,
    sourceRef: source,
    title,
    metadata,
  });
  const savedChunks = input.storage.knowledge.appendChunks(
    doc.docId,
    chunks.map((content) => ({
      content,
      embedding: pseudoEmbedding(content),
    })),
  );
  return {
    backend: buildBackendDescriptor(backendName, cacheTtlSeconds),
    fetchResult: fetched,
    document: normalizedDocument,
    chunksSaved: savedChunks.length,
    cached: false,
    chunks: savedChunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      content: chunk.content,
      score: 1,
      attribution,
    })),
  };
}

export function searchIngestedContext(input: { storage: Storage; namespace?: string; query: string; limit?: number }): {
  namespace: string;
  query: string;
  items: RetrievedContextChunk[];
} {
  const namespace = input.namespace;
  const query = input.query.trim().toLowerCase();
  const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
  const docs = input.storage.knowledge.listDocuments(namespace, 500);
  const docById = new Map(docs.map((doc) => [doc.docId, doc] as const));
  const items: RetrievedContextChunk[] = [];
  for (const chunk of input.storage.knowledge.listChunksByNamespace(namespace, 2000)) {
    const doc = docById.get(chunk.docId);
    if (!doc) {
      continue;
    }
    const score = lexicalScore(query, chunk.content.toLowerCase());
    if (score <= 0) {
      continue;
    }
    const ingestion = record(doc.metadata.ingestion);
    items.push({
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      content: chunk.content.slice(0, 640),
      score,
      attribution: {
        sourceType: doc.sourceType,
        sourceRef: doc.sourceRef,
        title: doc.title,
        backend: optionalString(ingestion.backend) as IngestionBackend["backend"] | undefined,
        fetchedAt: optionalString(ingestion.fetchedAt),
        trustLevel: optionalString(ingestion.trustLevel) as ToolExecutionTrustLevel | undefined,
      },
    });
  }
  items.sort((left, right) => right.score - left.score);
  return {
    namespace: namespace ?? "all",
    query: input.query,
    items: items.slice(0, limit),
  };
}

async function fetchDocument(input: {
  backend: IngestionBackend["backend"];
  request: ToolInvokeRequest;
  fetchUrl: (url: string) => Promise<FetchUrlResult>;
}): Promise<FetchResult> {
  const args = input.request.args;
  const sourceType = requiredString(args.sourceType, "sourceType") as "file" | "url" | "text";
  const source = requiredString(args.source, "source");
  if (sourceType === "file") {
    const rawText = await fs.readFile(path.resolve(source), "utf8");
    return {
      backend: input.backend,
      sourceType,
      sourceRef: source,
      title: optionalString(args.title),
      rawText,
      normalizedText: normalizeText(rawText),
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
  }
  if (sourceType === "text") {
    return {
      backend: input.backend,
      sourceType,
      sourceRef: source,
      title: optionalString(args.title),
      rawText: source,
      normalizedText: normalizeText(source),
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
  }

  if (input.backend === "firecrawl") {
    const firecrawlBaseUrl =
      optionalString(args.firecrawlBaseUrl) ?? process.env.FIRECRAWL_BASE_URL ?? "http://127.0.0.1:3002";
    const firecrawlTimeoutMs = positiveInt(args.firecrawlTimeoutMs) ?? 20_000;
    const firecrawlApiKeyEnv = optionalString(args.firecrawlApiKeyEnv) ?? "FIRECRAWL_API_KEY";
    const firecrawlApiKey = process.env[firecrawlApiKeyEnv]?.trim();
    const response = await fetch(`${firecrawlBaseUrl.replace(/\/$/, "")}/v2/scrape`, {
      method: "POST",
      signal: AbortSignal.timeout(firecrawlTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        ...(firecrawlApiKey ? { Authorization: `Bearer ${firecrawlApiKey}` } : {}),
      },
      body: JSON.stringify({
        url: source,
        formats: ["markdown", "html"],
      }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    const data = record(payload.data);
    const metadata = record(data.metadata);
    const markdown = optionalString(data.markdown) ?? optionalString(data.content) ?? optionalString(data.html) ?? "";
    const title = optionalString(metadata.title) ?? optionalString(data.title) ?? optionalString(args.title);
    return {
      backend: input.backend,
      sourceType,
      sourceRef: source,
      title,
      rawText: markdown,
      normalizedText: normalizeText(markdown),
      contentType: optionalString(data.markdown) || optionalString(data.content) ? "text/markdown" : "text/html",
      statusCode: response.status,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
  }

  const fetched = await input.fetchUrl(source);
  return {
    backend: input.backend,
    sourceType,
    sourceRef: fetched.finalUrl,
    title: optionalString(args.title),
    rawText: fetched.body,
    normalizedText: normalizeText(fetched.body, fetched.contentType),
    contentType: fetched.contentType,
    statusCode: fetched.statusCode,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
}

function readCachedDocument(input: {
  storage: Storage;
  namespace: string;
  sourceType: "file" | "url" | "text";
  source: string;
  backend: IngestionBackend["backend"];
  now: Date;
}):
  | {
      title: string;
      text: string;
      metadata: Record<string, unknown>;
      attribution: ContextSourceAttribution;
      cacheExpiresAt?: string;
      chunks: RetrievedContextChunk[];
    }
  | undefined {
  const docs = input.storage.knowledge.listDocuments(input.namespace, 500);
  for (const doc of docs) {
    if (doc.sourceType !== input.sourceType || doc.sourceRef !== input.source) {
      continue;
    }
    const ingestion = record(doc.metadata.ingestion);
    if ((optionalString(ingestion.backend) ?? "native") !== input.backend) {
      continue;
    }
    const cacheExpiresAt = optionalString(ingestion.cacheExpiresAt);
    if (cacheExpiresAt && new Date(cacheExpiresAt).getTime() <= input.now.getTime()) {
      continue;
    }
    const chunks = input.storage.knowledge.listChunksByDocument(doc.docId, 1000).map((chunk) => ({
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      content: chunk.content,
      score: 1,
      attribution: {
        sourceType: doc.sourceType,
        sourceRef: doc.sourceRef,
        title: doc.title,
        backend: optionalString(ingestion.backend) as IngestionBackend["backend"] | undefined,
        fetchedAt: optionalString(ingestion.fetchedAt),
      },
    }));
    return {
      title: doc.title,
      text: chunks.map((chunk) => chunk.content).join("\n\n"),
      metadata: doc.metadata,
      attribution: {
        sourceType: doc.sourceType,
        sourceRef: doc.sourceRef,
        title: doc.title,
        backend: optionalString(ingestion.backend) as IngestionBackend["backend"] | undefined,
        fetchedAt: optionalString(ingestion.fetchedAt),
      },
      cacheExpiresAt,
      chunks,
    };
  }
  return undefined;
}

function normalizeBackend(value: unknown): IngestionBackend["backend"] {
  return optionalString(value) === "firecrawl" ? "firecrawl" : "native";
}

function buildBackendDescriptor(backend: IngestionBackend["backend"], cacheTtlSeconds: number): IngestionBackend {
  return {
    backend,
    cacheTtlSeconds,
    supportsSearch: true,
    keepsRawContentOutOfPrompt: true,
  };
}

function normalizeText(rawText: string, contentType?: string): string {
  const normalized = contentType?.includes("html") ? stripHtmlContent(rawText) : rawText;
  return normalized
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripHtmlContent(input: string): string {
  return stripHtmlTags(stripHtmlNoiseTags(input, ["script", "style"]));
}

function chunkText(text: string, targetChars: number, overlapChars: number, maxChunks: number): string[] {
  const safeTarget = Math.max(300, targetChars);
  const safeOverlap = Math.max(0, Math.min(overlapChars, Math.floor(safeTarget / 2)));
  const safeMaxChunks = Math.max(1, maxChunks);
  if (!text.trim()) {
    return [];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < safeMaxChunks) {
    const next = Math.min(text.length, cursor + safeTarget);
    chunks.push(text.slice(cursor, next).trim());
    if (next >= text.length) {
      break;
    }
    cursor = Math.max(next - safeOverlap, cursor + 1);
  }
  return chunks.filter(Boolean);
}

function lexicalScore(query: string, text: string): number {
  if (!query || !text) {
    return 0;
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
}

function pseudoEmbedding(text: string): number[] {
  const buckets = new Array<number>(8).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    const bucketIndex = index % buckets.length;
    buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + text.charCodeAt(index) / 255;
  }
  return buckets.map((value) => Number(value.toFixed(4)));
}

function stableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
