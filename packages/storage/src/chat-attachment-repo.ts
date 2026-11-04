import type { DatabaseClient } from "./db.js";
import type { ChatAttachmentRecord, ChatArtifactRenderRecord } from "@goatcitadel/contracts";
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
  analysis_status: "queued" | "running" | "pending" | "ready" | "failed" | "unsupported" | "skipped" | null;
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
  analysisStatus?: "queued" | "running" | "pending" | "ready" | "failed" | "unsupported" | "skipped";
}

/** Private renderer authority; never accepted by the attachment upload API. */
export interface ChatArtifactRenderIdentity {
  artifactId: string;
  artifactVersion: number;
  sessionId: string;
  workspaceId: string;
  contentHash: string;
  rendererVersion: string;
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

  /** Record only a renderer-produced attachment already committed in this exact scope. */
  public recordArtifactRender(input: ChatArtifactRenderIdentity & {
    viewport: string; width: number; height: number; attachmentId: string; sha256: string;
  }): ChatArtifactRenderRecord {
    const identity = normalizeRenderIdentity(input);
    if (!input.viewport.trim() || input.viewport.length > 80 ||
        !Number.isSafeInteger(input.width) || input.width < 1 ||
        !Number.isSafeInteger(input.height) || input.height < 1) {
      throw new ValidationError({ message: "Invalid renderer viewport identity." });
    }
    const sha256 = normalizeRenderHash(input.sha256);
    const result = this.db.prepare(`
      INSERT INTO chat_artifact_render_receipts (
        artifact_id, artifact_version, session_id, workspace_id, content_hash, renderer_version,
        viewport, width, height, attachment_id, attachment_sha256, created_at
      ) SELECT artifact.artifact_id, artifact.version, artifact.session_id, @workspaceId, @contentHash, @rendererVersion,
        @viewport, @width, @height, attachment.attachment_id, attachment.sha256, attachment.created_at
      FROM chat_generated_artifacts artifact JOIN chat_attachments attachment ON attachment.attachment_id = @attachmentId
      WHERE artifact.artifact_id = @artifactId AND artifact.version = @artifactVersion AND artifact.kind = 'html'
        AND artifact.session_id = @sessionId AND COALESCE(artifact.workspace_id, 'default') = @workspaceId
        AND (artifact.content_hash IS NULL OR length(trim(artifact.content_hash)) <> 64 OR lower(trim(artifact.content_hash)) = @contentHash)
        AND attachment.session_id = @sessionId AND attachment.workspace_id = @workspaceId
        AND attachment.mime_type = 'image/png' AND attachment.media_type = 'image' AND attachment.sha256 = @sha256
      ON CONFLICT (workspace_id, artifact_id, artifact_version, content_hash, renderer_version, viewport)
      DO UPDATE SET attachment_id = excluded.attachment_id, attachment_sha256 = excluded.attachment_sha256,
        width = excluded.width, height = excluded.height, created_at = excluded.created_at
    `).run({ ...identity, viewport: input.viewport.trim(), width: input.width, height: input.height,
      attachmentId: input.attachmentId, sha256 });
    if (result.changes !== 1) throw new ValidationError({ message: "Renderer receipt does not match its canonical artifact and attachment." });
    const receipt = this.listArtifactRenders(identity).find((item) => item.viewport === input.viewport.trim());
    if (!receipt) throw new ValidationError({ message: "Renderer receipt is unavailable after recording." });
    return receipt;
  }

