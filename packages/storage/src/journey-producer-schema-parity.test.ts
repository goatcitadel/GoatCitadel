import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  GOVERNED_LIFECYCLE_EVENT_VERSION,
  GOVERNED_MUTATION_KINDS,
  computeGovernedMutationMaterialSha256,
  computeImprovementLifecycleRequestSha256,
  computeImprovementLifecycleResultSha256,
  type GovernanceJourneyEventRecord,
  type GovernedLifecycleEventRecord,
  type ImprovementLifecycleOperationRecord,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import type { DatabaseClient } from "./db.js";
import { GovernedLifecycleEventRepository } from "./governed-lifecycle-event-repo.js";
import { ImprovementLifecycleOperationRepository } from "./improvement-lifecycle-operation-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { createDatabase } from "./sqlite.js";

// ---------------------------------------------------------------------------
// HX-402 P0 journey-producer schema parity (SQLite 175 <-> PostgreSQL 117 <->
// the frozen contract registry) plus the live-PostgreSQL foundation proof.
//
// The live suite follows the repo's `.postgres.test.ts` conditional
// convention: it skips with a visible reason when GOATCITADEL_TEST_POSTGRES_URL
// is unset, and the P0 gate ("live PostgreSQL is not an optional release
// skip") is discharged by running it against a hermetic cluster
// (initdb/pg_ctl) exactly like the HX-407 closure lane.
// ---------------------------------------------------------------------------

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 117)?.sql ?? "";
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

after(() => db.close());

const TABLE_COLUMNS = {
  governed_lifecycle_events: [
    "schema_version",
    "event_id",
    "idempotency_key",
    "domain",
    "operation",
    "target_kind",
    "target_id",
    "material_sha256",
    "scope_kind",
    "workspace_id",
    "actor_id",
    "actor_type",
    "session_id",
    "turn_id",
    "source_required",
    "approval_required",
    "source_kind",
    "source_id",
    "approval_id",
    "occurred_at",
    "recorded_at",
  ],
  improvement_lifecycle_operations: [
    "operation_id",
    "idempotency_key",
    "workspace_id",
    "operation_kind",
    "target_kind",
    "target_id",
    "approval_id",
    "request_sha256",
    "actor_id",
    "session_id",
    "turn_id",
    "created_at",
  ],
  improvement_lifecycle_operation_claims: [
    "operation_id",
    "claim_generation",
    "worker_id",
    "claimed_at",
    "lease_expires_at",
  ],
  improvement_lifecycle_operation_inspections: [
    "inspection_id",
    "operation_id",
    "claim_generation",
    "observed_state_sha256",
    "disposition",
    "observed_at",
  ],
  improvement_lifecycle_operation_settlements: [
    "settlement_id",
    "operation_id",
    "claim_generation",
    "inspection_id",
    "disposition",
    "observed_state_sha256",
    "result_json",
    "result_sha256",
    "settled_at",
  ],
} as const;

