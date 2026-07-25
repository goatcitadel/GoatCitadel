import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export interface KnowledgeDocumentRecord {
  docId: string;
  namespace: string;
  sourceType: "file" | "url" | "text" | "memory" | "external_source_snapshot";
  sourceRef: string;
  title: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeChunkRecord {
  chunkId: string;
  docId: string;
  seq: number;
  content: string;
  embedding?: number[];
  embeddingMetadata?: Record<string, unknown>;
  tokenEstimate: number;
  createdAt: string;
}

interface KnowledgeDocumentRow {
  doc_id: string;
  namespace: string;
  source_type: "file" | "url" | "text" | "memory" | "external_source_snapshot";
  source_ref: string;
  title: string;
  metadata_json: string;
  created_at: string;
}

interface KnowledgeChunkRow {
  chunk_id: string;
  doc_id: string;
  seq: number;
  content: string;
  embedding_json: string | null;
  embedding_metadata_json?: string | null;
  token_estimate: number;
  created_at: string;
}

export class KnowledgeRepository {
  private readonly insertDocumentStmt;
  private readonly insertChunkStmt;
  private readonly listChunksByNamespaceStmt;
  private readonly listChunksStmt;
  private readonly listChunksByDocStmt;
  private readonly listDocumentsStmt;
  private readonly listDocumentsByNamespaceStmt;
  private readonly getDocumentStmt;
  private readonly updateChunkEmbeddingStmt;
  private readonly deleteChunksByNamespaceStmt;
  private readonly deleteDocumentsByNamespaceStmt;
  private readonly deleteDocumentStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertDocumentStmt = db.prepare(`
      INSERT INTO knowledge_documents (
        doc_id, namespace, source_type, source_ref, title, metadata_json, created_at
      ) VALUES (
        @docId, @namespace, @sourceType, @sourceRef, @title, @metadataJson, @createdAt
      )
    `);
    this.insertChunkStmt = db.prepare(`
      INSERT INTO knowledge_chunks (
        chunk_id, doc_id, seq, content, embedding_json, embedding_metadata_json, token_estimate, created_at
      ) VALUES (
        @chunkId, @docId, @seq, @content, @embeddingJson, @embeddingMetadataJson, @tokenEstimate, @createdAt
      )
    `);
    this.listChunksByNamespaceStmt = db.prepare(`
      SELECT kc.*
      FROM knowledge_chunks kc
      INNER JOIN knowledge_documents kd ON kd.doc_id = kc.doc_id
      WHERE kd.namespace = @namespace
      ORDER BY kc.created_at DESC, kc.seq ASC
      LIMIT @limit
    `);
    this.listChunksStmt = db.prepare(`
      SELECT kc.*
      FROM knowledge_chunks kc
      INNER JOIN knowledge_documents kd ON kd.doc_id = kc.doc_id
      ORDER BY kc.created_at DESC, kc.seq ASC
      LIMIT @limit
    `);
    this.listChunksByDocStmt = db.prepare(`
      SELECT *
      FROM knowledge_chunks
      WHERE doc_id = @docId
      ORDER BY seq ASC
      LIMIT @limit
    `);
    this.listDocumentsStmt = db.prepare(`
      SELECT *
      FROM knowledge_documents
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listDocumentsByNamespaceStmt = db.prepare(`
      SELECT *
      FROM knowledge_documents
      WHERE namespace = @namespace
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.getDocumentStmt = db.prepare(`
      SELECT *
      FROM knowledge_documents
      WHERE doc_id = @docId
      LIMIT 1
    `);
    this.updateChunkEmbeddingStmt = db.prepare(`
      UPDATE knowledge_chunks
      SET embedding_json = @embeddingJson,
          embedding_metadata_json = @embeddingMetadataJson
      WHERE chunk_id = @chunkId
    `);
    this.deleteChunksByNamespaceStmt = db.prepare(`
      DELETE FROM knowledge_chunks
      WHERE doc_id IN (
        SELECT doc_id
        FROM knowledge_documents
        WHERE namespace = @namespace
      )
    `);
    this.deleteDocumentsByNamespaceStmt = db.prepare(`
      DELETE FROM knowledge_documents
      WHERE namespace = @namespace
    `);
    this.deleteDocumentStmt = db.prepare(`
      DELETE FROM knowledge_documents
      WHERE doc_id = @docId
    `);
  }

  public createDocument(
    input: {
      namespace: string;
      sourceType: "file" | "url" | "text" | "memory" | "external_source_snapshot";
      sourceRef: string;
      title: string;
      metadata?: Record<string, unknown>;
    },
    now = new Date().toISOString(),
  ): KnowledgeDocumentRecord {
    const docId = randomUUID();
    this.insertDocumentStmt.run({
      docId,
      namespace: input.namespace,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      title: input.title,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: now,
    });
    return {
      docId,
      namespace: input.namespace,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      title: input.title,
      metadata: input.metadata ?? {},
      createdAt: now,
    };
  }

  public appendChunks(
    docId: string,
    chunks: Array<{
      content: string;
      embedding?: number[];
      embeddingMetadata?: Record<string, unknown>;
      tokenEstimate?: number;
    }>,
    now = new Date().toISOString(),
  ): KnowledgeChunkRecord[] {
    const out: KnowledgeChunkRecord[] = [];
    chunks.forEach((chunk, index) => {
      const chunkId = randomUUID();
      const tokenEstimate = chunk.tokenEstimate ?? estimateTokens(chunk.content);
      this.insertChunkStmt.run({
        chunkId,
        docId,
        seq: index,
        content: chunk.content,
        embeddingJson: chunk.embedding ? JSON.stringify(chunk.embedding) : null,
        embeddingMetadataJson: chunk.embeddingMetadata ? JSON.stringify(chunk.embeddingMetadata) : null,
        tokenEstimate,
        createdAt: now,
      });
      out.push({
        chunkId,
        docId,
        seq: index,
        content: chunk.content,
        embedding: chunk.embedding,
        embeddingMetadata: chunk.embeddingMetadata,
        tokenEstimate,
        createdAt: now,
      });
    });
    return out;
  }

  public listDocuments(namespace?: string, limit = 100): KnowledgeDocumentRecord[] {
    const rows = toKnowledgeDocumentRows(
      namespace
        ? this.listDocumentsByNamespaceStmt.all({
            namespace,
            limit,
          })
        : this.listDocumentsStmt.all({
            limit,
          }),
    );
    return rows.map((row) => ({
      docId: row.doc_id,
      namespace: row.namespace,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      title: row.title,
      metadata: parseDocumentMetadata(row.metadata_json),
      createdAt: row.created_at,
    }));
  }

  public getDocument(docId: string): KnowledgeDocumentRecord | undefined {
    const row = toKnowledgeDocumentRows(
      this.getDocumentStmt.all({
        docId,
      }),
    )[0];
    if (!row) {
      return undefined;
    }
    return {
      docId: row.doc_id,
      namespace: row.namespace,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      title: row.title,
      metadata: parseDocumentMetadata(row.metadata_json),
      createdAt: row.created_at,
    };
  }

  public listChunksByNamespace(namespace?: string, limit = 500): KnowledgeChunkRecord[] {
    const rows = toKnowledgeChunkRows(
      namespace
        ? this.listChunksByNamespaceStmt.all({
            namespace,
            limit,
          })
        : this.listChunksStmt.all({
            limit,
          }),
    );
    return rows.map(mapChunkRow);
  }

  public listChunksByDocument(docId: string, limit = 500): KnowledgeChunkRecord[] {
    const rows = toKnowledgeChunkRows(
      this.listChunksByDocStmt.all({
        docId,
        limit,
      }),
    );
    return rows.map(mapChunkRow);
  }

  public updateChunkEmbedding(chunkId: string, embedding: number[], embeddingMetadata?: Record<string, unknown>): void {
    this.updateChunkEmbeddingStmt.run({
      chunkId,
      embeddingJson: JSON.stringify(embedding),
      embeddingMetadataJson: embeddingMetadata ? JSON.stringify(embeddingMetadata) : null,
    });
  }

  public deleteNamespace(namespace: string): void {
    this.deleteChunksByNamespaceStmt.run({
      namespace,
    });
    this.deleteDocumentsByNamespaceStmt.run({
      namespace,
    });
  }

  public deleteDocument(docId: string): boolean {
    return (
      Number(
        this.deleteDocumentStmt.run({
          docId,
        }).changes ?? 0,
      ) > 0
    );
  }
}

function mapChunkRow(row: KnowledgeChunkRow): KnowledgeChunkRecord {
  return {
    chunkId: row.chunk_id,
    docId: row.doc_id,
    seq: row.seq,
    content: row.content,
    embedding: parseKnowledgeEmbedding(row.embedding_json),
    embeddingMetadata: parseKnowledgeMetadata(row.embedding_metadata_json),
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  };
}

function parseKnowledgeMetadata(value: string | null | undefined): Record<string, unknown> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(value, {});
  return isRecord(parsed) ? parsed : undefined;
}