  /** Only joined renderer receipts count as evidence; ordinary uploads are never inferred. */
  public listArtifactRenders(input: ChatArtifactRenderIdentity): ChatArtifactRenderRecord[] {
    const rows = this.db.prepare(`
      SELECT receipt.* FROM chat_artifact_render_receipts receipt
      JOIN chat_generated_artifacts artifact ON artifact.artifact_id = receipt.artifact_id
      JOIN chat_attachments attachment ON attachment.attachment_id = receipt.attachment_id
      WHERE receipt.artifact_id = @artifactId AND receipt.artifact_version = @artifactVersion
        AND receipt.session_id = @sessionId AND receipt.workspace_id = @workspaceId
        AND receipt.content_hash = @contentHash AND receipt.renderer_version = @rendererVersion
        AND artifact.version = receipt.artifact_version AND artifact.kind = 'html'
        AND artifact.session_id = receipt.session_id AND COALESCE(artifact.workspace_id, 'default') = receipt.workspace_id
        AND (artifact.content_hash IS NULL OR length(trim(artifact.content_hash)) <> 64 OR lower(trim(artifact.content_hash)) = receipt.content_hash)
        AND attachment.session_id = receipt.session_id AND attachment.workspace_id = receipt.workspace_id
        AND attachment.sha256 = receipt.attachment_sha256 AND attachment.mime_type = 'image/png' AND attachment.media_type = 'image'
      ORDER BY receipt.viewport LIMIT 16
    `).all<{ artifact_id: string; content_hash: string; viewport: string; attachment_id: string;
      attachment_sha256: string; width: number | string; height: number | string; created_at: string }>(normalizeRenderIdentity(input));
    return rows.map((row) => ({ artifactId: row.artifact_id, contentHash: row.content_hash, viewport: row.viewport,
      attachmentId: row.attachment_id, sha256: row.attachment_sha256, width: Number(row.width), height: Number(row.height), createdAt: row.created_at }));
  }
  public listBySession(sessionId: string, limit = 200, workspaceId?: string): ChatAttachmentRecord[] {
    const normalizedLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const rows = toChatAttachmentRows(
      workspaceId
        ? this.listBySessionWorkspaceStmt.all({
            sessionId,
            workspaceId: sanitizeWorkspaceId(workspaceId),
            limit: normalizedLimit,
          })
        : this.listBySessionStmt.all({
            sessionId,
            limit: normalizedLimit,
          }),
    );
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
  return (
    typeof value.attachment_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.workspace_id === "string" &&
    (typeof value.project_id === "string" || value.project_id === null) &&
    typeof value.file_name === "string" &&
    typeof value.mime_type === "string" &&
    (isMediaType(value.media_type) || value.media_type === null) &&
    typeof value.size_bytes === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.storage_rel_path === "string" &&
    isExtractStatus(value.extract_status) &&
    (typeof value.extract_preview === "string" || value.extract_preview === null) &&
    (typeof value.thumbnail_rel_path === "string" || value.thumbnail_rel_path === null) &&
    (typeof value.ocr_text === "string" || value.ocr_text === null) &&
    (typeof value.transcript_text === "string" || value.transcript_text === null) &&
    (isAnalysisStatus(value.analysis_status) || value.analysis_status === null) &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaType(value: unknown): value is NonNullable<ChatAttachmentRow["media_type"]> {
  return value === "text" || value === "image" || value === "audio" || value === "video" || value === "binary";
}

function isExtractStatus(value: unknown): value is ChatAttachmentRow["extract_status"] {
  return value === "ready" || value === "unsupported" || value === "failed";
}

function isAnalysisStatus(value: unknown): value is NonNullable<ChatAttachmentRow["analysis_status"]> {
  return (
    value === "queued" ||
    value === "running" ||
    value === "pending" ||
    value === "ready" ||
    value === "failed" ||
    value === "unsupported" ||
    value === "skipped"
  );
}

function normalizeRenderHash(value: string): string {
  const hash = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ValidationError({ message: "Renderer hashes must be complete SHA-256 values." });
  return hash;
}

function normalizeRenderIdentity(input: ChatArtifactRenderIdentity): ChatArtifactRenderIdentity {
  if (!input.artifactId.trim() || !input.sessionId.trim() || !input.rendererVersion.trim() || input.rendererVersion.length > 80 ||
      !Number.isSafeInteger(input.artifactVersion) || input.artifactVersion < 1) {
    throw new ValidationError({ message: "Invalid renderer artifact identity." });
  }
  return { artifactId: input.artifactId.trim(), artifactVersion: input.artifactVersion,
    sessionId: input.sessionId.trim(), workspaceId: sanitizeWorkspaceId(input.workspaceId),
    rendererVersion: input.rendererVersion.trim(), contentHash: normalizeRenderHash(input.contentHash) };
}