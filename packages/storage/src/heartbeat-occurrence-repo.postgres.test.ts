import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { Pool } from "pg";
import type { DatabaseClient, DbBindParams, DbStatement } from "./db.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import {
  HEARTBEAT_ADMISSION_OPERATION,
  HEARTBEAT_SYSTEM_ACTOR_ID,
  HeartbeatOccurrenceRepository,
  type ClaimHeartbeatOccurrenceInput,
  type HeartbeatOccurrenceRecord,
} from "./heartbeat-occurrence-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { SessionRepository } from "./session-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = connectionString ? it : it.skip;

describe("HeartbeatOccurrenceRepository live PostgreSQL", () => {
  postgresIt(
    "installs the exact heartbeat reclaim guard on both fresh 116 and 115-to-116 upgrade paths",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const adminPool = new Pool({ connectionString, max: 2 });
      const schemas: string[] = [];
      try {
        for (const mode of ["upgrade", "fresh"] as const) {
          const schemaName = `hx411_hbo_catalog_${mode}_${randomUUID().replaceAll("-", "")}`;
          schemas.push(schemaName);
          await adminPool.query(`CREATE SCHEMA ${schemaName}`);
          const scoped = scopedPostgres(connectionString, schemaName);
          const pool = new Pool({ connectionString: scoped.connectionString, max: 2 });
          const migrations = new PostgresDatabaseClient(
            { connectionString: scoped.connectionString, database: scoped.database },
            { pool },
          );
          const inspect = new PostgresSyncDatabaseClient({
            connectionString: scoped.connectionString,
            database: scoped.database,
            applicationName: `hx411-hbo-catalog-${mode}`,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          });
          try {
            inspect.exec(`SET search_path TO ${schemaName}`);
            if (mode === "upgrade") {
              await runPostgresMigrations(
                migrations,
                POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 115),
              );
              const before = readAdmissionGuardDefinition(inspect);
              assert.doesNotMatch(before, /heartbeat occurrence request-runtime reclaim/u);
              assert.deepEqual(
                inspect
                  .prepare(`SELECT MAX(version) AS version FROM ${schemaName}.schema_migrations`)
                  .get<{ version: number }>(),
                { version: 115 },
              );
              stageOrphanProfileBinding(inspect, mode);
              await assert.rejects(
                runPostgresMigrations(
                  migrations,
                  POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 116),
                ),
                /heartbeat profile binding FK repair orphan preflight failed/iu,
              );
              assert.deepEqual(
                inspect
                  .prepare(`SELECT MAX(version) AS version FROM ${schemaName}.schema_migrations`)
                  .get<{ version: number }>(),
                { version: 115 },
              );
              assert.doesNotMatch(
                readAdmissionGuardDefinition(inspect),
                /heartbeat occurrence request-runtime reclaim/u,
              );
              cleanupOrphanProfileBinding(inspect, mode);
            }
            await runPostgresMigrations(
              migrations,
              POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 116),
            );
            assertExactHeartbeatCatalogAndGuard(inspect);
            assert.deepEqual(
              inspect
                .prepare(`SELECT version, name FROM ${schemaName}.schema_migrations WHERE version = 116`)
                .get<{ version: number; name: string }>(),
              { version: 116, name: "durable_heartbeat_occurrence_authority" },
            );
          } finally {
            inspect.close();
            await migrations.close();
          }
        }
      } finally {
        for (const schemaName of schemas.reverse()) {
          await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
          const remaining = await adminPool.query<{ namespace_name: string | null }>(
            "SELECT to_regnamespace($1)::TEXT AS namespace_name",
            [schemaName],
          );
          assert.equal(remaining.rows[0]?.namespace_name, null);
        }
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "rolls back callback failure, serializes two workers, and rejects foreign or stale reclaim evidence",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_hbo_repo_${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scoped = scopedPostgres(connectionString, schemaName);
      const pool = new Pool({ connectionString: scoped.connectionString, max: 3 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scoped.connectionString, database: scoped.database },
        { pool },
      );
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(
          migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 116),
        );
        db = new PostgresSyncDatabaseClient({
          connectionString: scoped.connectionString,
          database: scoped.database,
          applicationName: `hx411-hbo-repo-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        db.exec(`SET search_path TO ${schemaName}`);

        const legacyNull = seedHeartbeatSession(db, `legacy-null-${suffix}`);
        forcePostgresLegacyNullLifecycleIntent(db, legacyNull.sessionId);
        assert.throws(() => claimHeartbeat(db!, legacyNull), /exact live operator session authority/iu);
        assert.equal(countRows(db, "chat_heartbeat_occurrences", legacyNull.sessionId), 0);
        assert.equal(countRows(db, "chat_session_mutation_admissions", legacyNull.sessionId), 0);
        assert.equal(new SessionAutonomyPrefsRepository(db).get(legacyNull.sessionId)?.lastProactiveRunId, undefined);

        const rollback = seedHeartbeatSession(db, `rollback-${suffix}`);
        const rollbackOccurrences = new HeartbeatOccurrenceRepository(db);
        const rollbackAdmissions = new SessionMutationAdmissionRepository(db);
        assert.throws(
          () =>
            rollbackOccurrences.claim(rollback.claimInput, (request) => {
              const admission = rollbackAdmissions.admit(request.admissionInput).admission;
              throw new Error(`simulated callback crash after ${admission.admissionId}`);
            }),
          /simulated callback crash/u,
        );
        assert.equal(countRows(db, "chat_heartbeat_occurrences", rollback.sessionId), 0);
        assert.equal(countRows(db, "chat_session_mutation_admissions", rollback.sessionId), 0);
        assert.deepEqual(new SessionAutonomyPrefsRepository(db).get(rollback.sessionId)?.lastProactiveRunId, undefined);

        const raceFixture = seedHeartbeatSession(db, `race-${suffix}`);
        const race = await runPostgresHeartbeatClaimRace(
          scoped.connectionString,
          scoped.database,
          schemaName,
          raceFixture.claimInput,
        );
        assert.equal(race.filter((result) => result.ok).length, 2, JSON.stringify(race));
        assert.deepEqual(race.map((result) => result.disposition).sort(), ["created", "replayed"]);
        assert.equal(new Set(race.map((result) => result.occurrenceId)).size, 1);
        assert.equal(countRows(db, "chat_heartbeat_occurrences", raceFixture.sessionId), 1);
        assert.equal(countRows(db, "chat_session_mutation_admissions", raceFixture.sessionId), 1);
        const racedOccurrence = new HeartbeatOccurrenceRepository(db)
          .listRecoverable()
          .find((occurrence) => occurrence.sessionId === raceFixture.sessionId);
        assert.ok(racedOccurrence);
        assert.equal(
          new SessionAutonomyPrefsRepository(db).get(raceFixture.sessionId)?.lastProactiveRunId,
          racedOccurrence.occurrenceId,
        );

        const target = claimHeartbeat(db, seedHeartbeatSession(db, `reclaim-${suffix}`));
        const foreign = claimHeartbeat(db, seedHeartbeatSession(db, `foreign-${suffix}`));
        const rawInsertFixture = seedHeartbeatSession(db, `raw-insert-${suffix}`);
        assertRawOccurrenceGuards(db, target, rawInsertFixture);
        proveDeferredProfileBindBeforeProfileCommit(db, target, suffix);
        forcePostgresAdmissionLeaseExpired(db, target.admissionId);
        const admissions = new SessionMutationAdmissionRepository(db);
        const reclaimInput = toReclaimInput(target, 1);
        assert.throws(
          () =>
            admissions.reclaimExpiredSystemTurnWriteRequestLease({
              ...reclaimInput,
              occurrenceId: foreign.occurrenceId,
            }),
          /no exact admitted occurrence/iu,
        );
        assert.throws(
          () =>
            admissions.reclaimExpiredSystemTurnWriteRequestLease({
              ...reclaimInput,
              claimSha256: sha256("stale-postgres-heartbeat-claim"),
            }),
          /no exact admitted occurrence/iu,
        );
        assert.equal(admissions.require(target.admissionId).runtimeLeaseRevision, 1);
        const reclaimRace = await runPostgresHeartbeatReclaimRace(
          scoped.connectionString,
          scoped.database,
          schemaName,
          reclaimInput,
        );
        assert.equal(
          reclaimRace.every((result) => result.ok),
          true,
          JSON.stringify(reclaimRace),
        );
        assert.deepEqual(reclaimRace.map((result) => result.disposition).sort(), ["live", "reclaimed"]);
        assert.deepEqual(reclaimRace.map((result) => result.leaseRevision).sort(), [2, 2]);
        assert.equal(admissions.require(target.admissionId).runtimeLeaseRevision, 2);
        assert.equal(
          admissions.reclaimExpiredSystemTurnWriteRequestLease(toReclaimInput(target, 2)).disposition,
          "live",
        );

        for (const [driftSeed, lifecycleIntentId] of [
          [`reclaim-null-${suffix}`, null],
          [`reclaim-changed-${suffix}`, `changed-persisted-incarnation-${suffix}`],
        ] as const) {
          const driftOccurrence = claimHeartbeat(db, seedHeartbeatSession(db, driftSeed));
          forcePostgresAdmissionLeaseExpired(db, driftOccurrence.admissionId);
          forcePostgresLifecycleIntent(db, driftOccurrence.sessionId, lifecycleIntentId);
          const driftOutcome = admissions.reclaimExpiredSystemTurnWriteRequestLease(toReclaimInput(driftOccurrence, 1));
          assert.equal(driftOutcome.disposition, "closed_or_authority_drift");
          assert.equal(
            driftOutcome.disposition === "closed_or_authority_drift" ? driftOutcome.reason : undefined,
            "authority_drift",
          );
          const driftAdmission = admissions.require(driftOccurrence.admissionId);
          assert.equal(driftAdmission.runtimeLeaseRevision, 1);
          assert.equal(driftAdmission.status, "cancelled");
          assert.equal(driftAdmission.terminalAuthorityKind, "authority_superseded");
          const storedOccurrence = new HeartbeatOccurrenceRepository(db).find(driftOccurrence.occurrenceId);
          assert.equal(storedOccurrence?.state, "abandoned");
          assert.equal(storedOccurrence?.abandonmentReason, "authority_drift");
        }
      } finally {
        db?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        const remaining = await adminPool.query<{ namespace_name: string | null }>(
          "SELECT to_regnamespace($1)::TEXT AS namespace_name",
          [schemaName],
        );
        assert.equal(remaining.rows[0]?.namespace_name, null);
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "atomically preempts both heartbeat states, closes pending control, and preserves committed decisions",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_hbo_preemption_${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scoped = scopedPostgres(connectionString, schemaName);
      const pool = new Pool({ connectionString: scoped.connectionString, max: 2 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scoped.connectionString, database: scoped.database },
        { pool },
      );
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(
          migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 116),
        );
        db = new PostgresSyncDatabaseClient({
          connectionString: scoped.connectionString,
          database: scoped.database,
          applicationName: `hx411-hbo-preemption-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        db.exec(`SET search_path TO ${schemaName}`);

        const prebindSeed = seedHeartbeatSession(db, `prebind-${suffix}`);
        const prebindOccurrence = claimHeartbeat(db, prebindSeed);
        const prebindAdmissions = new SessionMutationAdmissionRepository(db);
        forcePostgresAdmissionLeaseExpired(db, prebindOccurrence.admissionId);
        const expiredRequest = seedPostgresPendingControlRequest(db, prebindSeed, `expired-${suffix}`, {
          createdOffsetMs: -120_000,
          expiresOffsetMs: -60_000,
        });
        const liveRequest = seedPostgresPendingControlRequest(db, prebindSeed, `live-${suffix}`, {
          createdOffsetMs: -30_000,
          expiresOffsetMs: 600_000,
        });
        const prebindInput = postgresOperatorTurnAdmissionInput(prebindSeed, `prebind-${suffix}`, 1);
        const prebindCreated = prebindAdmissions.preemptHeartbeatAndAdmitOperatorTurn(prebindInput);
        assert.equal(prebindCreated.disposition, "created");
        assert.equal(prebindCreated.preemptionDisposition, "preempted");
        assert.equal(prebindCreated.controllerGeneration, 2);
        assert.ok(prebindCreated.controlEventId);
        assertPostgresPreemptionClockEquality(db, {
          sessionId: prebindSeed.sessionId,
          oldGeneration: 1,
          newGeneration: 2,
          controlEventId: prebindCreated.controlEventId,
          heartbeatAdmissionId: prebindOccurrence.admissionId,
          occurrenceId: prebindOccurrence.occurrenceId,
        });
        const cleanedRequests = db
          .prepare(
            `SELECT request_id, status, decision_reason_code, decided_at
             FROM chat_session_control_requests WHERE session_id = @sessionId
             ORDER BY created_at ASC, request_id ASC`,
          )
          .all<{
            request_id: string;
            status: string;
            decision_reason_code: string;
            decided_at: string;
          }>({ sessionId: prebindSeed.sessionId });
        assert.deepEqual(
          cleanedRequests.map((request) => [request.request_id, request.status, request.decision_reason_code]),
          [
            [expiredRequest.requestId, "expired", "request_expired"],
            [liveRequest.requestId, "cancelled", "request_cancelled"],
          ],
        );
        const cleanupEvents = db
          .prepare(
            `SELECT request_id, reason_code, created_at FROM chat_session_control_events
             WHERE session_id = @sessionId AND reason_code IN (
               'request_expired', 'request_cancelled', 'heartbeat_preempted'
             ) ORDER BY event_sequence ASC`,
          )
          .all<{ request_id: string | null; reason_code: string; created_at: string }>({
            sessionId: prebindSeed.sessionId,
          });
        assert.deepEqual(
          cleanupEvents.map((event) => [event.request_id, event.reason_code]),
          [
            [expiredRequest.requestId, "request_expired"],
            [liveRequest.requestId, "request_cancelled"],
            [null, "heartbeat_preempted"],
          ],
        );
        assert.equal(new Set(cleanupEvents.map((event) => event.created_at)).size, 1);
        assert.equal(new Set(cleanedRequests.map((request) => request.decided_at)).size, 1);
        assert.equal(cleanedRequests[0]?.decided_at, cleanupEvents[0]?.created_at);
        assert.equal(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_control_grants
               WHERE session_id = @sessionId AND is_current = 1 AND token_sha256 IS NOT NULL`,
            )
            .get<{ count: number }>({ sessionId: prebindSeed.sessionId })!.count,
          0,
        );
        const originalReplay = prebindAdmissions.preemptHeartbeatAndAdmitOperatorTurn(prebindInput);
        assert.equal(originalReplay.disposition, "replayed");
        assert.equal(originalReplay.preemptionDisposition, "replayed");
        const lostResponseReplay = prebindAdmissions.preemptHeartbeatAndAdmitOperatorTurn({
          ...prebindInput,
          expectedControllerGeneration: 2,
        });
        assert.equal(lostResponseReplay.disposition, "replayed");
        assert.equal(lostResponseReplay.preemptionDisposition, "replayed");
        assertRawPostgresHeartbeatPreemptionEventGuard(db, prebindSeed, 2, suffix);

        const delayedSeed = seedHeartbeatSession(db, `delayed-${suffix}`);
        const delayedOccurrence = claimHeartbeat(db, delayedSeed);
        forcePostgresAdmissionLeaseExpired(db, delayedOccurrence.admissionId);
        seedPostgresPendingControlRequest(db, delayedSeed, `delayed-expired-${suffix}`, {
          createdOffsetMs: -120_000,
          expiresOffsetMs: -60_000,
        });
        seedPostgresPendingControlRequest(db, delayedSeed, `delayed-live-${suffix}`, {
          createdOffsetMs: -30_000,
          expiresOffsetMs: 600_000,
        });
        const delayedDb = new RunHookDatabaseClient(
          db,
          (sql) => sql.includes("SET runtime_last_heartbeat_at = @preemptedAt"),
          () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_250),
        );
        const delayedAdmissions = new SessionMutationAdmissionRepository(delayedDb);
        const delayedInput = postgresOperatorTurnAdmissionInput(delayedSeed, `delayed-${suffix}`, 1);
        const delayedStartedAt = Date.now();
        const delayedCreated = delayedAdmissions.preemptHeartbeatAndAdmitOperatorTurn(delayedInput);
        assert.equal(delayedDb.hookCount, 1);
        assert.ok(Date.now() - delayedStartedAt >= 1_000);
        assert.equal(delayedCreated.disposition, "created");
        assert.equal(delayedCreated.preemptionDisposition, "preempted");
        assert.ok(delayedCreated.controlEventId);
        assertPostgresPreemptionClockEquality(db, {
          sessionId: delayedSeed.sessionId,
          oldGeneration: 1,
          newGeneration: 2,
          controlEventId: delayedCreated.controlEventId,
          heartbeatAdmissionId: delayedOccurrence.admissionId,
          occurrenceId: delayedOccurrence.occurrenceId,
        });
        const delayedSettlementRows = db
          .prepare(
            `SELECT decided_at AS settled_at FROM chat_session_control_requests
             WHERE session_id = @sessionId
             UNION ALL
             SELECT created_at AS settled_at FROM chat_session_control_events
             WHERE session_id = @sessionId AND reason_code IN (
               'request_expired', 'request_cancelled', 'heartbeat_preempted'
             )`,
          )
          .all<{ settled_at: string }>({ sessionId: delayedSeed.sessionId });
        assert.equal(delayedSettlementRows.length, 5);
        assert.equal(new Set(delayedSettlementRows.map((row) => row.settled_at)).size, 1);
        const delayedSettlementAt = delayedSettlementRows[0]!.settled_at;
        assert.notEqual(delayedCreated.admission.createdAt, delayedSettlementAt);
        assert.ok(Date.parse(delayedCreated.admission.createdAt) - Date.parse(delayedSettlementAt) >= 1_000);
        const delayedReplay = delayedAdmissions.preemptHeartbeatAndAdmitOperatorTurn(delayedInput);
        assert.equal(delayedReplay.disposition, "replayed");
        assert.equal(delayedReplay.preemptionDisposition, "replayed");
        assert.equal(delayedReplay.controlEventId, delayedCreated.controlEventId);
        assert.equal(readPostgresHeartbeatPreemptionEventCount(db, delayedSeed.sessionId), 1);

        const boundedSeed = seedHeartbeatSession(db, `pending-bound-${suffix}`);
        const boundedOccurrence = claimHeartbeat(db, boundedSeed);
        const boundedAdmissions = new SessionMutationAdmissionRepository(db);
        forcePostgresAdmissionLeaseExpired(db, boundedOccurrence.admissionId);
        seedManyPostgresPendingControlRequests(db, boundedSeed, `pending-bound-${suffix}`, 257);
        const beforeBoundedAdmission = boundedAdmissions.require(boundedOccurrence.admissionId);
        assert.throws(
          () =>
            boundedAdmissions.preemptHeartbeatAndAdmitOperatorTurn(
              postgresOperatorTurnAdmissionInput(boundedSeed, `pending-bound-${suffix}`, 1),
            ),
          /too many pending session-control requests/iu,
        );
        assert.deepEqual(boundedAdmissions.require(boundedOccurrence.admissionId), beforeBoundedAdmission);
        assert.equal(new HeartbeatOccurrenceRepository(db).find(boundedOccurrence.occurrenceId)?.state, "admitted");
        assert.equal(readPostgresCurrentControlGeneration(db, boundedSeed.sessionId), 1);
        assert.equal(readPostgresHeartbeatPreemptionEventCount(db, boundedSeed.sessionId), 0);
        assert.equal(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_control_requests
               WHERE session_id = @sessionId AND status = 'pending'`,
            )
            .get<{ count: number }>({ sessionId: boundedSeed.sessionId })!.count,
          257,
        );

        const bound = createPostgresTerminalReadyHeartbeat(db, `bound-${suffix}`, false);
        const boundCadence = new SessionAutonomyPrefsRepository(db).get(bound.fixture.sessionId);
        const boundInput = postgresOperatorTurnAdmissionInput(bound.fixture, `bound-${suffix}`, 1);
        const boundCreated = bound.admissions.preemptHeartbeatAndAdmitOperatorTurn(boundInput);
        assert.equal(boundCreated.disposition, "created");
        assert.equal(boundCreated.preemptionDisposition, "preempted");
        assert.ok(boundCreated.controlEventId);
        const storedBound = bound.occurrences.find(bound.occurrence.occurrenceId);
        assert.equal(storedBound?.state, "abandoned");
        assert.equal(storedBound?.abandonmentReason, "authority_drift");
        assert.equal(storedBound?.boundDurableRunId, bound.occurrence.durableRunId);
        assert.equal(storedBound?.capabilityProfileId, bound.profileId);
        assert.equal(
          bound.admissions.require(bound.occurrence.admissionId).terminalAuthorityKind,
          "authority_superseded",
        );
        const cancelledRun = bound.durableRuns.getRun(bound.occurrence.durableRunId);
        assert.equal(cancelledRun.status, "cancelled");
        assert.equal(cancelledRun.leaseOwnerId, undefined);
        assert.equal(cancelledRun.leaseExpiresAt, undefined);
        assert.equal(cancelledRun.leaseHeartbeatAt, undefined);
        assertPostgresPreemptionClockEquality(db, {
          sessionId: bound.fixture.sessionId,
          oldGeneration: 1,
          newGeneration: 2,
          controlEventId: boundCreated.controlEventId,
          heartbeatAdmissionId: bound.occurrence.admissionId,
          occurrenceId: bound.occurrence.occurrenceId,
          durableRunId: bound.occurrence.durableRunId,
        });
        const boundCadenceAfter = new SessionAutonomyPrefsRepository(db).get(bound.fixture.sessionId);
        assert.equal(boundCadenceAfter?.lastProactiveAt, boundCadence?.lastProactiveAt);
        assert.equal(boundCadenceAfter?.lastProactiveRunId, boundCadence?.lastProactiveRunId);
        assert.equal(
          bound.admissions.preemptHeartbeatAndAdmitOperatorTurn(boundInput).preemptionDisposition,
          "replayed",
        );

        const disabledSeed = seedHeartbeatSession(db, `disabled-${suffix}`);
        const disabledOccurrence = claimHeartbeat(db, disabledSeed);
        forcePostgresAdmissionLeaseExpired(db, disabledOccurrence.admissionId);
        const disabledAdmissions = new SessionMutationAdmissionRepository(db);
        const disabledInput = {
          workspaceId: disabledSeed.workspaceId,
          sessionId: disabledSeed.sessionId,
          occurrenceId: disabledOccurrence.occurrenceId,
          admissionId: disabledOccurrence.admissionId,
          claimSha256: disabledOccurrence.claimSha256,
          idempotencyKey: `heartbeat:execution-disabled:${suffix}`,
          correlationId: `heartbeat:execution-disabled:${suffix}`,
        };
        const parked = disabledAdmissions.abandonAdmittedHeartbeatForExecutionDisabled(disabledInput);
        assert.equal(parked.disposition, "parked");
        assert.equal(parked.admission.terminalAuthorityKind, "request_runtime");
        assert.equal(
          new HeartbeatOccurrenceRepository(db).find(disabledOccurrence.occurrenceId)?.abandonmentReason,
          "admission_closed",
        );
        assert.equal(
          disabledAdmissions.abandonAdmittedHeartbeatForExecutionDisabled(disabledInput).disposition,
          "replayed",
        );
        assert.equal(readPostgresHeartbeatPreemptionEventCount(db, disabledSeed.sessionId), 0);

        for (const notify of [false, true] as const) {
          const decision = createPostgresTerminalReadyHeartbeat(
            db,
            `decision-${notify ? "notify" : "silent"}-${suffix}`,
            false,
          );
          persistPostgresHeartbeatDecisionCommit(decision, notify);
          const decisionInput = postgresOperatorTurnAdmissionInput(
            decision.fixture,
            `decision-${notify ? "notify" : "silent"}-${suffix}`,
            1,
          );
          const beforeRun = decision.durableRuns.getRun(decision.occurrence.durableRunId);
          const outcome = decision.admissions.preemptHeartbeatAndAdmitOperatorTurn(decisionInput);
          assert.equal(outcome.disposition, "decision_committed");
          assert.equal(outcome.preemptionDisposition, "decision_committed");
          assert.equal(outcome.controllerGeneration, 1);
          assert.equal(outcome.occurrenceId, decision.occurrence.occurrenceId);
          assert.deepEqual(decision.durableRuns.getRun(decision.occurrence.durableRunId), beforeRun);
          assert.equal(decision.admissions.require(decision.occurrence.admissionId).status, "active");
          assert.equal(decision.occurrences.find(decision.occurrence.occurrenceId)?.state, "durable_bound");
          assert.equal(readPostgresHeartbeatPreemptionEventCount(db, decision.fixture.sessionId), 0);
        }

        for (const fault of [
          "raw_only",
          "receipt_drift",
          "assistant_without_pair",
          "completed_trace_without_pair",
          "missing_trace_without_pair",
          "drifted_trace_without_pair",
          "approval_wait_without_pair",
          "user_input_wait_without_pair",
          "completion_null",
          "completion_partial",
          "completion_repaired",
          "completion_extra",
          "completion_malformed",
        ] as const) {
          const malformed = createPostgresTerminalReadyHeartbeat(db, `decision-${fault}-${suffix}`, false);
          persistMalformedPostgresHeartbeatDecisionState(malformed, fault);
          assert.throws(
            () =>
              malformed.admissions.preemptHeartbeatAndAdmitOperatorTurn(
                postgresOperatorTurnAdmissionInput(malformed.fixture, `decision-${fault}-${suffix}`, 1),
              ),
            /decision evidence|decision pair|one-sided|pre-decision|durable turn authority/iu,
          );
          assert.equal(malformed.admissions.require(malformed.occurrence.admissionId).status, "active");
          assert.equal(malformed.occurrences.find(malformed.occurrence.occurrenceId)?.state, "durable_bound");
          assert.equal(readPostgresHeartbeatPreemptionEventCount(db, malformed.fixture.sessionId), 0);
          assert.equal(readPostgresCurrentControlGeneration(db, malformed.fixture.sessionId), 1);
        }

        assertRawPostgresHeartbeatPreemptionGrantGuard(db, `raw-grant-${suffix}`);
      } finally {
        db?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        const remaining = await adminPool.query<{ namespace_name: string | null }>(
          "SELECT to_regnamespace($1)::TEXT AS namespace_name",
          [schemaName],
        );
        assert.equal(remaining.rows[0]?.namespace_name, null);
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "accepts canonical terminal evidence and rejects raw forged authority, output, and handoff hashes",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_hbo_terminal_${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scoped = scopedPostgres(connectionString, schemaName);
      const pool = new Pool({ connectionString: scoped.connectionString, max: 2 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scoped.connectionString, database: scoped.database },
        { pool },
      );
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(
          migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 116),
        );
        db = new PostgresSyncDatabaseClient({
          connectionString: scoped.connectionString,
          database: scoped.database,
          applicationName: `hx411-hbo-terminal-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        db.exec(`SET search_path TO ${schemaName}`);

        const canonical = createPostgresTerminalReadyHeartbeat(db, `canonical-${suffix}`);
        assert.equal(canonical.occurrences.markTerminal(canonical.boundIdentity).disposition, "terminal");

        const forgedSeal = createPostgresTerminalReadyHeartbeat(db, `forged-seal-${suffix}`);
        const forgedSealMetadata = readPostgresRunMetadata(db, forgedSeal.occurrence.durableRunId);
        const forgedSealAuthority = forgedSealMetadata.chatTurnRuntimeAuthority as { materialSha256: string };
        forgedSealAuthority.materialSha256 = "f".repeat(64);
        writePostgresRunMetadata(db, forgedSeal.occurrence.durableRunId, forgedSealMetadata);
        assert.throws(() => rawPostgresTerminalTransition(db!, forgedSeal), /terminal runtime evidence invariant/iu);

        const forgedOutput = createPostgresTerminalReadyHeartbeat(db, `forged-output-${suffix}`);
        const forgedOutputMetadata = readPostgresRunMetadata(db, forgedOutput.occurrence.durableRunId);
        const forgedOutputAuthority = forgedOutputMetadata.chatTurnRuntimeAuthority as {
          material: { terminalOutput: { outputTextSha256: string } };
          materialSha256: string;
        };
        forgedOutputAuthority.material.terminalOutput.outputTextSha256 = "e".repeat(64);
        forgedOutputAuthority.materialSha256 = sha256(canonicalJsonString(forgedOutputAuthority.material));
        writePostgresRunMetadata(db, forgedOutput.occurrence.durableRunId, forgedOutputMetadata);
        new DurableRunRepository(db).createCheckpoint({
          checkpointId: `checkpoint-forged-output-${forgedOutput.occurrence.occurrenceId}`,
          runId: forgedOutput.occurrence.durableRunId,
          checkpointKind: "run_completed",
          state: {
            chatTurnRuntimeAuthority: forgedOutputAuthority,
            assistantMessageId: forgedOutput.occurrence.assistantMessageId,
            outputText: forgedOutputMetadata.outputText,
            outputSummary: forgedOutputMetadata.outputSummary,
          },
          createdAt: new Date(Date.now() + 1_000).toISOString(),
        });
        assert.throws(() => rawPostgresTerminalTransition(db!, forgedOutput), /terminal runtime evidence invariant/iu);

        const forgedHandoff = createPostgresTerminalReadyHeartbeat(db, `forged-handoff-${suffix}`);
        const forgedHandoffMetadata = readPostgresRunMetadata(db, forgedHandoff.occurrence.durableRunId);
        const forgedMarker = forgedHandoffMetadata.chatTurnAdmissionHandoff as { childRunIdsSha256: string };
        forgedMarker.childRunIdsSha256 = "d".repeat(64);
        writePostgresRunMetadata(db, forgedHandoff.occurrence.durableRunId, forgedHandoffMetadata);
        assert.throws(() => rawPostgresTerminalTransition(db!, forgedHandoff), /terminal runtime evidence invariant/iu);
      } finally {
        db?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        const remaining = await adminPool.query<{ namespace_name: string | null }>(
          "SELECT to_regnamespace($1)::TEXT AS namespace_name",
          [schemaName],
        );
        assert.equal(remaining.rows[0]?.namespace_name, null);
        await adminPool.end();
      }
    },
  );
});

function scopedPostgres(
  baseConnectionString: string,
  schemaName: string,
): {
  connectionString: string;
  database: string;
} {
  const scopedUrl = new URL(baseConnectionString);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
  return {
    connectionString: scopedUrl.toString(),
    database: decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres",
  };
}

function postgresOperatorTurnAdmissionInput(
  fixture: {
    workspaceId: string;
    sessionId: string;
    sessionIncarnationId: string;
    aggregateRevision: number;
  },
  seed: string,
  expectedControllerGeneration: number,
) {
  return {
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    expectedSessionIncarnationId: fixture.sessionIncarnationId,
    turnId: `operator-turn-${seed}`,
    runtimeOwnerId: `operator-runtime-${seed}`,
    aggregateRevision: fixture.aggregateRevision,
    expectedControllerGeneration,
    operatorActorId: "operator-heartbeat",
    operation: "chat_user_message",
    materialSha256: sha256(`operator-material:${seed}`),
    idempotencyKey: `operator-admission:${seed}`,
    correlationId: `operator-correlation:${seed}`,
  };
}

function seedPostgresPendingControlRequest(
  db: PostgresSyncDatabaseClient,
  fixture: { workspaceId: string; sessionId: string },
  seed: string,
  offsets: { createdOffsetMs: number; expiresOffsetMs: number },
): { requestId: string; tokenSha256: string } {
  const requestId = `control-request-${seed}`;
  const tokenSha256 = sha256(`control-token:${seed}`);
  const createdAt = new Date(Date.now() + offsets.createdOffsetMs).toISOString();
  const expiresAt = new Date(Date.now() + offsets.expiresOffsetMs).toISOString();
  db.exec("ALTER TABLE chat_session_control_requests DISABLE TRIGGER trg_chat_session_control_requests_insert_guard");
  try {
    db.prepare(
      `INSERT INTO chat_session_control_tokens (
         token_sha256, workspace_id, session_id, first_request_id, created_at
       ) VALUES (@tokenSha256, @workspaceId, @sessionId, @requestId, @createdAt)`,
    ).run({
      tokenSha256,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      requestId,
      createdAt,
    });
    db.prepare(
      `INSERT INTO chat_session_control_requests (
         request_id, workspace_id, session_id, companion_session_id, device_grant_id,
         client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
         requested_capabilities_sha256, requested_generation, status, idempotency_key,
         request_sha256, expires_at, created_at
       ) VALUES (
         @requestId, @workspaceId, @sessionId, @companionSessionId, @deviceGrantId,
         @clientInstanceId, 'session_control_client', @tokenSha256, '["send"]',
         @capabilitiesSha256, 1, 'pending', @idempotencyKey,
         @requestSha256, @expiresAt, @createdAt
       )`,
    ).run({
      requestId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      companionSessionId: `companion-${seed}`,
      deviceGrantId: `device-grant-${seed}`,
      clientInstanceId: `client-${seed}`,
      tokenSha256,
      capabilitiesSha256: sha256('["send"]'),
      idempotencyKey: `control-request:${seed}`,
      requestSha256: sha256(`control-request:${seed}`),
      expiresAt,
      createdAt,
    });
  } finally {
    db.exec("ALTER TABLE chat_session_control_requests ENABLE TRIGGER trg_chat_session_control_requests_insert_guard");
  }
  return { requestId, tokenSha256 };
}

function seedManyPostgresPendingControlRequests(
  db: PostgresSyncDatabaseClient,
  fixture: { workspaceId: string; sessionId: string },
  seed: string,
  count: number,
): void {
  const createdAt = new Date(Date.now() - 30_000).toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  db.exec("ALTER TABLE chat_session_control_requests DISABLE TRIGGER trg_chat_session_control_requests_insert_guard");
  try {
    for (let index = 0; index < count; index += 1) {
      const requestId = `control-request-${seed}-${index.toString().padStart(3, "0")}`;
      const tokenSha256 = sha256(`control-token:${seed}:${index}`);
      db.prepare(
        `INSERT INTO chat_session_control_tokens (
           token_sha256, workspace_id, session_id, first_request_id, created_at
         ) VALUES (@tokenSha256, @workspaceId, @sessionId, @requestId, @createdAt)`,
      ).run({ tokenSha256, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId, requestId, createdAt });
      db.prepare(
        `INSERT INTO chat_session_control_requests (
           request_id, workspace_id, session_id, companion_session_id, device_grant_id,
           client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
           requested_capabilities_sha256, requested_generation, status, idempotency_key,
           request_sha256, expires_at, created_at
         ) VALUES (
           @requestId, @workspaceId, @sessionId, @companionSessionId, @deviceGrantId,
           @clientInstanceId, 'session_control_client', @tokenSha256, '["send"]',
           @capabilitiesSha256, 1, 'pending', @idempotencyKey,
           @requestSha256, @expiresAt, @createdAt
         )`,
      ).run({
        requestId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        companionSessionId: `companion-${seed}-${index}`,
        deviceGrantId: `device-grant-${seed}-${index}`,
        clientInstanceId: `client-${seed}-${index}`,
        tokenSha256,
        capabilitiesSha256: sha256('["send"]'),
        idempotencyKey: `control-request:${seed}:${index}`,
        requestSha256: sha256(`control-request:${seed}:${index}`),
        expiresAt,
        createdAt,
      });
    }
  } finally {
    db.exec("ALTER TABLE chat_session_control_requests ENABLE TRIGGER trg_chat_session_control_requests_insert_guard");
  }
}

function readPostgresHeartbeatPreemptionEventCount(db: PostgresSyncDatabaseClient, sessionId: string): number {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM chat_session_control_events
       WHERE session_id = @sessionId AND reason_code = 'heartbeat_preempted'`,
    )
    .get<{ count: number }>({ sessionId })!.count;
}

function readPostgresCurrentControlGeneration(db: PostgresSyncDatabaseClient, sessionId: string): number {
  return db
    .prepare(
      `SELECT generation FROM chat_session_control_grants
       WHERE session_id = @sessionId AND is_current = 1`,
    )
    .get<{ generation: number }>({ sessionId })!.generation;
}

function assertPostgresPreemptionClockEquality(
  db: PostgresSyncDatabaseClient,
  input: {
    sessionId: string;
    oldGeneration: number;
    newGeneration: number;
    controlEventId: string;
    heartbeatAdmissionId: string;
    occurrenceId: string;
    durableRunId?: string;
  },
): void {
  const row = db
    .prepare(
      `SELECT
         (SELECT terminal_at FROM chat_session_control_grants
          WHERE session_id = @sessionId AND generation = @oldGeneration) AS old_grant_at,
         (SELECT created_at FROM chat_session_control_events
          WHERE event_id = @controlEventId) AS control_event_at,
         (SELECT created_at FROM chat_session_control_grants
          WHERE session_id = @sessionId AND generation = @newGeneration) AS new_grant_at,
         (SELECT closed_at FROM chat_session_mutation_admissions
          WHERE admission_id = @heartbeatAdmissionId) AS heartbeat_admission_at,
         (SELECT abandoned_at FROM chat_heartbeat_occurrences
          WHERE occurrence_id = @occurrenceId) AS occurrence_at,
         CASE WHEN CAST(@durableRunId AS TEXT) IS NULL THEN NULL ELSE
           (SELECT finished_at FROM durable_runs WHERE run_id = @durableRunId)
         END AS durable_run_at`,
    )
    .get<{
      old_grant_at: string | null;
      control_event_at: string | null;
      new_grant_at: string | null;
      heartbeat_admission_at: string | null;
      occurrence_at: string | null;
      durable_run_at: string | null;
    }>({
      sessionId: input.sessionId,
      oldGeneration: input.oldGeneration,
      newGeneration: input.newGeneration,
      controlEventId: input.controlEventId,
      heartbeatAdmissionId: input.heartbeatAdmissionId,
      occurrenceId: input.occurrenceId,
      durableRunId: input.durableRunId ?? null,
    });
  assert.ok(row);
  const timestamps = [
    row.old_grant_at,
    row.control_event_at,
    row.new_grant_at,
    row.heartbeat_admission_at,
    row.occurrence_at,
    ...(input.durableRunId ? [row.durable_run_at] : []),
  ];
  assert.equal(
    timestamps.every((value): value is string => typeof value === "string" && value.length > 0),
    true,
  );
  assert.equal(new Set(timestamps).size, 1);
}

function persistPostgresHeartbeatDecisionCommit(
  fixture: ReturnType<typeof createPostgresTerminalReadyHeartbeat>,
  notify: boolean,
): void {
  const rawOutput = notify
    ? JSON.stringify({ notify: true, message: "  Operator-visible heartbeat decision.  " })
    : JSON.stringify({ notify: false });
  const normalizedMessage = notify ? "Operator-visible heartbeat decision." : undefined;
  const receipt = {
    version: 1,
    occurrenceId: fixture.occurrence.occurrenceId,
    claimSha256: fixture.occurrence.claimSha256,
    rawOutputSha256: sha256(rawOutput),
    notify,
    normalizedMessageSha256: normalizedMessage ? sha256(normalizedMessage) : null,
  };
  writePostgresHeartbeatDecisionWindow(fixture, {
    metadata: { heartbeatDecisionRawOutput: rawOutput, heartbeatDecisionReceipt: receipt },
    completedTrace: true,
    ...(normalizedMessage ? { assistantMessage: normalizedMessage } : {}),
  });
}

function persistMalformedPostgresHeartbeatDecisionState(
  fixture: ReturnType<typeof createPostgresTerminalReadyHeartbeat>,
  fault:
    | "raw_only"
    | "receipt_drift"
    | "assistant_without_pair"
    | "completed_trace_without_pair"
    | "missing_trace_without_pair"
    | "drifted_trace_without_pair"
    | "approval_wait_without_pair"
    | "user_input_wait_without_pair"
    | "completion_null"
    | "completion_partial"
    | "completion_repaired"
    | "completion_extra"
    | "completion_malformed",
): void {
  const rawOutput = JSON.stringify({ notify: false });
  const receipt = {
    version: 1,
    occurrenceId: fixture.occurrence.occurrenceId,
    claimSha256: fixture.occurrence.claimSha256,
    rawOutputSha256: sha256(rawOutput),
    notify: false,
    normalizedMessageSha256: null,
  };
  if (
    fault === "assistant_without_pair" ||
    fault === "completed_trace_without_pair" ||
    fault === "missing_trace_without_pair" ||
    fault === "drifted_trace_without_pair" ||
    fault === "approval_wait_without_pair" ||
    fault === "user_input_wait_without_pair"
  ) {
    writePostgresHeartbeatDecisionWindow(fixture, {
      metadata: {},
      completedTrace: fault === "completed_trace_without_pair",
      ...(fault === "assistant_without_pair" ? { assistantMessage: "Unpaired heartbeat output." } : {}),
    });
    if (fault === "missing_trace_without_pair") {
      fixture.db.prepare("DELETE FROM chat_turn_traces WHERE turn_id = @turnId").run({
        turnId: fixture.occurrence.turnId,
      });
    } else if (fault === "drifted_trace_without_pair") {
      fixture.db
        .prepare("UPDATE chat_turn_traces SET session_id = @sessionId WHERE turn_id = @turnId")
        .run({ sessionId: `${fixture.fixture.sessionId}-drift`, turnId: fixture.occurrence.turnId });
    } else if (fault === "approval_wait_without_pair" || fault === "user_input_wait_without_pair") {
      fixture.db.prepare("UPDATE chat_turn_traces SET status = @status WHERE turn_id = @turnId").run({
        status: fault === "approval_wait_without_pair" ? "waiting_for_approval" : "waiting_for_user_input",
        turnId: fixture.occurrence.turnId,
      });
    }
    return;
  }
  writePostgresHeartbeatDecisionWindow(fixture, {
    metadata:
      fault === "raw_only"
        ? { heartbeatDecisionRawOutput: rawOutput }
        : {
            heartbeatDecisionRawOutput: rawOutput,
            heartbeatDecisionReceipt: fault === "receipt_drift" ? { ...receipt, claimSha256: "f".repeat(64) } : receipt,
          },
    completedTrace: true,
  });
  const completionJson =
    fault === "completion_null"
      ? null
      : fault === "completion_partial"
        ? JSON.stringify({ status: "complete" })
        : fault === "completion_repaired"
          ? JSON.stringify({ repaired: true, status: "complete" })
          : fault === "completion_extra"
            ? JSON.stringify({ finishReason: "stop", repaired: false, status: "complete" })
            : fault === "completion_malformed"
              ? "{"
              : undefined;
  if (completionJson !== undefined || fault === "completion_null") {
    fixture.db
      .prepare("UPDATE chat_turn_traces SET completion_json = @completionJson WHERE turn_id = @turnId")
      .run({ completionJson, turnId: fixture.occurrence.turnId });
  }
}

function writePostgresHeartbeatDecisionWindow(
  fixture: ReturnType<typeof createPostgresTerminalReadyHeartbeat>,
  input: {
    metadata: Record<string, unknown>;
    completedTrace: boolean;
    assistantMessage?: string;
  },
): void {
  const now = new Date().toISOString();
  const current = fixture.durableRuns.getRun(fixture.occurrence.durableRunId);
  fixture.durableRuns.updateRun({
    runId: current.runId,
    status: "running",
    metadata: { ...(current.metadata ?? {}), ...input.metadata },
    updatedAt: now,
    expectedVersion: current.version,
  });
  if (input.completedTrace) {
    fixture.db
      .prepare(
        `UPDATE chat_turn_traces
         SET status = 'completed', completion_json = @completionJson, finished_at = @finishedAt
         WHERE turn_id = @turnId`,
      )
      .run({
        completionJson: JSON.stringify({ repaired: false, status: "complete" }),
        finishedAt: now,
        turnId: fixture.occurrence.turnId,
      });
  }
  if (input.assistantMessage) {
    new ChatMessageRepository(fixture.db).upsert({
      messageId: fixture.occurrence.assistantMessageId,
      sessionId: fixture.fixture.sessionId,
      role: "assistant",
      actorType: "system",
      actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
      content: input.assistantMessage,
      timestamp: now,
    });
  }
}

function assertRawPostgresHeartbeatPreemptionEventGuard(
  db: PostgresSyncDatabaseClient,
  fixture: { workspaceId: string; sessionId: string },
  generation: number,
  seed: string,
): void {
  const createdAt = readPostgresNow(db);
  const eventSequence = db
    .prepare(
      `SELECT COALESCE(MAX(event_sequence), 0) + 1 AS sequence
         FROM chat_session_control_events WHERE session_id = @sessionId`,
    )
    .get<{ sequence: number }>({ sessionId: fixture.sessionId })!.sequence;
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO chat_session_control_events (
           event_id, workspace_id, session_id, event_sequence, request_id,
           previous_generation, next_generation, previous_owner_kind, next_owner_kind,
           previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
           companion_session_id, device_grant_id, idempotency_key, request_sha256,
           correlation_id, created_at
         ) VALUES (
           @eventId, @workspaceId, @sessionId, @eventSequence, NULL,
           @generation, @generation, 'operator', 'operator',
           'operator_active', 'operator_active', 'heartbeat_preempted', 'operator', @actorId,
           NULL, NULL, @idempotencyKey, @requestSha256, @correlationId, @createdAt
         )`,
        )
        .run({
          eventId: `invalid-heartbeat-event-${seed}`,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          eventSequence,
          generation,
          actorId: "operator-heartbeat",
          idempotencyKey: `invalid-heartbeat-event:${seed}`,
          requestSha256: sha256(`invalid-heartbeat-event:${seed}`),
          correlationId: `invalid-heartbeat-event:${seed}`,
          createdAt,
        }),
    /heartbeat preemption event invariant/iu,
  );
}

function assertRawPostgresHeartbeatPreemptionGrantGuard(db: PostgresSyncDatabaseClient, seed: string): void {
  const fixture = seedHeartbeatSession(db, seed);
  const transitionedAt = readPostgresNow(db);
  db.exec("ALTER TABLE chat_session_control_grants DISABLE TRIGGER trg_chat_session_control_grants_update_guard");
  try {
    db.prepare(
      `UPDATE chat_session_control_grants
       SET is_current = 0, lease_state = 'superseded', control_revision = control_revision + 1,
           updated_at = @transitionedAt, terminal_at = @transitionedAt
       WHERE workspace_id = @workspaceId AND session_id = @sessionId
         AND generation = 1 AND is_current = 1`,
    ).run({
      transitionedAt,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
    });
  } finally {
    db.exec("ALTER TABLE chat_session_control_grants ENABLE TRIGGER trg_chat_session_control_grants_update_guard");
  }
  const idempotencyKey = `invalid-heartbeat-grant:${seed}`;
  const requestSha256 = sha256(idempotencyKey);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO chat_session_control_grants (
           workspace_id, session_id, generation, is_current, owner_kind, lease_state,
           requested_capabilities_json, requested_capabilities_sha256,
           effective_capabilities_json, effective_capabilities_sha256,
           control_revision, transition_idempotency_key, transition_request_sha256,
           created_at, updated_at
         ) VALUES (
           @workspaceId, @sessionId, 2, 1, 'operator', 'operator_active',
           '[]', @emptyCapabilitiesSha256, '[]', @emptyCapabilitiesSha256,
           1, @idempotencyKey, @requestSha256, @createdAt, @createdAt
         )`,
        )
        .run({
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          emptyCapabilitiesSha256: sha256("[]"),
          idempotencyKey,
          requestSha256,
          createdAt: transitionedAt,
        }),
    /operator heartbeat-preemption generation lacks its exact event/iu,
  );
}

