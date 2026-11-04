import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, Pool } from "pg";
import { ApprovalRepository } from "./approval-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration } from "./postgres/migrations.js";
import {
  applyPostgresMigrationsSync,
  assertPostgresMigrationIntegrity,
  runPostgresMigrations,
} from "./postgres/migrator.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const testOptions = { skip, timeout: 150_000 };
const historicalSha256 = "f9bd51adefcc6f27142334b99af3d291bcef33d802005d5d7e6b16960e7b709d";
const nul = String.fromCharCode(0);
const legacyKey = "__gcApprovalLinkage";
const clean = { workspaceId: "fixture-w", runId: "fixture-run", sessionId: "fixture-session" };
const alternate = { workspaceId: "other-w", runId: "other-run", sessionId: "other-session" };
const legacy = (fields: Record<string, unknown>, extra = {}) => JSON.stringify({ ...extra, [legacyKey]: fields });
const raw = String.raw;

interface Scope {
  pool: Pool;
  client: PostgresDatabaseClient;
  db: PostgresSyncDatabaseClient;
  original: PostgresMigration;
  repo: ApprovalRepository;
}

async function withSchema(action: (scope: Scope) => Promise<void>): Promise<void> {
  assert.ok(connectionString);
  const admin = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  const schema = "storage05_" + randomUUID().replaceAll("-", "");
  let created = false;
  let pool: Pool | undefined;
  let client: PostgresDatabaseClient | undefined;
  let db: PostgresSyncDatabaseClient | undefined;
  try {
    await admin.connect();
    await admin.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    const target = new URL(connectionString);
    target.searchParams.set("options", "-csearch_path=" + schema);
    const options = { connectionString: target.href, database: target.pathname.slice(1) };
    pool = new Pool({ connectionString: target.href, max: 2, connectionTimeoutMillis: 10_000 });
    client = new PostgresDatabaseClient(options);
    db = new PostgresSyncDatabaseClient({ ...options, pool: { max: 1, connectionTimeoutMs: 10_000 } });
    for (const row of [
      (await pool.query("SELECT current_schema() AS schema, current_setting('server_encoding') AS encoding")).rows[0],
      db.prepare("SELECT current_schema() AS schema, current_setting('server_encoding') AS encoding").get(),
    ]) {
      assert.deepEqual(row, { schema, encoding: "UTF8" });
    }
    const original = POSTGRES_MIGRATIONS.find((migration) => migration.version === 209);
    assert.ok(original);
    assert.equal(original.name, "approval_execution_linkage_index");
    assert.equal(original.integritySha256, historicalSha256);
    const digest = createHash("sha256").update("atomic\n" + original.sql.replace(/\r\n/g, "\n").trim()).digest("hex");
    assert.equal(digest, historicalSha256);
    await action({ pool, client, db, original, repo: new ApprovalRepository(db) });
  } finally {
    try {
      db?.close();
      await client?.close();
      await pool?.end();
    } finally {
      try {
        if (created) {
          await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
          const { rowCount } = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
          assert.equal(rowCount, 0);
        }
      } finally {
        await admin.end();
      }
    }
  }
}

const migrationPrefix = (version: number) =>
  POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);

async function project(pool: Pool, canonical: string | null, payload: string, preview: string) {
  const { rows } = await pool.query(
    "SELECT gc_approval_execution_linkage($1::text,$2::text,$3::text) AS linkage",
    [canonical, payload, preview],
  );
  return rows[0].linkage;
}

