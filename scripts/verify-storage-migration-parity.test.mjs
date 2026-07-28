import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  POSTGRES_V2_DYNAMIC_BOOTSTRAP_EXCEPTION,
  buildAppendOnlyStorageMigrationManifest,
  createStorageMigrationManifest,
  extractPostgresMigrationRegistry,
  extractSqliteMigrationRegistry,
  findMigrationParityErrors,
  findPostgresRuntimeIntegrityErrors,
  findStorageMigrationManifestErrors,
  findStorageMigrationSemanticOwnershipErrors,
  loadStorageTypeScriptSourceFiles,
} from "./verification/lib/storage-migration-manifest.mjs";

function postgresSource(entries) {
  return `
    import { buildPostgresRuntimeSchemaSql } from "./runtime-schema.js";
    const POSTGRES_V7_FROZEN_SCHEMA_SQL = "SELECT 7;";
    export const POSTGRES_MIGRATIONS = [${entries}];
  `;
}

const TEST_RUNTIME_SCHEMA_SOURCE = `
  export function buildPostgresRuntimeSchemaSql() {
    return buildPostgresRuntimeSchemaSqlFromBlueprint(createSqliteSchemaBlueprint());
  }
`;
const TEST_RUNTIME_SCHEMA_INTERNAL_SOURCE = `
  export function buildPostgresRuntimeSchemaSqlFromBlueprint() {
    return "SELECT 1;";
  }
`;
const TEST_SQLITE_BLUEPRINT_SOURCE = `
  export function createSqliteSchemaBlueprint() {
    return createSqliteSchemaBlueprintFromDatabase(createDatabase());
  }
  function createSqliteSchemaBlueprintFromDatabase() {
    return { tables: [] };
  }
`;

function extractPostgresWithOwners(source, options = {}) {
  return extractPostgresMigrationRegistry(source, {
    ...options,
    runtimeSchemaSource: TEST_RUNTIME_SCHEMA_SOURCE,
    runtimeSchemaInternalSource: TEST_RUNTIME_SCHEMA_INTERNAL_SOURCE,
    sqliteSource: TEST_SQLITE_BLUEPRINT_SOURCE,
  });
}

function sqliteSource(entries) {
  return `
    function createOne(db) { db.exec("SELECT 1"); }
    function createTwo(db) { db.exec("SELECT 2"); }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [${entries}],
    }];
  `;
}

test("extracts only direct registry entries and keeps migrations after comments", () => {
  const records = extractPostgresMigrationRegistry(
    `
      const decoy = { version: 999, name: "comment_decoy", sql: "SELECT 999" };
      export const POSTGRES_MIGRATIONS = [
        { version: 61, name: "sixty_one", sql: "SELECT 61" },
        // The old regex skipped both of these because comments preceded the object.
        { version: 62, name: "sixty_two", sql: "SELECT 62" },
        /* keep extracting direct entries */
        { version: 63, name: "sixty_three", sql: "SELECT 63" },
      ];
    `,
    { requireContiguousFromOne: false },
  );

  assert.deepEqual(
    records.migrations.map(({ version, name }) => ({ version, name })),
    [
      { version: 61, name: "sixty_one" },
      { version: 62, name: "sixty_two" },
      { version: 63, name: "sixty_three" },
    ],
  );
});

test("extracts direct SQLite entries from SCHEMA_MIGRATION_GROUPS", () => {
  const registry = extractSqliteMigrationRegistry(
    sqliteSource(`
    { version: 1, name: "one", up: createOne },
    { version: 2, name: "two_parity", up: (db) => db.exec("SELECT 2") }
  `),
  );

  assert.deepEqual(
    registry.migrations.map(({ version, name, groupName }) => ({ version, name, groupName })),
    [
      { version: 1, name: "one", groupName: "canonical" },
      { version: 2, name: "two_parity", groupName: "canonical" },
    ],
  );
});

test("definition hashes ignore comments and formatting but detect code changes", () => {
  const compact = extractPostgresMigrationRegistry(postgresSource('{version:1,name:"one",sql:`SELECT 1;`}'));
  const formatted = extractPostgresMigrationRegistry(
    postgresSource(`
      {
        // formatting-only change
        version: 1,
        name: "one",
        sql: \`SELECT 1;\`,
      }
    `),
  );
  const changed = extractPostgresMigrationRegistry(postgresSource('{version:1,name:"one",sql:`SELECT 2;`}'));

  assert.equal(compact.migrations[0]?.definitionSha256, formatted.migrations[0]?.definitionSha256);
  assert.notEqual(compact.migrations[0]?.definitionSha256, changed.migrations[0]?.definitionSha256);
});