function readPostgresNow(db: PostgresSyncDatabaseClient): string {
  return db
    .prepare(
      `SELECT to_char(
         clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS now`,
    )
    .get<{ now: string }>()!.now;
}

function readAdmissionGuardDefinition(db: PostgresSyncDatabaseClient): string {
  return db
    .prepare("SELECT pg_get_functiondef(to_regprocedure('gc_session_mutation_admission_guard()')) AS definition")
    .get<{ definition: string }>()!.definition;
}

function assertExactHeartbeatCatalogAndGuard(db: PostgresSyncDatabaseClient): void {
  const definition = readAdmissionGuardDefinition(db);
  assert.match(definition, /heartbeat occurrence request-runtime reclaim/u);
  assert.match(
    definition,
    /gc_try_parse_timestamptz\(OLD\.runtime_lease_expires_at\)[\s\S]*<= gc_try_parse_timestamptz\(NEW\.runtime_last_heartbeat_at\)[\s\S]*gc_try_parse_timestamptz\(NEW\.runtime_lease_expires_at\)[\s\S]*= gc_try_parse_timestamptz\(NEW\.runtime_last_heartbeat_at\) \+ interval '60 seconds'[\s\S]*occurrence\.state = 'admitted'/u,
  );
  assert.match(
    definition,
    /occurrence\.frozen_request_sha256 = OLD\.material_sha256[\s\S]*occurrence\.aggregate_revision = OLD\.aggregate_revision[\s\S]*occurrence\.controller_generation = OLD\.controller_generation/u,
  );
  assert.match(
    definition,
    /gc_try_parse_timestamptz\(OLD\.runtime_lease_expires_at\) > clock_timestamp\(\)[\s\S]*NEW\.runtime_lease_revision = OLD\.runtime_lease_revision \+ 1/u,
  );
  const trigger = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pg_trigger trigger_row
       JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
       WHERE trigger_row.tgrelid = 'chat_session_mutation_admissions'::regclass
         AND trigger_row.tgname = 'trg_chat_session_mutation_admissions_guard'
         AND NOT trigger_row.tgisinternal
         AND function_row.proname = 'gc_session_mutation_admission_guard'`,
    )
    .get<{ count: number }>();
  assert.equal(trigger?.count, 1);
  const tableConstraint = db
    .prepare(
      `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'chat_heartbeat_occurrences'::regclass
         AND constraint_row.conname = 'gc_hbo_identity_shape'`,
    )
    .get<{ definition: string }>();
  assert.match(tableConstraint?.definition ?? "", /terminal_status[\s\S]*completed[\s\S]*failed[\s\S]*cancelled/u);
  assert.doesNotMatch(tableConstraint?.definition ?? "", /dead_lettered/u);
  assert.match(
    tableConstraint?.definition ?? "",
    /to_char\(\(?gc_try_parse_timestamptz\(claimed_at\)[\s\S]*claimed_at/u,
  );
  assert.match(
    tableConstraint?.definition ?? "",
    /to_char\(\(?gc_try_parse_timestamptz\(updated_at\)[\s\S]*updated_at/u,
  );
  const foreignKeys = db
    .prepare(
      `SELECT constraint_row.conname,
              constraint_row.condeferrable,
              constraint_row.condeferred,
              constraint_row.convalidated,
              constraint_row.confdeltype,
              constraint_row.confupdtype,
              pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'chat_heartbeat_occurrences'::regclass
         AND constraint_row.contype = 'f'
       ORDER BY constraint_row.conname`,
    )
    .all<{
      conname: string;
      condeferrable: boolean;
      condeferred: boolean;
      convalidated: boolean;
      confdeltype: string;
      confupdtype: string;
      definition: string;
    }>();
  assert.deepEqual(
    foreignKeys.map((foreignKey) => foreignKey.conname),
    [
      "fk_chat_heartbeat_occurrence_admission",
      "fk_chat_heartbeat_occurrence_capability_profile",
      "fk_chat_heartbeat_occurrence_durable_run",
    ],
  );
  for (const foreignKey of foreignKeys) {
    assert.equal(foreignKey.condeferrable, true);
    assert.equal(foreignKey.condeferred, true);
    assert.equal(foreignKey.convalidated, true);
    assert.equal(foreignKey.confdeltype, "a");
    assert.equal(foreignKey.confupdtype, "a");
    assert.match(foreignKey.definition, /DEFERRABLE INITIALLY DEFERRED/u);
  }
}

function stageOrphanProfileBinding(db: PostgresSyncDatabaseClient, seed: string): void {
  const constraint = db
    .prepare(
      `SELECT constraint_row.conname
       FROM pg_constraint constraint_row
       WHERE constraint_row.contype = 'f'
         AND constraint_row.conrelid = 'chat_turn_capability_profile_incarnation_bindings'::regclass
         AND constraint_row.confrelid = 'chat_turn_capability_profiles'::regclass`,
    )
    .get<{ conname: string }>();
  assert.ok(constraint?.conname);
  const quotedConstraint = `"${constraint.conname.replaceAll('"', '""')}"`;
  db.exec(`ALTER TABLE chat_turn_capability_profile_incarnation_bindings DROP CONSTRAINT ${quotedConstraint}`);
  const workspaceId = `orphan-workspace-${seed}`;
  const sessionId = `orphan-session-${seed}`;
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-orphan-upgrade",
    idempotencyKey: `lifecycle:init:orphan:${seed}`,
    correlationId: `correlation:lifecycle:init:orphan:${seed}`,
  });
  const admission = new SessionMutationAdmissionRepository(db).admit({
    workspaceId,
    sessionId,
    turnId: `orphan-turn-${seed}`,
    runtimeOwnerId: `orphan-runtime-${seed}`,
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator-orphan-upgrade",
    operation: "chat.turn.execute",
    materialSha256: sha256(`orphan-admission-material-${seed}`),
    idempotencyKey: `admission:orphan:${seed}`,
    correlationId: `correlation:admission:orphan:${seed}`,
  }).admission;
  const turnId = admission.turnId!;
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_turn_capability_profile_incarnation_bindings (
       profile_id, turn_id, profile_hash, created_at
     ) VALUES (@profileId, @turnId, @profileHash, @createdAt)`,
  ).run({
    profileId: `orphan-profile-${seed}`,
    turnId,
    profileHash: sha256(`orphan-profile-${seed}`),
    createdAt,
  });
}

function cleanupOrphanProfileBinding(db: PostgresSyncDatabaseClient, seed: string): void {
  db.exec(
    "ALTER TABLE chat_turn_capability_profile_incarnation_bindings DISABLE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_no_delete",
  );
  try {
    db.prepare("DELETE FROM chat_turn_capability_profile_incarnation_bindings WHERE profile_id = @profileId").run({
      profileId: `orphan-profile-${seed}`,
    });
  } finally {
    db.exec(
      "ALTER TABLE chat_turn_capability_profile_incarnation_bindings ENABLE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_no_delete",
    );
  }
}

function assertRawOccurrenceGuards(
  db: PostgresSyncDatabaseClient,
  source: HeartbeatOccurrenceRecord,
  invalidFixture: ReturnType<typeof seedHeartbeatSession>,
): void {
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO chat_heartbeat_occurrences (
           occurrence_id, workspace_id, session_id, session_incarnation_id,
           admission_id, admission_request_sha256, admission_idempotency_key,
           admission_correlation_id, runtime_owner_id, system_actor_id,
           admission_material_sha256, evaluated_policy_sha256, frozen_request_sha256,
           frozen_objective_sha256, claim_sha256, aggregate_revision, controller_generation,
           prior_last_proactive_at, prior_last_proactive_run_id,
           heartbeat_interval_seconds, cooldown_seconds, idle_floor_seconds,
           observed_session_activity_at, user_message_id, assistant_message_id, turn_id,
           expected_durable_run_id, durable_run_id, capability_profile_id, capability_profile_hash,
           state, revision, claimed_at, durable_bound_at, terminal_at, abandoned_at,
           terminal_status, terminal_handoff_sha256, abandonment_reason, updated_at
         )
         SELECT
           @occurrenceId, @workspaceId, @sessionId, @sessionIncarnationId,
           @admissionId, source.admission_request_sha256, @admissionIdempotencyKey,
           @admissionCorrelationId, @runtimeOwnerId, source.system_actor_id,
           source.admission_material_sha256, source.evaluated_policy_sha256, source.frozen_request_sha256,
           source.frozen_objective_sha256, @claimSha256, @aggregateRevision, source.controller_generation,
           NULL, NULL, source.heartbeat_interval_seconds, source.cooldown_seconds, source.idle_floor_seconds,
           source.observed_session_activity_at, @userMessageId, @assistantMessageId, @turnId,
           @durableRunId, NULL, NULL, NULL,
           'admitted', 1, source.claimed_at, NULL, NULL, NULL,
           NULL, NULL, NULL, source.claimed_at
         FROM chat_heartbeat_occurrences source
         WHERE source.occurrence_id = @sourceOccurrenceId`,
        )
        .run({
          occurrenceId: `raw-occurrence-${invalidFixture.sessionId}`,
          workspaceId: invalidFixture.workspaceId,
          sessionId: invalidFixture.sessionId,
          sessionIncarnationId: invalidFixture.sessionIncarnationId,
          admissionId: `raw-admission-${invalidFixture.sessionId}`,
          admissionIdempotencyKey: `raw-admission-idempotency-${invalidFixture.sessionId}`,
          admissionCorrelationId: `raw-admission-correlation-${invalidFixture.sessionId}`,
          runtimeOwnerId: `raw-runtime-${invalidFixture.sessionId}`,
          claimSha256: sha256(`raw-claim-${invalidFixture.sessionId}`),
          aggregateRevision: invalidFixture.aggregateRevision,
          userMessageId: `raw-user-${invalidFixture.sessionId}`,
          assistantMessageId: `raw-assistant-${invalidFixture.sessionId}`,
          turnId: `raw-turn-${invalidFixture.sessionId}`,
          durableRunId: `raw-run-${invalidFixture.sessionId}`,
          sourceOccurrenceId: source.occurrenceId,
        }),
    /heartbeat occurrence admission or cadence invariant/iu,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE chat_heartbeat_occurrences
         SET frozen_objective_sha256 = @frozenObjectiveSha256
         WHERE occurrence_id = @occurrenceId`,
        )
        .run({ occurrenceId: source.occurrenceId, frozenObjectiveSha256: "f".repeat(64) }),
    /heartbeat occurrence transition invariant/iu,
  );
  assert.throws(
    () =>
      db.prepare("DELETE FROM chat_heartbeat_occurrences WHERE occurrence_id = @occurrenceId").run({
        occurrenceId: source.occurrenceId,
      }),
    /append\/transition-only/iu,
  );
}

function proveDeferredProfileBindBeforeProfileCommit(
  db: PostgresSyncDatabaseClient,
  occurrence: HeartbeatOccurrenceRecord,
  seed: string,
): void {
  const profileId = `deferred-profile-${seed}`;
  const profileHash = sha256(`deferred-profile-hash-${seed}`);
  const createdAt = new Date().toISOString();
  db.transaction("immediate", () => {
    db.prepare(
      `INSERT INTO chat_turn_capability_profile_incarnation_bindings (
         profile_id, turn_id, profile_hash, created_at
       ) VALUES (@profileId, @turnId, @profileHash, @createdAt)`,
    ).run({ profileId, turnId: occurrence.turnId, profileHash, createdAt });
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_turn_capability_profiles WHERE profile_id = @profileId")
        .get<{ count: number }>({ profileId })?.count,
      0,
    );
    db.prepare(
      `INSERT INTO chat_turn_capability_profiles (
         profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
         schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
         selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
       ) VALUES (
         @profileId, @turnId, @sessionId, @workspaceId, @durableRunId, NULL, NULL,
         'chat.turn.capability-profile.v1', @profileHash, @snapshotId, @profileHash, @profileHash,
         @profileHash, @profileHash, @profileHash, '{}', @createdAt
       )`,
    ).run({
      profileId,
      turnId: occurrence.turnId,
      sessionId: occurrence.sessionId,
      workspaceId: occurrence.workspaceId,
      durableRunId: occurrence.durableRunId,
      profileHash,
      snapshotId: `deferred-snapshot-${seed}`,
      createdAt,
    });
  });
  assert.deepEqual(
    db
      .prepare(
        `SELECT binding.profile_id, binding.turn_id, binding.profile_hash
         FROM chat_turn_capability_profile_incarnation_bindings binding
         WHERE binding.profile_id = @profileId`,
      )
      .get<{ profile_id: string; turn_id: string; profile_hash: string }>({ profileId }),
    { profile_id: profileId, turn_id: occurrence.turnId, profile_hash: profileHash },
  );
}

function seedHeartbeatSession(db: PostgresSyncDatabaseClient, seed: string) {
  const workspaceId = `workspace-hb-${seed}`;
  const sessionId = `session-hb-${seed}`;
  const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-heartbeat",
    idempotencyKey: `lifecycle:init:${seed}`,
    correlationId: `correlation:lifecycle:init:${seed}`,
  });
  const activityAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
  new SessionRepository(db).upsert({
    sessionId,
    sessionKey: `session-key-hb-${seed}`,
    kind: "dm",
    channel: "test",
    account: "operator-heartbeat",
    timestamp: activityAt,
  });
  const prefs = new SessionAutonomyPrefsRepository(db);
  prefs.ensure(sessionId);
  const configured = prefs.patch(sessionId, {
    heartbeatEnabled: true,
    heartbeatIntervalSeconds: 900,
    cooldownSeconds: 0,
    activeHours: { start: 0, end: 0 },
  });
  const request = { content: `Read-only heartbeat ${seed}` };
  const frozenRequestSha256 = sha256(canonicalJsonString({ version: 2, request }));
  const claimInput: ClaimHeartbeatOccurrenceInput = {
    workspaceId,
    sessionId,
    expectedPriorCadence: {},
    evaluatedPolicySha256: sha256(`policy:${seed}`),
    frozenRequestSha256,
    frozenObjectiveSha256: sha256(`objective:${seed}`),
    idleFloorSeconds: 0,
  };
  return {
    workspaceId,
    sessionId,
    sessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    aggregateRevision: configured.revision,
    request,
    claimInput,
  };
}

function claimHeartbeat(
  db: PostgresSyncDatabaseClient,
  fixture: ReturnType<typeof seedHeartbeatSession>,
): HeartbeatOccurrenceRecord {
  const admissions = new SessionMutationAdmissionRepository(db);
  const outcome = new HeartbeatOccurrenceRepository(db).claim(fixture.claimInput, (request) => ({
    admission: admissions.admit(request.admissionInput).admission,
    child: request.child,
  }));
  assert.equal(outcome.disposition, "created");
  if (outcome.disposition !== "created") throw new Error(`expected created occurrence, got ${outcome.disposition}`);
  return outcome.occurrence;
}

function createPostgresTerminalReadyHeartbeat(db: PostgresSyncDatabaseClient, seed: string, settleTerminal = true) {
  const fixture = seedHeartbeatSession(db, seed);
  const occurrence = claimHeartbeat(db, fixture);
  const admissions = new SessionMutationAdmissionRepository(db);
  const occurrences = new HeartbeatOccurrenceRepository(db);
  const profileId = `profile-hb-${seed}`;
  const profileHash = sha256(`profile:${seed}`);
  const createdAt = new Date().toISOString();
  db.transaction("immediate", () => {
    admissions.bindCapabilityProfile({
      admissionId: occurrence.admissionId,
      workspaceId: occurrence.workspaceId,
      sessionId: occurrence.sessionId,
      sessionIncarnationId: occurrence.sessionIncarnationId,
      turnId: occurrence.turnId,
      profileId,
      profileHash,
      createdAt,
      requestRuntimeClaim: { runtimeOwnerId: occurrence.runtimeOwnerId, leaseRevision: 1 },
    });
    db.prepare(
      `INSERT INTO chat_turn_capability_profiles (
         profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
         schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
         selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
       ) VALUES (
         @profileId, @turnId, @sessionId, @workspaceId, @durableRunId, NULL, NULL,
         'chat.turn.capability-profile.v1', @profileHash, @snapshotId, @profileHash, @profileHash,
         @profileHash, @profileHash, @profileHash, '{}', @createdAt
       )`,
    ).run({
      profileId,
      turnId: occurrence.turnId,
      sessionId: occurrence.sessionId,
      workspaceId: occurrence.workspaceId,
      durableRunId: occurrence.durableRunId,
      profileHash,
      snapshotId: `snapshot-hb-${seed}`,
      createdAt,
    });
  });
  const payload = {
    version: "chat.turn.execute.v2",
    heartbeatOccurrenceId: occurrence.occurrenceId,
    heartbeatClaimSha256: occurrence.claimSha256,
    heartbeatEvaluatedPolicySha256: occurrence.evaluatedPolicySha256,
    heartbeatFrozenObjectiveSha256: occurrence.frozenObjectiveSha256,
    admissionId: occurrence.admissionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    admissionMaterialSha256: occurrence.admissionMaterialSha256,
    workspaceId: occurrence.workspaceId,
    admissionAggregateRevision: occurrence.aggregateRevision,
    admissionControllerGeneration: occurrence.controllerGeneration,
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({
        version: 1,
        admissionMaterialSha256: occurrence.admissionMaterialSha256,
        request: fixture.request,
      }),
    ),
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: occurrence.durableRunId },
    requestActor: { actorKind: "system", actorId: HEARTBEAT_SYSTEM_ACTOR_ID },
    sessionId: occurrence.sessionId,
    turnId: occurrence.turnId,
    userMessageId: occurrence.userMessageId,
    assistantMessageId: occurrence.assistantMessageId,
    capabilityProfileId: profileId,
    capabilityProfileHash: profileHash,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: fixture.request,
    userInputResponses: [],
  };
  const durableRuns = new DurableRunRepository(db);
  durableRuns.createRun({
    runId: occurrence.durableRunId,
    workflowKey: "chat.turn.execute",
    payload,
    metadata: {},
    now: createdAt,
  });
  db.prepare(
    `INSERT INTO chat_turn_traces (
       turn_id, session_id, user_message_id, assistant_message_id, status, mode,
       web_mode, memory_mode, thinking_level, routing_json, started_at
     ) VALUES (
       @turnId, @sessionId, @userMessageId, @assistantMessageId, 'queued', 'chat',
       'off', 'off', 'standard', '{}', @startedAt
     )`,
  ).run({
    turnId: occurrence.turnId,
    sessionId: occurrence.sessionId,
    userMessageId: occurrence.userMessageId,
    assistantMessageId: occurrence.assistantMessageId,
    startedAt: createdAt,
  });
  admissions.bindDurableRun({
    admissionId: occurrence.admissionId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    turnId: occurrence.turnId,
    durableRunId: occurrence.durableRunId,
    requestRuntimeClaim: { runtimeOwnerId: occurrence.runtimeOwnerId, leaseRevision: 1 },
  });
  const boundIdentity = {
    occurrenceId: occurrence.occurrenceId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    admissionId: occurrence.admissionId,
    turnId: occurrence.turnId,
    durableRunId: occurrence.durableRunId,
    capabilityProfileId: profileId,
    capabilityProfileHash: profileHash,
  };
  occurrences.markDurableBound(boundIdentity);
  const boundFixture = {
    db,
    fixture,
    occurrence,
    admissions,
    occurrences,
    profileId,
    profileHash,
    payload,
    durableRuns,
    boundIdentity,
  };
  if (!settleTerminal) return boundFixture;

  const committedAt = new Date().toISOString();
  const postCommitGenerationId = `generation-${occurrence.occurrenceId}`;
  const postCommitEligibility = {
    version: 1 as const,
    autonomyEnabledAtParentSettlement: false,
    evalIntegrityTurn: false,
    humanSession: false,
  };
  const outputText = "Canonical heartbeat completion.";
  const outputSummary = "Canonical heartbeat completion.";
  const heartbeatDecisionRawOutput = JSON.stringify({ notify: true, message: `  ${outputText}  ` });
  const heartbeatDecisionReceipt = {
    version: 1,
    occurrenceId: occurrence.occurrenceId,
    claimSha256: occurrence.claimSha256,
    rawOutputSha256: sha256(heartbeatDecisionRawOutput),
    notify: true,
    normalizedMessageSha256: sha256(outputText),
  };
  const authorityMaterial = {
    version: "chat.turn.runtime-authority.v1",
    runId: occurrence.durableRunId,
    turnId: occurrence.turnId,
    transitionKind: "terminal",
    durableStatus: "completed",
    traceStatus: "completed",
    transitionAt: committedAt,
    postCommitGenerationId,
    postCommitEligibility,
    waitForEvent: null,
    terminalOutput: {
      assistantMessageId: occurrence.assistantMessageId,
      outputTextSha256: sha256(canonicalJsonString(outputText)),
      outputSummarySha256: sha256(canonicalJsonString(outputSummary)),
    },
    linkedFinalization: null,
    requiredFinalizers: ["autonomous", "general"],
    heartbeatDecisionReceipt,
  };
  const chatTurnRuntimeAuthority = {
    material: authorityMaterial,
    materialSha256: sha256(canonicalJsonString(authorityMaterial)),
  };
  const childRunIds: string[] = [];
  const autonomous = {
    kind: "heartbeat",
    systemActorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    sourceRunId: `source-${occurrence.occurrenceId}`,
    reason: `heartbeat self-wake:${occurrence.sessionId}`,
    deliverMode: "on_notify",
  };
  const autonomousAdmissionMaterial = {
    version: "chat.autonomous.admission.v1",
    identity: {
      userMessageId: occurrence.userMessageId,
      turnId: occurrence.turnId,
      assistantMessageId: occurrence.assistantMessageId,
      durableRunId: occurrence.durableRunId,
    },
    sessionId: occurrence.sessionId,
    objectiveSha256: sha256(canonicalJsonString(fixture.request.content)),
    autonomous,
    admission: {
      admissionId: occurrence.admissionId,
      sessionIncarnationId: occurrence.sessionIncarnationId,
      workspaceId: occurrence.workspaceId,
      admissionMaterialSha256: occurrence.admissionMaterialSha256,
      effectiveRequestMaterialSha256: payload.effectiveRequestMaterialSha256,
    },
    capability: {
      profileId,
      profileHash,
      snapshotId: `snapshot-hb-${seed}`,
    },
    cronAdmission: null,
  };
  const autonomousAdmission = {
    material: autonomousAdmissionMaterial,
    materialSha256: sha256(canonicalJsonString(autonomousAdmissionMaterial)),
  };
  const current = durableRuns.getRun(occurrence.durableRunId);
  durableRuns.updateRun({
    runId: occurrence.durableRunId,
    status: "completed",
    finishedAt: committedAt,
    clearLease: true,
    metadata: {
      objective: fixture.request.content,
      autonomous,
      capabilityProfileId: profileId,
      capabilityProfileHash: profileHash,
      chatTurnRuntimeAuthority,
      autonomousAdmission,
      autonomousChatPostCommit: {
        delivery: { status: "skipped", reason: "not_required" },
        heartbeatCleanup: { status: "not_required" },
        generationId: postCommitGenerationId,
        requestedAt: committedAt,
        completedAt: committedAt,
      },
      generalChatPostCommit: {
        generationId: postCommitGenerationId,
        traceStatus: "completed",
        requestedAt: committedAt,
        postCommitEligibility,
        parentLocalEffectsStatus: "settled",
        parentLocalEffectsSettledAt: committedAt,
        completedEffects: [],
        durableEffectRunIds: {},
        durableEffectOutcomes: {},
        childOutcomeAuthority: "child_durable_runs",
        settlementStatus: "completed",
        completedAt: committedAt,
      },
      chatTurnAdmissionHandoff: {
        version: 1,
        admissionId: occurrence.admissionId,
        sessionIncarnationId: occurrence.sessionIncarnationId,
        turnId: occurrence.turnId,
        parentRunId: occurrence.durableRunId,
        postCommitGenerationId,
        parentLocalEffectsStatus: "settled",
        childRunIds,
        childRunIdsSha256: sha256(canonicalJsonString(childRunIds)),
        committedAt,
      },
      heartbeatDecisionRawOutput,
      heartbeatDecisionReceipt,
      outputText,
      finalOutput: outputText,
      outputSummary,
      finalSummary: outputSummary,
    },
    updatedAt: committedAt,
    expectedVersion: current.version,
  });
  durableRuns.createCheckpoint({
    checkpointId: `checkpoint-${occurrence.occurrenceId}-completed`,
    runId: occurrence.durableRunId,
    checkpointKind: "run_completed",
    state: {
      chatTurnRuntimeAuthority,
      heartbeatDecisionRawOutput,
      heartbeatDecisionReceipt,
      assistantMessageId: occurrence.assistantMessageId,
      outputText,
      outputSummary,
    },
    createdAt: committedAt,
  });
  new ChatMessageRepository(db).upsert({
    messageId: occurrence.assistantMessageId,
    sessionId: occurrence.sessionId,
    role: "assistant",
    actorType: "system",
    actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    content: outputText,
    timestamp: committedAt,
  });
  db.prepare(
    `UPDATE chat_turn_traces
     SET status = 'completed', finished_at = @finishedAt, durable_json = @durableJson
     WHERE turn_id = @turnId`,
  ).run({
    finishedAt: committedAt,
    durableJson: JSON.stringify({
      runId: occurrence.durableRunId,
      status: "completed",
      checkpointKind: "run_completed",
    }),
    turnId: occurrence.turnId,
  });
  admissions.closeTurnWrite({
    admissionId: occurrence.admissionId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    turnId: occurrence.turnId,
    status: "completed",
    actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    idempotencyKey: `close:${occurrence.occurrenceId}`,
    correlationId: occurrence.durableRunId,
  });
  return boundFixture;
}

function readPostgresRunMetadata(db: PostgresSyncDatabaseClient, runId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT metadata_json FROM durable_runs WHERE run_id = @runId")
    .get<{ metadata_json: string }>({ runId });
  assert.ok(row);
  return JSON.parse(row.metadata_json) as Record<string, unknown>;
}

function writePostgresRunMetadata(
  db: PostgresSyncDatabaseClient,
  runId: string,
  metadata: Record<string, unknown>,
): void {
  db.prepare("UPDATE durable_runs SET metadata_json = @metadataJson WHERE run_id = @runId").run({
    runId,
    metadataJson: JSON.stringify(metadata),
  });
}

function rawPostgresTerminalTransition(
  db: PostgresSyncDatabaseClient,
  fixture: ReturnType<typeof createPostgresTerminalReadyHeartbeat>,
): void {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `UPDATE chat_heartbeat_occurrences
     SET state = 'terminal', terminal_at = @updatedAt, terminal_status = 'completed',
         terminal_handoff_sha256 = @handoffSha256, updated_at = @updatedAt, revision = revision + 1
     WHERE occurrence_id = @occurrenceId`,
  ).run({
    occurrenceId: fixture.occurrence.occurrenceId,
    handoffSha256: sha256(`raw-terminal:${fixture.occurrence.occurrenceId}`),
    updatedAt,
  });
}

function countRows(db: PostgresSyncDatabaseClient, table: string, sessionId: string): number {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = @sessionId`)
    .get<{ count: number }>({ sessionId })!.count;
}