function parseDocumentMetadata(value: string): Record<string, unknown> {
  return parseKnowledgeMetadata(value) ?? {};
}

function parseKnowledgeEmbedding(value: string | null): number[] | undefined {
  const parsed = safeJsonParse<unknown>(value, undefined);
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "number") ? parsed : undefined;
}

function toKnowledgeDocumentRows(value: unknown): KnowledgeDocumentRow[] {
  return Array.isArray(value) ? value.filter(isKnowledgeDocumentRow) : [];
}

function toKnowledgeChunkRows(value: unknown): KnowledgeChunkRow[] {
  return Array.isArray(value) ? value.filter(isKnowledgeChunkRow) : [];
}

function isKnowledgeDocumentRow(value: unknown): value is KnowledgeDocumentRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.doc_id === "string" &&
    typeof value.namespace === "string" &&
    (value.source_type === "file" ||
      value.source_type === "url" ||
      value.source_type === "text" ||
      value.source_type === "memory" ||
      value.source_type === "external_source_snapshot") &&
    typeof value.source_ref === "string" &&
    typeof value.title === "string" &&
    typeof value.metadata_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isKnowledgeChunkRow(value: unknown): value is KnowledgeChunkRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.chunk_id === "string" &&
    typeof value.doc_id === "string" &&
    typeof value.seq === "number" &&
    typeof value.content === "string" &&
    (typeof value.embedding_json === "string" || value.embedding_json === null) &&
    (typeof value.embedding_metadata_json === "string" ||
      value.embedding_metadata_json === null ||
      value.embedding_metadata_json === undefined) &&
    typeof value.token_estimate === "number" &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function estimateTokens(text: string): number {
  const chars = text.length;
  if (chars === 0) {
    return 0;
  }
  return Math.ceil(chars / 4);
}
