import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./client.js";
import { PostgresSyncDatabaseClient } from "./sync.js";
import {
  applyPostgresMigrationsSync,
  runPostgresMigrations,
  buildCanonicalPostgresSchemaShapeManifest,
} from "./migrator.js";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { ChatSessionLifecycleRepository } from "../chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "../session-mutation-admission-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const legacyCheck = "chat_routed_context_snapshots_schema_version_v2_check";
const authorityCheck = "chat_routed_context_snapshot_authority_v3";
const checksSql = `SELECT conname,contype,convalidated,connoinherit,conislocal,coninhcount,
 pg_catalog.pg_get_constraintdef(oid,true) AS definition FROM pg_catalog.pg_constraint
 WHERE conrelid='chat_routed_context_snapshots'::regclass ORDER BY conname`;
const downgradeSql = `ALTER TABLE chat_routed_context_snapshots DROP CONSTRAINT ${authorityCheck};
 ALTER TABLE chat_routed_context_snapshots ADD CONSTRAINT ${legacyCheck}
 CHECK(schema_version IN ('chat.routed-context-snapshot.v1','chat.routed-context-snapshot.v2'))`;

// Separate databases are essential: the defect is an explicit public target,
// and no test may mutate another owner's public namespace in the shared test DB.
async function withDatabase(
  mode: "sync" | "async",
  work: (f: {
    migrate: (schema: string, prefix?: number, tamper128?: boolean) => Promise<void>;
    db: (schema: string) => PostgresSyncDatabaseClient;
    query: (sql: string) => Promise<unknown>;
  }) => Promise<void>,
) {
  assert.ok(connectionString);
  const database = `gc_scope_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  url.searchParams.delete("options");
  const clients: Array<{ close: () => unknown }> = [];
  let created = false;
  let pool: Pool | undefined;
  let closeFailure: PromiseRejectedResult | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 });
    const options = (schema: string) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-csearch_path=${schema}`);
      return { connectionString: scoped.toString(), database, pool: { max: 1, connectionTimeoutMs: 5000 } };
    };
    await work({
      migrate: async (schema, prefix, tamper128 = false) => {
        const migrations =
          prefix === undefined ? POSTGRES_MIGRATIONS : POSTGRES_MIGRATIONS.filter((m) => m.version <= prefix);
        const selected = tamper128
          ? migrations.map((m) => (m.version === 128 ? { ...m, sql: m.sql + "\nSELECT true;" } : m))
          : migrations;
        if (mode === "sync") {
          const db = new PostgresSyncDatabaseClient(options(schema));
          clients.push(db);
          applyPostgresMigrationsSync(db, { migrations: selected });
        } else {
          const db = new PostgresDatabaseClient(options(schema));
          clients.push(db);
          await runPostgresMigrations(db, selected);
        }
      },
      db: (schema) => {
        const db = new PostgresSyncDatabaseClient(options(schema));
        clients.push(db);
        return db;
      },
      query: async (sql) => (await pool!.query(sql)).rows,
    });
  } finally {
    const closed = await Promise.allSettled(clients.reverse().map(async (c) => await c.close()));
    closeFailure = closed.find((result) => result.status === "rejected");
    try {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
    }
  }
  if (closeFailure) throw closeFailure.reason;
}

