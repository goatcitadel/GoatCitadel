import type { DatabaseSync } from "node:sqlite";

// Additive: old rows retain NULL and their existing tool-name accounting.
// This identity is an accounting projection, never authority to invoke a tool.
export const TOOL_POLICY_IDENTITY_SQL = `
  ALTER TABLE tool_access_decisions ADD COLUMN policy_tool_name TEXT
    CHECK (policy_tool_name IS NULL OR (
      policy_tool_name = 'mcp.invoke'
      AND substr(tool_name, 1, 4) = 'mcp.'
      AND tool_name <> 'mcp.invoke'
      AND length(tool_name) BETWEEN 6 AND 255
    ));
  CREATE INDEX idx_tool_access_decisions_policy_time
    ON tool_access_decisions (policy_tool_name, timestamp DESC)
    WHERE policy_tool_name IS NOT NULL AND counts_toward_limits = 1;
`;

export function addToolPolicyIdentity(db: DatabaseSync): void {
  db.exec(TOOL_POLICY_IDENTITY_SQL);
}

// Fresh Postgres bootstrap already projects the latest SQLite shape. Older
// databases still need the additive column/index when this migration runs.
export const TOOL_POLICY_IDENTITY_POSTGRES_SQL = `
  ALTER TABLE tool_access_decisions ADD COLUMN IF NOT EXISTS policy_tool_name TEXT;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'tool_access_decisions'::regclass
        AND conname = 'chk_tool_access_decisions_policy_identity') THEN
      ALTER TABLE tool_access_decisions ADD CONSTRAINT chk_tool_access_decisions_policy_identity
        CHECK (policy_tool_name IS NULL OR (
          policy_tool_name = 'mcp.invoke'
          AND substr(tool_name, 1, 4) = 'mcp.'
          AND tool_name <> 'mcp.invoke'
          AND length(tool_name) BETWEEN 6 AND 255
        ));
    END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_policy_time
    ON tool_access_decisions (policy_tool_name, timestamp DESC)
    WHERE policy_tool_name IS NOT NULL AND counts_toward_limits = 1;
`;
