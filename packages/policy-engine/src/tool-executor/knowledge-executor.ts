import type {
  ContextSourceAttribution,
  IngestionBackend,
  MemoryEmbeddingProfileRequest,
  ToolExecutionTrustLevel,
  ToolInvokeRequest,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { Buffer } from "node:buffer";
import { mapWithConcurrency } from "../async-utils.js";
import { ingestDocumentViaBackend, resolveIngestionTrustLevel, searchIngestedContext } from "../ingestion-backends.js";
import { parseIngestionSourceType } from "../ingestion-source-type.js";
import { sanitizeForModel } from "../tool-security.js";
import {
  currentEmbeddingProfile,
  generateEmbedding,
  isEmbeddingCompatible,
  isEmbeddingCurrent,
  type AcquireLocalEmbeddingLease,
  type EmbeddingLeasePurpose,
  type EmbeddingRuntimeOptions,
  type PrepareEmbeddingUsageDispatch,
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
  "session.history",
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

export interface KnowledgeExecutorDeps {
  acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease;
  prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch;
  assertReadPathAllowedForRequest(
    candidate: string,
    request: ToolInvokeRequest,
    config: ToolPolicyConfig,
    storage: AsyncStorage,
  ): Promise<void>;
  fetchAllowlisted(
    url: string,
    init: RequestInit,
    allowlist: string[],
    signal?: AbortSignal,
    grantAllowlist?: string[],
  ): Promise<{ response: Response; finalUrl: string }>;
  resolveExecutionGrantAllowedHosts(request: ToolInvokeRequest, storage?: AsyncStorage): Promise<string[] | undefined>;
  resolveNetworkAllowlist(request: ToolInvokeRequest, config: ToolPolicyConfig): string[];
}

export function isKnowledgeToolName(toolName: string): boolean {
  return KNOWLEDGE_TOOL_NAMES.has(toolName);
}

export async function executeKnowledgeTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: KnowledgeExecutorDeps,
): Promise<Record<string, unknown>> {
  switch (request.toolName) {
    case "session.search":
      return sessionSearch(request, storage);
    case "session.history":
      return sessionHistory(request, storage);
    case "memory.read":
      return memoryRead(request.args, storage);
    case "memory.write":
      return memoryWrite(request, storage, false, deps);
    case "memory.upsert":
      return memoryWrite(request, storage, true, deps);
    case "memory.search":
      return memorySearch(request.args, storage);
    case "citations.build":
      return citationsBuild(request.args);
    case "docs.ingest":
      return docsIngest(request, config, storage, deps);
    case "docs.search":
      return docsSearch(request.args, storage);
    case "embeddings.index":
      return embeddingsIndex(request, storage, deps);
    case "embeddings.query":
      return embeddingsQuery(request, storage, deps);
    default:
      throw new Error(`Unsupported knowledge tool executor: ${request.toolName}`);
  }
}

async function memoryWrite(
  request: ToolInvokeRequest,
  storage: AsyncStorage,
  upsert: boolean,
  deps: KnowledgeExecutorDeps,
) {
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
  const doc = await storage.knowledge.createDocument({
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
  const canonicalUsageEventIds = new Set<string>();
  const embeddedChunks = await mapWithConcurrency(chunks, EMBEDDING_CONCURRENCY, async (chunk) => {
    const generated = await generateEmbedding(
      chunk,
      undefined,
      undefined,
      embeddingRuntimeOptions(request, deps, "memory_write"),
    );
    collectUsageEventIds(canonicalUsageEventIds, generated.modelUsageEventIds);
    return {
      content: chunk,
      embedding: generated.embedding,
      embeddingMetadata: {
        ...generated.metadata,
        ...(generated.modelUsageEventIds ? { modelUsageEventIds: generated.modelUsageEventIds } : {}),
      },
    };
  });
  await storage.knowledge.appendChunks(doc.docId, embeddedChunks);
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
    ...(canonicalUsageEventIds.size > 0 ? { modelUsageEventIds: [...canonicalUsageEventIds] } : {}),
  };
}

/**
 * P2-S4a `session.search`: read-only FTS recall over persisted chat messages.
 *
 * Defaults to the calling session (`scope:"session"`); `scope:"all"` searches the
 * calling workspace. Query sanitisation lives in the storage repo, so arbitrary user text is
 * safe here. The repo enforces sensible limit/context-radius bounds.
 */
async function sessionSearch(request: ToolInvokeRequest, storage: AsyncStorage) {
  const query = (asString(request.args.query) ?? "").trim();
  const scope = asString(request.args.scope) === "all" ? "all" : "session";
  const limit = clampInt(request.args.limit, 10, 1, 50);
  if (!query) {
    return { scope, query: "", hits: [] };
  }
  if (query.length > 512) {
    throw new Error("session.search query must be 512 characters or fewer");
  }
  const workspaceId = await resolveAuthorizedSessionWorkspace(request, storage, request.sessionId);
  const hits = await storage.chatMessages.searchMessages(query, {
    workspaceId,
    ...(scope === "session" ? { sessionId: request.sessionId } : {}),
    includeHidden: scope === "session",
    limit,
    contextRadius: 0,
  });
  const authorizedHits: typeof hits = [];
  for (const hit of hits) {
    if (
      hit.workspaceId !== workspaceId ||
      (scope === "session" && hit.sessionId !== request.sessionId) ||
      !hit.messageId ||
      !Number.isSafeInteger(hit.sequence) ||
      hit.sequence < 1
    ) {
      continue;
    }
    const meta = await storage.chatSessionMeta.get(hit.sessionId);
    if (meta?.workspaceId === workspaceId && (scope === "session" || meta.includeInHistory !== false)) {
      authorizedHits.push(hit);
      if (authorizedHits.length >= limit) break;
    }
  }
  return {
    scope,
    query: capUtf8Text(sanitizeForModel(query), 512, ""),
    hits: authorizedHits.map((hit) => ({
      workspaceId: hit.workspaceId,
      sessionId: hit.sessionId,
      messageId: hit.messageId,
      sequence: hit.sequence,
      role: hit.role,
      excerpt: capUtf8Text(sanitizeForModel(hit.content), 1_024, "\n[search excerpt truncated]"),
      timestamp: hit.timestamp,
      score: hit.score,
    })),
  };
}

async function sessionHistory(request: ToolInvokeRequest, storage: AsyncStorage) {
  const targetSessionId = (asString(request.args.sessionId) ?? request.sessionId).trim();
  const messageId = (asString(request.args.messageId) ?? "").trim();
  const sequence = clampInt(request.args.sequence, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(request.args.limit, 21, 1, 101);
  if (!messageId || sequence < 1) {
    throw new Error("session.history requires an exact messageId and positive sequence from session.search");
  }
  const workspaceId = await resolveAuthorizedSessionWorkspace(request, storage, targetSessionId);
  const window = await storage.chatMessages.readAnchoredWindow(
    { workspaceId, sessionId: targetSessionId, messageId, sequence },
    limit,
  );
  const providerWindow = capProviderSessionHistory(window.items, 64 * 1024);
  return {
    anchor: window.anchor,
    items: providerWindow.items,
    snapshotMaxSequence: window.snapshotMaxSequence,
    hasOlder: window.hasOlder || providerWindow.droppedOlder,
    hasNewer: window.hasNewer || providerWindow.droppedNewer,
    truncated: providerWindow.truncated,
    byteLength: providerWindow.byteLength,
    ...(providerWindow.anchorExceededByteLimit ? { anchorExceededByteLimit: true } : {}),
  };
}

function capProviderSessionHistory(
  source: Awaited<ReturnType<AsyncStorage["chatMessages"]["readAnchoredWindow"]>>["items"],
  maxBytes: number,
) {
  let contentWasTruncated = false;
  const safeItems = source.map((entry) => {
    const capped = capProviderMessageContent(sanitizeForModel(entry.message.content));
    contentWasTruncated ||= capped.truncated;
    return {
      sequence: entry.sequence,
      isAnchor: entry.isAnchor,
      message: {
        messageId: entry.message.messageId,
        sessionId: entry.message.sessionId,
        role: entry.message.role,
        content: capped.content,
        ...(capped.truncated ? { contentTruncated: true as const } : {}),
        timestamp: entry.message.timestamp,
      },
    };
  });
  const anchorIndex = safeItems.findIndex((entry) => entry.isAnchor);
  if (anchorIndex < 0) {
    return {
      items: [],
      truncated: safeItems.length > 0 || contentWasTruncated,
      byteLength: 2,
      anchorExceededByteLimit: false,
      droppedOlder: false,
      droppedNewer: false,
    };
  }
  let start = anchorIndex;
  let end = anchorIndex + 1;
  let items = safeItems.slice(start, end);
  let byteLength = Buffer.byteLength(JSON.stringify(items), "utf8");
  const anchorExceededByteLimit = byteLength > maxBytes;
  while (!anchorExceededByteLimit && (start > 0 || end < safeItems.length)) {
    let changed = false;
    if (start > 0) {
      const candidate = safeItems.slice(start - 1, end);
      const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (bytes <= maxBytes) {
        start -= 1;
        items = candidate;
        byteLength = bytes;
        changed = true;
      }
    }
    if (end < safeItems.length) {
      const candidate = safeItems.slice(start, end + 1);
      const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (bytes <= maxBytes) {
        end += 1;
        items = candidate;
        byteLength = bytes;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return {
    items,
    truncated: items.length < safeItems.length || contentWasTruncated || anchorExceededByteLimit,
    byteLength,
    anchorExceededByteLimit,
    droppedOlder: start > 0,
    droppedNewer: end < safeItems.length,
  };
}

function capProviderMessageContent(content: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf8") <= 16 * 1024) {
    return { content, truncated: false };
  }
  return {
    content: capUtf8Text(content, 16 * 1024, "\n[historical message truncated]"),
    truncated: true,
  };
}

function capUtf8Text(content: string, maxBytes: number, suffix: string): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(`${content.slice(0, middle)}${suffix}`, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 &&
    low < content.length &&
    isHighSurrogate(content.charCodeAt(low - 1)) &&
    isLowSurrogate(content.charCodeAt(low))
  ) {
    low -= 1;
  }
  return `${content.slice(0, low)}${suffix}`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

async function resolveAuthorizedSessionWorkspace(
  request: ToolInvokeRequest,
  storage: AsyncStorage,
  targetSessionId: string,
): Promise<string> {
  const [callingMeta, targetMeta] = await Promise.all([
    storage.chatSessionMeta.get(request.sessionId),
    storage.chatSessionMeta.get(targetSessionId),
  ]);
  const workspaceId = callingMeta?.workspaceId?.trim();
  if (
    !workspaceId ||
    !targetMeta?.workspaceId ||
    targetMeta.workspaceId !== workspaceId ||
    (request.workspaceId !== undefined && request.workspaceId.trim() !== workspaceId) ||
    (targetSessionId !== request.sessionId && targetMeta.includeInHistory === false)
  ) {
    throw new Error("Session history target is unavailable in the active workspace");
  }
  return workspaceId;
}

async function memoryRead(args: Record<string, unknown>, storage: AsyncStorage) {
  const namespace = asString(args.namespace);
  const query = (asString(args.query) ?? asString(args.title) ?? asString(args.key) ?? "").trim().toLowerCase();
  const limit = clampInt(args.limit, 5, 1, 50);
  const documents = await storage.knowledge.listDocuments(namespace, 500);
  type DocumentChunks = Awaited<ReturnType<AsyncStorage["knowledge"]["listChunksByDocument"]>>;
  const chunkMap = new Map<string, Promise<DocumentChunks>>();
  const readChunks = (docId: string): Promise<DocumentChunks> => {
    const existing = chunkMap.get(docId);
    if (existing) {
      return existing;
    }
    // Cache the in-flight read before yielding so duplicate document records
    // evaluated concurrently share one repository request.
    const next = storage.knowledge.listChunksByDocument(docId, 25);
    chunkMap.set(docId, next);
    return next;
  };

  if (!query) {
    return {
      namespace: namespace ?? "all",
      items: await Promise.all(
        documents.slice(0, limit).map(async (doc) => {
          const chunks = await readChunks(doc.docId);
          return {
            docId: doc.docId,
            title: doc.title,
            sourceRef: doc.sourceRef,
            metadata: doc.metadata,
            attribution: knowledgeDocumentAttribution(doc),
            snippet: chunks[0]?.content.slice(0, 320) ?? "",
          };
        }),
      ),
    };
  }

  const candidates = await Promise.all(
    documents.map(async (doc) => {
      const chunks = await readChunks(doc.docId);
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
    }),
  );
  const items = candidates
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return {
    namespace: namespace ?? "all",
    query,
    items,
  };
}

async function memorySearch(args: Record<string, unknown>, storage: AsyncStorage) {
  const query = required(args.query, "query").toLowerCase();
  const namespace = asString(args.namespace);
  const limit = clampInt(args.limit, 12, 1, 100);
  const [chunks, documents] = await Promise.all([
    storage.knowledge.listChunksByNamespace(namespace, 2000),
    storage.knowledge.listDocuments(namespace, 500),
  ]);
  const docById = new Map(documents.map((doc) => [doc.docId, doc] as const));
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
  doc: Awaited<ReturnType<AsyncStorage["knowledge"]["listDocuments"]>>[number],
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
  storage: AsyncStorage,
  deps: KnowledgeExecutorDeps,
) {
  const sourceType = parseIngestionSourceType(request.args.sourceType);
  if (sourceType === "file") {
    await deps.assertReadPathAllowedForRequest(String(request.args.source ?? ""), request, config, storage);
  }
  const { purpose: _purpose, ...embeddingRuntime } = embeddingRuntimeOptions(request, deps, "document_ingest");
  const ingested = await ingestDocumentViaBackend({
    request,
    storage,
    embeddingRuntime,
    networkAllowlist: deps.resolveNetworkAllowlist(request, config),
    sourceAllowlist: await deps.resolveExecutionGrantAllowedHosts(request, storage),
    fetchUrl: async (url) => {
      const res = await deps.fetchAllowlisted(
        url,
        { method: "GET" },
        deps.resolveNetworkAllowlist(request, config),
        request.signal,
        await deps.resolveExecutionGrantAllowedHosts(request, storage),
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
    ...(ingested.modelUsageEventIds ? { modelUsageEventIds: ingested.modelUsageEventIds } : {}),
  };
}

async function docsSearch(args: Record<string, unknown>, storage: AsyncStorage) {
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

async function embeddingsIndex(request: ToolInvokeRequest, storage: AsyncStorage, deps: KnowledgeExecutorDeps) {
  const args = request.args;
  const namespace = asString(args.namespace);
  const documentId = asString(args.documentId);
  const force = asBoolean(args.force, false);
  const embeddingProfileRequest = normalizeEmbeddingProfileRequest(args.embeddingProfile);
  const embeddingProfile = currentEmbeddingProfile(embeddingProfileRequest);
  const chunks = documentId
    ? await storage.knowledge.listChunksByDocument(documentId, 2000)
    : await storage.knowledge.listChunksByNamespace(namespace, 2000);
  let indexed = 0;
  let skipped = 0;
  let stale = 0;
  const methods = new Set<string>();
  const canonicalUsageEventIds = new Set<string>();
  for (const chunk of chunks) {
    const current = isEmbeddingCurrent(chunk.embedding, chunk.embeddingMetadata, embeddingProfileRequest);
    if (!force && current) {
      skipped += 1;
      continue;
    }
    if (!current && chunk.embedding) {
      stale += 1;
    }
    const generated = await generateEmbedding(
      chunk.content,
      undefined,
      embeddingProfileRequest,
      embeddingRuntimeOptions(request, deps, "embedding_index"),
    );
    collectUsageEventIds(canonicalUsageEventIds, generated.modelUsageEventIds);
    await storage.knowledge.updateChunkEmbedding(chunk.chunkId, generated.embedding, {
      ...generated.metadata,
      ...(generated.modelUsageEventIds ? { modelUsageEventIds: generated.modelUsageEventIds } : {}),
    });
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
    ...(canonicalUsageEventIds.size > 0 ? { modelUsageEventIds: [...canonicalUsageEventIds] } : {}),
  };
}

async function embeddingsQuery(request: ToolInvokeRequest, storage: AsyncStorage, deps: KnowledgeExecutorDeps) {
  const args = request.args;
  const namespace = asString(args.namespace);
  const query = required(args.query, "query");
  const limit = clampInt(args.limit, 10, 1, 100);
  const embeddingProfileRequest = normalizeEmbeddingProfileRequest(args.embeddingProfile);
  const generatedQuery = await generateEmbedding(
    query,
    undefined,
    embeddingProfileRequest,
    embeddingRuntimeOptions(request, deps, "embedding_query"),
  );
  const canonicalUsageEventIds = new Set<string>();
  collectUsageEventIds(canonicalUsageEventIds, generatedQuery.modelUsageEventIds);
  const [chunks, documents] = await Promise.all([
    storage.knowledge.listChunksByNamespace(namespace, 2000),
    storage.knowledge.listDocuments(namespace, 500),
  ]);
  const docById = new Map(documents.map((doc) => [doc.docId, doc] as const));
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
      const repaired = await generateEmbedding(
        chunk.content,
        undefined,
        embeddingProfileRequest,
        embeddingRuntimeOptions(request, deps, "embedding_repair"),
      );
      collectUsageEventIds(canonicalUsageEventIds, repaired.modelUsageEventIds);
      compatibleEmbedding = repaired.embedding;
      embeddingMetadata = {
        ...repaired.metadata,
        ...(repaired.modelUsageEventIds ? { modelUsageEventIds: repaired.modelUsageEventIds } : {}),
      };
      await storage.knowledge.updateChunkEmbedding(chunk.chunkId, repaired.embedding, embeddingMetadata);
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
    ...(canonicalUsageEventIds.size > 0 ? { modelUsageEventIds: [...canonicalUsageEventIds] } : {}),
    repairedEmbeddings,
    missingEmbeddings,
    staleEmbeddings,
  };
}

function embeddingRuntimeOptions(
  request: ToolInvokeRequest,
  deps: KnowledgeExecutorDeps,
  purpose: EmbeddingLeasePurpose,
): EmbeddingRuntimeOptions {
  return {
    purpose,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(deps.acquireLocalEmbeddingLease ? { acquireLocalServiceLease: deps.acquireLocalEmbeddingLease } : {}),
    ...(deps.prepareEmbeddingUsageDispatch ? { prepareModelUsageDispatch: deps.prepareEmbeddingUsageDispatch } : {}),
    modelUsageAttribution: {
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      durableRunId: request.runId,
      taskId: request.taskId,
      agentId: request.agentId,
      utilityKind: `tool:${request.toolName}:${purpose}`,
    },
  };
}

function collectUsageEventIds(target: Set<string>, eventIds: string[] | undefined): void {
  for (const eventId of eventIds ?? []) {
    const normalized = eventId.trim();
    if (normalized && normalized.length <= 256 && target.size < 1_000) target.add(normalized);
  }
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
