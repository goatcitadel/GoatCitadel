import type { DatabaseClient } from "./db.js";
import type { ThreadKnowledgeAttachmentRecord, ThreadKnowledgeRetrievalMode } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ChatThreadKnowledgeAttachmentRow {
  attachment_id: string;
  session_id: string;
  source_type: "file" | "url";
  source_ref: string;
  title: string;
  retrieval_mode: ThreadKnowledgeRetrievalMode;
  ingest_status: "queued" | "running" | "ready" | "failed";
  chunk_count: number | null;
  namespace: string | null;
  chat_attachment_id: string | null;
  document_id: string | null;
  error_message: string | null;
  last_ingest_at: string | null;
  created_at: string;
  updated_at: string;
}

type ChatThreadKnowledgeAttachmentPatchInput = Partial<{
  sourceRef: string;
  title: string;
  retrievalMode: ThreadKnowledgeRetrievalMode;
  ingestStatus: "queued" | "running" | "ready" | "failed";
  chunkCount: number;
  namespace: string;
  chatAttachmentId: string;
  documentId: string;
  errorMessage: string;
  lastIngestAt: string;
}>;

export class ChatThreadKnowledgeAttachmentRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listBySessionStmt;
  private readonly listByDocumentStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM chat_thread_knowledge_attachments
      WHERE attachment_id = ?
      LIMIT 1
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO chat_thread_knowledge_attachments (
        attachment_id,
        session_id,
        source_type,
        source_ref,
        title,
        retrieval_mode,
        ingest_status,
        chunk_count,
        namespace,
        chat_attachment_id,
        document_id,
        error_message,
        last_ingest_at,
        created_at,
        updated_at
      ) VALUES (
        @attachmentId,
        @sessionId,
        @sourceType,
        @sourceRef,
        @title,
        @retrievalMode,
        @ingestStatus,
        @chunkCount,
        @namespace,
        @chatAttachmentId,
        @documentId,
        @errorMessage,
        @lastIngestAt,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(attachment_id) DO UPDATE SET
        source_ref = excluded.source_ref,
        title = excluded.title,
        retrieval_mode = excluded.retrieval_mode,
        ingest_status = excluded.ingest_status,
        chunk_count = excluded.chunk_count,
        namespace = excluded.namespace,
        chat_attachment_id = excluded.chat_attachment_id,
        document_id = excluded.document_id,
        error_message = excluded.error_message,
        last_ingest_at = excluded.last_ingest_at,
        updated_at = excluded.updated_at
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT *
      FROM chat_thread_knowledge_attachments
      WHERE session_id = ?
      ORDER BY created_at DESC, attachment_id DESC
    `);
    this.listByDocumentStmt = db.prepare(`
      SELECT *
      FROM chat_thread_knowledge_attachments
      WHERE document_id = ?
      ORDER BY created_at DESC, attachment_id DESC
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM chat_thread_knowledge_attachments
      WHERE attachment_id = ?
    `);
  }

  public get(attachmentId: string): ThreadKnowledgeAttachmentRecord {
    const row = toChatThreadKnowledgeAttachmentRow(this.getStmt.get(attachmentId));
    if (!row) {
      throw new NotFoundError({ entity: "Thread knowledge attachment", id: attachmentId });
    }
    return mapRow(row);
  }

  public create(input: ThreadKnowledgeAttachmentRecord): ThreadKnowledgeAttachmentRecord {
    this.insertStmt.run({
      attachmentId: sanitizeRequired(input.attachmentId, "attachmentId"),
      sessionId: sanitizeRequired(input.sessionId, "sessionId"),
      sourceType: input.sourceType,
      sourceRef: sanitizeRequired(input.sourceRef, "sourceRef"),
      title: sanitizeRequired(input.title, "title"),
      retrievalMode: input.retrievalMode,
      ingestStatus: input.ingestStatus,
      chunkCount: input.chunkCount ?? null,
      namespace: sanitizeOptional(input.namespace),
      chatAttachmentId: sanitizeOptional(input.chatAttachmentId),
      documentId: sanitizeOptional(input.documentId),
      errorMessage: sanitizeOptional(input.errorMessage),
      lastIngestAt: input.lastIngestAt ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return this.get(input.attachmentId);
  }

  public patch(
    attachmentId: string,
    input: ChatThreadKnowledgeAttachmentPatchInput,
    now = new Date().toISOString(),
  ): ThreadKnowledgeAttachmentRecord {
    const current = this.get(attachmentId);
    return this.create({
      ...current,
      sourceRef: input.sourceRef !== undefined ? sanitizeRequired(input.sourceRef, "sourceRef") : current.sourceRef,
      title: input.title !== undefined ? sanitizeRequired(input.title, "title") : current.title,
      retrievalMode: input.retrievalMode ?? current.retrievalMode,
      ingestStatus: input.ingestStatus ?? current.ingestStatus,
      chunkCount: input.chunkCount !== undefined ? input.chunkCount : current.chunkCount,
      namespace: input.namespace !== undefined ? (sanitizeOptional(input.namespace) ?? undefined) : current.namespace,
      chatAttachmentId:
        input.chatAttachmentId !== undefined
          ? (sanitizeOptional(input.chatAttachmentId) ?? undefined)
          : current.chatAttachmentId,
      documentId:
        input.documentId !== undefined ? (sanitizeOptional(input.documentId) ?? undefined) : current.documentId,
      errorMessage:
        input.errorMessage !== undefined ? (sanitizeOptional(input.errorMessage) ?? undefined) : current.errorMessage,
      lastIngestAt: input.lastIngestAt !== undefined ? input.lastIngestAt : current.lastIngestAt,
      createdAt: current.createdAt,
      updatedAt: now,
    });
  }

  public listBySession(sessionId: string): ThreadKnowledgeAttachmentRecord[] {
    const rows = toChatThreadKnowledgeAttachmentRows(
      this.listBySessionStmt.all(sanitizeRequired(sessionId, "sessionId")),
    );
    return rows.map(mapRow);
  }

  public listByDocumentId(documentId: string): ThreadKnowledgeAttachmentRecord[] {
    const rows = toChatThreadKnowledgeAttachmentRows(
      this.listByDocumentStmt.all(sanitizeRequired(documentId, "documentId")),
    );
    return rows.map(mapRow);
  }

  public delete(attachmentId: string): boolean {
    return Number(this.deleteStmt.run(sanitizeRequired(attachmentId, "attachmentId")).changes ?? 0) > 0;
  }
}

function sanitizeRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function sanitizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatThreadKnowledgeAttachmentRow(value: unknown): value is ChatThreadKnowledgeAttachmentRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.attachment_id === "string" &&
    typeof value.session_id === "string" &&
    (value.source_type === "file" || value.source_type === "url") &&
    typeof value.source_ref === "string" &&
    typeof value.title === "string" &&
    isRetrievalMode(value.retrieval_mode) &&
    isIngestStatus(value.ingest_status) &&
    (typeof value.chunk_count === "number" || value.chunk_count === null) &&
    (typeof value.namespace === "string" || value.namespace === null) &&
    (typeof value.chat_attachment_id === "string" || value.chat_attachment_id === null) &&
    (typeof value.document_id === "string" || value.document_id === null) &&
    (typeof value.error_message === "string" || value.error_message === null) &&
    (typeof value.last_ingest_at === "string" || value.last_ingest_at === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRetrievalMode(value: unknown): value is ThreadKnowledgeRetrievalMode {
  return value === "full_text" || value === "retrieval";
}

function isIngestStatus(value: unknown): value is ChatThreadKnowledgeAttachmentRow["ingest_status"] {
  return value === "queued" || value === "running" || value === "ready" || value === "failed";
}

function toChatThreadKnowledgeAttachmentRow(value: unknown): ChatThreadKnowledgeAttachmentRow | undefined {
  return isChatThreadKnowledgeAttachmentRow(value) ? value : undefined;
}

function toChatThreadKnowledgeAttachmentRows(value: unknown): ChatThreadKnowledgeAttachmentRow[] {
  return Array.isArray(value) ? value.filter(isChatThreadKnowledgeAttachmentRow) : [];
}

function mapRow(row: ChatThreadKnowledgeAttachmentRow): ThreadKnowledgeAttachmentRecord {
  return {
    attachmentId: row.attachment_id,
    sessionId: row.session_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    title: row.title,
    retrievalMode: row.retrieval_mode,
    ingestStatus: row.ingest_status,
    chunkCount: row.chunk_count ?? undefined,
    namespace: row.namespace ?? undefined,
    chatAttachmentId: row.chat_attachment_id ?? undefined,
    documentId: row.document_id ?? undefined,
    errorMessage: row.error_message ?? undefined,
    lastIngestAt: row.last_ingest_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
