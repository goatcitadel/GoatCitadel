import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "./migration-registry.js";
import { readSqliteSchemaShape, type SqliteSchemaShapeManifest } from "./schema-shape.js";

export interface SqliteSchemaReference {
  compatibilityKey: string;
  shape: SqliteSchemaShapeManifest;
  shapeSha256: string;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compatibilityKey(db: DatabaseSync, migrations: readonly SqliteMigration[]): string {
  const engine = db.prepare("SELECT sqlite_source_id() AS sourceId").get()?.sourceId;
  const compileOptions = db
    .prepare("PRAGMA compile_options")
    .all()
    .map((row) => String(row.compile_options))
    .sort();
  return hashJson({
    engine,
    compileOptions,
    node: process.versions.node,
    arch: process.arch,
    platform: process.platform,
    icu: process.versions.icu,
    locale: new Intl.Collator().resolvedOptions().locale,
    // Migration parity locks the implementation associated with these versions and names.
    lineage: migrations.map(({ version, name }) => [version, name]),
  });
}

export function createSqliteSchemaReference(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
): SqliteSchemaReference {
  const shape = readSqliteSchemaShape(db);
  return { compatibilityKey: compatibilityKey(db, migrations), shape, shapeSha256: hashJson(shape) };
}

export function readPackagedSqliteSchemaShape(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
): SqliteSchemaShapeManifest | undefined {
  let reference: SqliteSchemaReference | undefined;
  try {
    // The builder writes this beside the deployed code. PostgreSQL never needs to load it.
    reference = JSON.parse(readFileSync(new URL("./packaged-schema-reference.json", import.meta.url), "utf8"));
  } catch {
    return undefined;
  }
  return readCompatibleSqliteSchemaReference(db, migrations, reference);
}

export function readCompatibleSqliteSchemaReference(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  reference: SqliteSchemaReference | undefined,
): SqliteSchemaShapeManifest | undefined {
  if (!reference || !Array.isArray(reference.shape?.entries) || reference.shape.entries.length === 0) return undefined;
  if (reference.compatibilityKey !== compatibilityKey(db, migrations)) return undefined;
  return reference.shapeSha256 === hashJson(reference.shape) ? reference.shape : undefined;
}
