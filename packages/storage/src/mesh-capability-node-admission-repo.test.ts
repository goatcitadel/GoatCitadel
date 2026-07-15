import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import type { MeshCapabilityPublisherGenerationRecord } from "@goatcitadel/contracts";
import { Pool, type PoolClient } from "pg";
import type { DatabaseClient, DbStatement } from "./db.js";
import {
  MeshCapabilityNodeAdmissionRepository,
  type AdmitMeshCapabilityNodeInput,
} from "./mesh-capability-node-admission-repo.js";
import {
  MeshCapabilityPublicationRepository,
  type RegisterMeshCapabilityPublisherInput,
} from "./mesh-capability-publication-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const NOW = "2026-07-14T12:00:00.000Z";

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function createHarness(nodeId = "node-a", tlsFingerprint: string | null = "sha256:node-a") {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  const mesh = new MeshRepository(db);
  mesh.upsertNode({
    nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    ...(tlsFingerprint === null ? {} : { tlsFingerprint }),
    joinedAt: NOW,
    lastSeenAt: NOW,
  });
  return { db, mesh, repo: new MeshCapabilityNodeAdmissionRepository(db) };
}

function prepareAdmission(
  mesh: MeshRepository,
  nodeId: string,
  token: string,
  overrides: Partial<AdmitMeshCapabilityNodeInput> = {},
): AdmitMeshCapabilityNodeInput {
  mesh.issueJoinToken(token, FUTURE);
  assert.equal(mesh.consumeJoinToken(token, nodeId, NOW), true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(nodeId, token).tokenHash;
  assert.ok(joinTokenSha256);
  return {
    workspaceId: "default",
    nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256,
    mtlsRequired: true,
    tlsFingerprint: `sha256:${nodeId}`,
    admittedByActorId: "operator-a",
    idempotencyKey: `admit:${nodeId}:1`,
    ...overrides,
  };
}

function createPostgresFacade(db: DatabaseClient, preparedSql: string[]): DatabaseClient {
  return {
    dialect: "postgres",
    prepare(sql: string): DbStatement {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      preparedSql.push(normalized);
      if (normalized.includes("pg_advisory_xact_lock")) {
        return staticStatement({ locked: null });
      }
      if (normalized.includes("clock_timestamp()")) {
        return staticStatement({ now: NOW });
      }
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
    close: () => undefined,
    transaction: (mode, callback) => db.transaction(mode, callback),
  };
}

function staticStatement(row: unknown): DbStatement {
  return {
    run: () => ({ changes: 0 }),
    get: () => row,
    all: () => (row === undefined ? [] : [row]),
  } as unknown as DbStatement;
}

function assertWorkspaceLockPrecedesReplayRead(preparedSql: string[], table: string): void {
  const lockIndex = preparedSql.findIndex((sql) => sql.includes("hashtextextended(@workspaceId, 411)"));
  const replayReadIndex = preparedSql.findIndex(
    (sql) => sql.startsWith("SELECT *") && sql.includes(`FROM ${table}`) && sql.includes("idempotency_key"),
  );
  assert.ok(lockIndex >= 0, "expected the workspace admission advisory lock");
  assert.ok(replayReadIndex >= 0, "expected the idempotency replay read");
  assert.ok(lockIndex < replayReadIndex, "workspace admission lock must precede the replay read");
}

describe("MeshCapabilityNodeAdmissionRepository", () => {
  it("binds admission to an exact consumed join token and node identity with immutable replay", () => {
    const { db, mesh, repo } = createHarness();
    const input = prepareAdmission(mesh, "node-a", "join-node-a");
    const admission = repo.admit(input);

    assert.equal(admission.admissionGeneration, 1);
    assert.equal(admission.joinTokenSha256, input.joinTokenSha256);
    assert.deepEqual(repo.findCurrent("default", "node-a"), admission);
    assert.deepEqual(repo.admit(input), admission);
    assert.throws(() => repo.admit({ ...input, admittedByActorId: "operator-b" }), /different request bytes/);

    assert.throws(() =>
      db
        .prepare(
          `UPDATE mesh_capability_node_admissions SET admitted_by_actor_id = 'operator-b'
           WHERE workspace_id = 'default' AND node_id = 'node-a' AND admission_generation = 1`,
        )
        .run(),
    );
    assert.throws(() =>
      db
        .prepare(
          `DELETE FROM mesh_capability_node_admissions
           WHERE workspace_id = 'default' AND node_id = 'node-a' AND admission_generation = 1`,
        )
        .run(),
    );

    mesh.upsertNode({
      nodeId: "node-b",
      transport: "lan",
      status: "online",
      capabilities: [],
      tlsFingerprint: "sha256:node-b",
      joinedAt: NOW,
      lastSeenAt: NOW,
    });
    mesh.upsertNode({
      nodeId: "node-c",
      transport: "lan",
      status: "online",
      capabilities: [],
      tlsFingerprint: "sha256:node-c",
      joinedAt: NOW,
      lastSeenAt: NOW,
    });
    const tokenForNodeB = prepareAdmission(mesh, "node-b", "join-node-b");
    assert.throws(() =>
      repo.admit({
        ...tokenForNodeB,
        nodeId: "node-c",
        tlsFingerprint: "sha256:node-c",
        idempotencyKey: "admit:wrong-token-owner",
      }),
    );
    mesh.upsertNode({
      nodeId: "node-d",
      transport: "lan",
      status: "online",
      capabilities: [],
      tlsFingerprint: "sha256:node-d",
      joinedAt: NOW,
      lastSeenAt: NOW,
    });
    const wrongFingerprint = prepareAdmission(mesh, "node-d", "join-node-d-wrong-fingerprint", {
      tlsFingerprint: "sha256:other",
      idempotencyKey: "admit:wrong-fingerprint",
    });
    assert.throws(() => repo.admit(wrongFingerprint));
  });

  it("requires current-generation revocation before a server-derived N+1 replacement", () => {
    const { db, mesh, repo } = createHarness();
    const firstInput = prepareAdmission(mesh, "node-a", "join-node-a-1");
    const first = repo.admit(firstInput);
    const revocationInput = {
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      reason: "Rotate the node admission identity.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke:node-a:1",
    };
    const revoked = repo.revoke(revocationInput);

    assert.deepEqual(repo.revoke(revocationInput), revoked);
    assert.throws(() => repo.revoke({ ...revocationInput, reason: "Changed bytes." }), /different request bytes/);
    assert.equal(repo.findCurrent("default", "node-a"), undefined);
    assert.throws(() =>
      db
        .prepare(
          `UPDATE mesh_capability_node_admission_revocations SET reason = 'changed'
           WHERE workspace_id = 'default' AND node_id = 'node-a' AND admission_generation = 1`,
        )
        .run(),
    );

    const secondBase = prepareAdmission(mesh, "node-a", "join-node-a-2", {
      idempotencyKey: "admit:node-a:2",
    });
    assert.throws(() => repo.admit(secondBase), /durable admission invariant/);
    const second = repo.admit({ ...secondBase, expectedAdmissionGeneration: first.admissionGeneration });
    assert.equal(second.admissionGeneration, 2);
    assert.deepEqual(repo.findCurrent("default", "node-a"), second);
    assert.throws(() =>
      repo.revoke({
        ...revocationInput,
        idempotencyKey: "revoke:stale-node-a:1",
      }),
    );

    const third = prepareAdmission(mesh, "node-a", "join-node-a-3", {
      expectedAdmissionGeneration: 2,
      idempotencyKey: "admit:node-a:3",
    });
    assert.throws(() => repo.admit(third));
  });

  it("requires terminal publisher health before revoking its current admission", () => {
    const { mesh, repo, db } = createHarness();
    repo.admit(prepareAdmission(mesh, "node-a", "join-node-a"));
    const lease = mesh.acquireLease("mesh-capability-publication:default:node-a", "node-a", 3_600, FUTURE);
    const publications = new MeshCapabilityPublicationRepository(db);
    const publisher = publications.registerPublisher({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 1,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: lease.leaseKey,
      publicationLeaseFencingToken: lease.fencingToken,
      publicationLeaseExpiresAt: lease.expiresAt,
      idempotencyKey: "publisher:node-a:1",
    });
    const revoke = {
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      reason: "Operator revoked the node authority.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke:node-a:1",
    };

    assert.throws(() => repo.revoke(revoke));
    publications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: 1,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: publisher.tlsFingerprint,
    });
    assert.equal(repo.revoke(revoke).admissionGeneration, 1);
    assert.equal(repo.findCurrent("default", "node-a"), undefined);
  });

  it("locks Postgres admission authority before identical or changed replay reads", () => {
    const { db, mesh } = createHarness();
    const preparedSql: string[] = [];
    const repo = new MeshCapabilityNodeAdmissionRepository(createPostgresFacade(db, preparedSql));
    const input = prepareAdmission(mesh, "node-a", "join-node-a");

    repo.admit(input);
    assertWorkspaceLockPrecedesReplayRead(preparedSql, "mesh_capability_node_admissions");
    preparedSql.length = 0;
    assert.equal(repo.admit(input).admissionGeneration, 1);
    assertWorkspaceLockPrecedesReplayRead(preparedSql, "mesh_capability_node_admissions");
    preparedSql.length = 0;
    assert.throws(() => repo.admit({ ...input, admittedByActorId: "operator-b" }), /different request bytes/);
    assertWorkspaceLockPrecedesReplayRead(preparedSql, "mesh_capability_node_admissions");

    const revoke = {
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      reason: "Revoke the admission.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke:node-a:1",
    };
    preparedSql.length = 0;
    repo.revoke(revoke);
    assertWorkspaceLockPrecedesReplayRead(preparedSql, "mesh_capability_node_admission_revocations");
    preparedSql.length = 0;
    assert.equal(repo.revoke(revoke).admissionGeneration, 1);
    assertWorkspaceLockPrecedesReplayRead(preparedSql, "mesh_capability_node_admission_revocations");
    preparedSql.length = 0;
    assert.throws(() => repo.revoke({ ...revoke, reason: "Changed bytes." }), /different request bytes/);
    assertWorkspaceLockPrecedesReplayRead(preparedSql, "mesh_capability_node_admission_revocations");
  });

  it("keeps raw SQL diagnostics and token hashes out of caller-visible conflicts", () => {
    const { db, mesh } = createHarness();
    const input = prepareAdmission(mesh, "node-a", "join-node-a");
    const syntheticDiagnostic =
      `SQLSTATE 23514: INSERT INTO mesh_capability_node_admissions ` + `VALUES ('${input.joinTokenSha256}')`;
    const throwingDb: DatabaseClient = {
      dialect: "sqlite",
      prepare(sql: string): DbStatement {
        if (/INSERT\s+INTO\s+mesh_capability_node_admissions/iu.test(sql)) {
          return {
            run: () => {
              throw new Error(syntheticDiagnostic);
            },
            get: () => undefined,
            all: () => [],
          };
        }
        return db.prepare(sql);
      },
      exec: (sql) => db.exec(sql),
      close: () => undefined,
      transaction: (mode, callback) => db.transaction(mode, callback),
    };
    const repo = new MeshCapabilityNodeAdmissionRepository(throwingDb);
    let thrown: unknown;
    try {
      repo.admit(input);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown && typeof (thrown as { toJSON?: unknown }).toJSON === "function");
    const visible = JSON.stringify(
      (
        thrown as {
          toJSON(): unknown;
        }
      ).toJSON(),
    );
    assert.doesNotMatch(visible, /SQLSTATE|INSERT INTO|mesh_capability_node_admissions/iu);
    assert.doesNotMatch(visible, new RegExp(input.joinTokenSha256, "u"));
    assert.match(visible, /durable_admission_invariant_conflict/u);
  });

  it("enforces the 16-current-admissions workspace cap before publication", () => {
    const { db, mesh, repo } = createHarness("node-00", null);
    repo.admit(
      prepareAdmission(mesh, "node-00", "join-node-00", {
        mtlsRequired: false,
        tlsFingerprint: undefined,
        idempotencyKey: "admit:node-00:1",
      }),
    );
    for (let index = 1; index < 16; index += 1) {
      const nodeId = `node-${String(index).padStart(2, "0")}`;
      mesh.upsertNode({
        nodeId,
        transport: "lan",
        status: "online",
        capabilities: [],
        joinedAt: NOW,
        lastSeenAt: NOW,
      });
      repo.admit(
        prepareAdmission(mesh, nodeId, `join-${nodeId}`, {
          mtlsRequired: false,
          tlsFingerprint: undefined,
        }),
      );
    }

    mesh.upsertNode({
      nodeId: "node-16",
      transport: "lan",
      status: "online",
      capabilities: [],
      joinedAt: NOW,
      lastSeenAt: NOW,
    });
    assert.throws(() =>
      repo.admit(
        prepareAdmission(mesh, "node-16", "join-node-16", {
          mtlsRequired: false,
          tlsFingerprint: undefined,
        }),
      ),
    );
    const count = db.prepare("SELECT COUNT(*) AS count FROM mesh_capability_node_admissions").get() as {
      count: number;
    };
    assert.equal(Number(count.count), 16);
  });
});

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

