import type { DatabaseClient } from "./db.js";

export const INTEGRATION_CONNECTION_REVISION_POSTGRES_SQL = `
CREATE TABLE IF NOT EXISTS integration_connection_revisions (
  connection_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL CHECK (generation > 0)
);
`;

export function createIntegrationConnectionRevisionSchema(db: Pick<DatabaseClient, "exec">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_connection_revisions (
      connection_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK (generation > 0)
    );
  `);
}