function forcePostgresAdmissionLeaseExpired(db: PostgresSyncDatabaseClient, admissionId: string): void {
  db.exec("ALTER TABLE chat_session_mutation_admissions DISABLE TRIGGER trg_chat_session_mutation_admissions_guard");
  try {
    db.prepare(
      `UPDATE chat_session_mutation_admissions
       SET runtime_last_heartbeat_at = to_char(
             clock_timestamp() AT TIME ZONE 'UTC' - INTERVAL '2 seconds',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ),
           runtime_lease_expires_at = to_char(
             clock_timestamp() AT TIME ZONE 'UTC' - INTERVAL '1 second',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
       WHERE admission_id = @admissionId`,
    ).run({ admissionId });
  } finally {
    db.exec("ALTER TABLE chat_session_mutation_admissions ENABLE TRIGGER trg_chat_session_mutation_admissions_guard");
  }
}

function forcePostgresLegacyNullLifecycleIntent(db: PostgresSyncDatabaseClient, sessionId: string): void {
  forcePostgresLifecycleIntent(db, sessionId, null);
}

function forcePostgresLifecycleIntent(
  db: PostgresSyncDatabaseClient,
  sessionId: string,
  lifecycleIntentId: string | null,
): void {
  db.exec("ALTER TABLE chat_session_meta DISABLE TRIGGER trg_chat_session_meta_lifecycle_guard");
  try {
    db.prepare(
      "UPDATE chat_session_meta SET lifecycle_intent_id = @lifecycleIntentId WHERE session_id = @sessionId",
    ).run({ lifecycleIntentId, sessionId });
  } finally {
    db.exec("ALTER TABLE chat_session_meta ENABLE TRIGGER trg_chat_session_meta_lifecycle_guard");
  }
}

