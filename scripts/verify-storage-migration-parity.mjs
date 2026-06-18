import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.cwd();
const SQLITE_MIGRATIONS_PATH = path.join(repoRoot, "packages", "storage", "src", "sqlite.ts");
const POSTGRES_MIGRATIONS_PATH = path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts");
const POSTGRES_RUNTIME_SCHEMA_PATH = path.join(repoRoot, "packages", "storage", "src", "postgres", "runtime-schema.ts");
const POSTGRES_RUNTIME_SCHEMA_INTERNAL_PATH = path.join(
  repoRoot,
  "packages",
  "storage",
  "src",
  "postgres",
  "runtime-schema.internal.ts",
);
const PROTECTED_POSTGRES_MIGRATIONS = Object.freeze([
  { version: 1, name: "runtime_event_and_cutover_tables", sha256: "9f9644496238572a6c3f284c11f5fa9fcbfab3fb14087378efd713f87676be3d" },
  { version: 2, name: "canonical_runtime_schema", sha256: null },
  { version: 3, name: "runtime_schema_hardening", sha256: "9702918aae7ceb5df2ee186f5cbe305bf89b34bce5bc05815f5c8231fb779040" },
  { version: 4, name: "chat_session_workbench_schema", sha256: "3f019ed0886e1c6006cc7b9ddca4718e04313c1297ab61b6e2e5cea8f85aad5d" },
  { version: 5, name: "sessions_session_key_unique_index", sha256: "b953dad29a0ab2399fd024300ed839d3b381e4fb7869a325b948794735ee1c33" },
  { version: 6, name: "runtime_inline_unique_indexes", sha256: "5f23718df4dca77b201eaaeb8e69ecc0f7b290e001d64e382f867d4631ca7167" },
  { version: 7, name: "canonical_runtime_schema_repairs", sha256: "4be5644c81f14c661aa180b5c3dbaa4de59f74864cecf0512c8fc8d9a29c6695" },
  { version: 8, name: "prompt_pack_benchmark_claim_repairs", sha256: "817db1dff8fd52c080f91e17f139655d0e871272586093ffd6bf9aa6733bcd06" },
  { version: 9, name: "orchestration_execution_ownership_schema", sha256: "97a686ed14ca2ddbd1565fe98d2d15c051c0212eb21d5f240c805802149f95d0" },
  { version: 10, name: "chat_user_input_prompt_repairs", sha256: "e5d940d6e74c9e9115fbcd72097e54ce4d5d24d70857ae68eb682505a81e0837" },
  { version: 11, name: "mutation_idempotency_runtime_repairs", sha256: "2d71799d5d8aca3d8fa6a0f68d57030ee713954fa683df75ce7f77c367a44509" },
  { version: 12, name: "prompt_pack_runs_shape_repairs", sha256: "c9003f790efa1f055ca1de0a286a6a3224375cfc6a12256155206e5f5d1ba5f1" },
  { version: 13, name: "chat_turn_trace_shape_repairs", sha256: "663ffee4fa23fb38c8ba2f0da441c0061d09db57938b098cdba0b1f3d4fb6861" },
  { version: 14, name: "chat_tool_and_delegation_shape_repairs", sha256: "150bbfd9e6e0f81c2a59c37ca02b7eace3bca324d5a27cab506dd2247ba329c4" },
  { version: 15, name: "chat_execution_plan_step_shape_repairs", sha256: "c16c6d04244abb184ef9356704edbb60155c0c69a230665cce0de6e140ef7a50" },
  { version: 16, name: "cron_jobs_action_description_end_at", sha256: "cdf35d8cb5d0d69e3d409fdf66d141b5515e2064d6dc8a84299ed2e9de3fe3fb" },
  { version: 17, name: "chat_session_and_agent_refresh_repairs", sha256: "f5a2eb34be357c368d08caf657957ad201e8f028e3aa9d0c0bf27a2895727a35" },
  { version: 18, name: "generated_artifact_provenance_repairs", sha256: "6e2f4e6b88021546bdba5ecdd1fcf27ad3d16e68906b24586b6d663c44ae1dde" },
  { version: 19, name: "imported_agent_catalog_schema_repairs", sha256: "4d976c7f82147ca671ae483c87a8caae45a90c4733a31d32e8e4609cbb7f2f76" },
  { version: 20, name: "chat_image_route_preference_repairs", sha256: "8fbfe1c508c4443f4422e033b4dde0a5b4db83d62a5a27e55863541af4407eae" },
  { version: 21, name: "prompt_pack_agentic_diagnostics_repairs", sha256: "47722441425ba101fe0dd40a00e73933555f3980a103e427beb9912b18ee3ba1" },
  { version: 22, name: "prompt_pack_benchmark_item_unique_repairs", sha256: "1c6e12500bcbfe896d44ed6e791cfbeef87e933fb5565b38494097b3e3516238" },
  { version: 23, name: "pending_approval_action_expiry_and_trace_index_parity", sha256: "5867a6eb99b33d4c48738daeae03fb0a14fd588be666c2d81f47f64f3ba71168" },
  { version: 24, name: "chat_delegation_step_current_shape_repairs", sha256: "82587b851edc91ec4447453329880d7642ca1b7b128c1ec2cdd9da7255d6fe45" },
  { version: 25, name: "runtime_evidence_envelopes", sha256: "27dc75637a76ba7b75f7a399ed2e7aa005818ecae589603833cdd3235dff1947" },
  { version: 26, name: "skill_evaluation_runs", sha256: "d2f5c4e90515fc4767ecc6274ab2c32f6ecd8c2b132ccfe673be45871655f980" },
  { version: 27, name: "skill_evaluation_runs", sha256: "d2f5c4e90515fc4767ecc6274ab2c32f6ecd8c2b132ccfe673be45871655f980" },
  { version: 28, name: "chat_operator_control_prefs", sha256: "319b6b187afb1bfa4fe15dd5dfeb1efcd258aced789705b12fe1652a1bba2c4e" },
]);

