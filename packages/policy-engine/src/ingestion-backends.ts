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
import { assertNotPrivateOrReservedHost, fetchAllowlisted, redactUrlForError } from "./sandbox/network-guard.js";
import { normalizeFirecrawlApiKeyEnvName } from "./safe-env-name.js";

// SECURITY (codex finding #12): `sourceType` is the discriminator that
// decides whether a URL or a local file is fetched. Previously the field was
// cast (`as "file" | "url" | "text"`) without a runtime check, so an
// attacker-supplied value like `"URL"` (uppercase) passed the policy-engine
// `sourceType === "url"` validation, then fell through to the URL-ingestion
// branch at runtime. Validate strictly here.
const VALID_SOURCE_TYPES = new Set<string>(["file", "url", "text"]);
type IngestionSourceType = "file" | "url" | "text";

function parseSourceType(value: unknown): IngestionSourceType {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!VALID_SOURCE_TYPES.has(normalized)) {
    throw new Error(`sourceType must be one of file|url|text (got ${JSON.stringify(value)})`);
  }
  return normalized as IngestionSourceType;
}

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
  const sourceType = parseSourceType(args.sourceType);
  const source = requiredString(args.source, "source");
  const namespace = requiredString(args.namespace, "namespace");
  const backendName = normalizeBackend(args.backend);
  const cacheTtlSeconds =
    positiveInt(args.cacheTtlSeconds) ?? (sourceType === "url" ? DEFAULT_URL_CACHE_TTL_SECONDS : 0);
  const now = new Date();
  const cachedDocument = readCachedDocument({
    storage: input.storage,
    namespace,
    sourceType,
    source,
    backend: backendName,
    now,
  });
  if (cachedDocument && args.forceRefresh !== true) {
    return {
      backend: buildBackendDescriptor(backendName, cacheTtlSeconds),
      fetchResult: {
        backend: backendName,
        sourceType,
        sourceRef: source,
        title: cachedDocument.title,
        rawText: cachedDocument.text,
        normalizedText: cachedDocument.text,
        fetchedAt: now.toISOString(),
        fromCache: true,
        cacheExpiresAt: cachedDocument.cacheExpiresAt,
      },
      document: {
        sourceType,
        sourceRef: source,
        title: cachedDocument.title,
        text: cachedDocument.text,
        metadata: cachedDocument.metadata,
        attribution: cachedDocument.attribution,
      },
      chunksSaved: 0,
      cached: true,
      chunks: cachedDocument.chunks,
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
  const sourceType = parseSourceType(args.sourceType);
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
    // SECURITY (codex finding #11, #23): The Firecrawl base URL and the URL
    // it scrapes are both user-controlled. We must:
    //   (a) refuse private/loopback/metadata destinations for the base URL
    //       so this endpoint cannot be used as a SSRF primitive to reach
    //       169.254.169.254, the Docker socket, or other internal hosts,
    //   (b) refuse the same for `source` so that an attacker cannot ask
    //       Firecrawl to scrape a private URL on our behalf,
    //   (c) use only Firecrawl-specific API key env names so tool args
    //       cannot exfiltrate unrelated local secrets,
    //   (d) use `fetchAllowlisted`, which does manual redirect handling
    //       and re-validates each hop plus resolved socket address against
    //       the private-host guard for the Firecrawl API request.
    const firecrawlBaseUrl =
      optionalString(args.firecrawlBaseUrl) ?? process.env.FIRECRAWL_BASE_URL ?? "http://127.0.0.1:3002";
    const firecrawlTimeoutMs = positiveInt(args.firecrawlTimeoutMs) ?? 20_000;
    const firecrawlApiKeyEnv =
      normalizeFirecrawlApiKeyEnvName(optionalString(args.firecrawlApiKeyEnv)) ??
      normalizeFirecrawlApiKeyEnvName(process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV) ??
      "FIRECRAWL_API_KEY";
    const firecrawlApiKey = process.env[firecrawlApiKeyEnv]?.trim();
    // Allow loopback for the base URL only when it matches the canonical
    // local default (so the bundled Firecrawl docker compose still works).
    let parsedBase: URL;
    try {
      parsedBase = new URL(firecrawlBaseUrl);
    } catch {
      throw new Error(`firecrawlBaseUrl is not a valid URL (${redactUrlForError(firecrawlBaseUrl)})`);
    }
    const isCanonicalLocalBase =
      (parsedBase.hostname === "127.0.0.1" || parsedBase.hostname === "localhost") && parsedBase.port === "3002";
    if (!isCanonicalLocalBase) {
      assertNotPrivateOrReservedHost(parsedBase.toString());
    }
    // Refuse to scrape a private or non-HTTP source URL — Firecrawl would
    // happily fetch it for us.
    assertHttpUrl(source, "source");
    assertNotPrivateOrReservedHost(source);

    const targetUrl = `${firecrawlBaseUrl.replace(/\/$/, "")}/v2/scrape`;
    // For canonical localhost Firecrawl we go through plain fetch so the
    // loopback allowance applies; otherwise we use fetchAllowlisted with a
    // wildcard allowlist (still blocks private hosts and resolved private IPs).
    const fetchOnce = async (): Promise<Response> => {
      const init: RequestInit = {
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
      };
      if (isCanonicalLocalBase) {
        return fetch(targetUrl, init);
      }
      return fetchAllowlisted(targetUrl, {
        allowlist: ["*"],
        timeoutMs: firecrawlTimeoutMs,
        init,
      });
    };
    const response = await fetchOnce();
    const payload = (await response.json()) as Record<string, unknown>;
    const data = record(payload.data);
    const metadata = record(data.metadata);
    // SECURITY (codex finding #11): Even though we validated the original
    // `source` URL, Firecrawl may report a different final URL after its
    // own redirect chain. If that final URL points to a private host, do
    // not return the response body — the redirect could have taken us to
    // a metadata endpoint via an open redirector.
    const reportedSourceUrl = optionalString(metadata.sourceURL) ?? optionalString(data.url);
    if (reportedSourceUrl) {
      try {
        assertHttpUrl(reportedSourceUrl, "Firecrawl final URL");
        assertNotPrivateOrReservedHost(reportedSourceUrl);
      } catch (error) {
        throw new Error(
          `Firecrawl returned a final URL on a private/reserved host; refusing to return content: ${redactUrlForError(reportedSourceUrl)}`,
          { cause: error },
        );
      }
    }
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
    buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + text.charCodeAt(index) / 255;
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
  return createHash("sha256").update(value).digest("hex");
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

function assertHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL (${redactUrlForError(value)})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https (${redactUrlForError(value)})`);
  }
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
