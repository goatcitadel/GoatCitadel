import type { DatabaseClient } from "./db.js";

export const CITADEL_ACCESS_REVISION_POSTGRES_SQL = `
CREATE TABLE IF NOT EXISTS citadel_access_revisions (
  citadel_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL CHECK (generation > 0)
);
`;

export function createCitadelAccessRevisionSchema(db: Pick<DatabaseClient, "exec">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS citadel_access_revisions (
      citadel_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK (generation > 0)
    );
  `);
}