test("resolved Postgres payload hashes detect frozen constant changes", () => {
  const firstSource = `
      import { buildPostgresRuntimeSchemaSql } from "./runtime-schema.js";
      const POSTGRES_V7_FROZEN_SCHEMA_SQL = "SELECT 7;";
      export const POSTGRES_MIGRATIONS = [
        { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
        {
          version: 7,
          name: "canonical_runtime_schema_repairs",
          sql: \`\${POSTGRES_V7_FROZEN_SCHEMA_SQL}\`,
        },
      ];
    `;
  const changedSource = `
      import { buildPostgresRuntimeSchemaSql } from "./runtime-schema.js";
      const POSTGRES_V7_FROZEN_SCHEMA_SQL = "SELECT changed;";
      export const POSTGRES_MIGRATIONS = [
        { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
        {
          version: 7,
          name: "canonical_runtime_schema_repairs",
          sql: \`\${POSTGRES_V7_FROZEN_SCHEMA_SQL}\`,
        },
      ];
    `;
  const first = extractPostgresWithOwners(firstSource, { requireContiguousFromOne: false });
  const changed = extractPostgresWithOwners(changedSource, { requireContiguousFromOne: false });

  assert.equal(first.migrations[1]?.definitionSha256, changed.migrations[1]?.definitionSha256);
  assert.match(first.migrations[1]?.sqlPayloadSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(first.migrations[1]?.sqlPayloadSha256, changed.migrations[1]?.sqlPayloadSha256);

  const sqlite = extractSqliteMigrationRegistry(sqliteSource('{ version: 1, name: "one", up: createOne }'));
  const manifest = createStorageMigrationManifest({ sqlite, postgres: first });
  assert.match(
    findStorageMigrationManifestErrors({ manifest, sqlite, postgres: changed })[0] ?? "",
    /resolved behavior digest/i,
  );
  assert.throws(
    () => buildAppendOnlyStorageMigrationManifest({ manifest, sqlite, postgres: changed }),
    /existing Postgres migration.*drift/i,
  );
});

test("resolved static Postgres payload hashes cover direct SQL", () => {
  const registry = extractPostgresMigrationRegistry(
    `
      export const POSTGRES_MIGRATIONS = [{
        version: 1,
        name: "direct_sql",
        sql: \`SELECT 1;\`,
      }];
    `,
  );
  assert.match(registry.migrations[0]?.sqlPayloadSha256 ?? "", /^[a-f0-9]{64}$/);
});

test("SQLite implementation hashes detect local helper body changes", () => {
  const first = extractSqliteMigrationRegistry(`
    function createOne(db) { db.exec("SELECT 1"); }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);
  const changed = extractSqliteMigrationRegistry(`
    function createOne(db) { db.exec("SELECT changed"); }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);
  const reformatted = extractSqliteMigrationRegistry(`
    // formatting and comments do not change executable ownership
    function createOne(db) {
      db.exec("SELECT 1");
    }
    const SCHEMA_MIGRATION_GROUPS = [
      {
        name: "canonical",
        migrations: [{ version: 1, name: "one", up: createOne }],
      },
    ];
  `);

  assert.equal(first.migrations[0]?.definitionSha256, changed.migrations[0]?.definitionSha256);
  assert.match(first.migrations[0]?.implementationSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(first.migrations[0]?.implementationSha256, reformatted.migrations[0]?.implementationSha256);
  assert.notEqual(first.migrations[0]?.implementationSha256, changed.migrations[0]?.implementationSha256);
});

test("canonical TypeScript token hashes detect semantic unary operator changes", () => {
  const negate = extractSqliteMigrationRegistry(`
    function createOne(value) { return !value; }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);
  const coerce = extractSqliteMigrationRegistry(`
    function createOne(value) { return +value; }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);

  assert.notEqual(negate.migrations[0]?.implementationSha256, coerce.migrations[0]?.implementationSha256);
});

test("canonical hashes preserve ASI-sensitive parse structure", () => {
  const returned = extractSqliteMigrationRegistry(`
    function createOne(db) { return db.exec("SELECT 1"); }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);
  const unreachable = extractSqliteMigrationRegistry(`
    function createOne(db) { return
      db.exec("SELECT 1"); }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);

  assert.notEqual(returned.migrations[0]?.implementationSha256, unreachable.migrations[0]?.implementationSha256);
});

test("SQLite implementation hashes detect imported helper body changes", () => {
  const sourcePath = "packages/storage/src/sqlite.ts";
  const source = `
    import { createOne } from "./sqlite/imported-helper.js";
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `;
  const first = extractSqliteMigrationRegistry(source, {
    sourcePath,
    sourceFiles: new Map([
      [sourcePath, source],
      ["packages/storage/src/sqlite/imported-helper.ts", 'export function createOne(db) { db.exec("SELECT 1"); }'],
    ]),
  });
  const changed = extractSqliteMigrationRegistry(source, {
    sourcePath,
    sourceFiles: new Map([
      [sourcePath, source],
      [
        "packages/storage/src/sqlite/imported-helper.ts",
        'export function createOne(db) { db.exec("SELECT changed"); }',
      ],
    ]),
  });

  assert.equal(first.migrations[0]?.definitionSha256, changed.migrations[0]?.definitionSha256);
  assert.notEqual(first.migrations[0]?.implementationSha256, changed.migrations[0]?.implementationSha256);
  assert.throws(
    () => extractSqliteMigrationRegistry(source, { sourcePath, sourceFiles: new Map([[sourcePath, source]]) }),
    /relative source.*not available/i,
  );
});

test("SQLite implementation closures include workspace package exports", async () => {
  const [sourceFiles, sqliteSourceText] = await Promise.all([
    loadStorageTypeScriptSourceFiles(new URL("../", import.meta.url)),
    readFile(new URL("../packages/storage/src/sqlite.ts", import.meta.url), "utf8"),
  ]);
  const contractsPolicyPath = "packages/contracts/src/prompt-pack.ts";
  const policySource = sourceFiles.get(contractsPolicyPath);
  assert.equal(typeof policySource, "string", "contracts prompt-pack source must be in the verifier graph");
  const changedPolicySource = policySource.replace(
    /DEFAULT_PROMPT_PACK_POLICY_V2: PromptPackPolicyV2 = \{([\s\S]*?)threshold: 75,/u,
    "DEFAULT_PROMPT_PACK_POLICY_V2: PromptPackPolicyV2 = {$1threshold: 76,",
  );
  assert.notEqual(changedPolicySource, policySource, "test mutation must change the v2 threshold");
  const changedSourceFiles = new Map(sourceFiles);
  changedSourceFiles.set(contractsPolicyPath, changedPolicySource);
  const first = extractSqliteMigrationRegistry(sqliteSourceText, { sourceFiles });
  const changed = extractSqliteMigrationRegistry(sqliteSourceText, { sourceFiles: changedSourceFiles });

  for (const version of [14, 19, 53]) {
    assert.notEqual(
      first.migrations.find((migration) => migration.version === version)?.implementationSha256,
      changed.migrations.find((migration) => migration.version === version)?.implementationSha256,
      `SQLite v${version} must lock DEFAULT_PROMPT_PACK_POLICY_V2`,
    );
  }
});

test("fails closed on spread, dynamic, duplicate, and malformed registry definitions", () => {
  assert.throws(
    () => extractPostgresMigrationRegistry("const other = []; export const POSTGRES_MIGRATIONS = [...other];"),
    /spread/i,
  );
  assert.throws(
    () =>
      extractPostgresMigrationRegistry(
        'const version = 1; export const POSTGRES_MIGRATIONS = [{ version, name: "one", sql: "" }];',
      ),
    /version.*numeric literal/i,
  );
  assert.throws(
    () =>
      extractPostgresMigrationRegistry(
        'const sql = ""; export const POSTGRES_MIGRATIONS = [{ version: 1, name: "one", sql }];',
      ),
    /sql.*property assignment/i,
  );
  assert.throws(
    () =>
      extractSqliteMigrationRegistry(
        'const migrations = []; const SCHEMA_MIGRATION_GROUPS = [{ name: "canonical", migrations }];',
      ),
    /migrations.*array literal/i,
  );
  assert.throws(
    () =>
      extractSqliteMigrationRegistry(
        'const up = () => {}; const SCHEMA_MIGRATION_GROUPS = [{ name: "canonical", migrations: [{ version: 1, name: "one", up }] }];',
      ),
    /up.*property assignment/i,
  );
  assert.throws(
    () =>
      extractSqliteMigrationRegistry(`
        const helpers = { createOne() {} };
        const SCHEMA_MIGRATION_GROUPS = [{
          name: "canonical",
          migrations: [{ version: 1, name: "one", up: helpers.createOne }],
        }];
      `),
    /up.*identifier.*function expression/i,
  );
  const workspaceSourcePath = "packages/storage/src/sqlite.ts";
  const workspaceSource = `
    import { createOne } from "./sqlite/workspace-helper.js";
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `;
  assert.throws(
    () =>
      extractSqliteMigrationRegistry(workspaceSource, {
        sourcePath: workspaceSourcePath,
        sourceFiles: new Map([
          [workspaceSourcePath, workspaceSource],
          [
            "packages/storage/src/sqlite/workspace-helper.ts",
            'import { POLICY } from "@goatcitadel/unmapped"; export function createOne() { return POLICY; }',
          ],
        ]),
      }),
    /workspace source.*not configured/i,
  );
  assert.throws(
    () =>
      extractPostgresMigrationRegistry(
        postgresSource('{ version: 1, name: "one", sql: "" }, { version: 1, name: "again", sql: "" }'),
      ),
    /duplicated.*1/i,
  );
  assert.throws(
    () => extractPostgresMigrationRegistry("export const POSTGRES_MIGRATIONS = [{ version: 1,"),
    /could not be parsed as TypeScript.*'}' expected/i,
  );
});

test("uses a supported fail-closed TypeScript syntax diagnostics API", async () => {
  const implementation = await readFile(
    new URL("./verification/lib/storage-migration-manifest.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(implementation, /\.parseDiagnostics\b/u);
  assert.match(implementation, /createProgram/u);
  assert.match(implementation, /getSyntacticDiagnostics/u);
  assert.match(implementation, /Array\.isArray\(diagnostics\)/u);
});

test("requires parity-bearing migrations on both storage backends and in the same order", () => {
  assert.deepEqual(findMigrationParityErrors(["first", "foo_parity"], ["first"]), [
    "SQLite parity migration missing from Postgres: foo_parity",
  ]);
  assert.deepEqual(findMigrationParityErrors(["first"], ["first", "foo_parity"]), [
    "Postgres parity migration missing from SQLite: foo_parity",
  ]);
  assert.deepEqual(findMigrationParityErrors(["a_parity", "b_parity"], ["b_parity", "a_parity"]), [
    "SQLite/Postgres parity migration ordering diverges.",
  ]);
});

test("requires complete exact manifest equality", () => {
  const sqlite = extractSqliteMigrationRegistry(sqliteSource('{ version: 1, name: "one", up: createOne }'));
  const postgres = extractPostgresWithOwners(
    postgresSource(`
      { version: 1, name: "one", sql: "SELECT 1" },
      { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() }
    `),
  );
  const manifest = createStorageMigrationManifest({ sqlite, postgres });

  assert.deepEqual(findStorageMigrationManifestErrors({ manifest, sqlite, postgres }), []);

  const changed = structuredClone(manifest);
  changed.sources.postgres.migrations[0].definitionSha256 = "0".repeat(64);
  assert.match(findStorageMigrationManifestErrors({ manifest: changed, sqlite, postgres })[0] ?? "", /exactly match/i);

  const extra = structuredClone(manifest);
  extra.sources.sqlite.migrations.push({
    version: 2,
    name: "untracked_extra",
    groupName: "canonical",
    definitionSha256: "1".repeat(64),
  });
  assert.match(findStorageMigrationManifestErrors({ manifest: extra, sqlite, postgres })[0] ?? "", /exactly match/i);
});

test("makes the Postgres v2 dynamic bootstrap limitation explicit", () => {
  const sqlite = extractSqliteMigrationRegistry(sqliteSource('{ version: 1, name: "one", up: createOne }'));
  const postgres = extractPostgresWithOwners(
    postgresSource(`
      { version: 1, name: "one", sql: "SELECT 1" },
      { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() }
    `),
  );
  const manifest = createStorageMigrationManifest({ sqlite, postgres });

  assert.deepEqual(manifest.exceptions[0], {
    ...POSTGRES_V2_DYNAMIC_BOOTSTRAP_EXCEPTION,
    ownerProvenance: postgres.v2OwnerProvenance,
  });
  assert.equal(POSTGRES_V2_DYNAMIC_BOOTSTRAP_EXCEPTION.protection, "definition-and-owner-only");
  assert.match(POSTGRES_V2_DYNAMIC_BOOTSTRAP_EXCEPTION.reason, /does not claim generated SQL byte immutability/i);

  manifest.exceptions = [];
  assert.match(findStorageMigrationManifestErrors({ manifest, sqlite, postgres })[0] ?? "", /exactly match/i);
});

test("captures and locks runtime integrity digests for generated Postgres migrations", () => {
  const v81Digest = "a".repeat(64);
  const v85Digest = "b".repeat(64);
  const registry = extractPostgresMigrationRegistry(
    postgresSource(`
      { version: 81, name: "generated_81", sql: "", integritySha256: "${v81Digest}", batchedStatements: [] },
      { version: 85, name: "generated_85", sql: "", integritySha256: "${v85Digest}", batchedStatements: [] }
    `),
    { requireContiguousFromOne: false },
  );

  assert.equal(registry.migrations[0]?.runtimeIntegritySha256, v81Digest);
  assert.equal(registry.migrations[1]?.runtimeIntegritySha256, v85Digest);
  assert.deepEqual(
    findPostgresRuntimeIntegrityErrors({
      migrations: [
        {
          version: 81,
          name: "scrub_legacy_remote_approval_bearers",
          runtimeIntegritySha256: "4187b1a0cc73330480192ee66650990775c53c35fe2c54a01559ab4af6631b0a",
        },
        {
          version: 85,
          name: "scrub_legacy_remote_approval_bearers_from_effect_results",
          runtimeIntegritySha256: "ef8cc376dbcba14eb6dd496d5cf14be19183096bafcab2ae57395dedae76df74",
        },
      ],
    }),
    [],
  );
  assert.match(
    findPostgresRuntimeIntegrityErrors({
      migrations: [
        { version: 81, name: "scrub_legacy_remote_approval_bearers", runtimeIntegritySha256: v81Digest },
        {
          version: 85,
          name: "scrub_legacy_remote_approval_bearers_from_effect_results",
          runtimeIntegritySha256: v85Digest,
        },
      ],
    })[0] ?? "",
    /v81.*integrity/i,
  );
  assert.throws(
    () =>
      extractPostgresMigrationRegistry(
        postgresSource('{ version: 1, name: "generated", sql: "", batchedStatements: [] }'),
      ),
    /batchedStatements.*integritySha256/i,
  );
});

test("semantic ownership proof follows AST nodes, not comments or string decoys", () => {
  const valid = findStorageMigrationSemanticOwnershipErrors({
    postgresMigrationsSource: postgresSource(`
      { version: 1, name: "one", sql: "SELECT 1" },
      { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
      { version: 3, name: "three", sql: "SELECT 3" },
      { version: 4, name: "four", sql: "SELECT 4" },
      { version: 5, name: "five", sql: "SELECT 5" },
      { version: 6, name: "six", sql: "SELECT 6" },
      { version: 7, name: "canonical_runtime_schema_repairs", sql: \`\${POSTGRES_V7_FROZEN_SCHEMA_SQL}\` }
    `),
    runtimeSchemaSource: `
      import { createSqliteSchemaBlueprint } from "../sqlite.js";
      import { buildPostgresRuntimeSchemaSqlFromBlueprint } from "./runtime-schema.internal.js";
      export function buildPostgresRuntimeSchemaSql() {
        return buildPostgresRuntimeSchemaSqlFromBlueprint(createSqliteSchemaBlueprint());
      }
    `,
    runtimeSchemaInternalSource: `
      export function render(table) {
        return [table.columns, table.indexes, table.foreignKeys, table.seedRows];
      }
    `,
  });
  assert.deepEqual(valid, []);

  const decoysOnly = findStorageMigrationSemanticOwnershipErrors({
    postgresMigrationsSource: `
      // buildPostgresRuntimeSchemaSql()
      const POSTGRES_MIGRATIONS = [
        { version: 2, name: "canonical_runtime_schema", sql: "buildPostgresRuntimeSchemaSql()" },
        { version: 7, name: "canonical_runtime_schema_repairs", sql: "POSTGRES_V7_FROZEN_SCHEMA_SQL" },
      ];
    `,
    runtimeSchemaSource: `
      // createSqliteSchemaBlueprint buildPostgresRuntimeSchemaSqlFromBlueprint
      export function buildPostgresRuntimeSchemaSql() { return "createSqliteSchemaBlueprint()"; }
    `,
    runtimeSchemaInternalSource: 'const decoy = "table.columns table.indexes table.foreignKeys table.seedRows";',
  });

  assert.ok(decoysOnly.length >= 6, `expected ownership failures, got ${JSON.stringify(decoysOnly)}`);
});

test("Postgres v2 owner provenance catches renderer drift that semantic anchors miss", async () => {
  const [postgresSourceText, runtimeSchemaSource, runtimeSchemaInternalSource, sqliteSourceText, sourceFiles] =
    await Promise.all([
      readFile(new URL("../packages/storage/src/postgres/migrations.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/postgres/runtime-schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/postgres/runtime-schema.internal.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/sqlite.ts", import.meta.url), "utf8"),
      loadStorageTypeScriptSourceFiles(new URL("../", import.meta.url)),
    ]);
  const sqlite = extractSqliteMigrationRegistry(sqliteSource('{ version: 1, name: "one", up: createOne }'));
  const postgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource: sqliteSourceText,
    sourceFiles,
  });
  const manifest = createStorageMigrationManifest({ sqlite, postgres });
  const changedRuntimeSchemaInternalSource = runtimeSchemaInternalSource.replace(
    'return statements.join("\\n");',
    'return "DROP TABLE chat_sessions;";',
  );
  assert.notEqual(changedRuntimeSchemaInternalSource, runtimeSchemaInternalSource);
  const changedPostgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource: changedRuntimeSchemaInternalSource,
    sqliteSource: sqliteSourceText,
    sourceFiles,
  });
  assert.deepEqual(
    findStorageMigrationSemanticOwnershipErrors({
      postgresMigrationsSource: postgresSourceText,
      runtimeSchemaSource,
      runtimeSchemaInternalSource: changedRuntimeSchemaInternalSource,
    }),
    [],
    "the durable owner digest must close paths that shallow semantic anchors cannot",
  );
  assert.match(
    findStorageMigrationManifestErrors({ manifest, sqlite, postgres: changedPostgres })[0] ?? "",
    /owner provenance|resolved behavior digest/i,
  );
  assert.throws(
    () => buildAppendOnlyStorageMigrationManifest({ manifest, sqlite, postgres: changedPostgres }),
    /owner provenance.*drift/i,
  );
});

test("Postgres v2 owner provenance includes blueprint helper source closure", async () => {
  const [postgresSourceText, runtimeSchemaSource, runtimeSchemaInternalSource, sqliteSourceText, sourceFiles] =
    await Promise.all([
      readFile(new URL("../packages/storage/src/postgres/migrations.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/postgres/runtime-schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/postgres/runtime-schema.internal.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/sqlite.ts", import.meta.url), "utf8"),
      loadStorageTypeScriptSourceFiles(new URL("../", import.meta.url)),
    ]);
  const sqlite = extractSqliteMigrationRegistry(sqliteSource('{ version: 1, name: "one", up: createOne }'));
  const postgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource: sqliteSourceText,
    sourceFiles,
  });
  const manifest = createStorageMigrationManifest({ sqlite, postgres });
  const changedSqliteSource = sqliteSourceText.replace(
    "return `idx_${tableName}_${columnPart}_${suffix}`;",
    "return `changed_${tableName}_${columnPart}_${suffix}`;",
  );
  assert.notEqual(changedSqliteSource, sqliteSourceText);
  const changedSourceFiles = new Map(sourceFiles);
  changedSourceFiles.set("packages/storage/src/sqlite.ts", changedSqliteSource);
  const changedPostgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource: changedSqliteSource,
    sourceFiles: changedSourceFiles,
  });

  assert.equal(
    postgres.v2OwnerProvenance.createSqliteSchemaBlueprintSha256,
    changedPostgres.v2OwnerProvenance.createSqliteSchemaBlueprintSha256,
    "the direct wrapper digest should not absorb unrelated migration-registry source",
  );
  assert.notEqual(
    postgres.v2OwnerProvenance.createSqliteSchemaBlueprintFromDatabaseClosureSha256,
    changedPostgres.v2OwnerProvenance.createSqliteSchemaBlueprintFromDatabaseClosureSha256,
  );
  assert.match(
    findStorageMigrationManifestErrors({ manifest, sqlite, postgres: changedPostgres })[0] ?? "",
    /resolved behavior digest/i,
  );
  assert.throws(
    () => buildAppendOnlyStorageMigrationManifest({ manifest, sqlite, postgres: changedPostgres }),
    /owner provenance.*drift/i,
  );
});

