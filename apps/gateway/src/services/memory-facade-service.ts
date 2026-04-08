import type {
  DocsIngestInput,
  EmbeddingIndexInput,
  EmbeddingQueryInput,
  MemorySearchQuery,
  MemoryWriteInput,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";

export interface MemoryFacadeHost {
  invokeAndUnwrap(
    request: ToolInvokeRequest,
    realtimeType: string,
  ): Promise<ToolInvokeResult | Record<string, unknown>>;
}

const KNOWLEDGE_SESSION = "session:operator:knowledge";
const KNOWLEDGE_AGENT = "operator";

export async function knowledgeMemoryWrite(
  host: MemoryFacadeHost,
  input: MemoryWriteInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(
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
  host: MemoryFacadeHost,
  input: MemorySearchQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(
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
  host: MemoryFacadeHost,
  input: DocsIngestInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(
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
  host: MemoryFacadeHost,
  input: EmbeddingIndexInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(
    {
      toolName: "embeddings.index",
      args: {
        namespace: input.namespace,
        documentId: input.documentId,
        force: input.force,
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_embeddings_index",
  );
}

export async function knowledgeEmbeddingsQuery(
  host: MemoryFacadeHost,
  input: EmbeddingQueryInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(
    {
      toolName: "embeddings.query",
      args: {
        namespace: input.namespace,
        query: input.query,
        limit: input.limit,
      },
      sessionId: input.sessionId ?? KNOWLEDGE_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "knowledge_embeddings_query",
  );
}
