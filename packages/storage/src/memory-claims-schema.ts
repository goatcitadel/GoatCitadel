import type { DatabaseSync } from "node:sqlite";

const LEARNINGS_TABLE = `CREATE TABLE IF NOT EXISTS memory_learnings (
  learning_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, learning_key TEXT NOT NULL,
  learning_type TEXT NOT NULL, insight TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
  source_refs_json TEXT NOT NULL, file_refs_json TEXT NOT NULL, authority TEXT NOT NULL,
  superseded_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);`;

const CLAIM_COLUMNS = {
  claim_json: "TEXT",
  claim_key: "TEXT",
  claim_scalar: "INTEGER",
  claim_scope_kind: "TEXT",
  claim_scope_id: "TEXT",
};
const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_learnings_active_scalar_claim
  ON memory_learnings(workspace_id, claim_key) WHERE status = 'trusted' AND claim_scalar = 1 AND claim_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_memory_active_scalar_claim
  ON learned_memory_items(session_id, claim_key) WHERE status = 'active' AND claim_scalar = 1 AND claim_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_learnings_recall ON memory_learnings(workspace_id, status, updated_at, learning_id);
CREATE INDEX IF NOT EXISTS idx_chat_turn_trace_completion_cursor ON chat_turn_traces(status, COALESCE(finished_at, started_at), turn_id);
`;

export const MEMORY_CLAIMS_POSTGRES_SQL =
  LEARNINGS_TABLE +
  ["memory_learnings", "learned_memory_items"]
    .flatMap((table) =>
      Object.entries(CLAIM_COLUMNS).map(
        ([name, type]) =>
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type === "INTEGER" ? "BIGINT" : type};`,
      ),
    )
    .join("\n") +
  INDEXES;

export function upgradeMemoryClaimsSchema(db: DatabaseSync): void {
  db.exec(LEARNINGS_TABLE);
  for (const table of ["memory_learnings", "learned_memory_items"]) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
    );
    for (const [name, type] of Object.entries(CLAIM_COLUMNS))
      if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec(INDEXES);
}
