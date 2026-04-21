export interface MemoryWriteInput {
  namespace: string;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface MemorySearchQuery {
  namespace?: string;
  query: string;
  limit?: number;
  filters?: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface DocsIngestInput {
  sourceType: "file" | "url" | "text";
  source: string;
  namespace: string;
  title?: string;
  backend?: "native" | "firecrawl";
  cacheTtlSeconds?: number;
  forceRefresh?: boolean;
  chunking?: {
    targetChars?: number;
    overlapChars?: number;
    maxChunks?: number;
  };
  metadata?: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface DocsSearchInput {
  namespace?: string;
  query: string;
  limit?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface EmbeddingIndexInput {
  namespace?: string;
  documentId?: string;
  force?: boolean;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface EmbeddingQueryInput {
  namespace?: string;
  query: string;
  limit?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export type ThreadKnowledgeRetrievalMode = "full_text" | "retrieval";

export interface ThreadKnowledgeAttachmentRecord {
  attachmentId: string;
  sessionId: string;
  sourceType: "file" | "url";
  sourceRef: string;
  title: string;
  retrievalMode: ThreadKnowledgeRetrievalMode;
  ingestStatus: "queued" | "running" | "ready" | "failed";
  chunkCount?: number;
  namespace?: string;
  chatAttachmentId?: string;
  documentId?: string;
  errorMessage?: string;
  lastIngestAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadKnowledgeCitationRecord {
  attachmentId: string;
  sourceRef: string;
  title: string;
  sectionLabel?: string;
  chunkId?: string;
  excerpt?: string;
  retrievalMode: ThreadKnowledgeRetrievalMode;
}