function toReclaimInput(occurrence: HeartbeatOccurrenceRecord, expectedLeaseRevision: number) {
  return {
    occurrenceId: occurrence.occurrenceId,
    admissionId: occurrence.admissionId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    turnId: occurrence.turnId,
    runtimeOwnerId: occurrence.runtimeOwnerId,
    expectedLeaseRevision,
    actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    operation: HEARTBEAT_ADMISSION_OPERATION,
    materialSha256: occurrence.admissionMaterialSha256,
    idempotencyKey: occurrence.admissionIdempotencyKey,
    correlationId: occurrence.admissionCorrelationId,
    admissionRequestSha256: occurrence.admissionRequestSha256,
    expectedDurableRunId: occurrence.durableRunId,
    userMessageId: occurrence.userMessageId,
    assistantMessageId: occurrence.assistantMessageId,
    evaluatedPolicySha256: occurrence.evaluatedPolicySha256,
    frozenRequestSha256: occurrence.frozenRequestSha256,
    frozenObjectiveSha256: occurrence.frozenObjectiveSha256,
    claimSha256: occurrence.claimSha256,
  };
}

interface HeartbeatWorkerResult {
  ok: boolean;
  disposition?: "created" | "replayed" | "reclaimed" | "live" | "durable_bound" | "closed_or_authority_drift";
  occurrenceId?: string;
  leaseRevision?: number;
  error?: string;
}