test("Postgres v2 owner closure treats the independently manifested SQLite group array as data", async () => {
  const [postgresSourceText, runtimeSchemaSource, runtimeSchemaInternalSource, sqliteSourceText, sourceFiles] =
    await Promise.all([
      readFile(new URL("../packages/storage/src/postgres/migrations.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/postgres/runtime-schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/postgres/runtime-schema.internal.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/storage/src/sqlite.ts", import.meta.url), "utf8"),
      loadStorageTypeScriptSourceFiles(new URL("../", import.meta.url)),
    ]);
  const sqlite = extractSqliteMigrationRegistry(sqliteSourceText, { sourceFiles });
  const postgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource: sqliteSourceText,
    sourceFiles,
  });
  const manifest = createStorageMigrationManifest({ sqlite, postgres });
  const registryEndMarker = "    ],\n  },\n];\n\nconst SCHEMA_MIGRATIONS";
  const registryEndIndex = sqliteSourceText.lastIndexOf(registryEndMarker);
  assert.ok(registryEndIndex > 0, "test must locate the canonical SQLite migration registry tail");
  const syntheticVersion = sqlite.lastVersion + 1;
  const appendedSqliteSource = `${sqliteSourceText.slice(0, registryEndIndex)}      {
        version: ${syntheticVersion},
        name: "synthetic_append_only_test",
        up: () => {},
      },
${sqliteSourceText.slice(registryEndIndex)}`;
  const appendedSourceFiles = new Map(sourceFiles);
  appendedSourceFiles.set("packages/storage/src/sqlite.ts", appendedSqliteSource);
  const appendedSqlite = extractSqliteMigrationRegistry(appendedSqliteSource, {
    sourceFiles: appendedSourceFiles,
  });
  const unchangedOwnerPostgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource: appendedSqliteSource,
    sourceFiles: appendedSourceFiles,
  });

  assert.deepEqual(unchangedOwnerPostgres.v2OwnerProvenance, postgres.v2OwnerProvenance);
  const updated = buildAppendOnlyStorageMigrationManifest({
    manifest,
    sqlite: appendedSqlite,
    postgres: unchangedOwnerPostgres,
  });
  assert.equal(updated.sources.sqlite.expectedLastVersion, syntheticVersion);
  assert.deepEqual(updated.exceptions[0].ownerProvenance, manifest.exceptions[0].ownerProvenance);
});

