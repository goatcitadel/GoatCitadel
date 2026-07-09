import { DatabaseSync } from "node:sqlite";

export function createCitadelCoreSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS citadel_charters (
      citadel_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      kind TEXT NOT NULL,
      goals_json TEXT NOT NULL DEFAULT '[]',
      boundaries_json TEXT NOT NULL DEFAULT '[]',
      success_definition_json TEXT NOT NULL DEFAULT '[]',
      default_chamber_id TEXT,
      risk_posture TEXT NOT NULL DEFAULT 'balanced',
      model_policy_default TEXT NOT NULL DEFAULT 'hybrid_guarded',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS citadel_chambers (
      chamber_id TEXT PRIMARY KEY,
      citadel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sensitivity TEXT NOT NULL DEFAULT 'private',
      sealed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_citadel_chambers_citadel
      ON citadel_chambers(citadel_id, name);
  `);
}

interface LegacyCitadelCharterMigrationRow {
  citadel_id: string;
  name: string | null;
  kind: string;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export function migrateLegacyCitadelCharters(db: DatabaseSync): void {
  const existingRows = db.prepare("SELECT citadel_id, slug FROM citadel_records").all() as Array<{
    citadel_id: string;
    slug: string;
  }>;
  const existingCitadelIds = new Set(existingRows.map((row) => row.citadel_id));
  const usedSlugs = new Set(existingRows.map((row) => row.slug));
  const hasWorkspacesTable = tableExists(db, "workspaces");
  const rows = db
    .prepare(
      hasWorkspacesTable
        ? `
        SELECT
          charter.citadel_id,
          COALESCE(NULLIF(TRIM(workspace.name), ''), charter.citadel_id) AS name,
          charter.kind,
          workspace.workspace_id,
          charter.created_at,
          charter.updated_at
        FROM citadel_charters AS charter
        LEFT JOIN workspaces AS workspace
          ON workspace.workspace_id = charter.citadel_id
        ORDER BY charter.citadel_id ASC
      `
        : `
        SELECT
          charter.citadel_id,
          charter.citadel_id AS name,
          charter.kind,
          NULL AS workspace_id,
          charter.created_at,
          charter.updated_at
        FROM citadel_charters AS charter
        ORDER BY charter.citadel_id ASC
      `,
    )
    .all() as unknown as LegacyCitadelCharterMigrationRow[];
  const insert = db.prepare(`
    INSERT INTO citadel_records (
      citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
      default_workspace_id, created_at, updated_at
    ) VALUES (
      @citadelId, @name, @description, @slug, @kind, 'active', NULL,
      @defaultWorkspaceId, @createdAt, @updatedAt
    )
    ON CONFLICT(citadel_id) DO NOTHING
  `);
  for (const row of rows) {
    if (existingCitadelIds.has(row.citadel_id)) {
      continue;
    }
    const slug = reserveUniqueCitadelSlugForMigration(normalizeCitadelSlugForMigration(row.citadel_id), usedSlugs);
    existingCitadelIds.add(row.citadel_id);
    insert.run({
      citadelId: row.citadel_id,
      name: row.name ?? row.citadel_id,
      description: "Legacy workspace Citadel preserved during parent-scope migration.",
      slug,
      kind: row.kind,
      defaultWorkspaceId: row.workspace_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return Boolean(row);
}

function normalizeCitadelSlugForMigration(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const slug = normalized || "citadel";
  if (slug.length > 64) {
    return slug.slice(0, 64).replace(/-+$/g, "") || "citadel";
  }
  return slug;
}

function reserveUniqueCitadelSlugForMigration(baseSlug: string, usedSlugs: Set<string>): string {
  if (!usedSlugs.has(baseSlug)) {
    usedSlugs.add(baseSlug);
    return baseSlug;
  }
  let suffix = 2;
  while (true) {
    const suffixText = `-${suffix}`;
    const candidate = `${baseSlug.slice(0, Math.max(1, 64 - suffixText.length)).replace(/-+$/g, "")}${suffixText}`;
    if (!usedSlugs.has(candidate)) {
      usedSlugs.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}
