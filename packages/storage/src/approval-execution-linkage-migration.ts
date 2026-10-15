/** Forward-only metadata index. The approval record remains the authority. */
const LINKAGE_WHITESPACE = " \t\n\u000b\f\r                 　﻿";

/** Last duplicate key wins, matching JSON.parse and PostgreSQL JSONB for legacy records. */
export const APPROVAL_EXECUTION_LINKAGE_SQLITE_SQL = `CREATE TABLE IF NOT EXISTS approval_execution_linkages (
 approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL, run_id TEXT, durable_run_id TEXT, session_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_execution_run ON approval_execution_linkages(workspace_id, run_id, created_at DESC, approval_id DESC);
CREATE INDEX IF NOT EXISTS idx_approval_execution_durable_run ON approval_execution_linkages(workspace_id, durable_run_id, created_at DESC, approval_id DESC);
CREATE VIEW IF NOT EXISTS approval_execution_linkage_source AS
 WITH sources AS (
 SELECT approval_id, created_at, 0 AS priority, CASE WHEN json_valid(linkage_json) AND json_type(CASE WHEN json_valid(linkage_json) THEN linkage_json ELSE '{}' END) = 'object' THEN linkage_json ELSE '{}' END AS linkage FROM approvals
 UNION ALL SELECT approval_id, created_at, 1 AS priority, COALESCE((SELECT CASE WHEN type = 'object' THEN value ELSE '{}' END FROM json_each(CASE WHEN json_valid(payload_json) AND json_type(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END) = 'object' THEN payload_json ELSE '{}' END) WHERE key = '__gcApprovalLinkage' ORDER BY id DESC LIMIT 1), '{}') FROM approvals
 UNION ALL SELECT approval_id, created_at, 2 AS priority, COALESCE((SELECT CASE WHEN type = 'object' THEN value ELSE '{}' END FROM json_each(CASE WHEN json_valid(preview_json) AND json_type(CASE WHEN json_valid(preview_json) THEN preview_json ELSE '{}' END) = 'object' THEN preview_json ELSE '{}' END) WHERE key = '__gcApprovalLinkage' ORDER BY id DESC LIMIT 1), '{}') FROM approvals
 ), normalized AS (
 SELECT source.approval_id, source.created_at, source.priority,
  (SELECT json_group_object(entry.key, entry.value) FROM json_each(source.linkage) entry
   WHERE entry.type = 'text' AND length(trim(entry.value, '${LINKAGE_WHITESPACE}')) > 0
    AND NOT EXISTS(SELECT 1 FROM json_each(source.linkage) later WHERE later.key = entry.key AND later.id > entry.id)) AS linkage
 FROM sources source
 ), valid AS (
 SELECT *, row_number() OVER (PARTITION BY approval_id ORDER BY priority) AS selected FROM normalized WHERE linkage <> '{}'
 ), projected AS (
 SELECT approval_id, created_at, json_extract(linkage, '$.workspaceId') AS workspace_id,
  json_extract(linkage, '$.runId') AS run_id, json_extract(linkage, '$.durableRunId') AS durable_run_id,
  json_extract(linkage, '$.sessionId') AS session_id FROM valid WHERE selected = 1
 ) SELECT * FROM projected WHERE workspace_id IS NOT NULL AND (run_id IS NOT NULL OR durable_run_id IS NOT NULL);
INSERT OR REPLACE INTO approval_execution_linkages(approval_id, workspace_id, run_id, durable_run_id, session_id, created_at)
 SELECT approval_id, workspace_id, run_id, durable_run_id, session_id, created_at FROM approval_execution_linkage_source;
CREATE TRIGGER IF NOT EXISTS trg_approval_execution_linkage_insert AFTER INSERT ON approvals BEGIN
 INSERT INTO approval_execution_linkages(approval_id, workspace_id, run_id, durable_run_id, session_id, created_at)
 SELECT approval_id, workspace_id, run_id, durable_run_id, session_id, created_at FROM approval_execution_linkage_source WHERE approval_id = NEW.approval_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_approval_execution_linkage_update AFTER UPDATE OF linkage_json, payload_json, preview_json, created_at ON approvals BEGIN
 DELETE FROM approval_execution_linkages WHERE approval_id = OLD.approval_id;
 INSERT INTO approval_execution_linkages(approval_id, workspace_id, run_id, durable_run_id, session_id, created_at)
 SELECT approval_id, workspace_id, run_id, durable_run_id, session_id, created_at FROM approval_execution_linkage_source WHERE approval_id = NEW.approval_id;
END;`;

