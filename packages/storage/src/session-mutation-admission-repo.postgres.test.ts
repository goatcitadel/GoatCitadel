import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { Pool } from "pg";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { DurableRunEventRepository } from "./durable-run-event-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { SessionControlRepository } from "./session-control-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = connectionString ? it : it.skip;

describe("SessionMutationAdmissionRepository live PostgreSQL", () => {
  postgresIt(
    "admits one durable turn across workers and recovers its exact active evidence after restart",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_admission_${suffix}`;
      const sessionId = `session-${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      let setupDb: PostgresSyncDatabaseClient | undefined = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx411-admission-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        setupDb.exec(`SET search_path TO ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        new ChatSessionLifecycleRepository(setupDb).initialize({
          workspaceId: "workspace-a",
          sessionId,
          actorId: "operator-a",
          idempotencyKey: `lifecycle:init:${sessionId}`,
          correlationId: `correlation:lifecycle:init:${sessionId}`,
        });

        const race = await runPostgresAdmissionRace(scopedUrl.toString(), database, schemaName, sessionId, [
          "left",
          "right",
        ]);
        assert.equal(race.filter((result) => result.ok).length, 1, JSON.stringify(race));
        assert.equal(race.filter((result) => !result.ok).length, 1, JSON.stringify(race));
        const winningId = race.find((result) => result.ok)?.admissionId;
        assert.ok(winningId);
        assert.equal(
          setupDb
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_mutation_admissions
               WHERE session_id = @sessionId AND admission_kind = 'turn_write' AND status = 'active'`,
            )
            .get<{ count: number }>({ sessionId })!.count,
          1,
        );
        assert.equal(
          setupDb
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_mutation_admission_events
               WHERE session_id = @sessionId AND event_type = 'admitted'`,
            )
            .get<{ count: number }>({ sessionId })!.count,
          1,
        );

        setupDb.close();
        setupDb = undefined;
        const recoveredDb = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database,
          applicationName: `hx411-admission-recovery-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        try {
          recoveredDb.exec(`SET search_path TO ${schemaName}`);
          const recovered = new SessionMutationAdmissionRepository(recoveredDb);
          assert.equal(recovered.require(winningId).status, "active");
          assert.deepEqual(
            recovered.listActive("workspace-a", sessionId).map((record) => record.admissionId),
            [winningId],
          );
          const active = recovered.require(winningId);
          const capabilityBinding = {
            admissionId: active.admissionId,
            workspaceId: active.workspaceId,
            sessionId: active.sessionId,
            sessionIncarnationId: active.sessionIncarnationId,
            turnId: active.turnId!,
            profileId: `profile-${suffix}`,
            profileHash: "e".repeat(64),
            createdAt: "2026-07-15T00:00:00.000Z",
          };
          recoveredDb.transaction("immediate", () => {
            recovered.bindCapabilityProfile({
              ...capabilityBinding,
              requestRuntimeClaim: {
                runtimeOwnerId: active.runtimeOwnerId!,
                leaseRevision: active.runtimeLeaseRevision!,
              },
            });
            recoveredDb
              .prepare(
                `INSERT INTO chat_turn_capability_profiles (
                   profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
                   schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
                   selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
                 ) VALUES (
                   @profileId, @turnId, @sessionId, @workspaceId, NULL, NULL, NULL,
                   'chat.turn.capability-profile.v1', @profileHash, @snapshotId, @profileHash, @profileHash,
                   @profileHash, @profileHash, @profileHash, '{}', @createdAt
                 )`,
              )
              .run({
                profileId: capabilityBinding.profileId,
                turnId: capabilityBinding.turnId,
                sessionId: capabilityBinding.sessionId,
                workspaceId: capabilityBinding.workspaceId,
                profileHash: capabilityBinding.profileHash,
                createdAt: capabilityBinding.createdAt,
                snapshotId: `snapshot-${suffix}`,
              });
          });
          assert.equal(recovered.requireCapabilityProfileBinding(capabilityBinding).admission.status, "active");
          assert.throws(() =>
            recovered.requireCapabilityProfileBinding({ ...capabilityBinding, profileHash: "f".repeat(64) }),
          );
          const closed = recovered.closeTurnWrite({
            admissionId: winningId,
            workspaceId: active.workspaceId,
            sessionId: active.sessionId,
            sessionIncarnationId: active.sessionIncarnationId,
            turnId: active.turnId!,
            status: "cancelled",
            actorId: "recovery-owner",
            idempotencyKey: `admission:${sessionId}:recovery-cancelled`,
            correlationId: `correlation:admission:${sessionId}:recovery-cancelled`,
            requestRuntimeClaim: {
              runtimeOwnerId: active.runtimeOwnerId!,
              leaseRevision: active.runtimeLeaseRevision!,
            },
          });
          assert.equal(closed.status, "cancelled");
          assert.equal(recovered.requireCapabilityProfileBinding(capabilityBinding).admission.status, "cancelled");
          assert.equal(
            recovered.closeTurnWrite({
              admissionId: winningId,
              workspaceId: active.workspaceId,
              sessionId: active.sessionId,
              sessionIncarnationId: active.sessionIncarnationId,
              turnId: active.turnId!,
              status: "cancelled",
              actorId: "recovery-owner",
              idempotencyKey: `admission:${sessionId}:recovery-cancelled`,
              correlationId: `correlation:admission:${sessionId}:recovery-cancelled`,
              requestRuntimeClaim: {
                runtimeOwnerId: active.runtimeOwnerId!,
                leaseRevision: active.runtimeLeaseRevision!,
              },
            }).status,
            "cancelled",
          );
          assert.deepEqual(
            recovered.listEvents(winningId).map((event) => event.eventSequence),
            [1, 2],
          );
          const nextTurn = recovered.admit({
            workspaceId: active.workspaceId,
            sessionId: active.sessionId,
            expectedSessionIncarnationId: active.sessionIncarnationId,
            turnId: `turn-${suffix}-next`,
            runtimeOwnerId: `runtime-${suffix}-next`,
            admissionKind: "turn_write",
            aggregateRevision: active.aggregateRevision,
            controllerGeneration: active.controllerGeneration,
            actorKind: "operator",
            actorId: "operator-a",
            operation: "chat.turn.execute",
            materialSha256: "c".repeat(64),
            idempotencyKey: `admission:${sessionId}:next`,
            correlationId: `correlation:admission:${sessionId}:next`,
          });
          assert.equal(nextTurn.disposition, "created");
          assert.equal(nextTurn.admission.status, "active");
          assert.deepEqual(
            recovered.listActive(active.workspaceId, active.sessionId).map((admission) => admission.admissionId),
            [nextTurn.admission.admissionId],
          );

          const completedSessionId = `${sessionId}-completed`;
          new ChatSessionLifecycleRepository(recoveredDb).initialize({
            workspaceId: "workspace-a",
            sessionId: completedSessionId,
            actorId: "system:completed-proof",
            idempotencyKey: `lifecycle:init:${completedSessionId}`,
            correlationId: `correlation:lifecycle:init:${completedSessionId}`,
          });
          const completedRequest = { content: "PostgreSQL durable terminal capability replay proof." };
          const completedMaterialSha256 = createHash("sha256")
            .update(canonicalJsonString({ version: 2, request: completedRequest }))
            .digest("hex");
          const completedAdmission = recovered.admit({
            workspaceId: "workspace-a",
            sessionId: completedSessionId,
            turnId: `turn-${suffix}-completed`,
            runtimeOwnerId: `runtime-${suffix}-completed`,
            admissionKind: "turn_write",
            aggregateRevision: 1,
            controllerGeneration: 1,
            actorKind: "system",
            actorId: "system:completed-proof",
            operation: "chat.turn.execute",
            materialSha256: completedMaterialSha256,
            idempotencyKey: `admission:${completedSessionId}`,
            correlationId: `correlation:admission:${completedSessionId}`,
          }).admission;
          const completedRunId = `run-${suffix}-completed`;
          const completedProfileBinding = {
            admissionId: completedAdmission.admissionId,
            workspaceId: completedAdmission.workspaceId,
            sessionId: completedAdmission.sessionId,
            sessionIncarnationId: completedAdmission.sessionIncarnationId,
            turnId: completedAdmission.turnId!,
            profileId: `profile-${suffix}-completed`,
            profileHash: "a".repeat(64),
            createdAt: "2026-07-15T00:01:00.000Z",
          };
          recoveredDb.transaction("immediate", () => {
            recovered.bindCapabilityProfile({
              ...completedProfileBinding,
              requestRuntimeClaim: {
                runtimeOwnerId: completedAdmission.runtimeOwnerId!,
                leaseRevision: completedAdmission.runtimeLeaseRevision!,
              },
            });
            recoveredDb
              .prepare(
                `INSERT INTO chat_turn_capability_profiles (
                   profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
                   schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
                   selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
                 ) VALUES (
                   @profileId, @turnId, @sessionId, @workspaceId, @durableRunId, NULL, NULL,
                   'chat.turn.capability-profile.v1', @profileHash, @snapshotId, @profileHash, @profileHash,
                   @profileHash, @profileHash, @profileHash, '{}', @createdAt
                 )`,
              )
              .run({
                profileId: completedProfileBinding.profileId,
                turnId: completedProfileBinding.turnId,
                sessionId: completedProfileBinding.sessionId,
                workspaceId: completedProfileBinding.workspaceId,
                durableRunId: completedRunId,
                profileHash: completedProfileBinding.profileHash,
                createdAt: completedProfileBinding.createdAt,
                snapshotId: `snapshot-${suffix}-completed`,
              });
          });
          const completedPayload = {
            version: "chat.turn.execute.v2",
            admissionId: completedAdmission.admissionId,
            sessionIncarnationId: completedAdmission.sessionIncarnationId,
            admissionMaterialSha256: completedAdmission.materialSha256,
            workspaceId: completedAdmission.workspaceId,
            admissionAggregateRevision: completedAdmission.aggregateRevision,
            admissionControllerGeneration: completedAdmission.controllerGeneration,
            effectiveRequestMaterialSha256: createHash("sha256")
              .update(
                canonicalJsonString({
                  version: 1,
                  admissionMaterialSha256: completedAdmission.materialSha256,
                  request: completedRequest,
                }),
              )
              .digest("hex"),
            policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: completedRunId },
            requestActor: { actorKind: "system", actorId: completedAdmission.actorId },
            sessionId: completedAdmission.sessionId,
            turnId: completedAdmission.turnId!,
            userMessageId: `message-${suffix}-completed-user`,
            assistantMessageId: `message-${suffix}-completed-assistant`,
            capabilityProfileId: completedProfileBinding.profileId,
            capabilityProfileHash: completedProfileBinding.profileHash,
            branchKind: "append",
            threadEventType: "chat_thread_turn_appended",
            request: completedRequest,
          };
          const durableRuns = new DurableRunRepository(recoveredDb);
          const queuedCompletedRun = durableRuns.createRun({
            runId: completedRunId,
            workflowKey: "chat.turn.execute",
            payload: completedPayload,
            metadata: {},
          });
          recoveredDb
            .prepare(
              `INSERT INTO chat_turn_traces (
                 turn_id, session_id, user_message_id, assistant_message_id, status, mode,
                 web_mode, memory_mode, thinking_level, routing_json, started_at
               ) VALUES (
                 @turnId, @sessionId, @userMessageId, @assistantMessageId, 'queued', 'chat',
                 'off', 'off', 'standard', '{}', @startedAt
               )`,
            )
            .run({
              turnId: completedAdmission.turnId!,
              sessionId: completedAdmission.sessionId,
              userMessageId: completedPayload.userMessageId,
              assistantMessageId: completedPayload.assistantMessageId,
              startedAt: "2026-07-15T00:01:30.000Z",
            });
          recovered.bindDurableRun({
            admissionId: completedAdmission.admissionId,
            workspaceId: completedAdmission.workspaceId,
            sessionId: completedAdmission.sessionId,
            sessionIncarnationId: completedAdmission.sessionIncarnationId,
            turnId: completedAdmission.turnId!,
            durableRunId: completedRunId,
            requestRuntimeClaim: {
              runtimeOwnerId: completedAdmission.runtimeOwnerId!,
              leaseRevision: completedAdmission.runtimeLeaseRevision!,
            },
          });
          const recoveredDurableBinding = recovered.findDurableRunBinding({
            admissionId: completedAdmission.admissionId,
            workspaceId: completedAdmission.workspaceId,
            sessionId: completedAdmission.sessionId,
            sessionIncarnationId: completedAdmission.sessionIncarnationId,
            turnId: completedAdmission.turnId!,
          });
          assert.ok(recoveredDurableBinding);
          assert.equal(recoveredDurableBinding.durableRunId, completedRunId);
          assert.equal(recoveredDurableBinding.admissionId, completedAdmission.admissionId);
          assert.equal(recoveredDurableBinding.sessionIncarnationId, completedAdmission.sessionIncarnationId);
          assert.throws(() =>
            recovered.findDurableRunBinding({
              admissionId: completedAdmission.admissionId,
              workspaceId: "workspace-wrong",
              sessionId: completedAdmission.sessionId,
              sessionIncarnationId: completedAdmission.sessionIncarnationId,
              turnId: completedAdmission.turnId!,
            }),
          );
          const childRunIds: string[] = [];
          const completedAt = "2026-07-15T00:02:00.000Z";
          const postCommitGenerationId = `generation-${suffix}-completed`;
          const postCommitEligibility = {
            version: 1 as const,
            autonomyEnabledAtParentSettlement: false,
            evalIntegrityTurn: false,
            humanSession: true,
          };
          const outputText = "PostgreSQL durable terminal capability replay proof.";
          const outputSummary = "PostgreSQL durable terminal capability replay proof.";
          const terminalOutput = {
            assistantMessageId: completedPayload.assistantMessageId,
            outputTextSha256: sha256(canonicalJsonString(outputText)),
            outputSummarySha256: sha256(canonicalJsonString(outputSummary)),
          };
          const authorityMaterial = {
            version: "chat.turn.runtime-authority.v1",
            runId: completedRunId,
            turnId: completedAdmission.turnId!,
            transitionKind: "terminal",
            durableStatus: "completed",
            traceStatus: "completed",
            transitionAt: completedAt,
            postCommitGenerationId,
            postCommitEligibility,
            waitForEvent: null,
            terminalOutput,
            linkedFinalization: null,
            requiredFinalizers: ["general"],
          };
          const chatTurnRuntimeAuthority = {
            material: authorityMaterial,
            materialSha256: sha256(canonicalJsonString(authorityMaterial)),
          };
          durableRuns.updateRun({
            runId: completedRunId,
            status: "completed",
            finishedAt: completedAt,
            clearLease: true,
            metadata: {
              chatTurnRuntimeAuthority,
              outputText,
              finalOutput: outputText,
              outputSummary,
              finalSummary: outputSummary,
              generalChatPostCommit: {
                generationId: postCommitGenerationId,
                traceStatus: "completed",
                requestedAt: completedAt,
                postCommitEligibility,
                parentLocalEffectsStatus: "settled",
                parentLocalEffectsSettledAt: completedAt,
                completedEffects: [
                  "capability_gap",
                  "learned_memory_user",
                  "learned_memory_assistant",
                  "commitments",
                  "background_review",
                  "memory_maintenance",
                  "memory_prewarm",
                  "realtime",
                  "agent_end",
                ],
                durableEffectRunIds: {},
                durableEffectOutcomes: {},
                childOutcomeAuthority: "child_durable_runs",
                settlementStatus: "completed",
                completedAt,
              },
              chatTurnAdmissionHandoff: {
                version: 1,
                admissionId: completedAdmission.admissionId,
                sessionIncarnationId: completedAdmission.sessionIncarnationId,
                turnId: completedAdmission.turnId!,
                parentRunId: completedRunId,
                postCommitGenerationId,
                parentLocalEffectsStatus: "settled",
                childRunIds,
                childRunIdsSha256: sha256(canonicalJsonString(childRunIds)),
                committedAt: completedAt,
              },
            },
            updatedAt: completedAt,
            expectedVersion: queuedCompletedRun.version,
          });
          durableRuns.createCheckpoint({
            checkpointId: `checkpoint-${suffix}-completed`,
            runId: completedRunId,
            checkpointKind: "run_completed",
            state: {
              chatTurnRuntimeAuthority,
              assistantMessageId: completedPayload.assistantMessageId,
              outputText,
              outputSummary,
            },
            createdAt: completedAt,
          });
          new ChatMessageRepository(recoveredDb).upsert({
            messageId: completedPayload.assistantMessageId,
            sessionId: completedAdmission.sessionId,
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: outputText,
            timestamp: completedAt,
          });
          recoveredDb
            .prepare(
              `UPDATE chat_turn_traces
               SET status = 'completed', finished_at = @finishedAt, durable_json = @durableJson
               WHERE turn_id = @turnId`,
            )
            .run({
              finishedAt: completedAt,
              durableJson: JSON.stringify({
                runId: completedRunId,
                status: "completed",
                checkpointKind: "run_completed",
              }),
              turnId: completedAdmission.turnId!,
            });
          const durableClosed = recovered.closeTurnWrite({
            admissionId: completedAdmission.admissionId,
            workspaceId: completedAdmission.workspaceId,
            sessionId: completedAdmission.sessionId,
            sessionIncarnationId: completedAdmission.sessionIncarnationId,
            turnId: completedAdmission.turnId!,
            status: "completed",
            actorId: completedAdmission.actorId,
            idempotencyKey: `admission:${completedSessionId}:completed`,
            correlationId: completedRunId,
          });
          assert.equal(durableClosed.status, "completed");
          assert.equal(durableClosed.terminalAuthorityKind, "durable_terminal");
          assert.equal(
            recovered.requireCapabilityProfileBinding(completedProfileBinding).admission.status,
            "completed",
          );
          assert.throws(() =>
            recoveredDb
              .prepare(
                `UPDATE chat_session_mutation_admissions
                 SET material_sha256 = @digest WHERE admission_id = @admissionId`,
              )
              .run({ digest: "f".repeat(64), admissionId: winningId }),
          );
          assert.throws(() =>
            recoveredDb
              .prepare("DELETE FROM chat_session_mutation_admission_events WHERE admission_id = @admissionId")
              .run({ admissionId: winningId }),
          );
        } finally {
          recoveredDb.close();
        }
      } finally {
        setupDb?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "keeps raced durable user-input wake events on the shared sequence ledger",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_continuation_sequence_${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const pool = new Pool({ connectionString: scopedUrl.toString(), max: 2 });
      const migrations = new PostgresDatabaseClient({ connectionString: scopedUrl.toString(), database }, { pool });
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        db = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database,
          applicationName: `hx411-continuation-sequence-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        db.exec(`SET search_path TO ${schemaName}`);
        const fixture = createPostgresContinuationFixture(db, `sequence-${suffix}`);
        const events = new DurableRunEventRepository(db);
        assert.equal(
          events.append({
            eventId: `event-waiting-${suffix}`,
            runId: fixture.runId,
            eventType: "run_waiting",
            createdAt: "2026-07-30T00:00:00.000Z",
          }).sequence,
          1,
        );

        const race = await runPostgresContinuationRace(scopedUrl.toString(), database, schemaName, fixture.resolution);
        assert.deepEqual(
          race.map((result) => result.disposition).sort(),
          ["replayed", "resolved"],
          JSON.stringify(race),
        );
        assert.equal(
          events.append({
            eventId: `event-started-${suffix}`,
            runId: fixture.runId,
            eventType: "run_started",
            createdAt: "2026-07-30T00:00:02.000Z",
          }).sequence,
          3,
        );
        assert.deepEqual(
          events.listByRun(fixture.runId).map((event) => [event.eventType, event.sequence]),
          [
            ["run_waiting", 1],
            ["run_woken", 2],
            ["run_started", 3],
          ],
        );
        assert.equal(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM durable_run_events
               WHERE run_id = @runId AND event_type = 'run_woken'`,
            )
            .get<{ count: number }>({ runId: fixture.runId })?.count,
          1,
        );
        db.prepare(
          `INSERT INTO durable_run_events (
             event_id, run_id, sequence, event_type, step_key, payload_json, created_at
           ) VALUES (@eventId, @runId, 4, 'run_waiting', NULL, '{}', @createdAt)`,
        ).run({
          eventId: `event-legacy-direct-${suffix}`,
          runId: fixture.runId,
          createdAt: "2026-07-30T00:00:03.000Z",
        });
        assert.equal(
          events.append({
            eventId: `event-healed-${suffix}`,
            runId: fixture.runId,
            eventType: "run_started",
            createdAt: "2026-07-30T00:00:04.000Z",
          }).sequence,
          5,
        );
        assert.equal(
          db
            .prepare("SELECT last_sequence FROM durable_run_event_sequences WHERE run_id = @runId")
            .get<{ last_sequence: number }>({ runId: fixture.runId })?.last_sequence,
          5,
        );
      } finally {
        db?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "permits only control-plane operator responders before resolution and replay",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_continuation_${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const pool = new Pool({ connectionString: scopedUrl.toString(), max: 2 });
      const migrations = new PostgresDatabaseClient({ connectionString: scopedUrl.toString(), database }, { pool });
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        db = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database,
          applicationName: `hx411-continuation-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        db.exec(`SET search_path TO ${schemaName}`);

        for (const authActorSource of ["none", "token", "basic", "loopback"] as const) {
          const fixture = createPostgresContinuationFixture(db, `allowed-${authActorSource}-${suffix}`);
          const resolution = {
            ...fixture.resolution,
            responder: { actorId: `operator-shifted-${authActorSource}`, authActorSource },
          };
          assert.equal(fixture.repo.resolveDurableChatUserInput(resolution).disposition, "resolved");
          const beforeUnauthorizedReplay = readPostgresContinuationMutationSnapshot(db, fixture);
          assert.throws(
            () =>
              fixture.repo.resolveDurableChatUserInput({
                ...resolution,
                expectedWaitingRunVersion: 3,
                responder: { actorId: resolution.responder.actorId, authActorSource: "companion" },
              }),
            /requires an operator admission and a control-plane responder/iu,
          );
          assert.deepEqual(readPostgresContinuationMutationSnapshot(db, fixture), beforeUnauthorizedReplay);
        }

        for (const authActorSource of ["companion", "device", "a2a_peer", "sse"] as const) {
          const fixture = createPostgresContinuationFixture(db, `rejected-${authActorSource}-${suffix}`);
          const before = readPostgresContinuationMutationSnapshot(db, fixture);
          assert.throws(
            () =>
              fixture.repo.resolveDurableChatUserInput({
                ...fixture.resolution,
                responder: { actorId: "operator-a", authActorSource },
              }),
            /requires an operator admission and a control-plane responder/iu,
          );
          assert.deepEqual(readPostgresContinuationMutationSnapshot(db, fixture), before);
        }

        for (const actor of [
          { actorKind: "system", actorId: "system-heartbeat", authActorSource: "loopback" },
          {
            actorKind: "external_companion",
            actorId: `companion-continuation-${suffix}`,
            authActorSource: "companion",
          },
        ] as const) {
          const fixture = createPostgresContinuationFixture(db, `${actor.actorKind}-${suffix}`, actor);
          const before = readPostgresContinuationMutationSnapshot(db, fixture);
          assert.throws(
            () =>
              fixture.repo.resolveDurableChatUserInput({
                ...fixture.resolution,
                responder: { actorId: actor.actorId, authActorSource: actor.authActorSource },
              }),
            /requires an operator admission and a control-plane responder/iu,
          );
          assert.deepEqual(readPostgresContinuationMutationSnapshot(db, fixture), before);
        }
      } finally {
        db?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function createPostgresContinuationFixture(
  db: PostgresSyncDatabaseClient,
  seed: string,
  options: {
    actorKind?: "operator" | "system" | "external_companion";
    actorId?: string;
  } = {},
) {
  const workspaceId = `workspace-continuation-${seed}`;
  const sessionId = `session-continuation-${seed}`;
  const turnId = `turn-continuation-${seed}`;
  const runId = `run-continuation-${seed}`;
  const promptId = `prompt-continuation-${seed}`;
  const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-a",
    idempotencyKey: `lifecycle:init:${sessionId}`,
    correlationId: `correlation:init:${sessionId}`,
  });
  const actorKind = options.actorKind ?? "operator";
  const actorId = options.actorId ?? (actorKind === "operator" ? "operator-a" : `actor-${actorKind}-${seed}`);
  let controllerGeneration = 1;
  if (actorKind === "external_companion") {
    const deviceGrantId = `grant-continuation-${seed}`;
    seedPostgresSessionControlAuth(db, actorId, deviceGrantId, seed);
    const controls = new SessionControlRepository(db);
    const requested = controls.createExternalRequest({
      workspaceId,
      sessionId,
      companionSessionId: actorId,
      deviceGrantId,
      clientInstanceId: `client-continuation-${seed}`,
      principalPurpose: "session_control_client",
      expectedGeneration: 1,
      tokenHashSha256: sha256(`control-token:${seed}`),
      capabilities: ["send"],
      idempotencyKey: `control:request:${seed}`,
      correlationId: `correlation:control:request:${seed}`,
    });
    controls.handoff({
      workspaceId,
      sessionId,
      requestId: requested.request.requestId,
      expectedGeneration: 1,
      effectiveCapabilities: ["send"],
      operatorActorId: "operator-a",
      idempotencyKey: `control:handoff:${seed}`,
      correlationId: `correlation:control:handoff:${seed}`,
    });
    controllerGeneration = 2;
  }
  const request = { message: "Continue after operator input." };
  const materialSha256 = sha256(canonicalJsonString({ version: 2, request }));
  const repo = new SessionMutationAdmissionRepository(db);
  const admitted = repo.admit({
    workspaceId,
    sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId,
    runtimeOwnerId: `request-runtime-${seed}`,
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration,
    actorKind,
    actorId,
    operation: "chat.turn.execute",
    materialSha256,
    idempotencyKey: `admission:${seed}`,
    correlationId: `correlation:admission:${seed}`,
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    admissionMaterialSha256: materialSha256,
    workspaceId,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: controllerGeneration,
    sessionId,
    turnId,
    request,
    requestActor: { actorKind, actorId },
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({ version: 1, admissionMaterialSha256: materialSha256, request }),
    ),
    userInputResponses: [],
  };
  const pendingPrompt = {
    promptId,
    turnId,
    kind: "text",
    title: "Operator input",
    question: "What should the durable run do next?",
  };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO durable_runs (
       run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
       version, created_at, updated_at
     ) VALUES (
       @runId, 'chat.turn.execute', 'waiting', 0, 3, @payloadJson, @metadataJson,
       2, @now, @now
     )`,
  ).run({
    runId,
    payloadJson: canonicalJsonString(payload),
    metadataJson: canonicalJsonString({
      waitForEvent: { eventKey: "chat.user_input.resolved", correlationId: promptId },
    }),
    now,
  });
  db.prepare(
    `INSERT INTO chat_turn_traces (
       turn_id, session_id, user_message_id, status, mode, web_mode, memory_mode,
       thinking_level, routing_json, pending_user_input_json, durable_json, started_at
     ) VALUES (
       @turnId, @sessionId, @userMessageId, 'waiting_for_user_input', 'chat',
       'off', 'off', 'standard', '{}', @pendingUserInputJson, @durableJson, @now
     )`,
  ).run({
    turnId,
    sessionId,
    userMessageId: `message-continuation-${seed}`,
    pendingUserInputJson: canonicalJsonString(pendingPrompt),
    durableJson: canonicalJsonString({ runId }),
    now,
  });
  repo.bindDurableRun({
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    durableRunId: runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admitted.runtimeOwnerId!,
      leaseRevision: admitted.runtimeLeaseRevision!,
    },
  });
  return {
    repo,
    runId,
    turnId,
    resolution: {
      admissionIdentity: {
        admissionId: admitted.admissionId,
        sessionIncarnationId: admitted.sessionIncarnationId,
        workspaceId,
        sessionId,
        turnId,
        aggregateRevision: 1,
        controllerGeneration,
        materialSha256,
      },
      durableRunId: runId,
      expectedWaitingRunVersion: 2,
      promptId,
      eventKey: "chat.user_input.resolved" as const,
      correlationId: promptId,
      responder: { actorId: "operator-a", authActorSource: "token" as const },
      response: { kind: "text" as const, text: "Proceed with the verified plan." },
    },
  };
}

