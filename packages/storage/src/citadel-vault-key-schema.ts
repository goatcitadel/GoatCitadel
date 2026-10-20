// Vault key hierarchy storage (design: docs/superpowers/specs/2026-10-19-vault-chamber-keys-design.md §5).
// Only wrapped data keys, IDs, versions and progress live here; no plaintext and
// no key-encryption key. Uniqueness uses nullable marker columns under plain
// unique indexes (NULLs never collide on either engine) instead of partial or
// expression indexes, so the PostgreSQL v2 live render of these SQLite tables and
// the additive PostgreSQL migration have the same canonical shape. Value domains
// (phase, target) are validated by the repository, not by CHECKs, for the same reason.

// --- SQLite v269 ---------------------------------------------------------------

const SQLITE_KEY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS citadel_vault_keys (
  key_id TEXT PRIMARY KEY,
  citadel_id TEXT NOT NULL,
  chamber_id TEXT,
  scope_key TEXT NOT NULL,
  active_scope_key TEXT,
  dek_version INTEGER NOT NULL,
  kek_version INTEGER NOT NULL,
  wrapped_dek_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_vault_keys_version
  ON citadel_vault_keys(citadel_id, scope_key, dek_version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_vault_keys_active
  ON citadel_vault_keys(citadel_id, active_scope_key);

CREATE TABLE IF NOT EXISTS citadel_vault_key_state (
  citadel_id TEXT PRIMARY KEY,
  kek_version INTEGER NOT NULL,
  legacy_reads_closed INTEGER NOT NULL DEFAULT 0,
  kek_created_at TEXT NOT NULL,
  kek_rotated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citadel_vault_rotations (
  rotation_id TEXT PRIMARY KEY,
  citadel_id TEXT NOT NULL,
  open_citadel_id TEXT,
  target TEXT NOT NULL,
  chamber_id TEXT,
  from_key_id TEXT,
  to_key_id TEXT,
  from_kek_version INTEGER,
  to_kek_version INTEGER,
  phase TEXT NOT NULL,
  approval_id TEXT,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  resealed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_vault_rotations_open
  ON citadel_vault_rotations(open_citadel_id);
CREATE INDEX IF NOT EXISTS idx_citadel_vault_rotations_citadel
  ON citadel_vault_rotations(citadel_id, created_at);
`;

/** SQLite v269 columns added to citadel_vault_secrets (existing rows: envelope 1, NULL key and scope). */
export const CITADEL_VAULT_SECRET_SCOPE_COLUMNS: ReadonlyArray<readonly [name: string, sqliteDefinition: string]> = [
  ["chamber_id", "TEXT"],
  ["key_id", "TEXT"],
  ["envelope_version", "INTEGER NOT NULL DEFAULT 1"],
];

/** SQLite v269 tables and indexes; run after the scope columns exist. */
export const CITADEL_VAULT_KEYS_SQLITE_SQL = `
CREATE INDEX IF NOT EXISTS idx_citadel_vault_secrets_key ON citadel_vault_secrets(citadel_id, key_id);
${SQLITE_KEY_TABLES_SQL}`;

// --- PostgreSQL v217 / v218 ----------------------------------------------------

/**
 * PostgreSQL v217: additive, for installs whose v2 render predates these tables.
 * Written in the v2 render's own form: BIGINT integers, unique indexes as named
 * table constraints, plain secondary indexes, no CHECKs.
 */
export const CITADEL_VAULT_KEYS_POSTGRES_SQL = `
ALTER TABLE citadel_vault_secrets ADD COLUMN IF NOT EXISTS chamber_id TEXT;
ALTER TABLE citadel_vault_secrets ADD COLUMN IF NOT EXISTS key_id TEXT;
ALTER TABLE citadel_vault_secrets ADD COLUMN IF NOT EXISTS envelope_version BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_citadel_vault_secrets_key ON citadel_vault_secrets(citadel_id, key_id);

CREATE TABLE IF NOT EXISTS citadel_vault_keys (
  key_id TEXT PRIMARY KEY,
  citadel_id TEXT NOT NULL,
  chamber_id TEXT,
  scope_key TEXT NOT NULL,
  active_scope_key TEXT,
  dek_version BIGINT NOT NULL,
  kek_version BIGINT NOT NULL,
  wrapped_dek_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT idx_citadel_vault_keys_version UNIQUE (citadel_id, scope_key, dek_version),
  CONSTRAINT idx_citadel_vault_keys_active UNIQUE (citadel_id, active_scope_key)
);

CREATE TABLE IF NOT EXISTS citadel_vault_key_state (
  citadel_id TEXT PRIMARY KEY,
  kek_version BIGINT NOT NULL,
  legacy_reads_closed BIGINT NOT NULL DEFAULT 0,
  kek_created_at TEXT NOT NULL,
  kek_rotated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citadel_vault_rotations (
  rotation_id TEXT PRIMARY KEY,
  citadel_id TEXT NOT NULL,
  open_citadel_id TEXT,
  target TEXT NOT NULL,
  chamber_id TEXT,
  from_key_id TEXT,
  to_key_id TEXT,
  from_kek_version BIGINT,
  to_kek_version BIGINT,
  phase TEXT NOT NULL,
  approval_id TEXT,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  resealed_count BIGINT NOT NULL DEFAULT 0,
  total_count BIGINT NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CONSTRAINT idx_citadel_vault_rotations_open UNIQUE (open_citadel_id)
);
CREATE INDEX IF NOT EXISTS idx_citadel_vault_rotations_citadel ON citadel_vault_rotations(citadel_id, created_at);
`;

const BIGINT_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["citadel_vault_secrets", "envelope_version"],
  ["citadel_vault_keys", "dek_version"],
  ["citadel_vault_keys", "kek_version"],
  ["citadel_vault_key_state", "kek_version"],
  ["citadel_vault_key_state", "legacy_reads_closed"],
  ["citadel_vault_rotations", "from_kek_version"],
  ["citadel_vault_rotations", "to_kek_version"],
  ["citadel_vault_rotations", "resealed_count"],
  ["citadel_vault_rotations", "total_count"],
];

/**
 * PostgreSQL v218: frozen, idempotent, forward-only convergence. Fresh installs
 * get these tables from the v2 render; upgraded installs get v217. Both end with
 * BIGINT integers, the named unique constraints and the plain secondary indexes.
 * Rollback is restoration of the pre-migration backup.
 */
export const CITADEL_VAULT_KEYS_SCHEMA_CONVERGENCE_POSTGRES_SQL = `
${BIGINT_COLUMNS.map(([table, column]) => `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE BIGINT;`).join("\n")}
DROP INDEX IF EXISTS idx_citadel_vault_secrets_key;
CREATE INDEX idx_citadel_vault_secrets_key ON citadel_vault_secrets(citadel_id, key_id);
DROP INDEX IF EXISTS idx_citadel_vault_rotations_citadel;
CREATE INDEX idx_citadel_vault_rotations_citadel ON citadel_vault_rotations(citadel_id, created_at);
`;
