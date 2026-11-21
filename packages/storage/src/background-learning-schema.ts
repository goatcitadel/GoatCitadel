import type { DatabaseSync } from "node:sqlite";

export const BACKGROUND_LEARNING_QUEUE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_durable_runs_learning_foreground_status
  ON durable_runs(workflow_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_durable_runs_learning_foreground_recent
  ON durable_runs(workflow_key, updated_at DESC);
`;
export function upgradeBackgroundLearningQueueIndexes(db: DatabaseSync): void {
  db.exec(BACKGROUND_LEARNING_QUEUE_INDEXES_SQL);
}