// Independent typed204 expectation, normalized by the server rather than copied
// from migration229 or accepted on constraint name alone.
function assertCanonicalAuthority(db: PostgresSyncDatabaseClient) {
  db.exec(`CREATE TEMP TABLE schema229_test_oracle(schema_version TEXT,capability_profile_id TEXT,capability_profile_hash TEXT,
  admission_id TEXT,session_incarnation_id TEXT,admission_material_sha256 TEXT,admission_aggregate_revision BIGINT,admission_controller_generation BIGINT,
  CONSTRAINT expected_authority CHECK(
   (schema_version IN('chat.routed-context-snapshot.v1','chat.routed-context-snapshot.v2')
    AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL
    AND admission_id IS NULL AND session_incarnation_id IS NULL AND admission_material_sha256 IS NULL
    AND admission_aggregate_revision IS NULL AND admission_controller_generation IS NULL)
   OR(schema_version='chat.routed-context-snapshot.v3' AND capability_profile_id IS NULL AND capability_profile_hash IS NULL
    AND admission_id IS NOT NULL AND session_incarnation_id IS NOT NULL AND admission_material_sha256 IS NOT NULL
    AND admission_aggregate_revision IS NOT NULL AND admission_controller_generation IS NOT NULL)))`);
  try {
    const expected = db
      .prepare(
        "SELECT pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid='pg_temp.schema229_test_oracle'::regclass AND conname='expected_authority'",
      )
      .get<{ definition: string }>()!;
    const actual = db
      .prepare(checksSql)
      .all<{ conname: string; definition: string; convalidated: boolean; connoinherit: boolean }>();
    assert.equal(actual.find((c) => c.conname === authorityCheck)?.definition, expected.definition);
    assert.ok(!actual.some((c) => c.conname === legacyCheck));
  } finally {
    db.exec("DROP TABLE pg_temp.schema229_test_oracle");
  }
}
// Real lifecycle/admission/binding owners; no trigger disabling or replica role.
function insertSnapshot(db: PostgresSyncDatabaseClient, version: "v1" | "v2" | "v3", suffix: string) {
  const workspaceId = "workspace-a",
    sessionId = `session-${suffix}`,
    turnId = `turn-${suffix}`;
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-a",
    idempotencyKey: `init-${suffix}`,
    correlationId: `init-${suffix}`,
  });
  const repo = new SessionMutationAdmissionRepository(db);
  const admission = repo.admit({
    workspaceId,
    sessionId,
    turnId,
    runtimeOwnerId: `runtime-${suffix}`,
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator-a",
    operation: "chat.turn.execute",
    materialSha256: "a".repeat(64),
    idempotencyKey: `admit-${suffix}`,
    correlationId: `admit-${suffix}`,
  }).admission;
  const profileId = `profile-${suffix}`,
    profileHash = "b".repeat(64),
    createdAt = new Date().toISOString();
  if (version !== "v3")
    db.transaction("immediate", () => {
      repo.bindCapabilityProfile({
        admissionId: admission.admissionId,
        workspaceId,
        sessionId,
        sessionIncarnationId: admission.sessionIncarnationId,
        turnId,
        profileId,
        profileHash,
        createdAt,
        requestRuntimeClaim: {
          runtimeOwnerId: admission.runtimeOwnerId!,
          leaseRevision: admission.runtimeLeaseRevision!,
        },
      });
      db.prepare(
        `INSERT INTO chat_turn_capability_profiles
   (profile_id,turn_id,session_id,workspace_id,durable_run_id,operator_id,auth_actor_id,schema_version,profile_hash,
    catalog_snapshot_id,inspectable_hash,callable_hash,selection_hash,governance_hash,preflight_fingerprint,profile_json,created_at)
   VALUES(@profileId,@turnId,@sessionId,@workspaceId,NULL,NULL,NULL,'chat.turn.capability-profile.v1',@profileHash,
    @profileId,@profileHash,@profileHash,@profileHash,@profileHash,@profileHash,'{}',@createdAt)`,
      ).run({ profileId, turnId, sessionId, workspaceId, profileHash, createdAt });
    });
  const row = {
    snapshot_id: `snapshot-${suffix}`,
    schema_version: `chat.routed-context-snapshot.${version}`,
    turn_id: turnId,
    session_id: sessionId,
    workspace_id: workspaceId,
    capability_profile_id: version === "v3" ? null : profileId,
    capability_profile_hash: version === "v3" ? null : profileHash,
    source_request_hash: "c".repeat(64),
    content_hash: "d".repeat(64),
    snapshot_hash: "e".repeat(64),
    effective_provider_id: "provider",
    effective_model: "model",
    context_window_tokens: 8192,
    prompt_reserved_tokens: 1000,
    output_reserved_tokens: 1000,
    hard_cap_tokens: 4096,
    effective_budget_tokens: 4096,
    used_tokens: 0,
    source_count: 0,
    included_count: 0,
    truncated_count: 0,
    omitted_count: 0,
    already_attached_count: 0,
    estimator_version: "gc-approx-tokens.v1",
    budget_policy_version: "chat.routed-context-budget.v1",
    snapshot_json: '{ "retained" : "bytes" }',
    created_at: createdAt,
    admission_id: version === "v3" ? admission.admissionId : null,
    session_incarnation_id: version === "v3" ? admission.sessionIncarnationId : null,
    admission_material_sha256: version === "v3" ? admission.materialSha256 : null,
    admission_aggregate_revision: version === "v3" ? admission.aggregateRevision : null,
    admission_controller_generation: version === "v3" ? admission.controllerGeneration : null,
  };
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO chat_routed_context_snapshots (${keys.join(",")}) VALUES(${keys.map((k) => `@${k}`).join(",")})`,
  ).run(row);
  return db.prepare("SELECT * FROM chat_routed_context_snapshots ORDER BY snapshot_id").all();
}

for (const mode of ["sync", "async"] as const) {
  test(
    `real PG ${mode} migration122 widens scoped path flavors and preserves public neighbors`,
    { skip, timeout: 240000 },
    () =>
      withDatabase(mode, async (f) => {
        const tables = ["workspace_path_bridge_snapshots", "external_source_configs"] as const;
        const columns = ["input_flavor", "target_flavor"] as const;
        // Deliberately model the historical four-value domains in a separate namespace.
        // The actual migration chain creates all scoped tables and runs the frozen122 owner.
        for (const table of tables) {
          await f.query(`CREATE TABLE public.${table} (
     input_flavor TEXT CHECK(input_flavor IN ('windows_native','windows_forward','msys','wsl')),
     target_flavor TEXT CHECK(target_flavor IN ('windows_native','windows_forward','msys','wsl'))
   )`);
        }
        const publicCatalog = `SELECT t.relname,c.conname,pg_catalog.pg_get_constraintdef(c.oid,true) AS definition
   FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='public' AND t.relname IN ('workspace_path_bridge_snapshots','external_source_configs') AND c.contype='c'
   ORDER BY t.relname,c.conname`;
        const before = await f.query(publicCatalog);
        assert.ok(Array.isArray(before));
        assert.equal(before.length, 4);
        await f.query("CREATE SCHEMA scope122");
        await f.migrate("scope122", 122);
        assert.deepEqual(await f.query(publicCatalog), before);

        const db = f.db("scope122");
        db.exec(`CREATE TEMP TABLE scope122_oracle (
    input_flavor TEXT CONSTRAINT expected_input CHECK(input_flavor IN ('windows_native','windows_forward','msys','wsl','posix')),
    target_flavor TEXT CONSTRAINT expected_target CHECK(target_flavor IN ('windows_native','windows_forward','msys','wsl','posix'))
  )`);
        try {
          const constraintDefinition = db.prepare(`SELECT pg_catalog.pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass(@relation)
    AND c.conname=@name AND c.contype='c' AND c.convalidated AND NOT c.connoinherit`);
          for (const table of tables)
            for (const column of columns) {
              const name = `${table}_${column}_posix_check`;
              const expected = constraintDefinition.get<{ definition: string }>({
                relation: "pg_temp.scope122_oracle",
                name: column === "input_flavor" ? "expected_input" : "expected_target",
              });
              const actual = constraintDefinition.get<{ definition: string }>({ relation: `scope122.${table}`, name });
              assert.ok(expected);
              assert.deepEqual(actual, expected, `Canonical scoped check ${name}`);
            }
        } finally {
          db.exec("DROP TABLE pg_temp.scope122_oracle");
        }
      }),
  );
  test(
    `real PG ${mode} scoped install preserves canonical public and an admitted v3 row`,
    { skip, timeout: 240000 },
    () =>
      withDatabase(mode, async (f) => {
        await f.migrate("public");
        const db = f.db("public");
        assertCanonicalAuthority(db);
        const rows = insertSnapshot(db, "v3", "neighbor"),
          before = db.prepare(checksSql).all();
        await f.query("CREATE SCHEMA scope_new");
        await f.migrate("scope_new");
        assert.deepEqual(db.prepare(checksSql).all(), before);
        assert.deepEqual(db.prepare("SELECT * FROM chat_routed_context_snapshots ORDER BY snapshot_id").all(), rows);
        await f.migrate("public");
        await f.migrate("scope_new");
      }),
  );
  for (const retained of ["empty", "v1", "v2"] as const)
    test(`real PG ${mode} repairs exact damaged228 ${retained} without row changes`, { skip, timeout: 240000 }, () =>
      withDatabase(mode, async (f) => {
        await f.migrate("public", 228);
        const db = f.db("public");
        const rows = retained === "empty" ? [] : insertSnapshot(db, retained, retained);
        db.exec(downgradeSql);
        await f.migrate("public");
        assertCanonicalAuthority(db);
        assert.ok(
          db
            .prepare(checksSql)
            .all<{ conname: string }>()
            .some((c) => c.conname === authorityCheck),
        );
        assert.ok(
          !db
            .prepare(checksSql)
            .all<{ conname: string }>()
            .some((c) => c.conname === legacyCheck),
        );
        assert.deepEqual(db.prepare("SELECT * FROM chat_routed_context_snapshots ORDER BY snapshot_id").all(), rows);
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=229").get<{ count: number }>()
            ?.count,
          1,
        );
        await f.migrate("public");
      }),
    );
  for (const drift of [
    "legacy_expression",
    "unrelated_check",
    "unrelated_column",
    "ledger_failure",
    "intact_inheritance",
    "damaged_inheritance",
  ] as const)
    test(`real PG ${mode} rejects ${drift} and rolls229 back`, { skip, timeout: 240000 }, () =>
      withDatabase(mode, async (f) => {
        await f.migrate("public", 228);
        const db = f.db("public");
        if (drift !== "intact_inheritance") db.exec(downgradeSql);
        const inherited = drift === "intact_inheritance" || drift === "damaged_inheritance";
        const childChecks = checksSql.replace(
          "'chat_routed_context_snapshots'::regclass",
          "'scope229_child'::regclass",
        );
        if (inherited) db.exec("CREATE TABLE scope229_child () INHERITS (chat_routed_context_snapshots)");
        const childBefore = inherited ? db.prepare(childChecks).all() : undefined;
        if (drift === "legacy_expression")
          db.exec(
            `ALTER TABLE chat_routed_context_snapshots DROP CONSTRAINT ${legacyCheck};ALTER TABLE chat_routed_context_snapshots ADD CONSTRAINT ${legacyCheck} CHECK(TRUE)`,
          );
        if (drift === "unrelated_check")
          db.exec("ALTER TABLE chat_routed_context_snapshots ADD CONSTRAINT operator_unknown CHECK(source_count>=0)");
        if (drift === "unrelated_column")
          db.exec("ALTER TABLE chat_routed_context_snapshots ALTER COLUMN snapshot_json DROP NOT NULL");
        if (drift === "ledger_failure")
          db.exec(`CREATE FUNCTION gc_fail229() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.version=229 THEN RAISE EXCEPTION 'injected229ledger';END IF;RETURN NEW;END$$;
   CREATE TRIGGER fail229 BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION gc_fail229()`);
        const before = db.prepare(checksSql).all();
        const expectedError = {
          legacy_expression: /unknown legacy constraint drift/u,
          unrelated_check: /unknown damaged CHECK inventory/u,
          unrelated_column: /column chat_routed_context_snapshots\.snapshot_json has a non-canonical shape/u,
          ledger_failure: /injected229ledger/u,
          intact_inheritance: /refuses an inherited snapshot relation/u,
          damaged_inheritance: /refuses an inherited snapshot relation/u,
        }[drift];
        await assert.rejects(f.migrate("public"), expectedError);
        if (inherited) assert.deepEqual(db.prepare(childChecks).all(), childBefore);
        assert.deepEqual(db.prepare(checksSql).all(), before);
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=229").get<{ count: number }>()
            ?.count,
          0,
        );
      }),
    );
  test(`real PG ${mode} rejects changed frozen128 bytes before executing them`, { skip, timeout: 240000 }, () =>
    withDatabase(mode, async (f) => {
      await f.migrate("public", 127);
      const db = f.db("public"),
        before = db.prepare(checksSql).all();
      await assert.rejects(f.migrate("public", undefined, true), /exact canonical|compatibility|integrity/);
      assert.deepEqual(db.prepare(checksSql).all(), before);
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=128").get<{ count: number }>()?.count,
        0,
      );
    }),
  );
  test(`real PG ${mode} upgrades pre128 lineage into the same229 contract`, { skip, timeout: 240000 }, () =>
    withDatabase(mode, async (f) => {
      await f.migrate("public", 127);
      await f.migrate("public");
      assertCanonicalAuthority(f.db("public"));
      const checks = f.db("public").prepare(checksSql).all<{ conname: string }>();
      assert.ok(checks.some((c) => c.conname === authorityCheck));
      assert.ok(!checks.some((c) => c.conname === legacyCheck));
    }),
  );
}

test("PG229 converges to existing PG204/SQLite257 authority without manifest probe drift", () => {
  const before = buildCanonicalPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS.filter((m) => m.version <= 228));
  const after = buildCanonicalPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS.filter((m) => m.version <= 229));
  assert.deepEqual(after, before); // No shape change: only exact damaged installations converge.
  assert.equal(POSTGRES_MIGRATIONS.find((m) => m.version === 229)?.name, "chat_routed_context_namespace_convergence");
});