test("append-only updater adds only a contiguous suffix and refuses existing drift", () => {
  const originalSqlite = extractSqliteMigrationRegistry(sqliteSource('{ version: 1, name: "one", up: createOne }'));
  const originalPostgres = extractPostgresWithOwners(
    postgresSource(`
      { version: 1, name: "one", sql: "SELECT 1" },
      { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() }
    `),
  );
  const manifest = createStorageMigrationManifest({ sqlite: originalSqlite, postgres: originalPostgres });
  const appendedSqlite = extractSqliteMigrationRegistry(
    sqliteSource(`
    { version: 1, name: "one", up: createOne },
    { version: 2, name: "two", up: createTwo }
  `),
  );
  const appendedPostgres = extractPostgresWithOwners(
    postgresSource(`
      { version: 1, name: "one", sql: "SELECT 1" },
      { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
      { version: 3, name: "three", sql: "SELECT 3" }
    `),
  );

  const updated = buildAppendOnlyStorageMigrationManifest({
    manifest,
    sqlite: appendedSqlite,
    postgres: appendedPostgres,
  });
  assert.equal(updated.sources.sqlite.expectedCount, 2);
  assert.equal(updated.sources.postgres.expectedLastVersion, 3);
  assert.deepEqual(updated.sources.sqlite.migrations[0], manifest.sources.sqlite.migrations[0]);
  assert.deepEqual(updated.sources.postgres.migrations[0], manifest.sources.postgres.migrations[0]);

  const driftedPostgres = extractPostgresWithOwners(
    postgresSource(`
      { version: 1, name: "one", sql: "SELECT changed" },
      { version: 2, name: "canonical_runtime_schema", sql: buildPostgresRuntimeSchemaSql() },
      { version: 3, name: "three", sql: "SELECT 3" }
    `),
  );
  assert.throws(
    () => buildAppendOnlyStorageMigrationManifest({ manifest, sqlite: appendedSqlite, postgres: driftedPostgres }),
    /existing Postgres migration.*drift/i,
  );
  assert.throws(
    () =>
      buildAppendOnlyStorageMigrationManifest({
        manifest,
        sqlite: appendedSqlite,
        postgres: extractPostgresMigrationRegistry(postgresSource('{ version: 1, name: "one", sql: "SELECT 1" }')),
      }),
    /removed.*Postgres/i,
  );
  const helperDriftSqlite = extractSqliteMigrationRegistry(`
    function createOne(db) { db.exec("SELECT changed"); }
    const SCHEMA_MIGRATION_GROUPS = [{
      name: "canonical",
      migrations: [{ version: 1, name: "one", up: createOne }],
    }];
  `);
  assert.throws(
    () =>
      buildAppendOnlyStorageMigrationManifest({
        manifest,
        sqlite: helperDriftSqlite,
        postgres: originalPostgres,
      }),
    /existing SQLite migration.*drift/i,
  );
});

