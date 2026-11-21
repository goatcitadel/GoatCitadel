import type { DatabaseSync } from "node:sqlite";
export const IMPROVEMENT_WATCH_EVIDENCE_POSTGRES_SQL = `
ALTER TABLE improvement_activations ADD COLUMN IF NOT EXISTS positive_signal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE improvement_activations ADD COLUMN IF NOT EXISTS watch_evidence_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE improvement_activations ADD COLUMN IF NOT EXISTS watch_evidence_complete INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_improvement_signals_watch_scope ON improvement_signals(workspace_id,fingerprint,occurred_at,signal_id);
`;
export function upgradeImprovementWatchEvidence(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(improvement_activations)").all() as { name: string }[];
  for (const [name, value] of [
    ["positive_signal_count", 0],
    ["watch_evidence_version", 0],
    ["watch_evidence_complete", 1],
  ] as const)
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE improvement_activations ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${value}`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_improvement_signals_watch_scope ON improvement_signals(workspace_id,fingerprint,occurred_at,signal_id)",
  );
}
