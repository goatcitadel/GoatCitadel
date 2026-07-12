import fs from "node:fs/promises";
import path from "node:path";
import {
  buildAppendOnlyStorageMigrationManifest,
  extractPostgresMigrationRegistry,
  extractSqliteMigrationRegistry,
  findMigrationParityErrors,
  findPostgresRuntimeIntegrityErrors,
  findStorageMigrationSemanticOwnershipErrors,
  loadStorageTypeScriptSourceFiles,
} from "./verification/lib/storage-migration-manifest.mjs";

const repoRoot = process.cwd();
const paths = {
  sqlite: path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"),
  postgres: path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"),
  runtimeSchema: path.join(repoRoot, "packages", "storage", "src", "postgres", "runtime-schema.ts"),
  runtimeSchemaInternal: path.join(repoRoot, "packages", "storage", "src", "postgres", "runtime-schema.internal.ts"),
  manifest: path.join(repoRoot, "scripts", "verification", "baselines", "storage-migrations.json"),
};

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
const safetyErrors = [
  ...findMigrationParityErrors(
    sqlite.migrations.map((migration) => migration.name),
    postgres.migrations.map((migration) => migration.name),
  ),
  ...findPostgresRuntimeIntegrityErrors(postgres),
  ...findStorageMigrationSemanticOwnershipErrors({
    postgresMigrationsSource: postgresSource,
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
  }),
];
if (safetyErrors.length > 0) {
  throw new Error(`Refusing to update storage migration manifest:\n- ${safetyErrors.join("\n- ")}`);
}

const existingManifest = JSON.parse(manifestSource);
const updatedManifest = buildAppendOnlyStorageMigrationManifest({
  manifest: existingManifest,
  sqlite,
  postgres,
});
const serialized = `${JSON.stringify(updatedManifest, null, 2)}\n`;
if (serialized === manifestSource.replace(/\r\n/g, "\n")) {
  console.log("Storage migration manifest is already current; no changes written.");
} else {
  await fs.writeFile(paths.manifest, serialized, "utf8");
  console.log(
    `Appended storage migration manifest through SQLite v${sqlite.lastVersion} and Postgres v${postgres.lastVersion}.`,
  );
}
