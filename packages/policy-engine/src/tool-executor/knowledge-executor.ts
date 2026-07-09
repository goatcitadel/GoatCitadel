import type {
  ContextSourceAttribution,
  IngestionBackend,
  MemoryEmbeddingProfileRequest,
  ToolExecutionTrustLevel,
  ToolInvokeRequest,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { mapWithConcurrency } from "../async-utils.js";
import { ingestDocumentViaBackend, resolveIngestionTrustLevel, searchIngestedContext } from "../ingestion-backends.js";
import { parseIngestionSourceType } from "../ingestion-source-type.js";
import {
  currentEmbeddingProfile,
  generateEmbedding,
  isEmbeddingCompatible,
  isEmbeddingCurrent,
} from "../local-embeddings.js";

const EMBEDDING_CONCURRENCY = 8;
const TRUST_RESTRICTIVENESS: Record<ToolExecutionTrustLevel, number> = {
  trusted_operator: 0,
  trusted_workspace: 1,
  mixed_untrusted: 2,
  untrusted_external: 3,
};
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const KNOWLEDGE_TOOL_NAMES = new Set([
  "session.search",
  "memory.read",
  "memory.write",
  "memory.upsert",
  "memory.search",
  "citations.build",
  "docs.ingest",
  "docs.search",
  "embeddings.index",
  "embeddings.query",
]);

export type ToolFamilyExecutor = (
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: Storage,
) => Promise<Record<string, unknown>>;

export interface KnowledgeExecutorDeps {
  assertReadPathAllowedForRequest(
    candidate: string,
    request: ToolInvokeRequest,
    config: ToolPolicyConfig,
    storage: Storage,
  ): void;
  fetchAllowlisted(
    url: string,
    init: RequestInit,
    allowlist: string[],
    signal?: AbortSignal,
    grantAllowlist?: string[],
  ): Promise<{ response: Response; finalUrl: string }>;
  resolveExecutionGrantAllowedHosts(request: ToolInvokeRequest, storage?: Storage): string[] | undefined;
  resolveNetworkAllowlist(request: ToolInvokeRequest, config: ToolPolicyConfig): string[];
}

export function isKnowledgeToolName(toolName: string): boolean {
  return KNOWLEDGE_TOOL_NAMES.has(toolName);
}

export async function executeKnowledgeTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: Storage,
  deps: KnowledgeExecutorDeps,
): Promise<Record<string, unknown>> {
  switch (request.toolName) {
    case "session.search":
      return sessionSearch(request, storage);
    case "memory.read":
      return memoryRead(request.args, storage);
    case "memory.write":
      return memoryWrite(request, storage, false);
    case "memory.upsert":
      return memoryWrite(request, storage, true);
    case "memory.search":
      return memorySearch(request.args, storage);
    case "citations.build":
      return citationsBuild(request.args);
    case "docs.ingest":
      return docsIngest(request, config, storage, deps);
    case "docs.search":
      return docsSearch(request.args, storage);
    case "embeddings.index":
      return embeddingsIndex(request.args, storage);
    case "embeddings.query":
      return embeddingsQuery(request.args, storage);
    default:
      throw new Error(`Unsupported knowledge tool executor: ${request.toolName}`);
  }
}

async function memoryWrite(request: ToolInvokeRequest, storage: Storage, upsert: boolean) {
  const args = request.args;
  const namespace = required(args.namespace, "namespace");
  const title = required(args.title, "title");
  const content = required(args.content, "content");
  const inputMetadata = record(args.metadata);
  const sourceAttribution = normalizeSourceAttributionForStorage(request.sourceAttribution);
  const carriedTrustLevel = resolveMostRestrictiveSourceTrustLevel(sourceAttribution);
  const ingestionMetadata = {
    ...record(inputMetadata.ingestion),
    ...(carriedTrustLevel ? { trustLevel: carriedTrustLevel } : {}),
  };
  const doc = storage.knowledge.createDocument({
    namespace,
    sourceType: "memory",
    sourceRef: upsert ? `upsert:${namespace}:${title}` : `memory:${Date.now()}`,
    title,
    metadata: {
      tags: stringArray(args.tags),
      ...inputMetadata,
      ...(sourceAttribution.length > 0 ? { sourceAttribution } : {}),
      ...(Object.keys(ingestionMetadata).length > 0 ? { ingestion: ingestionMetadata } : {}),
    },
  });
  const chunks = chunkText(content, 1200, 180, 400);
  const embeddedChunks = await mapWithConcurrency(chunks, EMBEDDING_CONCURRENCY, async (chunk) => {
    const generated = await generateEmbedding(chunk);
    return {
      content: chunk,
      embedding: generated.embedding,
      embeddingMetadata: generated.metadata,
    };
  });
  storage.knowledge.appendChunks(doc.docId, embeddedChunks);
  const attribution = knowledgeDocumentAttribution(doc);
  return {
    mode: upsert ? "upsert" : "write",
    document: {
      ...doc,
      attribution,
    },
    attribution,
    ...(sourceAttribution.length > 0 ? { sourceAttribution } : {}),
    chunksSaved: chunks.length,
  };
}