async function assertProjectionCases(pool: Pool) {
  const escapedLiteral = "literal " + "\\" + "u0000";
  const twiceEscapedLiteral = "literal " + "\\".repeat(2) + "u0000";
  const knownLookalike = { workspaceId: clean.workspaceId, durableRunId: "durable", ["run" + nul + "Id"]: "forged" };
  const cases: Array<[string, string | null, string, string, unknown]> = [
    ["canonical short-circuits raw legacy", JSON.stringify(clean), legacy(alternate, { unrelated: nul }), "{}", clean],
    ["detached escaped NUL", null, JSON.stringify({ unrelated: nul }), "{}", null],
    ["valid payload linkage with unrelated NUL", null, legacy(clean, { unrelated: nul }), legacy(alternate), clean],
    ["valid preview fallback", null, JSON.stringify({ unrelated: nul }), legacy(clean, { unrelated: nul }), clean],
    ["canonical linkage with unrelated NUL", JSON.stringify({ ...clean, unrelated: nul }), legacy(alternate), "{}", clean],
    ["literal backslash-u survives a nearby active escape", null, legacy({ ...clean, runId: escapedLiteral }, { unrelated: nul }), "{}", { ...clean, runId: escapedLiteral }],
    ["even run of four raw backslashes is literal", null, legacy({ ...clean, runId: twiceEscapedLiteral }, { unrelated: nul }), "{}", { ...clean, runId: twiceEscapedLiteral }],
    ["odd raw backslash run before active NUL is unrepresentable", JSON.stringify({ ...clean, runId: "\\" + nul }), legacy(alternate), "{}", null],
    ["escaped Unicode backslash stays literal data", raw`{"workspaceId":"fixture-w","runId":"literal \u005cu0000","sessionId":"fixture-session","note":"\u0000"}`, legacy(alternate), "{}", { ...clean, runId: escapedLiteral }],
    ["raw and escaped tilde keys retain last-key-wins identity", raw`{"~guard":"would suppress fallback","\u007Eguard":false,"unrelated\u0000":0}`, legacy(clean), legacy(alternate), clean],
    ["genuine tilde-n key stays distinct from a NUL-bearing key", raw`{"~n":"must suppress fallback","\u0000":false}`, legacy(clean), legacy(alternate), null],
    ["genuine raw and escaped tilde-n values round trip", raw`{"workspaceId":"fixture-w","runId":"~n\u007en","sessionId":"fixture-session","note":"\u0000"}`, legacy(alternate), "{}", { ...clean, runId: "~n~n" }],
    ["duplicate decoded run key still uses last value", raw`{"workspaceId":"fixture-w","runId":"old","run\u0049d":"fixture-run","sessionId":"fixture-session","note":"\u0000"}`, legacy(alternate), "{}", clean],
    ["duplicate decoded legacy envelope still uses last value", null, raw`{"__gcApprovalLinkage":{"workspaceId":"wrong","runId":"wrong"},"__gcApprovalLink\u0061ge":{"workspaceId":"fixture-w","runId":"fixture-run","sessionId":"fixture-session"},"note":"\u0000"}`, "{}", clean],
    ["malformed text falls through", "{broken", legacy(clean), legacy(alternate), clean],
    ["malformed text after NUL remains malformed", raw`{"note":"\u0000",}`, legacy(clean), legacy(alternate), clean],
    ["nonobject canonical and payload fall through", JSON.stringify(nul), JSON.stringify([{ unrelated: nul, [legacyKey]: alternate }]), legacy(clean), clean],
    ["NUL lookalike legacy key cannot create authority", null, JSON.stringify({ ["__gcApproval" + nul + "Linkage"]: alternate }), legacy(clean), clean],
    ["NUL lookalike run key cannot bind", null, legacy(knownLookalike), legacy(alternate), { workspaceId: clean.workspaceId, durableRunId: "durable" }],
    ["incomplete first nonempty canonical prevents fallback", JSON.stringify({ note: nul }), legacy(clean), legacy(alternate), null],
    ["incomplete first nonempty legacy object prevents fallback", null, legacy({ note: nul }), legacy(alternate), null],
    ["empty or whitespace-only normalized object permits fallback", JSON.stringify({ empty: " \t\u00a0\ufeff", ["raw" + nul]: 1 }), legacy(clean), legacy(alternate), clean],
  ];
  for (const field of ["workspaceId", "runId", "durableRunId", "sessionId"]) {
    cases.push(["unrepresentable authority " + field, JSON.stringify({ ...clean, [field]: nul }), legacy(alternate), "{}", null]);
  }
  for (const [label, canonical, payload, preview, expected] of cases) {
    assert.deepEqual(await project(pool, canonical, payload, preview), expected, label);
  }
  await assert.rejects(project(pool, raw`{"number":1e200000}`, legacy(clean), "{}"), { code: "22003" });
}

async function assertHistoricalTriggerRejectsNul(pool: Pool) {
  // Assert the exact PostgreSQL code on pg. The sync worker serializes message/stack only.
  await assert.rejects(
    pool.query(
      "INSERT INTO approvals (approval_id,kind,risk_level,status,payload_json,preview_json,created_at) " +
        "VALUES ($1,'tool.invoke','safe','pending',$2,'{}',$3)",
      [randomUUID(), JSON.stringify({ unrelated: nul }), new Date().toISOString()],
    ),
    { code: "22P05" },
  );
}

function makeDraft(repo: ApprovalRepository, payload = {}, preview = {}) {
  return repo.create({ kind: "tool.invoke", riskLevel: "safe", payload, preview });
}