describe("HX-402 journey-producer schema parity (SQLite 175 / PostgreSQL 117)", () => {
  it("keeps the paired table/column contracts byte-aligned", () => {
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      const sqliteColumns = tableColumns(db, table);
      assert.deepEqual(sqliteColumns, [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(
          postgresSql,
          new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"),
          `${table}.${column} missing in PostgreSQL 117`,
        );
      }
    }
  });

  it("freezes the exact contract kind registry in BOTH dialects' insert guards", () => {
    const sqliteGuard = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_governed_lifecycle_events_kind_guard'",
        )
        .get() as { sql: string }
    ).sql;
    const normalizedSqliteGuard = sqliteGuard.replace(/ AS [a-z_]+/gu, "").replace(/\s+/gu, " ");
    for (const kind of GOVERNED_MUTATION_KINDS) {
      const flags = `${kind.sourceRequired ? 1 : 0}, ${kind.approvalRequired ? 1 : 0}, ${kind.systemActorOnly ? 1 : 0}`;
      const sqliteRow = `'${kind.domain}', '${kind.operation}', '${kind.targetKind}', ${flags}`;
      assert.ok(
        normalizedSqliteGuard.includes(sqliteRow),
        `SQLite kind registry is missing ${kind.domain}:${kind.operation}`,
      );
      const postgresRow = `('${kind.domain}', '${kind.operation}', '${kind.targetKind}', ${flags})`;
      assert.ok(
        postgresSql.includes(postgresRow),
        `PostgreSQL kind registry is missing ${kind.domain}:${kind.operation}`,
      );
    }
    // No extra rows on either side: both registries carry exactly the frozen
    // contract count.
    assert.equal(
      (normalizedSqliteGuard.match(/SELECT '(?:memory|skill_state|capability_state|improvement)'/gu) ?? []).length,
      GOVERNED_MUTATION_KINDS.length,
    );
    assert.equal(
      (postgresSql.match(/^\s*\('(?:memory|skill_state|capability_state|improvement)', '/gmu) ?? []).length,
      GOVERNED_MUTATION_KINDS.length,
    );
    for (const guard of [normalizedSqliteGuard, postgresSql]) {
      assert.match(guard, /system_actor_only = 0 OR NEW\.actor_type = 'system'/u);
      assert.match(guard, /not in the frozen registry/u);
    }
  });

  it("keeps both dialects fail-closed for immutability, requirement pairing, scope, and fencing", () => {
    const sqliteTriggers = (
      db
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'trigger'
             AND (name LIKE 'trg_governed_lifecycle%' OR name LIKE 'trg_improvement_lifecycle%')
           ORDER BY name`,
        )
        .all() as Array<{ name: string; sql: string }>
    )
      .map((row) => `${row.name}\n${row.sql}`)
      .join("\n");
    const sqliteTables = (
      db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'table' AND (name LIKE 'governed_%' OR name LIKE 'improvement_lifecycle%')
           ORDER BY name`,
        )
        .all() as Array<{ sql: string }>
    )
      .map((row) => row.sql)
      .join("\n");
    for (const table of Object.keys(TABLE_COLUMNS)) {
      for (const suffix of ["no_update", "no_delete"]) {
        assert.match(sqliteTriggers, new RegExp(`trg_${table}_${suffix}`, "u"), `SQLite ${table} ${suffix}`);
        assert.match(postgresSql, new RegExp(`trg_${table}_${suffix}`, "u"), `PostgreSQL ${table} ${suffix}`);
      }
    }
    for (const sql of [`${sqliteTables}\n${sqliteTriggers}`, postgresSql]) {
      assert.match(sql, /approval_required = 1 AND approval_id IS NOT NULL/u);
      assert.match(sql, /source_required = 0 OR \(source_kind IS NOT NULL AND source_id IS NOT NULL\)/u);
      assert.match(sql, /scope_kind = 'global' AND workspace_id IS NULL/u);
      assert.match(sql, /COALESCE\(MAX\(prior\.claim_generation\), 0\) \+ 1/u);
      assert.match(sql, /disposition = 'matches_intent'/u);
      assert.match(sql, /observed_state_sha256 = NEW\.observed_state_sha256/u);
      // Stale-claim fencing runs on the database clock in both dialects.
      assert.match(sql, /(?:strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)|clock_timestamp\(\))/u);
    }
  });
});

// ---------------------------------------------------------------------------
// Live PostgreSQL foundation proof (the P0 gate's second dialect).
// ---------------------------------------------------------------------------

const MATERIAL_SHA = computeGovernedMutationMaterialSha256({ changeId: "change-1" });
const OBSERVED_SHA = "b".repeat(64);