function seedPostgresSessionControlAuth(
  db: PostgresSyncDatabaseClient,
  companionSessionId: string,
  deviceGrantId: string,
  seed: string,
): void {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const authRequestId = `auth-request-${sha256(seed).slice(0, 24)}`;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES (
       @requestId, @approvalId, @secretHash, 'HX-411 test client', 'test', 'approved',
       @now, @expiresAt, @now, 'operator-a', 'session_control_client'
     )`,
  ).run({
    requestId: authRequestId,
    approvalId: `approval-${sha256(seed).slice(0, 24)}`,
    secretHash: sha256(`request-secret:${seed}`),
    now,
    expiresAt,
  });
  db.prepare(
    `INSERT INTO auth_device_grants (
       grant_id, request_id, token_hash, device_label, device_type, granted_by,
       created_at, expires_at, metadata_json, principal_purpose
     ) VALUES (
       @grantId, @requestId, @tokenHash, 'HX-411 test client', 'test', 'operator-a',
       @now, @expiresAt, '{}', 'session_control_client'
     )`,
  ).run({
    grantId: deviceGrantId,
    requestId: authRequestId,
    tokenHash: sha256(`device-token:${seed}`),
    now,
    expiresAt,
  });
  db.prepare(
    `INSERT INTO companion_sessions (
       session_id, grant_id, access_token_hash, access_token_expires_at,
       refresh_token_hash, refresh_token_expires_at, signing_public_key_pem,
       signature_algorithm, created_at, last_rotated_at, metadata_json, principal_purpose
     ) VALUES (
       @sessionId, @grantId, @accessTokenHash, @expiresAt,
       @refreshTokenHash, @expiresAt, 'hx411-test-public-key',
       'ed25519', @now, @now, '{}', 'session_control_client'
     )`,
  ).run({
    sessionId: companionSessionId,
    grantId: deviceGrantId,
    accessTokenHash: sha256(`access-token:${seed}`),
    refreshTokenHash: sha256(`refresh-token:${seed}`),
    now,
    expiresAt,
  });
}

function readPostgresContinuationMutationSnapshot(
  db: PostgresSyncDatabaseClient,
  fixture: ReturnType<typeof createPostgresContinuationFixture>,
) {
  return {
    admission: fixture.repo.require(fixture.resolution.admissionIdentity.admissionId),
    run: db
      .prepare(
        `SELECT status, version, payload_json, metadata_json, updated_at
         FROM durable_runs WHERE run_id = @runId`,
      )
      .get({ runId: fixture.runId }),
    trace: db
      .prepare(
        `SELECT status, pending_user_input_json, completion_json, finished_at
         FROM chat_turn_traces WHERE turn_id = @turnId`,
      )
      .get({ turnId: fixture.turnId }),
    sealCount: db
      .prepare(
        `SELECT COUNT(*) AS count FROM chat_turn_user_input_continuation_seals
         WHERE durable_run_id = @runId`,
      )
      .get<{ count: number }>({ runId: fixture.runId })!.count,
    wakeEventCount: db
      .prepare(
        `SELECT COUNT(*) AS count FROM durable_run_events
         WHERE run_id = @runId AND event_type = 'run_woken'`,
      )
      .get<{ count: number }>({ runId: fixture.runId })!.count,
  };
}

interface AdmissionWorkerResult {
  ok: boolean;
  admissionId?: string;
  disposition?: string;
  error?: string;
}

interface ContinuationWorkerResult {
  ok: boolean;
  disposition?: "resolved" | "replayed";
  error?: string;
}

async function runPostgresContinuationRace(
  connectionString: string,
  database: string,
  schemaName: string,
  resolution: ReturnType<typeof createPostgresContinuationFixture>["resolution"],
): Promise<[ContinuationWorkerResult, ContinuationWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = ["left", "right"].map((contender) =>
    runPostgresContinuationWorker(connectionString, database, schemaName, resolution, contender, startSignal),
  ) as [ReturnType<typeof runPostgresContinuationWorker>, ReturnType<typeof runPostgresContinuationWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<
    [ContinuationWorkerResult, ContinuationWorkerResult]
  >;
}

function runPostgresContinuationWorker(
  connectionString: string,
  database: string,
  schemaName: string,
  resolution: ReturnType<typeof createPostgresContinuationFixture>["resolution"],
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<ContinuationWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(POSTGRES_CONTINUATION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName: `hx411-continuation-${contender}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      schemaName,
      resolution,
      startSignal,
      repositoryModuleUrl: new URL(`./session-mutation-admission-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: ContinuationWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<ContinuationWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: ContinuationWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`PostgreSQL continuation worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

async function runPostgresAdmissionRace(
  connectionString: string,
  database: string,
  schemaName: string,
  sessionId: string,
  contenders: readonly [string, string],
): Promise<[AdmissionWorkerResult, AdmissionWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = contenders.map((contender) =>
    runPostgresAdmissionWorker(connectionString, database, schemaName, sessionId, contender, startSignal),
  ) as [ReturnType<typeof runPostgresAdmissionWorker>, ReturnType<typeof runPostgresAdmissionWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[AdmissionWorkerResult, AdmissionWorkerResult]>;
}

function runPostgresAdmissionWorker(
  connectionString: string,
  database: string,
  schemaName: string,
  sessionId: string,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<AdmissionWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(POSTGRES_ADMISSION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName: `hx411-admission-${contender}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      schemaName,
      sessionId,
      contender,
      startSignal,
      repositoryModuleUrl: new URL(`./session-mutation-admission-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: AdmissionWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<AdmissionWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: AdmissionWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`PostgreSQL admission worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const POSTGRES_CONTINUATION_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { SessionMutationAdmissionRepository } = await tsImport(
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
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const value = new SessionMutationAdmissionRepository(db).resolveDurableChatUserInput(workerData.resolution);
      parentPort.postMessage({
        kind: "result",
        result: { ok: true, disposition: value.disposition },
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

const POSTGRES_ADMISSION_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { SessionMutationAdmissionRepository } = await tsImport(
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
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const contender = workerData.contender;
      const value = new SessionMutationAdmissionRepository(db).admit({
        workspaceId: "workspace-a",
        sessionId: workerData.sessionId,
        turnId: "turn-" + workerData.sessionId + "-" + contender,
        runtimeOwnerId: "runtime-" + workerData.sessionId + "-" + contender,
        admissionKind: "turn_write",
        aggregateRevision: 1,
        controllerGeneration: 1,
        actorKind: "operator",
        actorId: "operator-" + contender,
        operation: "chat.turn.execute",
        materialSha256: (contender === "right" ? "d" : "c").repeat(64),
        idempotencyKey: "admission:" + workerData.sessionId + ":" + contender,
        correlationId: "correlation:admission:" + workerData.sessionId + ":" + contender,
      });
      parentPort.postMessage({
        kind: "result",
        result: {
          ok: true,
          admissionId: value.admission.admissionId,
          disposition: value.disposition,
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
