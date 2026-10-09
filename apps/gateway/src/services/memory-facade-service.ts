import type {
  DocsIngestInput,
  EmbeddingIndexInput,
  EmbeddingQueryInput,
  MemorySearchQuery,
  MemoryWriteInput,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";

export interface KnowledgeFacadePort {
  invokeAndUnwrap(
    request: ToolInvokeRequest,
    realtimeType: string,
  ): Promise<ToolInvokeResult | Record<string, unknown>>;
}

// Omit absent optional executable arguments before policy evaluation. JSON-backed
// approval persistence drops undefined keys; the strict mutation guard must stay intact.
const KNOWLEDGE_SESSION = "session:operator:knowledge";
const KNOWLEDGE_AGENT = "operator";

export class KnowledgeFacadeService {
  public constructor(private readonly deps: KnowledgeFacadePort) {}

  public knowledgeMemoryWrite(input: MemoryWriteInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeMemoryWrite(this.deps, input);
  }

  public knowledgeMemorySearch(input: MemorySearchQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeMemorySearch(this.deps, input);
  }

  public knowledgeDocsIngest(input: DocsIngestInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeDocsIngest(this.deps, input);
  }

  public knowledgeEmbeddingsIndex(input: EmbeddingIndexInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeEmbeddingsIndex(this.deps, input);
  }

  public knowledgeEmbeddingsQuery(input: EmbeddingQueryInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeEmbeddingsQuery(this.deps, input);
  }
}

export async function knowledgeMemoryWrite(
  deps: KnowledgeFacadePort,
  input: MemoryWriteInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return deps.invokeAndUnwrap(
    {
      toolName: "memory.write",
      args: {
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        content: input.content,
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_memory_write",
  );
}

export async function knowledgeMemorySearch(
  deps: KnowledgeFacadePort,
  input: MemorySearchQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return deps.invokeAndUnwrap(
    {
      toolName: "memory.search",
      args: {
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.filters !== undefined ? { filters: input.filters } : {}),
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_memory_search",
  );
}

export async function knowledgeDocsIngest(
  deps: KnowledgeFacadePort,
  input: DocsIngestInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return deps.invokeAndUnwrap(
    {
      toolName: "docs.ingest",
      args: {
        sourceType: input.sourceType,
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.chunking !== undefined ? { chunking: input.chunking } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_docs_ingest",
  );
}

export async function knowledgeEmbeddingsIndex(
  deps: KnowledgeFacadePort,
  input: EmbeddingIndexInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return deps.invokeAndUnwrap(
    {
      toolName: "embeddings.index",
      args: {
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.embeddingProfile !== undefined ? { embeddingProfile: input.embeddingProfile } : {}),
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_embeddings_index",
  );
}

export async function knowledgeEmbeddingsQuery(
  deps: KnowledgeFacadePort,
  input: EmbeddingQueryInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return deps.invokeAndUnwrap(
    {
      toolName: "embeddings.query",
      args: {
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.embeddingProfile !== undefined ? { embeddingProfile: input.embeddingProfile } : {}),
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_embeddings_query",
  );
}
