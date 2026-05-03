import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.cwd();
const SQLITE_MIGRATIONS_PATH = path.join(repoRoot, "packages", "storage", "src", "sqlite.ts");
const POSTGRES_MIGRATIONS_PATH = path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts");

export function extractMigrationNames(source) {
  return [...source.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
}

export function findMigrationParityErrors(sqliteNames, postgresNames) {
  const sqliteParity = sqliteNames.filter(isParityMigrationName);
  const postgresParity = postgresNames.filter(isParityMigrationName);
  const sqliteSet = new Set(sqliteParity);
  const postgresSet = new Set(postgresParity);
  const errors = [];

  for (const name of sqliteParity) {
    if (!postgresSet.has(name)) {
      errors.push(`SQLite parity migration missing from Postgres: ${name}`);
    }
  }
  for (const name of postgresParity) {
    if (!sqliteSet.has(name)) {
      errors.push(`Postgres parity migration missing from SQLite: ${name}`);
    }
  }

  const sharedSqliteOrder = sqliteParity.filter((name) => postgresSet.has(name));
  const sharedPostgresOrder = postgresParity.filter((name) => sqliteSet.has(name));
  if (sharedSqliteOrder.join("\n") !== sharedPostgresOrder.join("\n")) {
    errors.push("SQLite/Postgres parity migration ordering diverges.");
  }

  return errors;
}

function isParityMigrationName(name) {
  return name.endsWith("_parity") || name.includes("_parity_");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sqlite = extractMigrationNames(await fs.readFile(SQLITE_MIGRATIONS_PATH, "utf8"));
  const postgres = extractMigrationNames(await fs.readFile(POSTGRES_MIGRATIONS_PATH, "utf8"));
  const errors = findMigrationParityErrors(sqlite, postgres);
  if (errors.length > 0) {
    console.error("Storage migration parity check failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Storage migration parity check passed.");
  }
}
