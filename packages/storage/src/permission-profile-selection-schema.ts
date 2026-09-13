import type { DatabaseClient } from "./db.js";

export const PERMISSION_PROFILE_SELECTION_POSTGRES_SQL = `
CREATE TABLE IF NOT EXISTS permission_profile_selection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  generation TEXT NOT NULL
);
INSERT INTO permission_profile_selection_state (singleton_id, generation)
VALUES (1, gen_random_uuid()::text) ON CONFLICT (singleton_id) DO NOTHING;
`;

export function createPermissionProfileSelectionSchema(db: Pick<DatabaseClient, "exec">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_profile_selection_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      generation TEXT NOT NULL
    );
    INSERT OR IGNORE INTO permission_profile_selection_state (singleton_id, generation)
    VALUES (1, lower(hex(randomblob(16))));
  `);
}
