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
        namespace: input.namespace,
        title: input.title,
        content: input.content,
        tags: input.tags,
        metadata: input.metadata,
        source: input.source,
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
        namespace: input.namespace,
        query: input.query,
        limit: input.limit,
        filters: input.filters,
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
        source: input.source,
        namespace: input.namespace,
        title: input.title,
        chunking: input.chunking,
        metadata: input.metadata,
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
        namespace: input.namespace,
        documentId: input.documentId,
        force: input.force,
        embeddingProfile: input.embeddingProfile,
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
        namespace: input.namespace,
        query: input.query,
        limit: input.limit,
        embeddingProfile: input.embeddingProfile,
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_embeddings_query",
  );
}