export function extractMigrationNames(source) {
  return extractMigrationRecords(source).map((record) => record.name);
}

export function extractMigrationRecords(source) {
  return [...source.matchAll(/\{\s*version:\s*(\d+),\s*name:\s*"([^"]+)"\s*(?:,([\s\S]*?))?\s*\}(?=\s*,|\s*\])/g)].map(
    (match) => {
      const sqlMatch = match[3]?.match(/sql:\s*`([\s\S]*?)`/);
      return {
        version: Number(match[1]),
        name: match[2],
        sha256: sqlMatch ? hashSql(sqlMatch[1]) : null,
      };
    },
  );
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

export function findPostgresMigrationImmutabilityErrors(
  postgresRecords,
  protectedRecords = PROTECTED_POSTGRES_MIGRATIONS,
) {
  const errors = [];
  const byVersion = new Map(postgresRecords.map((record) => [record.version, record]));
  const seenVersions = new Set();
  for (const record of postgresRecords) {
    if (seenVersions.has(record.version)) {
      errors.push(`Postgres migration version is duplicated: ${record.version}`);
    }
    seenVersions.add(record.version);
  }
  for (const expected of protectedRecords) {
    const actual = byVersion.get(expected.version);
    if (!actual) {
      errors.push(`Protected Postgres migration missing: v${expected.version} ${expected.name}`);
      continue;
    }
    if (actual.name !== expected.name) {
      errors.push(
        `Protected Postgres migration v${expected.version} was renamed: expected ${expected.name}, found ${actual.name}`,
      );
    }
    if (expected.sha256 && actual.sha256 !== expected.sha256) {
      errors.push(`Protected Postgres migration v${expected.version} SQL hash changed: ${expected.name}`);
    }
  }
  return errors;
}

export function findRuntimeSchemaSemanticGuardErrors({
  postgresMigrationsSource,
  runtimeSchemaSource,
  runtimeSchemaInternalSource,
}) {
  const errors = [];
  if (
    !/name:\s*"canonical_runtime_schema"[\s\S]*?sql:\s*buildPostgresRuntimeSchemaSql\(\)/.test(
      postgresMigrationsSource,
    )
  ) {
    errors.push("Postgres canonical runtime schema migration must be generated from the SQLite schema blueprint.");
  }
  if (
    !/name:\s*"canonical_runtime_schema_repairs"[\s\S]*?\$\{buildPostgresRuntimeSchemaSql\(\)\}/.test(
      postgresMigrationsSource,
    )
  ) {
    errors.push("Postgres runtime schema repair migration must replay the generated SQLite schema blueprint.");
  }
  if (!/\bcreateSqliteSchemaBlueprint\b/.test(runtimeSchemaSource)) {
    errors.push("Postgres runtime schema generator must import createSqliteSchemaBlueprint from SQLite storage.");
  }
  if (!/buildPostgresRuntimeSchemaSqlFromBlueprint\(createSqliteSchemaBlueprint\(\)\)/.test(runtimeSchemaSource)) {
    errors.push("Postgres runtime schema generator must render from createSqliteSchemaBlueprint().");
  }
  for (const token of ["table.columns", "table.indexes", "table.foreignKeys", "table.seedRows"]) {
    if (!runtimeSchemaInternalSource.includes(token)) {
      errors.push(`Postgres runtime schema renderer must consume SQLite blueprint field: ${token}`);
    }
  }
  return errors;
}

function isParityMigrationName(name) {
  return name.endsWith("_parity") || name.includes("_parity_");
}

function hashSql(sql) {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n").trim()).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sqlite = extractMigrationNames(await fs.readFile(SQLITE_MIGRATIONS_PATH, "utf8"));
  const postgresSource = await fs.readFile(POSTGRES_MIGRATIONS_PATH, "utf8");
  const runtimeSchemaSource = await fs.readFile(POSTGRES_RUNTIME_SCHEMA_PATH, "utf8");
  const runtimeSchemaInternalSource = await fs.readFile(POSTGRES_RUNTIME_SCHEMA_INTERNAL_PATH, "utf8");
  const postgresRecords = extractMigrationRecords(postgresSource);
  const postgres = postgresRecords.map((record) => record.name);
  const errors = [
    ...findMigrationParityErrors(sqlite, postgres),
    ...findPostgresMigrationImmutabilityErrors(postgresRecords),
    ...findRuntimeSchemaSemanticGuardErrors({
      postgresMigrationsSource: postgresSource,
      runtimeSchemaSource,
      runtimeSchemaInternalSource,
    }),
  ];
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