function governedEvent(overrides: Partial<GovernedLifecycleEventRecord> = {}): GovernedLifecycleEventRecord {
  return {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId: "governed-event-pg-1",
    idempotencyKey: "memory:item_updated:item-1:change-1",
    domain: "memory",
    operation: "item_updated",
    targetKind: "memory_item",
    targetId: "item-1",
    materialSha256: MATERIAL_SHA,
    scopeKind: "workspace",
    workspaceId: "workspace-1",
    actorId: "operator-1",
    actorType: "operator",
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: "memory_history",
    sourceId: "change-1",
    approvalId: "approval-pg-1",
    occurredAt: "2026-07-23T12:00:00.000Z",
    recordedAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

function governedJourneyEvent(stored: GovernedLifecycleEventRecord): GovernanceJourneyEventRecord {
  return {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `journey-${stored.eventId}`,
    idempotencyKey: `journey:${stored.idempotencyKey}`,
    scopeKind: "workspace",
    workspaceId: stored.workspaceId,
    eventType: "memory_item_lifecycle",
    subjectKind: stored.targetKind,
    subjectId: stored.targetId,
    action: stored.operation,
    actorId: stored.actorId,
    actorType: stored.actorType,
    approvalId: stored.approvalId,
    fingerprint: stored.materialSha256,
    sourceKind: stored.sourceKind,
    sourceId: stored.sourceId,
    evidenceRefs: [{ owner: "governed_lifecycle", refId: stored.eventId }],
    provenance: { sourceRequired: stored.sourceRequired, approvalRequired: stored.approvalRequired },
    summary: { operation: stored.operation, materialSha256: stored.materialSha256 },
    occurredAt: stored.occurredAt,
    recordedAt: stored.recordedAt,
  };
}

describe("HX-402 live PostgreSQL foundation proof (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "proves immutability, registry fail-closure, replay/conflict, Journey rollback, and the one-winner claim race",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx402_journey_foundation_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const liveDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx402-journey-foundation-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        liveDb.exec(`SET search_path TO ${schemaName}`);
        // Fresh chain: migrate an EMPTY schema through the physical head so the
        // HX-402 governed-lifecycle migration 117 runs exactly as released. The
        // head advances with later additive migrations (e.g. HX-501B1's 118), so
        // this proof requires the chain to have reached AT LEAST 117.
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const head = liveDb
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get<{ version: number | string }>();
        assert.ok(Number(head?.version) >= 117);

        const events = new GovernedLifecycleEventRepository(liveDb);
        const countRows = (table: string) =>
          Number(liveDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: string | number }>()!.count);

        // --- Journey-failure rollback: the coupled write leaves nothing. ---
        assert.throws(
          () =>
            events.createWithJourney(governedEvent(), () => {
              throw new Error("injected Journey producer failure");
            }),
          /injected Journey producer failure/u,
        );
        assert.equal(countRows("governed_lifecycle_events"), 0);
        assert.equal(countRows("governance_journey_events"), 0);

        // --- Transactional Journey coupling commits together. ---
        const coupled = events.createWithJourney(governedEvent(), (persisted) => [governedJourneyEvent(persisted)]);
        assert.equal(coupled.journeyEvents.length, 1);
        assert.equal(countRows("governed_lifecycle_events"), 1);
        assert.equal(countRows("governance_journey_events"), 1);

        // --- Exact replay returns the original; drifted material conflicts. ---
        const replayed = events.create(governedEvent());
        assert.deepEqual(replayed, coupled.event);
        assert.throws(
          () =>
            events.create(
              governedEvent({
                materialSha256: computeGovernedMutationMaterialSha256({ changeId: "different-change" }),
              }),
            ),
          /conflicts with an existing immutable record/u,
        );

        // --- Scope/linkage: reads are exact-workspace scoped. ---
        assert.equal(events.findScoped("governed-event-pg-1", "workspace-1")?.eventId, "governed-event-pg-1");
        assert.equal(events.findScoped("governed-event-pg-1", "workspace-2"), undefined);

        // --- Immutability: UPDATE and DELETE are rejected in the dialect. ---
        assert.throws(
          () => liveDb.prepare("UPDATE governed_lifecycle_events SET target_id = 'item-2'").run(),
          /immutable/u,
        );
        assert.throws(() => liveDb.prepare("DELETE FROM governed_lifecycle_events").run(), /immutable/u);

        // --- Registry fail-closure: unknown kinds and forged system authority. ---
        const rawInsert = (operation: string, actorType: string, approvalRequired: number, approvalId: string | null) =>
          liveDb
            .prepare(
              `INSERT INTO governed_lifecycle_events (
                 schema_version, event_id, idempotency_key, domain, operation, target_kind, target_id,
                 material_sha256, scope_kind, workspace_id, actor_id, actor_type, session_id, turn_id,
                 source_required, approval_required, source_kind, source_id, approval_id, occurred_at, recorded_at
               ) VALUES (
                 'goatcitadel.governed-lifecycle-event.v1', @eventId, @idempotencyKey, 'memory', @operation,
                 'memory_item', 'item-9', @materialSha256, 'workspace', 'workspace-1', 'actor-raw', @actorType,
                 NULL, NULL, 1, @approvalRequired, 'memory_history', 'change-9', @approvalId,
                 '2026-07-23T12:00:00.000Z', '2026-07-23T12:00:00.000Z'
               )`,
            )
            .run({
              eventId: `raw-${operation}-${actorType}`,
              idempotencyKey: `raw-${operation}-${actorType}`,
              operation,
              actorType,
              materialSha256: MATERIAL_SHA,
              approvalRequired,
              approvalId,
            });
        assert.throws(() => rawInsert("item_promoted", "operator", 1, "approval-raw"), /not in the frozen registry/u);
        assert.throws(() => rawInsert("maintenance_expired", "operator", 0, null), /not in the frozen registry/u);
        rawInsert("maintenance_expired", "system", 0, null);
        assert.equal(countRows("governed_lifecycle_events"), 2);

        // --- Improvement one-winner claim under REAL concurrency. ---
        const improvements = new ImprovementLifecycleOperationRepository(liveDb);
        const intentBase = {
          operationId: `improvement-op-${suffix}`,
          idempotencyKey: `improvement:activate:${suffix}`,
          workspaceId: "workspace-1",
          operationKind: "activate" as const,
          targetKind: "improvement_activation" as const,
          targetId: "activation-1",
          actorId: "operator-1",
          createdAt: "2026-07-23T12:00:00.000Z",
        };
        const intent: ImprovementLifecycleOperationRecord = {
          ...intentBase,
          approvalId: `approval-improvement-${suffix}`,
          requestSha256: computeImprovementLifecycleRequestSha256(intentBase),
        };
        improvements.createIntent(intent);
        assert.deepEqual(improvements.createIntent(intent), intent);
        assert.throws(
          () => improvements.createIntent({ ...intent, targetId: "activation-2" }),
          /conflicts with an immutable record/u,
        );

        const startSignal = new SharedArrayBuffer(4);
        const workers = ["worker-a", "worker-b"].map((workerId) =>
          spawnClaimWorker(
            scopedUrl.toString(),
            database,
            `hx402-claim-race-${workerId}-${suffix}`,
            schemaName,
            {
              operationId: intent.operationId,
              workerId,
              claimedAt: "2026-07-23T12:01:00.000Z",
              leaseExpiresAt: "2126-07-23T12:06:00.000Z",
            },
            startSignal,
          ),
        );
        await Promise.all(workers.map((worker) => worker.ready));
        const startState = new Int32Array(startSignal);
        Atomics.store(startState, 0, 1);
        Atomics.notify(startState, 0);
        const results = await Promise.all(workers.map((worker) => worker.result));
        console.log(`HX-402 PG claim-race observed outcome: ${JSON.stringify(results)}`);
        const winners = results.filter(
          (result): result is { ok: true; claimGeneration: number; workerId: string } => result.ok === true,
        );
        const losers = results.filter((result): result is { ok: false; error: string } => result.ok === false);
        assert.equal(winners.length, 1, `exactly one racing claim may win: ${JSON.stringify(results)}`);
        assert.equal(winners[0]?.claimGeneration, 1);
        assert.equal(losers.length, 1);
        assert.match(
          losers[0]?.error ?? "",
          /fenced|non-sequential|duplicate key|conflict|one-winner/iu,
          `the losing claim must fail closed with a conflict-class error: ${losers[0]?.error}`,
        );
        const currentClaim = improvements.findCurrentClaim(intent.operationId);
        assert.equal(currentClaim?.claimGeneration, 1);
        assert.equal(currentClaim?.workerId, winners[0]?.workerId);

        // --- Fenced stale generation cannot settle; the winner settles once. ---
        improvements.recordInspection({
          inspectionId: `inspection-${suffix}`,
          operationId: intent.operationId,
          claimGeneration: 1,
          observedStateSha256: OBSERVED_SHA,
          disposition: "matches_intent",
          observedAt: "2026-07-23T12:02:00.000Z",
        });
        const result = { disposition: "applied", observedStateSha256: OBSERVED_SHA };
        const settlement = {
          settlementId: `settlement-${suffix}`,
          operationId: intent.operationId,
          claimGeneration: 1,
          inspectionId: `inspection-${suffix}`,
          disposition: "applied" as const,
          observedStateSha256: OBSERVED_SHA,
          result,
          resultSha256: computeImprovementLifecycleResultSha256(result),
          settledAt: "2026-07-23T12:03:00.000Z",
        };
        const settled = improvements.settle(settlement);
        assert.deepEqual(improvements.settle(settlement), settled);
        assert.throws(
          () => improvements.settle({ ...settlement, disposition: "failed" }),
          /conflicts with an immutable record/u,
        );
        assert.throws(
          () => liveDb.prepare("UPDATE improvement_lifecycle_operation_settlements SET disposition = 'failed'").run(),
          /immutable/u,
        );
        assert.throws(
          () =>
            improvements.claim({
              operationId: intent.operationId,
              workerId: "worker-late",
              claimedAt: "2026-07-23T12:04:00.000Z",
              leaseExpiresAt: "2126-07-23T12:09:00.000Z",
            }),
          /settled|fenced/u,
        );
        assert.deepEqual(improvements.listUnsettled("workspace-1"), []);
      } finally {
        liveDb.close();
        await migrations.close().catch(() => undefined);
        await scopedPool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
      }
    },
  );
});

function tableColumns(client: DatabaseClient, table: string): string[] {
  return (client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

type ClaimWorkerResult = { ok: true; claimGeneration: number; workerId: string } | { ok: false; error: string };

function spawnClaimWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  schemaName: string,
  input: Record<string, unknown>,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<ClaimWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(CLAIM_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      input,
      schemaName,
      startSignal,
      repositoryModuleUrl: new URL(`./improvement-lifecycle-operation-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: ClaimWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<ClaimWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: ClaimWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`HX-402 PostgreSQL claim worker exited with code ${code}.`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const CLAIM_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { ImprovementLifecycleOperationRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      parentPort.postMessage({ kind: "ready" });
      const startState = new Int32Array(workerData.startSignal);
      Atomics.wait(startState, 0, 0);
      try {
        const claim = new ImprovementLifecycleOperationRepository(db).claim(workerData.input);
        parentPort.postMessage({
          kind: "result",
          result: { ok: true, claimGeneration: claim.claimGeneration, workerId: claim.workerId },
        });
      } catch (error) {
        parentPort.postMessage({
          kind: "result",
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: "worker bootstrap failed: " + (error instanceof Error ? error.message : String(error)) },
      });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* best-effort cleanup on worker exit */
        }
      }
    }
  })();
`;