it(
  "serializes real Postgres publisher registration against node-admission revoke",
  {
    skip: postgresConnectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres race lane",
  },
  async () => {
    assert.ok(postgresConnectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `hx408_admission_race_${suffix}`;
    const adminPool = new Pool({ connectionString: postgresConnectionString });
    const scopedUrl = new URL(postgresConnectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let publisherClient: PoolClient | undefined;
    let revokerClient: PoolClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      await seedPostgresAdmissionRace(scopedPool);
      publisherClient = await scopedPool.connect();
      revokerClient = await scopedPool.connect();

      await publisherClient.query("BEGIN");
      await insertPostgresPublisher(publisherClient, "node-publisher-wins", "publisher-wins");
      await insertPostgresPublisherHealth(publisherClient, "node-publisher-wins");
      await revokerClient.query("BEGIN");
      await revokerClient.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        insertPostgresAdmissionRevocation(revokerClient, "node-publisher-wins", "revoke-racing-publisher"),
        hasPostgresCode("55P03"),
      );
      await revokerClient.query("ROLLBACK");
      await publisherClient.query("COMMIT");

      await revokerClient.query("BEGIN");
      await assert.rejects(
        insertPostgresAdmissionRevocation(revokerClient, "node-publisher-wins", "revoke-after-publisher"),
        hasPostgresCode("23514"),
      );
      await revokerClient.query("ROLLBACK");

      await revokerClient.query("BEGIN");
      await insertPostgresAdmissionRevocation(revokerClient, "node-revocation-wins", "revoke-wins");
      await publisherClient.query("BEGIN");
      await publisherClient.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        insertPostgresPublisher(publisherClient, "node-revocation-wins", "publisher-racing-revoke"),
        hasPostgresCode("55P03"),
      );
      await publisherClient.query("ROLLBACK");
      await revokerClient.query("COMMIT");

      await publisherClient.query("BEGIN");
      await assert.rejects(
        insertPostgresPublisher(publisherClient, "node-revocation-wins", "publisher-after-revoke"),
        hasPostgresCode("23514"),
      );
      await publisherClient.query("ROLLBACK");

      const state = await scopedPool.query<{ node_id: string; revoked: boolean; published: boolean }>(`
        SELECT admission.node_id,
          EXISTS (SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation) AS revoked,
          EXISTS (SELECT 1 FROM mesh_capability_publishers publisher
                  WHERE publisher.workspace_id = admission.workspace_id AND publisher.node_id = admission.node_id) AS published
        FROM mesh_capability_node_admissions admission
        ORDER BY admission.node_id
      `);
      assert.deepEqual(state.rows, [
        { node_id: "node-publisher-wins", revoked: false, published: true },
        { node_id: "node-revocation-wins", revoked: true, published: false },
      ]);
    } finally {
      for (const client of [publisherClient, revokerClient]) {
        if (!client) continue;
        try {
          await client.query("ROLLBACK");
        } catch (error) {
          void error;
        }
        client.release();
      }
      await migrationClient.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

it(
  "serializes real Postgres publisher replay and orders admission ahead of an activation race",
  {
    skip: postgresConnectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres race lane",
  },
  async () => {
    assert.ok(postgresConnectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `hx408_publisher_replay_${suffix}`;
    const adminPool = new Pool({ connectionString: postgresConnectionString });
    const scopedUrl = new URL(postgresConnectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let barrierClient: PoolClient | undefined;
    let activationClient: PoolClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      await seedPostgresAdmissionRace(scopedPool);

      const publisherInput = postgresPublisherInput("publisher-concurrent-replay", 1);
      const [firstReplay, secondReplay] = await Promise.all([
        runPublisherWorker(scopedUrl.toString(), schemaName, `hx408-replay-a-${suffix}`, publisherInput),
        runPublisherWorker(scopedUrl.toString(), schemaName, `hx408-replay-b-${suffix}`, publisherInput),
      ]);
      assertPublisherWorkerSucceeded(firstReplay);
      assertPublisherWorkerSucceeded(secondReplay);
      assert.deepEqual(
        firstReplay.record,
        secondReplay.record,
        "canonical concurrent replay must return one durable row",
      );

      const stored = await scopedPool.query<{ publisher_count: string; health_count: string }>(`
        SELECT
          (SELECT COUNT(*) FROM mesh_capability_publishers
           WHERE workspace_id = 'default' AND node_id = 'node-publisher-wins') AS publisher_count,
          (SELECT COUNT(*) FROM mesh_capability_publisher_health
           WHERE workspace_id = 'default' AND node_id = 'node-publisher-wins') AS health_count
      `);
      assert.deepEqual(stored.rows[0], { publisher_count: "1", health_count: "1" });

      const [exactReplay, changedReplay] = await Promise.all([
        runPublisherWorker(scopedUrl.toString(), schemaName, `hx408-exact-${suffix}`, publisherInput),
        runPublisherWorker(scopedUrl.toString(), schemaName, `hx408-changed-${suffix}`, {
          ...publisherInput,
          publisherGeneration: 2,
        }),
      ]);
      assertPublisherWorkerSucceeded(exactReplay);
      assert.equal(changedReplay.ok, false, "same key with changed canonical bytes must conflict");
      if (changedReplay.ok) assert.fail("changed replay unexpectedly succeeded");
      assert.match(changedReplay.error, /different request bytes/u);

      const barrierKey = `hx408-activation-order:${suffix}`;
      const activationApplicationName = `hx408-activation-${suffix}`;
      const publisherApplicationName = `hx408-publisher-v2-${suffix}`;
      await scopedPool.query(`
        CREATE FUNCTION hx408_activation_order_barrier_${suffix}() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('${barrierKey}'));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER trg_mesh_capability_50_activation_lock_order_barrier
          BEFORE INSERT ON mesh_capability_activations
          FOR EACH ROW EXECUTE FUNCTION hx408_activation_order_barrier_${suffix}();
      `);
      const triggerOrder = await scopedPool.query<{ tgname: string }>(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'mesh_capability_activations'::regclass AND NOT tgisinternal
        ORDER BY tgname
      `);
      const triggerNames = triggerOrder.rows
        .map((row) => row.tgname)
        .filter((name) => name.includes("activation") && !name.includes("no_"));
      assert.deepEqual(triggerNames, [
        "trg_mesh_capability_00_activations_admission_authority",
        "trg_mesh_capability_50_activation_lock_order_barrier",
        "trg_mesh_capability_activation_guard",
      ]);

      barrierClient = await scopedPool.connect();
      activationClient = await scopedPool.connect();
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKey]);
      await activationClient.query("SELECT set_config('application_name', $1, false)", [activationApplicationName]);
      await activationClient.query("BEGIN");
      await activationClient.query("SET LOCAL statement_timeout = '10s'");
      const activationAttempt = insertPostgresActivationSkeleton(activationClient).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForPostgresAdvisoryWait(scopedPool, activationApplicationName);

      const publisherGenerationTwo = runPublisherWorker(
        scopedUrl.toString(),
        schemaName,
        publisherApplicationName,
        postgresPublisherInput("publisher-generation-two", 2),
      );
      await waitForPostgresAdvisoryWait(scopedPool, publisherApplicationName);
      await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);

      const activationResult = await activationAttempt;
      assert.equal(activationResult.ok, false, "the intentionally incomplete activation must fail closed");
      if (activationResult.ok) assert.fail("incomplete activation unexpectedly succeeded");
      assert.equal((activationResult.error as { code?: string }).code, "23514");
      await activationClient.query("ROLLBACK");
      const publisherResult = await publisherGenerationTwo;
      assertPublisherWorkerSucceeded(publisherResult);
      assert.equal(publisherResult.record.publisherGeneration, 2);
    } finally {
      if (barrierClient) {
        try {
          await barrierClient.query("SELECT pg_advisory_unlock_all()");
        } catch (error) {
          void error;
        }
      }
      if (activationClient) {
        try {
          await activationClient.query("ROLLBACK");
        } catch (error) {
          void error;
        }
      }
      activationClient?.release();
      barrierClient?.release();
      await migrationClient.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

async function seedPostgresAdmissionRace(pool: Pool): Promise<void> {
  const joinedAt = NOW;
  const expiresAt = FUTURE;
  await pool.query(
    `INSERT INTO mesh_nodes (
       node_id, label, advertise_address, transport, status, capabilities_json,
       tls_fingerprint, joined_at, last_seen_at
     ) VALUES
       ('node-publisher-wins', NULL, NULL, 'lan', 'online', '[]', NULL, $1, $1),
       ('node-revocation-wins', NULL, NULL, 'lan', 'online', '[]', NULL, $1, $1)`,
    [joinedAt],
  );
  await pool.query(
    `INSERT INTO mesh_join_tokens (
       token_hash, created_at, expires_at, used_at, used_by_node_id
     ) VALUES
       ($1, $3, $4, $3, 'node-publisher-wins'),
       ($2, $3, $4, $3, 'node-revocation-wins')`,
    ["a".repeat(64), "b".repeat(64), joinedAt, expiresAt],
  );
  await pool.query(
    `INSERT INTO mesh_capability_node_admissions (
       workspace_id, node_id, admission_generation, join_token_sha256, mtls_required,
       tls_fingerprint, admitted_by_actor_id, idempotency_key, request_sha256, admitted_at
     ) VALUES
       ('default', 'node-publisher-wins', 1, $1, 0, NULL, 'operator-a', 'admit-publisher-wins', $3, $5),
       ('default', 'node-revocation-wins', 1, $2, 0, NULL, 'operator-a', 'admit-revocation-wins', $4, $5)`,
    ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), joinedAt],
  );
  await pool.query(
    `INSERT INTO mesh_leases (lease_key, holder_node_id, fencing_token, expires_at, updated_at) VALUES
       ('lease-publisher-wins', 'node-publisher-wins', 1, $1, $2),
       ('lease-revocation-wins', 'node-revocation-wins', 1, $1, $2)`,
    [expiresAt, joinedAt],
  );
}

async function insertPostgresPublisher(client: PoolClient, nodeId: string, idempotencyKey: string): Promise<void> {
  await client.query(
    `INSERT INTO mesh_capability_publishers (
       workspace_id, node_id, admission_generation, publisher_generation, mtls_required,
       tls_fingerprint, publication_lease_key, publication_lease_fencing_token,
       publication_lease_expires_at, idempotency_key, request_sha256, created_at
     ) VALUES ('default', $1, 1, 1, 0, NULL, $2, 1, $3, $4, $5, $6)`,
    [nodeId, `lease-${nodeId.replace("node-", "")}`, FUTURE, idempotencyKey, "e".repeat(64), NOW],
  );
}

async function insertPostgresPublisherHealth(client: PoolClient, nodeId: string): Promise<void> {
  await client.query(
    `INSERT INTO mesh_capability_publisher_health (
       workspace_id, node_id, publisher_generation, health_generation, status,
       publication_lease_fencing_token, publication_lease_expires_at, tls_fingerprint, updated_at
     ) VALUES ('default', $1, 1, 1, 'online', 1, $2, NULL, $3)`,
    [nodeId, FUTURE, NOW],
  );
}

async function insertPostgresAdmissionRevocation(
  client: PoolClient,
  nodeId: string,
  idempotencyKey: string,
): Promise<void> {
  await client.query(
    `INSERT INTO mesh_capability_node_admission_revocations (
       workspace_id, node_id, admission_generation, reason, revoked_by_actor_id,
       idempotency_key, request_sha256, revoked_at
     ) VALUES ('default', $1, 1, 'Operator revoked admission.', 'operator-a', $2, $3, $4)`,
    [nodeId, idempotencyKey, "f".repeat(64), NOW],
  );
}

function hasPostgresCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === code;
}

function postgresPublisherInput(
  idempotencyKey: string,
  publisherGeneration: number,
): RegisterMeshCapabilityPublisherInput {
  return {
    workspaceId: "default",
    nodeId: "node-publisher-wins",
    admissionGeneration: 1,
    publisherGeneration,
    mtlsRequired: false,
    publicationLeaseKey: "lease-publisher-wins",
    publicationLeaseFencingToken: 1,
    publicationLeaseExpiresAt: FUTURE,
    idempotencyKey,
  };
}

type PublisherWorkerResult =
  | { ok: true; record: MeshCapabilityPublisherGenerationRecord }
  | { ok: false; error: string; code?: string };

function runPublisherWorker(
  connectionString: string,
  schemaName: string,
  applicationName: string,
  input: RegisterMeshCapabilityPublisherInput,
): Promise<PublisherWorkerResult> {
  const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(PUBLISHER_REGISTRATION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database: "goatcitadel_test",
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      schemaName,
      input,
      repositoryModuleUrl: new URL(`./mesh-capability-publication-repo${runtimeModuleExtension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${runtimeModuleExtension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  return new Promise((resolve, reject) => {
    let received = false;
    worker.once("message", (message: PublisherWorkerResult) => {
      received = true;
      resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`publisher registration worker exited before reporting (code ${code})`));
    });
  });
}

function assertPublisherWorkerSucceeded(
  result: PublisherWorkerResult,
): asserts result is Extract<PublisherWorkerResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
}

async function waitForPostgresAdvisoryWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
         JOIN pg_locks lock ON lock.pid = activity.pid
         WHERE activity.application_name = $1 AND lock.locktype = 'advisory' AND lock.granted = FALSE
       ) AS waiting`,
      [applicationName],
    );
    if (state.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${applicationName} to block on an advisory lock`);
}

async function insertPostgresActivationSkeleton(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO mesh_capability_activations (
       workspace_id, activation_id, activation_revision, capability_id, node_id,
       publisher_generation, health_generation, publication_lease_fencing_token,
       manifest_sha256, entry_sha256, descriptor_sha256, permission_envelope_sha256,
       effect_posture, permission_diff_json, effect_diff_json, approval_id, actor_id,
       session_id, turn_id, idempotency_key, request_sha256, created_at
     ) VALUES (
       'default', 'activation-lock-order', 1, 'capability-lock-order', 'node-publisher-wins',
       1, 1, 1, $1, $2, $3, $4, 'read', '{}', '{}', 'missing-approval', 'operator-a',
       NULL, NULL, 'activation-lock-order', $5, $6
     )`,
    ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64), "5".repeat(64), NOW],
  );
}

const PUBLISHER_REGISTRATION_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    let result;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { MeshCapabilityPublicationRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.prepare("SELECT set_config('search_path', @schemaName, false) AS search_path")
        .get({ schemaName: workerData.schemaName });
      const record = new MeshCapabilityPublicationRepository(db).registerPublisher(workerData.input);
      result = { ok: true, record };
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" ? error.code : undefined,
      };
    } finally {
      if (db) db.close();
    }
    parentPort.postMessage(result);
  })();
`;