/**
 * P2-S4a `session.search`: read-only FTS recall over persisted chat messages.
 *
 * Defaults to the calling session (`scope:"session"`); `scope:"all"` searches every
 * session. Query sanitisation lives in the storage repo, so arbitrary user text is
 * safe here. The repo enforces sensible limit/context-radius bounds.
 */
function sessionSearch(request: ToolInvokeRequest, storage: Storage) {
  const query = (asString(request.args.query) ?? "").trim();
  const scope = asString(request.args.scope) === "all" ? "all" : "session";
  const limit = clampInt(request.args.limit, 10, 1, 50);
  const contextRadius = clampInt(request.args.contextRadius, 2, 0, 10);
  if (!query) {
    return { scope, query: "", hits: [] };
  }
  const hits = storage.chatMessages.searchMessages(query, {
    ...(scope === "session" ? { sessionId: request.sessionId } : {}),
    limit,
    contextRadius,
  });
  return { scope, query, hits };
}

async function memoryRead(args: Record<string, unknown>, storage: Storage) {
  const namespace = asString(args.namespace);
  const query = (asString(args.query) ?? asString(args.title) ?? asString(args.key) ?? "").trim().toLowerCase();
  const limit = clampInt(args.limit, 5, 1, 50);
  const documents = storage.knowledge.listDocuments(namespace, 500);
  const chunkMap = new Map<string, ReturnType<Storage["knowledge"]["listChunksByDocument"]>>();
  const readChunks = (docId: string) => {
    const existing = chunkMap.get(docId);
    if (existing) {
      return existing;
    }
    const next = storage.knowledge.listChunksByDocument(docId, 25);
    chunkMap.set(docId, next);
    return next;
  };

  if (!query) {
    return {
      namespace: namespace ?? "all",
      items: documents.slice(0, limit).map((doc) => {
        const chunks = readChunks(doc.docId);
        return {
          docId: doc.docId,
          title: doc.title,
          sourceRef: doc.sourceRef,
          metadata: doc.metadata,
          attribution: knowledgeDocumentAttribution(doc),
          snippet: chunks[0]?.content.slice(0, 320) ?? "",
        };
      }),
    };
  }

  const items = documents
    .map((doc) => {
      const chunks = readChunks(doc.docId);
      const titleScore = scoreLexical(query, `${doc.title} ${doc.sourceRef}`.toLowerCase());
      const bestChunk = chunks
        .map((chunk) => ({
          chunk,
          score: scoreLexical(query, chunk.content.toLowerCase()),
        }))
        .sort((left, right) => right.score - left.score)[0];
      const score = Math.max(titleScore, bestChunk?.score ?? 0);
      return score > 0
        ? {
            docId: doc.docId,
            title: doc.title,
            sourceRef: doc.sourceRef,
            metadata: doc.metadata,
            attribution: knowledgeDocumentAttribution(doc),
            score,
            snippet: bestChunk?.chunk.content.slice(0, 320) ?? "",
          }
        : undefined;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return {
    namespace: namespace ?? "all",
    query,
    items,
  };
}

async function memorySearch(args: Record<string, unknown>, storage: Storage) {
  const query = required(args.query, "query").toLowerCase();
  const namespace = asString(args.namespace);
  const limit = clampInt(args.limit, 12, 1, 100);
  const chunks = storage.knowledge.listChunksByNamespace(namespace, 2000);
  const docById = new Map(storage.knowledge.listDocuments(namespace, 500).map((doc) => [doc.docId, doc] as const));
  const items = chunks
    .map((chunk) => {
      const doc = docById.get(chunk.docId);
      if (!doc) {
        return undefined;
      }
      return {
        chunkId: chunk.chunkId,
        docId: chunk.docId,
        score: scoreLexical(query, chunk.content.toLowerCase()),
        snippet: chunk.content.slice(0, 320),
        attribution: knowledgeDocumentAttribution(doc),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { namespace: namespace ?? "all", query, items };
}

function knowledgeDocumentAttribution(
  doc: ReturnType<Storage["knowledge"]["listDocuments"]>[number],
): ContextSourceAttribution {
  const ingestion = record(doc.metadata.ingestion);
  const backend = asString(ingestion.backend);
  return {
    sourceType: doc.sourceType,
    sourceRef: doc.sourceRef,
    title: doc.title,
    ...(backend === "native" || backend === "firecrawl" ? { backend: backend as IngestionBackend["backend"] } : {}),
    ...(asString(ingestion.fetchedAt) ? { fetchedAt: asString(ingestion.fetchedAt) } : {}),
    trustLevel: resolveIngestionTrustLevel(doc.sourceType, ingestion.trustLevel),
  };
}

function normalizeSourceAttributionForStorage(
  sourceAttribution: ToolInvokeRequest["sourceAttribution"],
): ContextSourceAttribution[] {
  return (sourceAttribution ?? []).map((source) => ({
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    ...(source.title ? { title: source.title } : {}),
    ...(source.backend ? { backend: source.backend } : {}),
    ...(source.fetchedAt ? { fetchedAt: source.fetchedAt } : {}),
    trustLevel: resolveIngestionTrustLevel(source.sourceType, source.trustLevel),
  }));
}

function resolveMostRestrictiveSourceTrustLevel(
  sourceAttribution: readonly ContextSourceAttribution[],
): ToolExecutionTrustLevel | undefined {
  let effectiveTrust: ToolExecutionTrustLevel | undefined;
  for (const source of sourceAttribution) {
    const sourceTrust = resolveIngestionTrustLevel(source.sourceType, source.trustLevel);
    if (!effectiveTrust || TRUST_RESTRICTIVENESS[sourceTrust] > TRUST_RESTRICTIVENESS[effectiveTrust]) {
      effectiveTrust = sourceTrust;
    }
  }
  return effectiveTrust;
}

function citationsBuild(args: Record<string, unknown>) {
  const rawSources = Array.isArray(args.sources) ? args.sources : [];
  const results = rawSources
    .map((entry, index) => {
      const source = record(entry);
      const url = asString(source.url);
      if (!url) {
        return undefined;
      }
      return {
        citationId: asString(source.citationId) ?? `citation-${index + 1}`,
        title: asString(source.title),
        url,
        snippet: asString(source.snippet) ?? asString(source.description),
        sourceType: asString(source.sourceType) ?? "web",
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  return {
    count: results.length,
    results,
    citations: results,
    builtAt: new Date().toISOString(),
  };
}

async function docsIngest(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: Storage,
  deps: KnowledgeExecutorDeps,
) {
  const sourceType = parseIngestionSourceType(request.args.sourceType);
  if (sourceType === "file") {
    deps.assertReadPathAllowedForRequest(String(request.args.source ?? ""), request, config, storage);
  }
  const ingested = await ingestDocumentViaBackend({
    request,
    storage,
    networkAllowlist: deps.resolveNetworkAllowlist(request, config),
    sourceAllowlist: deps.resolveExecutionGrantAllowedHosts(request, storage),
    fetchUrl: async (url) => {
      const res = await deps.fetchAllowlisted(
        url,
        { method: "GET" },
        deps.resolveNetworkAllowlist(request, config),
        request.signal,
        deps.resolveExecutionGrantAllowedHosts(request, storage),
      );
      const body = await res.response.text();
      return {
        finalUrl: res.finalUrl,
        statusCode: res.response.status,
        contentType: res.response.headers.get("content-type") ?? undefined,
        body,
      };
    },
  });
  return {
    backend: ingested.backend,
    fetchResult: ingested.fetchResult,
    document: ingested.document,
    chunksSaved: ingested.chunksSaved,
    cached: ingested.cached,
    chunks: ingested.chunks,
  };
}

function docsSearch(args: Record<string, unknown>, storage: Storage) {
  const query = required(args.query, "query");
  const namespace = asString(args.namespace);
  const limit = clampInt(args.limit, 8, 1, 50);
  return searchIngestedContext({
    storage,
    namespace,
    query,
    limit,
  });
}

async function embeddingsIndex(args: Record<string, unknown>, storage: Storage) {
  const namespace = asString(args.namespace);
  const documentId = asString(args.documentId);
  const force = asBoolean(args.force, false);
  const embeddingProfileRequest = normalizeEmbeddingProfileRequest(args.embeddingProfile);
  const embeddingProfile = currentEmbeddingProfile(embeddingProfileRequest);
  const chunks = documentId
    ? storage.knowledge.listChunksByDocument(documentId, 2000)
    : storage.knowledge.listChunksByNamespace(namespace, 2000);
  let indexed = 0;
  let skipped = 0;
  let stale = 0;
  const methods = new Set<string>();
  for (const chunk of chunks) {
    const current = isEmbeddingCurrent(chunk.embedding, chunk.embeddingMetadata, embeddingProfileRequest);
    if (!force && current) {
      skipped += 1;
      continue;
    }
    if (!current && chunk.embedding) {
      stale += 1;
    }
    const generated = await generateEmbedding(chunk.content, undefined, embeddingProfileRequest);
    storage.knowledge.updateChunkEmbedding(chunk.chunkId, generated.embedding, generated.metadata);
    methods.add(generated.method);
    indexed += 1;
  }
  return {
    namespace: namespace ?? "all",
    documentId,
    indexed,
    skipped,
    stale,
    methods: [...methods],
    embeddingProfile,
  };
}

async function embeddingsQuery(args: Record<string, unknown>, storage: Storage) {
  const namespace = asString(args.namespace);
  const query = required(args.query, "query");
  const limit = clampInt(args.limit, 10, 1, 100);
  const embeddingProfileRequest = normalizeEmbeddingProfileRequest(args.embeddingProfile);
  const generatedQuery = await generateEmbedding(query, undefined, embeddingProfileRequest);
  const chunks = storage.knowledge.listChunksByNamespace(namespace, 2000);
  const docById = new Map(storage.knowledge.listDocuments(namespace, 500).map((doc) => [doc.docId, doc] as const));
  let repairedEmbeddings = 0;
  let missingEmbeddings = 0;
  let staleEmbeddings = 0;
  const scoredItems = await mapWithConcurrency(chunks, EMBEDDING_CONCURRENCY, async (chunk) => {
    const doc = docById.get(chunk.docId);
    if (!doc) {
      return undefined;
    }
    let compatibleEmbedding: number[];
    let embeddingMetadata = chunk.embeddingMetadata;
    let embeddingStatus: "used" | "generated" | "reindexed" = "used";
    if (isEmbeddingCompatible(chunk.embedding, chunk.embeddingMetadata, generatedQuery.metadata)) {
      compatibleEmbedding = chunk.embedding;
    } else {
      if (chunk.embedding) {
        staleEmbeddings += 1;
        embeddingStatus = "reindexed";
      } else {
        missingEmbeddings += 1;
        embeddingStatus = "generated";
      }
      const repaired = await generateEmbedding(chunk.content, undefined, embeddingProfileRequest);
      compatibleEmbedding = repaired.embedding;
      embeddingMetadata = repaired.metadata;
      storage.knowledge.updateChunkEmbedding(chunk.chunkId, repaired.embedding, repaired.metadata);
      repairedEmbeddings += 1;
    }
    return {
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      score: cosine(generatedQuery.embedding, compatibleEmbedding),
      snippet: chunk.content.slice(0, 320),
      attribution: knowledgeDocumentAttribution(doc),
      embeddingMetadata,
      embeddingStatus,
    };
  });
  const items = scoredItems
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    namespace: namespace ?? "all",
    query,
    items,
    method: generatedQuery.method,
    embedding: {
      provider: generatedQuery.metadata.provider,
      modelId: generatedQuery.metadata.modelId,
      dimensions: generatedQuery.metadata.dimensions,
      version: generatedQuery.metadata.version,
      ...(generatedQuery.metadata.fallbackReason ? { fallbackReason: generatedQuery.metadata.fallbackReason } : {}),
    },
    embeddingProfile: generatedQuery.profile,
    repairedEmbeddings,
    missingEmbeddings,
    staleEmbeddings,
  };
}

function normalizeEmbeddingProfileRequest(value: unknown): MemoryEmbeddingProfileRequest | undefined {
  const input = record(value);
  const provider = asString(input.provider);
  const modelId = asString(input.modelId);
  const profileId = asString(input.profileId);
  const dimensions =
    typeof input.dimensions === "number" && Number.isFinite(input.dimensions)
      ? Math.floor(input.dimensions)
      : undefined;
  if (!provider && !modelId && !profileId && dimensions === undefined) {
    return undefined;
  }
  return {
    provider,
    modelId,
    profileId,
    dimensions,
  };
}

function chunkText(text: string, targetChars: number, overlap: number, maxChunks: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length && out.length < maxChunks) {
    const end = Math.min(trimmed.length, cursor + targetChars);
    const chunk = trimmed.slice(cursor, end).trim();
    if (chunk) out.push(chunk);
    if (end >= trimmed.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function scoreLexical(query: string, candidate: string): number {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      continue;
    }
    out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function required(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
}