async function snapshot(pool: Pool, id: string) {
  const { rows } = await pool.query(
    "SELECT linkage_json,payload_json,preview_json,created_at FROM approvals WHERE approval_id=$1",
    [id],
  );
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function seedLegacy(scope: Scope, canonical: string | null, payload: string, preview: string) {
  const { approvalId } = makeDraft(scope.repo);
  await scope.pool.query("UPDATE approvals SET linkage_json=$1,payload_json=$2,preview_json=$3 WHERE approval_id=$4",
    [canonical, payload, preview, approvalId]);
  return { approvalId, before: await snapshot(scope.pool, approvalId) };
}

async function assertRepositoryCases(scope: Scope) {
  const detachedPayload = { source: nul, printable: "retained" };
  const detachedPreview = { label: nul };
  const detached = makeDraft(scope.repo, detachedPayload, detachedPreview);
  assert.deepEqual(detached.payload, detachedPayload);
  assert.deepEqual(detached.preview, detachedPreview);
  const detachedBytes = await snapshot(scope.pool, detached.approvalId);
  assert.equal(detachedBytes.payload_json, JSON.stringify(detachedPayload));
  assert.equal(detachedBytes.preview_json, JSON.stringify(detachedPreview));
  const { rowCount } = await scope.pool.query("SELECT 1 FROM approval_execution_linkages WHERE approval_id=$1", [detached.approvalId]);
  assert.equal(rowCount, 0);

  const good = await seedLegacy(scope, null, legacy(clean, { unrelated: nul }), legacy(alternate));
  assert.deepEqual(scope.repo.get(good.approvalId).linkage, clean);
  assert.deepEqual(await snapshot(scope.pool, good.approvalId), good.before);
  const wildcardPoison = await seedLegacy(scope, JSON.stringify({ ...clean, sessionId: nul }), legacy(alternate), "{}");
  assert.equal(scope.repo.get(wildcardPoison.approvalId).linkage?.sessionId, nul);
  const ids = scope.repo.listByRunLinkage({ workspaceId: clean.workspaceId, runId: clean.runId, sessionId: clean.sessionId })
    .items.map((item) => item.approvalId);
  assert.deepEqual(ids, [good.approvalId], "An unrepresentable session must not become a NULL wildcard.");
}

for (const runner of ["async", "sync"]) {
  test("pending v209 retains raw approval bytes and authority via the " + runner + " migration owner", testOptions, async () => {
    await withSchema(async (scope) => {
      await runPostgresMigrations(scope.client, migrationPrefix(208));
      const detached = makeDraft(scope.repo, { unrelated: nul });
      const beforeDetached = await snapshot(scope.pool, detached.approvalId);
      const linked = await seedLegacy(scope, null, legacy(clean, { unrelated: nul }), legacy(alternate));
      const preview = await seedLegacy(scope, null, JSON.stringify({ unrelated: nul }), legacy(alternate, { unrelated: nul }));
      const poisoned = await seedLegacy(scope, JSON.stringify({ ...clean, sessionId: nul }), legacy(alternate), "{}");

      if (runner === "async") await runPostgresMigrations(scope.client);
      else applyPostgresMigrationsSync(scope.db);

      const { rows } = await scope.pool.query("SELECT version,name FROM schema_migrations WHERE version=209");
      assert.deepEqual(rows, [{ version: 209, name: scope.original.name }]);
      for (const { approvalId, before } of [linked, preview, poisoned, { approvalId: detached.approvalId, before: beforeDetached }]) {
        assert.deepEqual(await snapshot(scope.pool, approvalId), before);
      }
      assert.deepEqual(scope.repo.listByRunLinkage({ workspaceId: clean.workspaceId, runId: clean.runId,
        sessionId: clean.sessionId }).items.map((item) => item.approvalId), [linked.approvalId]);
      assert.deepEqual(scope.repo.listByRunLinkage({ workspaceId: alternate.workspaceId, runId: alternate.runId })
        .items.map((item) => item.approvalId), [preview.approvalId]);
      const absent = await scope.pool.query("SELECT 1 FROM approval_execution_linkages WHERE approval_id=ANY($1::text[])",
        [[detached.approvalId, poisoned.approvalId]]);
      assert.equal(absent.rowCount, 0);
    });
  });
}

for (const lineage of ["fresh", "already-applied-v227"]) {
  test("current registry retains correct projection on " + lineage, testOptions, async () => {
    await withSchema(async (scope) => {
      const readTriggerOid = async () => (await scope.pool.query<{ oid: number }>(`
        SELECT oid FROM pg_trigger
        WHERE tgrelid = 'approvals'::regclass AND tgname = 'trg_approval_execution_linkage'
      `)).rows[0]?.oid;
      let previousTriggerOid: number | undefined;
      if (lineage === "already-applied-v227") {
        await runPostgresMigrations(scope.client, migrationPrefix(227));
        // Bootstrap used the pending bridge. Recreate the real old projector and trigger.
        await scope.pool.query(scope.original.sql);
        await assertHistoricalTriggerRejectsNul(scope.pool);
        previousTriggerOid = await readTriggerOid();
        assert.ok(previousTriggerOid);
      }
      const applied = await runPostgresMigrations(scope.client);
      assert.equal(applied.latestVersion, POSTGRES_MIGRATIONS.at(-1)?.version);
      if (lineage === "already-applied-v227") {
        assert.deepEqual(applied.appliedVersions,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version > 227).map((migration) => migration.version));
        assert.equal(await readTriggerOid(), previousTriggerOid, "Forward repair must not replay the historical trigger DDL.");
      }
      await assertProjectionCases(scope.pool);
      await assertRepositoryCases(scope);
      assert.deepEqual((await runPostgresMigrations(scope.client)).appliedVersions, []);
    });
  });
}