test("current registries and checked-in manifest cover every migration exactly", async () => {
  const [
    sqliteSourceText,
    postgresSourceText,
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    manifestText,
    sourceFiles,
  ] = await Promise.all([
    readFile(new URL("../packages/storage/src/sqlite.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/storage/src/postgres/migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/storage/src/postgres/runtime-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/storage/src/postgres/runtime-schema.internal.ts", import.meta.url), "utf8"),
    readFile(new URL("./verification/baselines/storage-migrations.json", import.meta.url), "utf8"),
    loadStorageTypeScriptSourceFiles(new URL("../", import.meta.url)),
  ]);
  const sqlite = extractSqliteMigrationRegistry(sqliteSourceText, { sourceFiles });
  const postgres = extractPostgresMigrationRegistry(postgresSourceText, {
    runtimeSchemaSource,
    runtimeSchemaInternalSource,
    sqliteSource: sqliteSourceText,
    sourceFiles,
  });
  const manifest = JSON.parse(manifestText);

  assert.equal(sqlite.migrations.length, 181);
  assert.deepEqual([sqlite.firstVersion, sqlite.lastVersion], [1, 181]);
  assert.equal(postgres.migrations.length, 124);
  assert.deepEqual([postgres.firstVersion, postgres.lastVersion], [1, 124]);
  assert.equal(
    postgres.migrations.find((record) => record.version === 62)?.name,
    "chat_delegation_step_degraded_handoff_repairs",
  );
  assert.ok(
    sqlite.migrations.every((record) => /^[a-f0-9]{64}$/.test(record.implementationSha256)),
    "every SQLite migration must lock its executable up implementation/source closure",
  );
  assert.match(postgres.migrations.find((record) => record.version === 7)?.sqlPayloadSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(postgres.migrations.find((record) => record.version === 2)?.sqlPayloadSha256, undefined);
  assert.deepEqual(
    postgres.migrations.filter((record) => !record.sqlPayloadSha256).map((record) => record.version),
    [2, 119, 120, 121, 122],
  );
  assert.equal(postgres.migrations.find((record) => record.version === 63)?.name, "citadel_tables_backfill");
  assert.equal(
    postgres.migrations.find((record) => record.version === 81)?.runtimeIntegritySha256,
    "4187b1a0cc73330480192ee66650990775c53c35fe2c54a01559ab4af6631b0a",
  );
  assert.equal(
    postgres.migrations.find((record) => record.version === 85)?.runtimeIntegritySha256,
    "ef8cc376dbcba14eb6dd496d5cf14be19183096bafcab2ae57395dedae76df74",
  );
  assert.deepEqual(findStorageMigrationManifestErrors({ manifest, sqlite, postgres }), []);
});

test("package scripts expose verification and an append-only manifest updater", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const verifyCommand = packageJson.scripts?.["verify:storage:migration-parity"];
  const updateCommand = packageJson.scripts?.["update:storage:migration-manifest"];

  assert.equal(typeof verifyCommand, "string");
  assert.equal(typeof updateCommand, "string");
  assert.match(updateCommand, /update-storage-migration-manifest\.mjs/);
  const buildIndex = verifyCommand.indexOf("pnpm --filter @goatcitadel/contracts build");
  const sourceTestIndex = verifyCommand.indexOf("tsx --test src/postgres-migration-integrity.test.ts");
  assert.ok(buildIndex >= 0, "migration parity must build the contracts runtime dependency");
  assert.ok(sourceTestIndex > buildIndex, "contracts must be built before the source-level integrity test");
  assert.match(verifyCommand, /tsx --test src\/postgres-runtime-schema\.test\.ts/);
});
