import type { DatabaseClient } from "./db.js";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ChatAttachmentRow {
  attachment_id: string;
  session_id: string;
  workspace_id: string;
  project_id: string | null;
  file_name: string;
  mime_type: string;
  media_type: "text" | "image" | "audio" | "video" | "binary" | null;
  size_bytes: number;
  sha256: string;
  storage_rel_path: string;
  extract_status: "ready" | "unsupported" | "failed";
  extract_preview: string | null;
  thumbnail_rel_path: string | null;
  ocr_text: string | null;
  transcript_text: string | null;
  analysis_status: "queued" | "running" | "pending" | "ready" | "failed" | "unsupported" | null;
  created_at: string;
}

export interface ChatAttachmentInsertInput {
  attachmentId: string;
  sessionId: string;
  workspaceId?: string;
  projectId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageRelPath: string;
  extractStatus: "ready" | "unsupported" | "failed";
  extractPreview?: string;
  mediaType?: "text" | "image" | "audio" | "video" | "binary";
  thumbnailRelPath?: string;
  ocrText?: string;
  transcriptText?: string;
  analysisStatus?: "queued" | "running" | "pending" | "ready" | "failed" | "unsupported";
}

export class ChatAttachmentRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listBySessionStmt;
  private readonly listBySessionWorkspaceStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_attachments WHERE attachment_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_attachments (
        attachment_id, session_id, workspace_id, project_id, file_name, mime_type, size_bytes,
        sha256, storage_rel_path, extract_status, extract_preview, media_type,
        thumbnail_rel_path, ocr_text, transcript_text, analysis_status, created_at
      ) VALUES (
        @attachmentId, @sessionId, @workspaceId, @projectId, @fileName, @mimeType, @sizeBytes,
        @sha256, @storageRelPath, @extractStatus, @extractPreview, @mediaType,
        @thumbnailRelPath, @ocrText, @transcriptText, @analysisStatus, @createdAt
      )
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_attachments
      WHERE session_id = @sessionId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listBySessionWorkspaceStmt = db.prepare(`
      SELECT * FROM chat_attachments
      WHERE session_id = @sessionId
        AND workspace_id = @workspaceId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
  }

  public get(attachmentId: string): ChatAttachmentRecord {
    const row = toChatAttachmentRow(this.getStmt.get(attachmentId));
    if (!row) {
      throw new NotFoundError({ entity: "Attachment", id: attachmentId });
    }
    return mapRow(row);
  }

  public create(input: ChatAttachmentInsertInput, now = new Date().toISOString()): ChatAttachmentRecord {
    this.insertStmt.run({
      ...input,
      workspaceId: sanitizeWorkspaceId(input.workspaceId ?? "default"),
      projectId: input.projectId ?? null,
      extractPreview: input.extractPreview ?? null,
      mediaType: input.mediaType ?? null,
      thumbnailRelPath: input.thumbnailRelPath ?? null,
      ocrText: input.ocrText ?? null,
      transcriptText: input.transcriptText ?? null,
      analysisStatus: input.analysisStatus ?? inferAnalysisStatus(input.extractStatus),
      createdAt: now,
    });
    return this.get(input.attachmentId);
  }

  public listBySession(sessionId: string, limit = 200, workspaceId?: string): ChatAttachmentRecord[] {
    const rows = toChatAttachmentRows((workspaceId ? this.listBySessionWorkspaceStmt : this.listBySessionStmt).all({
      sessionId,
      workspaceId: workspaceId ? sanitizeWorkspaceId(workspaceId) : undefined,
      limit: Math.max(1, Math.min(2000, Math.floor(limit))),
    }));
    return rows.map(mapRow);
  }

  public listByIds(ids: string[], workspaceId?: string): ChatAttachmentRecord[] {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    const workspace = workspaceId ? sanitizeWorkspaceId(workspaceId) : undefined;
    const sql = workspace
      ? `
        SELECT * FROM chat_attachments
        WHERE attachment_id IN (${placeholders})
          AND workspace_id = ?
      `
      : `
        SELECT * FROM chat_attachments
        WHERE attachment_id IN (${placeholders})
      `;
    const rows = toChatAttachmentRows(this.db.prepare(sql).all(...ids, ...(workspace ? [workspace] : [])));
    return rows.map(mapRow);
  }
}

function mapRow(row: ChatAttachmentRow): ChatAttachmentRecord {
  return {
    attachmentId: row.attachment_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id ?? undefined,
    fileName: row.file_name,
    mimeType: row.mime_type,
    mediaType: row.media_type ?? undefined,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storageRelPath: row.storage_rel_path,
    extractStatus: row.extract_status,
    extractPreview: row.extract_preview ?? undefined,
    thumbnailRelPath: row.thumbnail_rel_path ?? undefined,
    ocrText: row.ocr_text ?? undefined,
    transcriptText: row.transcript_text ?? undefined,
    analysisStatus: row.analysis_status ?? inferAnalysisStatus(row.extract_status),
    createdAt: row.created_at,
  };
}

function inferAnalysisStatus(
  extractStatus: "ready" | "unsupported" | "failed",
): "queued" | "running" | "pending" | "ready" | "failed" | "unsupported" {
  if (extractStatus === "ready") {
    return "ready";
  }
  if (extractStatus === "failed") {
    return "failed";
  }
  return "unsupported";
}

function sanitizeWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
  }
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(trimmed)) {
    throw new ValidationError({ message: "workspaceId contains unsupported characters" });
  }
  return trimmed;
}

function toChatAttachmentRow(value: unknown): ChatAttachmentRow | undefined {
  return isChatAttachmentRow(value) ? value : undefined;
}

function toChatAttachmentRows(value: unknown): ChatAttachmentRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isChatAttachmentRow);
}

function isChatAttachmentRow(value: unknown): value is ChatAttachmentRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.attachment_id === "string"
    && typeof value.session_id === "string"
    && typeof value.workspace_id === "string"
    && (typeof value.project_id === "string" || value.project_id === null)
    && typeof value.file_name === "string"
    && typeof value.mime_type === "string"
    && (typeof value.media_type === "string" || value.media_type === null)
    && typeof value.size_bytes === "number"
    && typeof value.sha256 === "string"
    && typeof value.storage_rel_path === "string"
    && typeof value.extract_status === "string"
    && (typeof value.extract_preview === "string" || value.extract_preview === null)
    && (typeof value.thumbnail_rel_path === "string" || value.thumbnail_rel_path === null)
    && (typeof value.ocr_text === "string" || value.ocr_text === null)
    && (typeof value.transcript_text === "string" || value.transcript_text === null)
    && (typeof value.analysis_status === "string" || value.analysis_status === null)
    && typeof value.created_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