test("pending v209 rolls back the projector, trigger, index and ledger when backfill has a different SQL error", testOptions, async () => {
  await withSchema(async (scope) => {
    await runPostgresMigrations(scope.client, migrationPrefix(208));
    // Today's v2 renderer can precreate the table. This disposable old shape
    // exercises rollback of the table and indexes actually created by v209.
    await scope.pool.query("DROP TABLE IF EXISTS approval_execution_linkages");
    const overflow = await seedLegacy(scope, null, raw`{"number":1e200000}`, "{}");
    await assert.rejects(runPostgresMigrations(scope.client, migrationPrefix(209)), { code: "22003" });
    const { rows } = await scope.pool.query(`
      SELECT to_regclass('approval_execution_linkages') AS link_table,
             to_regclass('idx_approval_execution_run') AS run_index,
             to_regclass('idx_approval_execution_durable_run') AS durable_index,
             to_regprocedure('gc_approval_execution_linkage(text,text,text)') AS projector,
             to_regprocedure('gc_update_approval_execution_linkage()') AS trigger_fn,
             EXISTS (SELECT 1 FROM schema_migrations WHERE version = 209) AS applied
    `);
    assert.deepEqual(rows, [{ link_table: null, run_index: null, durable_index: null, projector: null, trigger_fn: null, applied: false }]);
    assert.deepEqual(await snapshot(scope.pool, overflow.approvalId), overflow.before);
    const repaired = legacy(clean, { unrelated: nul });
    await scope.pool.query("UPDATE approvals SET payload_json=$1 WHERE approval_id=$2", [repaired, overflow.approvalId]);
    assert.deepEqual((await runPostgresMigrations(scope.client, migrationPrefix(209))).appliedVersions, [209]);
    assert.equal((await snapshot(scope.pool, overflow.approvalId)).payload_json, repaired);
    assert.deepEqual(scope.repo.listByRunLinkage({ workspaceId: clean.workspaceId, runId: clean.runId, sessionId: clean.sessionId })
      .items.map((item) => item.approvalId), [overflow.approvalId]);
  });
});

test("v209 compatibility does not bless custom lookalikes or modified historical bytes", testOptions, async () => {
  await withSchema(async (scope) => {
    const prefix = migrationPrefix(208);
    await runPostgresMigrations(scope.client, prefix);
    await seedLegacy(scope, null, legacy(clean, { unrelated: nul }), "{}");
    const tampered = { ...scope.original, sql: scope.original.sql + "\nSELECT 1;" };
    assert.throws(() => assertPostgresMigrationIntegrity(tampered), /integrity hash mismatch/u);
    await assert.rejects(runPostgresMigrations(scope.client, [...prefix, tampered]), /integrity hash mismatch/u);
    const lookalike = { ...scope.original, name: "custom_approval_execution_linkage_index" };
    await assert.rejects(runPostgresMigrations(scope.client, [...prefix, lookalike]), { code: "22P05" });
    assert.equal((await scope.pool.query("SELECT 1 FROM schema_migrations WHERE version=209")).rowCount, 0);
    assert.deepEqual((await runPostgresMigrations(scope.client, migrationPrefix(209))).appliedVersions, [209]);
  });
});
