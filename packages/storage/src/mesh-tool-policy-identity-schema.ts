import type { DatabaseSync } from "node:sqlite";

// Extend the constrained accounting identity without changing historical rows
// or the original MCP migration. The migration runner owns the transaction;
// replacement is validated before the old column and its index are removed.
export const MESH_TOOL_POLICY_IDENTITY_SQL = `
  ALTER TABLE tool_access_decisions ADD COLUMN policy_tool_name_mesh_upgrade TEXT
    CHECK (policy_tool_name_mesh_upgrade IS NULL OR (
      policy_tool_name_mesh_upgrade = 'mcp.invoke'
      AND substr(tool_name, 1, 4) = 'mcp.'
      AND tool_name <> 'mcp.invoke'
      AND length(tool_name) BETWEEN 6 AND 255
    ) OR (
      policy_tool_name_mesh_upgrade = 'mesh.invoke'
      AND substr(tool_name, 1, 5) = 'mesh:'
      AND length(tool_name) BETWEEN 13 AND 273
      AND (tool_name LIKE 'mesh:%:tool:%' OR tool_name LIKE 'mesh:%:mcp_server:%')
    ));
  UPDATE tool_access_decisions SET policy_tool_name_mesh_upgrade = policy_tool_name;
  DROP INDEX idx_tool_access_decisions_policy_time;
  ALTER TABLE tool_access_decisions DROP COLUMN policy_tool_name;
  ALTER TABLE tool_access_decisions RENAME COLUMN policy_tool_name_mesh_upgrade TO policy_tool_name;
  CREATE INDEX idx_tool_access_decisions_policy_time
    ON tool_access_decisions (policy_tool_name, timestamp DESC)
    WHERE policy_tool_name IS NOT NULL AND counts_toward_limits = 1;
`;

export function extendMeshToolPolicyIdentity(db: DatabaseSync): void {
  db.exec(MESH_TOOL_POLICY_IDENTITY_SQL);
}

// PostgreSQL can replace the v162 named constraint directly. Bootstrap and
// upgraded databases retain the same column, index and historical evidence.
export const MESH_TOOL_POLICY_IDENTITY_POSTGRES_SQL = `
  ALTER TABLE tool_access_decisions DROP CONSTRAINT IF EXISTS chk_tool_access_decisions_policy_identity;
  ALTER TABLE tool_access_decisions ADD CONSTRAINT chk_tool_access_decisions_policy_identity
    CHECK (policy_tool_name IS NULL OR (
      policy_tool_name = 'mcp.invoke'
      AND substr(tool_name, 1, 4) = 'mcp.'
      AND tool_name <> 'mcp.invoke'
      AND length(tool_name) BETWEEN 6 AND 255
    ) OR (
      policy_tool_name = 'mesh.invoke'
      AND substr(tool_name, 1, 5) = 'mesh:'
      AND length(tool_name) BETWEEN 13 AND 273
      AND (tool_name LIKE 'mesh:%:tool:%' OR tool_name LIKE 'mesh:%:mcp_server:%')
    ));
`;