async function runPostgresHeartbeatReclaimRace(
  scopedConnectionString: string,
  database: string,
  schemaName: string,
  reclaimInput: ReturnType<typeof toReclaimInput>,
): Promise<[HeartbeatWorkerResult, HeartbeatWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = ["left", "right"].map((contender) =>
    runPostgresHeartbeatReclaimWorker(
      scopedConnectionString,
      database,
      schemaName,
      reclaimInput,
      contender,
      startSignal,
    ),
  ) as [ReturnType<typeof runPostgresHeartbeatReclaimWorker>, ReturnType<typeof runPostgresHeartbeatReclaimWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[HeartbeatWorkerResult, HeartbeatWorkerResult]>;
}

async function runPostgresHeartbeatClaimRace(
  scopedConnectionString: string,
  database: string,
  schemaName: string,
  claimInput: ClaimHeartbeatOccurrenceInput,
): Promise<[HeartbeatWorkerResult, HeartbeatWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = ["left", "right"].map((contender) =>
    runPostgresHeartbeatWorker(scopedConnectionString, database, schemaName, claimInput, contender, startSignal),
  ) as [ReturnType<typeof runPostgresHeartbeatWorker>, ReturnType<typeof runPostgresHeartbeatWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[HeartbeatWorkerResult, HeartbeatWorkerResult]>;
}

function runPostgresHeartbeatWorker(
  scopedConnectionString: string,
  database: string,
  schemaName: string,
  claimInput: ClaimHeartbeatOccurrenceInput,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<HeartbeatWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(POSTGRES_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString: scopedConnectionString,
        database,
        applicationName: `hx411-hbo-worker-${contender}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      schemaName,
      mode: "claim",
      claimInput,
      contender,
      startSignal,
      heartbeatModuleUrl: new URL(`./heartbeat-occurrence-repo${extension}`, import.meta.url).href,
      admissionModuleUrl: new URL(`./session-mutation-admission-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: HeartbeatWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<HeartbeatWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: HeartbeatWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`PostgreSQL heartbeat worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

function runPostgresHeartbeatReclaimWorker(
  scopedConnectionString: string,
  database: string,
  schemaName: string,
  reclaimInput: ReturnType<typeof toReclaimInput>,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<HeartbeatWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(POSTGRES_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString: scopedConnectionString,
        database,
        applicationName: `hx411-hbo-reclaim-worker-${contender}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      schemaName,
      mode: "reclaim",
      reclaimInput,
      contender,
      startSignal,
      heartbeatModuleUrl: new URL(`./heartbeat-occurrence-repo${extension}`, import.meta.url).href,
      admissionModuleUrl: new URL(`./session-mutation-admission-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: HeartbeatWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<HeartbeatWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: HeartbeatWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`PostgreSQL heartbeat reclaim worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const POSTGRES_HEARTBEAT_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { HeartbeatOccurrenceRepository } = await tsImport(
        workerData.heartbeatModuleUrl,
        workerData.heartbeatModuleUrl,
      );
      const { SessionMutationAdmissionRepository } = await tsImport(
        workerData.admissionModuleUrl,
        workerData.admissionModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      parentPort.postMessage({ kind: "ready" });
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const admissions = new SessionMutationAdmissionRepository(db);
      const outcome = workerData.mode === "reclaim"
        ? admissions.reclaimExpiredSystemTurnWriteRequestLease(workerData.reclaimInput)
        : new HeartbeatOccurrenceRepository(db).claim(workerData.claimInput, (request) => ({
            admission: admissions.admit(request.admissionInput).admission,
            child: request.child,
          }));
      parentPort.postMessage({
        kind: "result",
        result: {
          ok: workerData.mode === "reclaim"
            ? outcome.disposition === "reclaimed" || outcome.disposition === "live"
            : outcome.disposition === "created" || outcome.disposition === "replayed",
          disposition: outcome.disposition,
          occurrenceId: outcome.occurrence && outcome.occurrence.occurrenceId,
          leaseRevision: outcome.admission && outcome.admission.runtimeLeaseRevision,
        },
      });
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (db) db.close();
    }
  })();
`;

class RunHookDatabaseClient implements DatabaseClient {
  public readonly dialect: DatabaseClient["dialect"];
  public hookCount = 0;

  public constructor(
    private readonly delegate: DatabaseClient,
    private readonly matches: (sql: string) => boolean,
    private readonly hook: () => void,
  ) {
    this.dialect = delegate.dialect;
  }

  public prepare(sql: string): DbStatement {
    const statement = this.delegate.prepare(sql);
    if (!this.matches(sql)) return statement;
    return {
      run: (...params: DbBindParams[]) => {
        if (this.hookCount === 0) {
          this.hookCount += 1;
          this.hook();
        }
        return statement.run(...params);
      },
      get: <T>(...params: DbBindParams[]) => statement.get<T>(...params),
      all: <T>(...params: DbBindParams[]) => statement.all<T>(...params),
    };
  }

  public exec(sql: string): void {
    this.delegate.exec(sql);
  }

  public close(): void {
    this.delegate.close();
  }

  public transaction<T>(mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return this.delegate.transaction(mode, callback);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