export const APPROVAL_EXECUTION_LINKAGE_POSTGRES_SQL = `CREATE TABLE IF NOT EXISTS approval_execution_linkages (
 approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL, run_id TEXT, durable_run_id TEXT, session_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_execution_run ON approval_execution_linkages(workspace_id, run_id, created_at DESC, approval_id DESC);
CREATE INDEX IF NOT EXISTS idx_approval_execution_durable_run ON approval_execution_linkages(workspace_id, durable_run_id, created_at DESC, approval_id DESC);
CREATE OR REPLACE FUNCTION gc_approval_execution_linkage(canonical TEXT, payload TEXT, preview TEXT) RETURNS JSONB AS $$
DECLARE raw TEXT; candidate JSONB; normalized JSONB; source_index INTEGER;
 sources TEXT[] := ARRAY[canonical, payload, preview];
BEGIN
 FOR source_index IN 1..3 LOOP
  raw := sources[source_index];
  BEGIN candidate := raw::jsonb; EXCEPTION WHEN invalid_text_representation THEN candidate := NULL; END;
  IF source_index > 1 THEN candidate := candidate -> '__gcApprovalLinkage'; END IF;
  IF jsonb_typeof(candidate) = 'object' THEN
   SELECT jsonb_object_agg(key, value) INTO normalized FROM jsonb_each(candidate)
    WHERE jsonb_typeof(value) = 'string' AND length(btrim(value #>> '{}', '${LINKAGE_WHITESPACE}')) > 0;
   IF normalized IS NOT NULL THEN RETURN normalized; END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
INSERT INTO approval_execution_linkages(approval_id, workspace_id, run_id, durable_run_id, session_id, created_at)
 SELECT approval_id, linkage ->> 'workspaceId', linkage ->> 'runId', linkage ->> 'durableRunId', linkage ->> 'sessionId', created_at
 FROM (SELECT approval_id, created_at, gc_approval_execution_linkage(linkage_json, payload_json, preview_json) AS linkage FROM approvals) source
 WHERE linkage ->> 'workspaceId' IS NOT NULL AND (linkage ->> 'runId' IS NOT NULL OR linkage ->> 'durableRunId' IS NOT NULL)
 ON CONFLICT(approval_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id, run_id=EXCLUDED.run_id, durable_run_id=EXCLUDED.durable_run_id, session_id=EXCLUDED.session_id, created_at=EXCLUDED.created_at;
CREATE OR REPLACE FUNCTION gc_update_approval_execution_linkage() RETURNS trigger AS $$
DECLARE linkage JSONB;
BEGIN
 DELETE FROM approval_execution_linkages WHERE approval_id = NEW.approval_id;
 linkage := gc_approval_execution_linkage(NEW.linkage_json, NEW.payload_json, NEW.preview_json);
 IF linkage ->> 'workspaceId' IS NOT NULL AND (linkage ->> 'runId' IS NOT NULL OR linkage ->> 'durableRunId' IS NOT NULL) THEN
 INSERT INTO approval_execution_linkages(approval_id, workspace_id, run_id, durable_run_id, session_id, created_at)
 VALUES(NEW.approval_id, linkage ->> 'workspaceId', linkage ->> 'runId', linkage ->> 'durableRunId', linkage ->> 'sessionId', NEW.created_at);
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_approval_execution_linkage ON approvals;
CREATE TRIGGER trg_approval_execution_linkage AFTER INSERT OR UPDATE OF linkage_json, payload_json, preview_json, created_at ON approvals
 FOR EACH ROW EXECUTE FUNCTION gc_update_approval_execution_linkage();`;
