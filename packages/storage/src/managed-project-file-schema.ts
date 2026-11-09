export const MANAGED_PROJECT_FILE_SCHEMA_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_workspace_project
  ON chat_projects(workspace_id, project_id);
CREATE TABLE IF NOT EXISTS managed_project_file_revisions (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path_key TEXT NOT NULL,
  path TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  previous_revision_id TEXT,
  effect_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  content_sha256 TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_base64 TEXT,
  content_revision_id TEXT,
  PRIMARY KEY (workspace_id, project_id, path_key, revision_id),
  UNIQUE (effect_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES chat_projects(workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id, path_key, previous_revision_id)
    REFERENCES managed_project_file_revisions(workspace_id, project_id, path_key, revision_id),
  FOREIGN KEY (workspace_id, project_id, path_key, content_revision_id)
    REFERENCES managed_project_file_revisions(workspace_id, project_id, path_key, revision_id),
  CHECK (
    (content_sha256 IS NULL AND byte_length = 0 AND content_base64 IS NULL AND content_revision_id IS NULL)
    OR (content_sha256 IS NOT NULL AND
      ((content_base64 IS NOT NULL AND content_revision_id IS NULL)
        OR (content_base64 IS NULL AND content_revision_id IS NOT NULL)))
  )
);
CREATE TABLE IF NOT EXISTS managed_project_file_heads (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, path_key),
  FOREIGN KEY (workspace_id, project_id, path_key, revision_id)
    REFERENCES managed_project_file_revisions(workspace_id, project_id, path_key, revision_id)
);`;
