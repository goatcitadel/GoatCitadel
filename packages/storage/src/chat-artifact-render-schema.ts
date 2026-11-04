/** Renderer-owned associations; ordinary attachment labels never create these receipts. */
export const CHAT_ARTIFACT_RENDER_RECEIPTS_SQLITE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_artifact_render_receipts (
    artifact_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL CHECK (artifact_version > 0),
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    renderer_version TEXT NOT NULL,
    viewport TEXT NOT NULL,
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    attachment_id TEXT NOT NULL,
    attachment_sha256 TEXT NOT NULL CHECK (length(attachment_sha256) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, artifact_id, artifact_version, content_hash, renderer_version, viewport),
    FOREIGN KEY (artifact_id) REFERENCES chat_generated_artifacts(artifact_id) ON DELETE CASCADE,
    FOREIGN KEY (attachment_id) REFERENCES chat_attachments(attachment_id) ON DELETE CASCADE
  );
`;
/** Match the canonical SQLite-to-PostgreSQL integer representation on upgrades. */
export const CHAT_ARTIFACT_RENDER_RECEIPTS_POSTGRES_SQL = CHAT_ARTIFACT_RENDER_RECEIPTS_SQLITE_SQL.replace(/\bINTEGER\b/g, "BIGINT");
