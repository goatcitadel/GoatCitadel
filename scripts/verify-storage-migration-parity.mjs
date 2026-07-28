import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPostgresMigrationRegistry,
  extractSqliteMigrationRegistry,
  findMigrationParityErrors,
  findPostgresRuntimeIntegrityErrors,
  findStorageMigrationManifestErrors,
  findStorageMigrationLineageErrors,
  findStorageMigrationSemanticOwnershipErrors,
  loadStorageTypeScriptSourceFiles,
} from "./verification/lib/storage-migration-manifest.mjs";
import { loadStorageMigrationBaseManifest } from "./verification/lib/storage-migration-lineage.mjs";

const repoRoot = process.cwd();
const paths = {
  sqlite: path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"),
  postgres: path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"),
  runtimeSchema: path.join(repoRoot, "packages", "storage", "src", "postgres", "runtime-schema.ts"),
  runtimeSchemaInternal: path.join(repoRoot, "packages", "storage", "src", "postgres", "runtime-schema.internal.ts"),
  manifest: path.join(repoRoot, "scripts", "verification", "baselines", "storage-migrations.json"),
};

export async function verifyStorageMigrationParity() {
  const [sqliteSource, postgresSource, runtimeSchemaSource, runtimeSchemaInternalSource, manifestSource, sourceFiles] =
    await Promise.all([
      fs.readFile(paths.sqlite, "utf8"),
      fs.readFile(paths.postgres, "utf8"),
      fs.readFile(paths.runtimeSchema, "utf8"),
      fs.readFile(paths.runtimeSchemaInternal, "utf8"),
      fs.readFile(paths.manifest, "utf8"),
      loadStorageTypeScriptSourceFiles(repoRoot),
    ]);
  const sqlite = extractSqliteMigrationRegistry(sqliteSource, { sourceFiles });
  const postgres = extractPostgresMigrationRegistry(postgresSource, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource,
    sourceFiles,
  });
  const manifest = JSON.parse(manifestSource);
  const base = await loadStorageMigrationBaseManifest({
    repoRoot,
    explicitRef: process.env.GOATCITADEL_STORAGE_MIGRATION_BASE_REF,
  });
  const errors = [
    ...findMigrationParityErrors(
      sqlite.migrations.map((migration) => migration.name),
      postgres.migrations.map((migration) => migration.name),
    ),
    ...findStorageMigrationManifestErrors({ manifest, sqlite, postgres }),
    ...(base ? findStorageMigrationLineageErrors({ baseManifest: base.manifest, sqlite, postgres }) : []),
    ...findPostgresRuntimeIntegrityErrors(postgres),
    ...findStorageMigrationSemanticOwnershipErrors({
      postgresMigrationsSource: postgresSource,
      runtimeSchemaSource,
      runtimeSchemaInternalSource,
    }),
  ];
  return { errors, sqlite, postgres, baseRef: base?.ref };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyStorageMigrationParity();
    if (result.errors.length > 0) {
      console.error("Storage migration parity check failed:");
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log(
        `Storage migration parity check passed (${result.sqlite.migrations.length} SQLite migrations, ${result.postgres.migrations.length} Postgres migrations${result.baseRef ? `; lineage base ${result.baseRef}` : ""}).`,
      );
    }
  } catch (error) {
    console.error("Storage migration parity check failed:");
    console.error(`- ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
