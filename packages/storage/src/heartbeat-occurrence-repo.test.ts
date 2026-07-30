import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { DatabaseClient, DbBindParams, DbStatement } from "./db.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import {
  HEARTBEAT_ADMISSION_OPERATION,
  HEARTBEAT_SYSTEM_ACTOR_ID,
  HeartbeatOccurrenceRepository,
  type ClaimHeartbeatOccurrenceInput,
  type HeartbeatOccurrenceRecord,
} from "./heartbeat-occurrence-repo.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { SessionRepository } from "./session-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("HeartbeatOccurrenceRepository SQLite", () => {
  it("claims, consumes cadence, replays exactly, and rolls the callback back atomically", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = seedHeartbeatSession(db, "atomic");
    const occurrences = new HeartbeatOccurrenceRepository(db);
    const admissions = new SessionMutationAdmissionRepository(db);
    let callbackCount = 0;

    assert.throws(
      () =>
        occurrences.claim(fixture.claimInput, (request) => {
          admissions.admit(request.admissionInput);
          throw new Error("crash after admission");
        }),
      /crash after admission/u,
    );
    assert.equal(readCount(db, "chat_session_mutation_admissions"), 0);
    assert.equal(readCount(db, "chat_heartbeat_occurrences"), 0);
    assert.equal(new SessionAutonomyPrefsRepository(db).get(fixture.sessionId)?.lastProactiveAt, undefined);

    const created = occurrences.claim(fixture.claimInput, (request) => {
      callbackCount += 1;
      assert.equal(request.admissionInput.materialSha256, fixture.frozenRequestSha256);
      assert.equal(request.admissionInput.correlationId, request.occurrenceId);
      const admission = admissions.admit(request.admissionInput).admission;
      return { admission, child: request.child };
    });
    assert.equal(created.disposition, "created");
    assert.equal(callbackCount, 1);
    if (created.disposition !== "created") throw new Error("expected created occurrence");
    assert.equal(created.occurrence.admissionMaterialSha256, fixture.frozenRequestSha256);
    assert.equal(created.occurrence.frozenRequestSha256, fixture.frozenRequestSha256);
    assert.equal(created.occurrence.state, "admitted");
    const cadence = new SessionAutonomyPrefsRepository(db).get(fixture.sessionId);
    assert.equal(cadence?.lastProactiveAt, created.occurrence.claimedAt);
    assert.equal(cadence?.lastProactiveRunId, created.occurrence.occurrenceId);

    const replay = occurrences.claim(fixture.claimInput, () => {
      callbackCount += 1;
      throw new Error("replay must not invoke callback");
    });
    assert.equal(replay.disposition, "replayed");
    assert.equal(callbackCount, 1);
    if (replay.disposition !== "replayed") throw new Error("expected replayed occurrence");
    assert.deepEqual(replay.occurrence, created.occurrence);

    const differentIdleGate = occurrences.claim({ ...fixture.claimInput, idleFloorSeconds: 1 }, () => {
      throw new Error("an unresolved competing claim must not invoke callback");
    });
    assert.equal(differentIdleGate.disposition, "unresolved_busy");
    assert.throws(
      () =>
        occurrences.claim({ ...fixture.claimInput, expectedPriorCadence: { lastProactiveAt: "" } }, () => {
          throw new Error("invalid cadence must not invoke callback");
        }),
      /lastProactiveAt|validation/iu,
    );
    assert.throws(
      () =>
        occurrences.claim(
          {
            ...fixture.claimInput,
            expectedPriorCadence: {
              lastProactiveAt: null,
            } as unknown as ClaimHeartbeatOccurrenceInput["expectedPriorCadence"],
          },
          () => {
            throw new Error("invalid cadence must not invoke callback");
          },
        ),
      /lastProactiveAt|validation/iu,
    );

    const currentCadence = {
      lastProactiveAt: created.occurrence.claimedAt,
      lastProactiveRunId: created.occurrence.occurrenceId,
    };
    const busy = occurrences.claim(
      {
        ...fixture.claimInput,
        expectedPriorCadence: currentCadence,
        frozenObjectiveSha256: sha256("second objective"),
      },
      () => {
        throw new Error("busy claim must not invoke callback");
      },
    );
    assert.equal(busy.disposition, "unresolved_busy");
    assert.equal(
      busy.disposition === "unresolved_busy" ? busy.occurrence.occurrenceId : "",
      created.occurrence.occurrenceId,
    );
    assert.equal(occurrences.listRecoverable().length, 1);
    assert.equal(readCount(db, "chat_session_mutation_admissions"), 1);
    db.close();
  });

  it("requires exact child, profile, actor, and heartbeat occurrence payload bindings", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createBoundHeartbeatFixture(db, "binding");
    const malformedPayload = {
      ...fixture.payload,
      requestActor: { actorKind: "system", actorId: HEARTBEAT_SYSTEM_ACTOR_ID, extra: true },
    };
    db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @runId").run({
      payloadJson: canonicalJsonString(malformedPayload),
      runId: fixture.occurrence.durableRunId,
    });
    assert.throws(() => fixture.markBound(), /exact admission, profile, run, or trace evidence/iu);

    db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @runId").run({
      payloadJson: canonicalJsonString(fixture.payload),
      runId: fixture.occurrence.durableRunId,
    });
    const bound = fixture.markBound();
    assert.equal(bound.disposition, "created");
    assert.equal(bound.occurrence.state, "durable_bound");
    assert.equal(fixture.markBound().disposition, "replayed");
    assert.equal(fixture.occurrences.markTerminal(fixture.boundIdentity).disposition, "still_bound");
    assert.deepEqual(
      fixture.occurrences.listRecoverable().map((item) => item.state),
      ["durable_bound"],
    );
    assert.throws(
      () => fixture.occurrences.markDurableBound({ ...fixture.boundIdentity, capabilityProfileHash: "f".repeat(64) }),
      /identity conflicts|exact admission/iu,
    );
    db.close();
  });

  it("fails closed when an active legacy session has no persisted lifecycle incarnation", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = seedHeartbeatSession(db, "legacy-null-incarnation");
    forceLegacyNullLifecycleIntent(db, fixture.sessionId);
    const occurrences = new HeartbeatOccurrenceRepository(db);
    const admissions = new SessionMutationAdmissionRepository(db);

    assert.throws(
      () =>
        occurrences.claim(fixture.claimInput, (request) => ({
          admission: admissions.admit(request.admissionInput).admission,
          child: request.child,
        })),
      /exact live operator session authority/iu,
    );
    assert.equal(readCount(db, "chat_heartbeat_occurrences"), 0);
    assert.equal(readCount(db, "chat_session_mutation_admissions"), 0);
    assert.deepEqual(new SessionAutonomyPrefsRepository(db).get(fixture.sessionId)?.lastProactiveRunId, undefined);
    db.close();
  });

  it("keyset-pages past more than the legacy cap without starving a later occurrence", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const created: HeartbeatOccurrenceRecord[] = [];
    for (let index = 0; index < 101; index += 1) {
      created.push(createClaimedHeartbeatFixture(db, `recovery-page-${index}`).occurrence);
    }
    const occurrences = new HeartbeatOccurrenceRepository(db);
    const first = occurrences.listRecoverablePage({ limit: 100 });
    assert.equal(first.items.length, 100);
    assert.ok(first.nextCursor);
    const second = occurrences.listRecoverablePage({ limit: 100, after: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, undefined);
    const observed = [...first.items, ...second.items].map((occurrence) => occurrence.occurrenceId);
    assert.equal(new Set(observed).size, 101);
    assert.deepEqual(new Set(observed), new Set(created.map((occurrence) => occurrence.occurrenceId)));
    db.close();
  });

  it("accepts only canonical completed, failed, and cancelled terminal handoffs", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const fixture = createBoundHeartbeatFixture(db, `terminal-${status}`);
      fixture.markBound();
      settleDurableHeartbeat(fixture, status);
      const terminal = fixture.occurrences.markTerminal(fixture.boundIdentity);
      assert.equal(terminal.disposition, "terminal");
      assert.equal(terminal.occurrence.terminalStatus, status);
      assert.equal(fixture.occurrences.markTerminal(fixture.boundIdentity).disposition, "replayed");
    }

    const deadLetter = createBoundHeartbeatFixture(db, "terminal-dead-letter");
    deadLetter.markBound();
    writeTerminalRunAndTrace(deadLetter, "dead_lettered");
    assert.throws(
      () =>
        deadLetter.admissions.closeTurnWrite({
          ...deadLetter.exactIdentity,
          status: "cancelled",
          actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
          idempotencyKey: `close:${deadLetter.occurrence.occurrenceId}`,
          correlationId: deadLetter.occurrence.durableRunId,
        }),
      /non-canonical terminal|execution claim/iu,
    );
    assert.equal(deadLetter.occurrences.markTerminal(deadLetter.boundIdentity).disposition, "still_bound");
    assert.equal(
      deadLetter.occurrences.listRecoverable().some((item) => item.occurrenceId === deadLetter.occurrence.occurrenceId),
      true,
    );

    const completed = createBoundHeartbeatFixture(db, "terminal-revalidation");
    completed.markBound();
    settleDurableHeartbeat(completed, "completed");
    completed.occurrences.markTerminal(completed.boundIdentity);
    db.prepare("UPDATE durable_runs SET metadata_json = '{}' WHERE run_id = @runId").run({
      runId: completed.occurrence.durableRunId,
    });
    assert.throws(
      () => completed.occurrences.markTerminal(completed.boundIdentity),
      /runtime authority|current finalizer evidence|handoff/iu,
    );
    db.close();
  });

  it("raw terminal transitions reject forged authority, output, and handoff hashes", () => {
    const db = createDatabase({ dbPath: ":memory:" });

    const forgedSeal = createBoundHeartbeatFixture(db, "raw-terminal-forged-seal");
    forgedSeal.markBound();
    settleDurableHeartbeat(forgedSeal, "completed");
    const forgedSealMetadata = readRunMetadata(db, forgedSeal.occurrence.durableRunId);
    const forgedSealAuthority = forgedSealMetadata.chatTurnRuntimeAuthority as {
      materialSha256: string;
    };
    forgedSealAuthority.materialSha256 = "f".repeat(64);
    writeRunMetadata(db, forgedSeal.occurrence.durableRunId, forgedSealMetadata);
    assert.throws(() => rawTerminalTransition(db, forgedSeal), /terminal runtime evidence invariant/iu);

    const forgedOutput = createBoundHeartbeatFixture(db, "raw-terminal-forged-output");
    forgedOutput.markBound();
    settleDurableHeartbeat(forgedOutput, "completed", { notify: true });
    const forgedOutputMetadata = readRunMetadata(db, forgedOutput.occurrence.durableRunId);
    const forgedOutputAuthority = forgedOutputMetadata.chatTurnRuntimeAuthority as {
      material: { terminalOutput: { outputTextSha256: string } };
      materialSha256: string;
    };
    forgedOutputAuthority.material.terminalOutput.outputTextSha256 = "e".repeat(64);
    forgedOutputAuthority.materialSha256 = sha256(canonicalJsonString(forgedOutputAuthority.material));
    writeRunMetadata(db, forgedOutput.occurrence.durableRunId, forgedOutputMetadata);
    new DurableRunRepository(db).createCheckpoint({
      checkpointId: `checkpoint-forged-output-${forgedOutput.occurrence.occurrenceId}`,
      runId: forgedOutput.occurrence.durableRunId,
      checkpointKind: "run_completed",
      state: {
        chatTurnRuntimeAuthority: forgedOutputAuthority,
        heartbeatDecisionRawOutput: forgedOutputMetadata.heartbeatDecisionRawOutput,
        heartbeatDecisionReceipt: forgedOutputMetadata.heartbeatDecisionReceipt,
        assistantMessageId: forgedOutput.occurrence.assistantMessageId,
        outputText: forgedOutputMetadata.outputText,
        outputSummary: forgedOutputMetadata.outputSummary,
      },
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    assert.throws(() => rawTerminalTransition(db, forgedOutput), /terminal runtime evidence invariant/iu);

    const forgedHandoff = createBoundHeartbeatFixture(db, "raw-terminal-forged-handoff");
    forgedHandoff.markBound();
    settleDurableHeartbeat(forgedHandoff, "completed");
    const forgedHandoffMetadata = readRunMetadata(db, forgedHandoff.occurrence.durableRunId);
    const forgedMarker = forgedHandoffMetadata.chatTurnAdmissionHandoff as { childRunIdsSha256: string };
    forgedMarker.childRunIdsSha256 = "d".repeat(64);
    writeRunMetadata(db, forgedHandoff.occurrence.durableRunId, forgedHandoffMetadata);
    assert.throws(() => rawTerminalTransition(db, forgedHandoff), /terminal runtime evidence invariant/iu);
    db.close();
  });

  it("reclaims only the exact expired admitted lease and leaves durable-bound work to canonical recovery", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createClaimedHeartbeatFixture(db, "reclaim");
    forceAdmissionLeaseExpired(db, fixture.occurrence.admissionId);
    const reclaimInput = toReclaimInput(fixture.occurrence, 1);
    const foreign = createClaimedHeartbeatFixture(db, "reclaim-foreign");
    assert.throws(
      () =>
        fixture.admissions.reclaimExpiredSystemTurnWriteRequestLease({
          ...reclaimInput,
          occurrenceId: foreign.occurrence.occurrenceId,
        }),
      /no exact admitted occurrence/iu,
    );
    assert.throws(
      () =>
        fixture.admissions.reclaimExpiredSystemTurnWriteRequestLease({
          ...reclaimInput,
          claimSha256: sha256("stale-heartbeat-claim"),
        }),
      /no exact admitted occurrence/iu,
    );
    assert.equal(fixture.admissions.require(fixture.occurrence.admissionId).runtimeLeaseRevision, 1);
    const reclaimed = fixture.admissions.reclaimExpiredSystemTurnWriteRequestLease(reclaimInput);
    assert.equal(reclaimed.disposition, "reclaimed");
    assert.equal(reclaimed.admission.runtimeOwnerId, fixture.occurrence.runtimeOwnerId);
    assert.equal(reclaimed.admission.runtimeLeaseRevision, 2);
    assert.equal(
      fixture.admissions.reclaimExpiredSystemTurnWriteRequestLease(toReclaimInput(fixture.occurrence, 2)).disposition,
      "live",
    );
    const staleObserver = fixture.admissions.reclaimExpiredSystemTurnWriteRequestLease(reclaimInput);
    assert.equal(staleObserver.disposition, "live");
    assert.equal(staleObserver.admission.runtimeLeaseRevision, 2);

    const bound = createBoundHeartbeatFixture(db, "reclaim-bound");
    bound.markBound();
    assert.equal(
      bound.admissions.reclaimExpiredSystemTurnWriteRequestLease(toReclaimInput(bound.occurrence, 2)).disposition,
      "durable_bound",
    );
    db.close();
  });

  it("closes null or changed lifecycle incarnations as authority drift without reclaiming the lease", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    for (const [seed, lifecycleIntentId] of [
      ["reclaim-null-incarnation", null],
      ["reclaim-changed-incarnation", "changed-persisted-incarnation"],
    ] as const) {
      const fixture = createClaimedHeartbeatFixture(db, seed);
      forceAdmissionLeaseExpired(db, fixture.occurrence.admissionId);
      forceLifecycleIntent(db, fixture.sessionId, lifecycleIntentId);
      const outcome = fixture.admissions.reclaimExpiredSystemTurnWriteRequestLease(
        toReclaimInput(fixture.occurrence, 1),
      );
      assert.equal(outcome.disposition, "closed_or_authority_drift");
      assert.equal(outcome.disposition === "closed_or_authority_drift" ? outcome.reason : undefined, "authority_drift");
      const admission = fixture.admissions.require(fixture.occurrence.admissionId);
      assert.equal(admission.runtimeLeaseRevision, 1);
      assert.equal(admission.status, "cancelled");
      assert.equal(admission.terminalAuthorityKind, "authority_superseded");
      const occurrence = fixture.occurrences.find(fixture.occurrence.occurrenceId);
      assert.equal(occurrence?.state, "abandoned");
      assert.equal(occurrence?.abandonmentReason, "authority_drift");
    }
    db.close();
  });

  it("atomically admits an operator turn when no heartbeat is active", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = seedHeartbeatSession(db, "operator-no-heartbeat");
    const admissions = new SessionMutationAdmissionRepository(db);
    const input = operatorTurnAdmissionInput(fixture, "operator-no-heartbeat", 1);

    const created = admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(created.disposition, "created");
    assert.equal(created.preemptionDisposition, "not_required");
    assert.equal(created.controllerGeneration, 1);
    assert.equal(created.admission.controllerGeneration, 1);
    assert.equal(created.controlEventId, undefined);

    const replay = admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.preemptionDisposition, "not_required");
    assert.equal(replay.admission.admissionId, created.admission.admissionId);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 0);
    db.close();
  });

  it("returns a structured no-mutation outcome for a normal active turn", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = seedHeartbeatSession(db, "operator-active-noop");
    const admissions = new SessionMutationAdmissionRepository(db);
    const active = admissions.admit({
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      expectedSessionIncarnationId: fixture.sessionIncarnationId,
      turnId: "normal-active-turn",
      runtimeOwnerId: "normal-active-runtime",
      admissionKind: "turn_write",
      aggregateRevision: fixture.aggregateRevision,
      controllerGeneration: 1,
      actorKind: "operator",
      actorId: "operator-heartbeat",
      operation: "chat_turn",
      materialSha256: sha256("normal-active-material"),
      idempotencyKey: "normal-active-admission",
      correlationId: "normal-active-turn",
    }).admission;
    const before = admissions.require(active.admissionId);

    const outcome = admissions.preemptHeartbeatAndAdmitOperatorTurn(
      operatorTurnAdmissionInput(fixture, "operator-active-noop", 1),
    );

    assert.deepEqual(outcome, {
      disposition: "not_preemptible",
      preemptionDisposition: "not_preemptible",
      recoveryOutcome: "not_preemptible",
      mutated: false,
      controllerGeneration: 1,
      activeAdmission: before,
    });
    assert.deepEqual(admissions.require(active.admissionId), before);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 0);
    assert.equal(readCountForSession(db, "chat_session_mutation_admissions", fixture.sessionId), 1);
    db.close();
  });

  it("reclaims and preempts an admitted heartbeat before atomically admitting the operator", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createClaimedHeartbeatFixture(db, "operator-prebind-preempt");
    forceAdmissionLeaseExpired(db, fixture.occurrence.admissionId);
    const expiredRequest = seedPendingControlRequest(db, fixture, "operator-prebind-expired", {
      createdOffsetMs: -120_000,
      expiresOffsetMs: -60_000,
    });
    const liveRequest = seedPendingControlRequest(db, fixture, "operator-prebind-live", {
      createdOffsetMs: -30_000,
      expiresOffsetMs: 600_000,
    });
    const input = operatorTurnAdmissionInput(fixture, "operator-prebind-preempt", 1);

    const created = fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(created.disposition, "created");
    assert.equal(created.preemptionDisposition, "preempted");
    assert.equal(created.controllerGeneration, 2);
    assert.equal(created.admission.controllerGeneration, 2);
    assert.equal(created.occurrenceId, fixture.occurrence.occurrenceId);
    assert.equal(created.heartbeatAdmissionId, fixture.occurrence.admissionId);
    assert.equal(created.durableRunId, undefined);
    assert.ok(created.controlEventId);

    const occurrence = fixture.occurrences.find(fixture.occurrence.occurrenceId);
    assert.equal(occurrence?.state, "abandoned");
    assert.equal(occurrence?.abandonmentReason, "admission_closed");
    assert.equal(occurrence?.boundDurableRunId, undefined);
    assert.equal(occurrence?.capabilityProfileId, undefined);
    assert.equal(occurrence?.capabilityProfileHash, undefined);
    const heartbeatAdmission = fixture.admissions.require(fixture.occurrence.admissionId);
    assert.equal(heartbeatAdmission.status, "cancelled");
    assert.equal(heartbeatAdmission.terminalAuthorityKind, "request_runtime");
    assert.equal(heartbeatAdmission.terminalControlEventId, undefined);
    assert.equal(heartbeatAdmission.runtimeLeaseRevision, 2);
    assertPreemptionClockEquality(db, {
      sessionId: fixture.sessionId,
      oldGeneration: 1,
      newGeneration: 2,
      controlEventId: created.controlEventId,
      heartbeatAdmissionId: fixture.occurrence.admissionId,
      occurrenceId: fixture.occurrence.occurrenceId,
    });
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 1);
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
      }>({ sessionId: fixture.sessionId });
    assert.deepEqual(
      cleanedRequests.map((request) => ({
        requestId: request.request_id,
        status: request.status,
        reason: request.decision_reason_code,
      })),
      [
        { requestId: expiredRequest.requestId, status: "expired", reason: "request_expired" },
        { requestId: liveRequest.requestId, status: "cancelled", reason: "request_cancelled" },
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
        sessionId: fixture.sessionId,
      });
    assert.deepEqual(
      cleanupEvents.map((event) => ({ requestId: event.request_id, reason: event.reason_code })),
      [
        { requestId: expiredRequest.requestId, reason: "request_expired" },
        { requestId: liveRequest.requestId, reason: "request_cancelled" },
        { requestId: null, reason: "heartbeat_preempted" },
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
        .get<{ count: number }>({ sessionId: fixture.sessionId })!.count,
      0,
    );

    const replay = fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.preemptionDisposition, "replayed");
    assert.equal(replay.controlEventId, created.controlEventId);
    assert.equal(replay.occurrenceId, created.occurrenceId);
    assert.equal(replay.admission.admissionId, created.admission.admissionId);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 1);
    const lostResponseReplay = fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn({
      ...input,
      expectedControllerGeneration: 2,
    });
    assert.equal(lostResponseReplay.disposition, "replayed");
    assert.equal(lostResponseReplay.preemptionDisposition, "replayed");
    assert.equal(lostResponseReplay.controlEventId, created.controlEventId);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 1);
    assert.throws(
      () =>
        fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn({
          ...input,
          expectedControllerGeneration: 3,
        }),
      /replay conflicts|heartbeat-preemption generation/iu,
    );
    assertRawHeartbeatPreemptionEventGuard(db, fixture, 2, "operator-prebind-preempt");
    assertRawHeartbeatPreemptionGrantGuard(db, "raw-grant");
    db.close();
  });

  it("keeps one canonical settlement clock across a delayed pre-bind preemption", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createClaimedHeartbeatFixture(db, "operator-prebind-delayed");
    forceAdmissionLeaseExpired(db, fixture.occurrence.admissionId);
    seedPendingControlRequest(db, fixture, "operator-prebind-delayed-expired", {
      createdOffsetMs: -120_000,
      expiresOffsetMs: -60_000,
    });
    seedPendingControlRequest(db, fixture, "operator-prebind-delayed-live", {
      createdOffsetMs: -30_000,
      expiresOffsetMs: 600_000,
    });
    const delayedDb = new RunHookDatabaseClient(
      db,
      (sql) => sql.includes("SET runtime_last_heartbeat_at = @preemptedAt"),
      () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_250),
    );
    const input = operatorTurnAdmissionInput(fixture, "operator-prebind-delayed", 1);
    const admissions = new SessionMutationAdmissionRepository(delayedDb);
    const startedAt = Date.now();
    const created = admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(delayedDb.hookCount, 1);
    assert.ok(Date.now() - startedAt >= 1_000);
    assert.equal(created.disposition, "created");
    assert.equal(created.preemptionDisposition, "preempted");
    assert.ok(created.controlEventId);
    assertPreemptionClockEquality(db, {
      sessionId: fixture.sessionId,
      oldGeneration: 1,
      newGeneration: 2,
      controlEventId: created.controlEventId,
      heartbeatAdmissionId: fixture.occurrence.admissionId,
      occurrenceId: fixture.occurrence.occurrenceId,
    });
    const settlementRows = db
      .prepare(
        `SELECT decided_at AS settled_at FROM chat_session_control_requests
         WHERE session_id = @sessionId
         UNION ALL
         SELECT created_at AS settled_at FROM chat_session_control_events
         WHERE session_id = @sessionId AND reason_code IN (
           'request_expired', 'request_cancelled', 'heartbeat_preempted'
         )`,
      )
      .all<{ settled_at: string }>({ sessionId: fixture.sessionId });
    assert.equal(settlementRows.length, 5);
    assert.equal(new Set(settlementRows.map((row) => row.settled_at)).size, 1);
    const settlementAt = settlementRows[0]!.settled_at;
    assert.notEqual(created.admission.createdAt, settlementAt);
    assert.ok(Date.parse(created.admission.createdAt) - Date.parse(settlementAt) >= 1_000);
    const replay = admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.preemptionDisposition, "replayed");
    assert.equal(replay.controlEventId, created.controlEventId);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 1);
    db.close();
  });

  it("fails closed before mutating when pending control cleanup exceeds its atomic bound", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createClaimedHeartbeatFixture(db, "operator-prebind-pending-bound");
    forceAdmissionLeaseExpired(db, fixture.occurrence.admissionId);
    seedManyPendingControlRequests(db, fixture, "operator-prebind-pending-bound", 257);
    const beforeAdmission = fixture.admissions.require(fixture.occurrence.admissionId);
    assert.throws(
      () =>
        fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(
          operatorTurnAdmissionInput(fixture, "operator-prebind-pending-bound", 1),
        ),
      /too many pending session-control requests/iu,
    );
    assert.deepEqual(fixture.admissions.require(fixture.occurrence.admissionId), beforeAdmission);
    assert.equal(fixture.occurrences.find(fixture.occurrence.occurrenceId)?.state, "admitted");
    assert.equal(readCurrentControlGeneration(db, fixture.sessionId), 1);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 0);
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_requests
           WHERE session_id = @sessionId AND status = 'pending'`,
        )
        .get<{ count: number }>({ sessionId: fixture.sessionId })!.count,
      257,
    );
    assert.equal(readCountForSession(db, "chat_session_mutation_admissions", fixture.sessionId), 1);
    db.close();
  });

  it("preempts a durable-bound heartbeat with retained provenance and one atomic clock", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createBoundHeartbeatFixture(db, "operator-bound-preempt");
    const bound = fixture.markBound();
    assert.equal(bound.disposition, "created");
    const cadenceBefore = new SessionAutonomyPrefsRepository(db).get(fixture.sessionId);
    const input = operatorTurnAdmissionInput(fixture, "operator-bound-preempt", 1);

    const created = fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(created.disposition, "created");
    assert.equal(created.preemptionDisposition, "preempted");
    assert.equal(created.controllerGeneration, 2);
    assert.equal(created.durableRunId, fixture.occurrence.durableRunId);
    assert.ok(created.controlEventId);

    const occurrence = fixture.occurrences.find(fixture.occurrence.occurrenceId);
    assert.equal(occurrence?.state, "abandoned");
    assert.equal(occurrence?.abandonmentReason, "authority_drift");
    assert.equal(occurrence?.boundDurableRunId, fixture.occurrence.durableRunId);
    assert.equal(occurrence?.capabilityProfileId, fixture.profileId);
    assert.equal(occurrence?.capabilityProfileHash, fixture.profileHash);
    const heartbeatAdmission = fixture.admissions.require(fixture.occurrence.admissionId);
    assert.equal(heartbeatAdmission.status, "cancelled");
    assert.equal(heartbeatAdmission.terminalAuthorityKind, "authority_superseded");
    assert.equal(heartbeatAdmission.terminalControlEventId, created.controlEventId);
    const durableRun = new DurableRunRepository(db).getRun(fixture.occurrence.durableRunId);
    assert.equal(durableRun.status, "cancelled");
    assert.equal(durableRun.leaseOwnerId, undefined);
    assert.equal(durableRun.leaseExpiresAt, undefined);
    assert.equal(durableRun.leaseHeartbeatAt, undefined);
    assert.equal(durableRun.finishedAt, durableRun.updatedAt);
    assertPreemptionClockEquality(db, {
      sessionId: fixture.sessionId,
      oldGeneration: 1,
      newGeneration: 2,
      controlEventId: created.controlEventId,
      heartbeatAdmissionId: fixture.occurrence.admissionId,
      occurrenceId: fixture.occurrence.occurrenceId,
      durableRunId: fixture.occurrence.durableRunId,
    });
    const cadenceAfter = new SessionAutonomyPrefsRepository(db).get(fixture.sessionId);
    assert.equal(cadenceAfter?.lastProactiveAt, cadenceBefore?.lastProactiveAt);
    assert.equal(cadenceAfter?.lastProactiveRunId, cadenceBefore?.lastProactiveRunId);

    const replay = fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.preemptionDisposition, "replayed");
    assert.equal(replay.controlEventId, created.controlEventId);
    assert.equal(replay.durableRunId, fixture.occurrence.durableRunId);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 1);
    db.close();
  });

  it("returns a no-mutation decision-committed outcome for silent and notifying heartbeats", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    for (const notify of [false, true] as const) {
      const seed = `decision-committed-${notify ? "notify" : "silent"}`;
      const fixture = createBoundHeartbeatFixture(db, seed);
      fixture.markBound();
      persistHeartbeatDecisionCommit(fixture, notify);
      const input = operatorTurnAdmissionInput(fixture, seed, 1);
      const beforeRun = new DurableRunRepository(db).getRun(fixture.occurrence.durableRunId);
      const beforeCadence = new SessionAutonomyPrefsRepository(db).get(fixture.sessionId);

      const outcome = fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input);
      assert.deepEqual(outcome, {
        disposition: "decision_committed",
        preemptionDisposition: "decision_committed",
        controllerGeneration: 1,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        sessionIncarnationId: fixture.sessionIncarnationId,
        turnId: fixture.occurrence.turnId,
        occurrenceId: fixture.occurrence.occurrenceId,
        heartbeatAdmissionId: fixture.occurrence.admissionId,
        durableRunId: fixture.occurrence.durableRunId,
      });
      assert.deepEqual(fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input), outcome);
      assert.equal(fixture.admissions.require(fixture.occurrence.admissionId).status, "active");
      assert.equal(fixture.occurrences.find(fixture.occurrence.occurrenceId)?.state, "durable_bound");
      assert.deepEqual(new DurableRunRepository(db).getRun(fixture.occurrence.durableRunId), beforeRun);
      assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 0);
      assert.equal(readCountForSession(db, "chat_session_mutation_admissions", fixture.sessionId), 1);
      assert.equal(readCurrentControlGeneration(db, fixture.sessionId), 1);
      const afterCadence = new SessionAutonomyPrefsRepository(db).get(fixture.sessionId);
      assert.equal(afterCadence?.lastProactiveAt, beforeCadence?.lastProactiveAt);
      assert.equal(afterCadence?.lastProactiveRunId, beforeCadence?.lastProactiveRunId);
    }
    db.close();
  });

  it("rejects partial, malformed, repaired, and unpaired durable heartbeat decision evidence", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    for (const fault of [
      "raw_only",
      "receipt_drift",
      "trace_incomplete",
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
      const fixture = createBoundHeartbeatFixture(db, `decision-fault-${fault}`);
      fixture.markBound();
      persistMalformedHeartbeatDecisionState(fixture, fault);
      const input = operatorTurnAdmissionInput(fixture, `decision-fault-${fault}`, 1);
      assert.throws(
        () => fixture.admissions.preemptHeartbeatAndAdmitOperatorTurn(input),
        /decision evidence|decision pair|one-sided|pre-decision|durable turn authority/iu,
      );
      assert.equal(fixture.admissions.require(fixture.occurrence.admissionId).status, "active");
      assert.equal(fixture.occurrences.find(fixture.occurrence.occurrenceId)?.state, "durable_bound");
      assert.equal(new DurableRunRepository(db).getRun(fixture.occurrence.durableRunId).status, "running");
      assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 0);
      assert.equal(readCountForSession(db, "chat_session_mutation_admissions", fixture.sessionId), 1);
      assert.equal(readCurrentControlGeneration(db, fixture.sessionId), 1);
    }
    db.close();
  });

  it("parks an expired admitted heartbeat without changing control authority", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createClaimedHeartbeatFixture(db, "execution-disabled");
    forceAdmissionLeaseExpired(db, fixture.occurrence.admissionId);
    const input = {
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      occurrenceId: fixture.occurrence.occurrenceId,
      admissionId: fixture.occurrence.admissionId,
      claimSha256: fixture.occurrence.claimSha256,
      idempotencyKey: `heartbeat:execution-disabled:${fixture.occurrence.occurrenceId}`,
      correlationId: `heartbeat:execution-disabled:${fixture.occurrence.occurrenceId}`,
    };

    const parked = fixture.admissions.abandonAdmittedHeartbeatForExecutionDisabled(input);
    assert.equal(parked.disposition, "parked");
    assert.equal(parked.admission.status, "cancelled");
    assert.equal(parked.admission.terminalAuthorityKind, "request_runtime");
    assert.equal(parked.admission.runtimeLeaseRevision, 2);
    const occurrence = fixture.occurrences.find(fixture.occurrence.occurrenceId);
    assert.equal(occurrence?.state, "abandoned");
    assert.equal(occurrence?.abandonmentReason, "admission_closed");
    assert.equal(parked.admission.closedAt, occurrence?.abandonedAt);
    assert.equal(readHeartbeatPreemptionEventCount(db, fixture.sessionId), 0);
    const currentGrant = db
      .prepare(
        `SELECT generation, owner_kind, lease_state FROM chat_session_control_grants
         WHERE workspace_id = @workspaceId AND session_id = @sessionId AND is_current = 1`,
      )
      .get<{ generation: number; owner_kind: string; lease_state: string }>({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
      });
    assert.equal(currentGrant?.generation, 1);
    assert.equal(currentGrant?.owner_kind, "operator");
    assert.equal(currentGrant?.lease_state, "operator_active");

    const replay = fixture.admissions.abandonAdmittedHeartbeatForExecutionDisabled(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.admission.admissionId, parked.admission.admissionId);
    db.close();
  });

  it("rechecks an open occurrence after candidate selection before generic cleanup", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = seedHeartbeatSession(db, "cleanup-race");
    const admissions = new SessionMutationAdmissionRepository(db);
    const directAdmission = admissions.admit({
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      expectedSessionIncarnationId: fixture.sessionIncarnationId,
      turnId: "turn-cleanup-race",
      runtimeOwnerId: "runtime-cleanup-race",
      admissionKind: "turn_write",
      aggregateRevision: fixture.aggregateRevision,
      controllerGeneration: 1,
      actorKind: "system",
      actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
      operation: HEARTBEAT_ADMISSION_OPERATION,
      materialSha256: fixture.frozenRequestSha256,
      idempotencyKey: "admission:cleanup-race",
      correlationId: "occurrence-cleanup-race",
    }).admission;
    forceAdmissionLeaseExpired(db, directAdmission.admissionId);

    const hooked = new CandidateHookDatabaseClient(db, () => {
      seedOpenOccurrenceAfterCandidateSelection(db, fixture, directAdmission);
    });
    const cleanup = new SessionMutationAdmissionRepository(hooked).cancelExpiredUnboundTurnAdmissions({
      actorId: "system:cleanup",
      idempotencyKeyPrefix: "cleanup:expired",
      correlationId: "cleanup-race",
      limit: 10,
    });
    assert.equal(hooked.hookCount, 1);
    assert.deepEqual(cleanup.cancelledAdmissionIds, []);
    assert.equal(admissions.require(directAdmission.admissionId).status, "active");
    assert.equal(
      db
        .prepare("SELECT state FROM chat_heartbeat_occurrences WHERE admission_id = @admissionId")
        .get<{ state: string }>({
          admissionId: directAdmission.admissionId,
        })?.state,
      "admitted",
    );
    db.close();
  });

  it("serializes two workers into one committed heartbeat occurrence", { timeout: 120_000 }, async () => {
    const dbPath = tempDatabasePath("worker-race");
    const setup = createDatabase({ dbPath });
    const fixture = seedHeartbeatSession(setup, "worker-race");
    setup.close();

    const race = await runHeartbeatClaimRace(dbPath, fixture.claimInput);
    assert.equal(race.filter((item) => item.ok).length, 2, JSON.stringify(race));
    assert.deepEqual(race.map((item) => item.disposition).sort(), ["created", "replayed"]);
    assert.equal(new Set(race.map((item) => item.occurrenceId)).size, 1);

    const verify = createDatabase({ dbPath });
    assert.equal(readCount(verify, "chat_heartbeat_occurrences"), 1);
    assert.equal(readCount(verify, "chat_session_mutation_admissions"), 1);
    const occurrence = new HeartbeatOccurrenceRepository(verify).listRecoverable();
    assert.equal(occurrence.length, 1);
    assert.equal(
      new SessionAutonomyPrefsRepository(verify).get(fixture.sessionId)?.lastProactiveRunId,
      occurrence[0]?.occurrenceId,
    );
    verify.close();
  });
});

function seedHeartbeatSession(db: DatabaseClient, seed: string) {
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
    frozenRequestSha256,
    claimInput,
  };
}

function operatorTurnAdmissionInput(
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

function seedPendingControlRequest(
  db: DatabaseClient,
  fixture: { workspaceId: string; sessionId: string },
  seed: string,
  offsets: { createdOffsetMs: number; expiresOffsetMs: number },
): { requestId: string; tokenSha256: string } {
  const requestId = `control-request-${seed}`;
  const tokenSha256 = sha256(`control-token:${seed}`);
  const createdAt = new Date(Date.now() + offsets.createdOffsetMs).toISOString();
  const expiresAt = new Date(Date.now() + offsets.expiresOffsetMs).toISOString();
  const triggerName = "trg_chat_session_control_requests_insert_guard";
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = @triggerName")
    .get<{ sql: string }>({ triggerName });
  assert.ok(trigger?.sql);
  db.exec(`DROP TRIGGER ${triggerName}`);
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
    db.exec(trigger.sql);
  }
  return { requestId, tokenSha256 };
}

function seedManyPendingControlRequests(
  db: DatabaseClient,
  fixture: { workspaceId: string; sessionId: string },
  seed: string,
  count: number,
): void {
  const triggerName = "trg_chat_session_control_requests_insert_guard";
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = @triggerName")
    .get<{ sql: string }>({ triggerName });
  assert.ok(trigger?.sql);
  const createdAt = new Date(Date.now() - 30_000).toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  db.exec(`DROP TRIGGER ${triggerName}`);
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
    db.exec(trigger.sql);
  }
}

function readHeartbeatPreemptionEventCount(db: DatabaseClient, sessionId: string): number {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM chat_session_control_events
       WHERE session_id = @sessionId AND reason_code = 'heartbeat_preempted'`,
    )
    .get<{ count: number }>({ sessionId })!.count;
}

function readCountForSession(db: DatabaseClient, table: string, sessionId: string): number {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = @sessionId`)
    .get<{ count: number }>({ sessionId })!.count;
}

function readCurrentControlGeneration(db: DatabaseClient, sessionId: string): number {
  return db
    .prepare(
      `SELECT generation FROM chat_session_control_grants
       WHERE session_id = @sessionId AND is_current = 1`,
    )
    .get<{ generation: number }>({ sessionId })!.generation;
}

function assertRawHeartbeatPreemptionEventGuard(
  db: DatabaseClient,
  fixture: { workspaceId: string; sessionId: string },
  generation: number,
  seed: string,
): void {
  const createdAt = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!.now;
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

function assertRawHeartbeatPreemptionGrantGuard(db: DatabaseClient, seed: string): void {
  const fixture = seedHeartbeatSession(db, seed);
  const transitionedAt = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!.now;
  const triggerName = "trg_chat_session_control_grants_update_guard";
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = @triggerName")
    .get<{ sql: string }>({ triggerName });
  assert.ok(trigger?.sql);
  db.exec(`DROP TRIGGER ${triggerName}`);
  try {
    db.prepare(
      `UPDATE chat_session_control_grants
       SET is_current = 0, lease_state = 'superseded', control_revision = control_revision + 1,
           updated_at = @transitionedAt, terminal_at = @transitionedAt
       WHERE workspace_id = @workspaceId AND session_id = @sessionId
         AND generation = 1 AND is_current = 1`,
    ).run({ transitionedAt, workspaceId: fixture.workspaceId, sessionId: fixture.sessionId });
  } finally {
    db.exec(trigger.sql);
  }
  const idempotencyKey = `invalid-heartbeat-grant:${seed}`;
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
          requestSha256: sha256(idempotencyKey),
          createdAt: transitionedAt,
        }),
    /operator heartbeat-preemption generation lacks its exact event/iu,
  );
}

function persistHeartbeatDecisionCommit(
  fixture: ReturnType<typeof createBoundHeartbeatFixture>,
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
  writeHeartbeatDecisionWindow(fixture, {
    metadata: { heartbeatDecisionRawOutput: rawOutput, heartbeatDecisionReceipt: receipt },
    completedTrace: true,
    ...(normalizedMessage ? { assistantMessage: normalizedMessage } : {}),
  });
}

function persistMalformedHeartbeatDecisionState(
  fixture: ReturnType<typeof createBoundHeartbeatFixture>,
  fault:
    | "raw_only"
    | "receipt_drift"
    | "trace_incomplete"
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
    writeHeartbeatDecisionWindow(fixture, {
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
        .run({ sessionId: `${fixture.sessionId}-drift`, turnId: fixture.occurrence.turnId });
    } else if (fault === "approval_wait_without_pair" || fault === "user_input_wait_without_pair") {
      fixture.db.prepare("UPDATE chat_turn_traces SET status = @status WHERE turn_id = @turnId").run({
        status: fault === "approval_wait_without_pair" ? "waiting_for_approval" : "waiting_for_user_input",
        turnId: fixture.occurrence.turnId,
      });
    }
    return;
  }
  writeHeartbeatDecisionWindow(fixture, {
    metadata:
      fault === "raw_only"
        ? { heartbeatDecisionRawOutput: rawOutput }
        : {
            heartbeatDecisionRawOutput: rawOutput,
            heartbeatDecisionReceipt: fault === "receipt_drift" ? { ...receipt, claimSha256: "f".repeat(64) } : receipt,
          },
    completedTrace: fault !== "trace_incomplete",
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

function writeHeartbeatDecisionWindow(
  fixture: ReturnType<typeof createBoundHeartbeatFixture>,
  input: {
    metadata: Record<string, unknown>;
    completedTrace: boolean;
    assistantMessage?: string;
  },
): void {
  const now = new Date().toISOString();
  const runs = new DurableRunRepository(fixture.db);
  const current = runs.getRun(fixture.occurrence.durableRunId);
  runs.updateRun({
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
      sessionId: fixture.sessionId,
      role: "assistant",
      actorType: "system",
      actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
      content: input.assistantMessage,
      timestamp: now,
    });
  }
}

function assertPreemptionClockEquality(
  db: DatabaseClient,
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
         CASE WHEN @durableRunId IS NULL THEN NULL ELSE
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

function forceLegacyNullLifecycleIntent(db: DatabaseClient, sessionId: string): void {
  forceLifecycleIntent(db, sessionId, null);
}

function forceLifecycleIntent(db: DatabaseClient, sessionId: string, lifecycleIntentId: string | null): void {
  const trigger = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_chat_session_meta_workspace_and_intent_update_guard'`,
    )
    .get<{ sql: string }>();
  assert.ok(trigger?.sql);
  db.exec("DROP TRIGGER trg_chat_session_meta_workspace_and_intent_update_guard");
  try {
    db.prepare(
      "UPDATE chat_session_meta SET lifecycle_intent_id = @lifecycleIntentId WHERE session_id = @sessionId",
    ).run({ lifecycleIntentId, sessionId });
  } finally {
    db.exec(trigger.sql);
  }
}

function createClaimedHeartbeatFixture(db: DatabaseClient, seed: string) {
  const seeded = seedHeartbeatSession(db, seed);
  const admissions = new SessionMutationAdmissionRepository(db);
  const occurrences = new HeartbeatOccurrenceRepository(db);
  const claimed = occurrences.claim(seeded.claimInput, (request) => ({
    admission: admissions.admit(request.admissionInput).admission,
    child: request.child,
  }));
  if (claimed.disposition !== "created") throw new Error(`expected created heartbeat, got ${claimed.disposition}`);
  return { ...seeded, admissions, occurrences, occurrence: claimed.occurrence };
}

function createBoundHeartbeatFixture(db: DatabaseClient, seed: string) {
  const claimed = createClaimedHeartbeatFixture(db, seed);
  const profileId = `profile-hb-${seed}`;
  const profileHash = sha256(`profile:${seed}`);
  const profileCreatedAt = new Date().toISOString();
  db.transaction("immediate", () => {
    claimed.admissions.bindCapabilityProfile({
      admissionId: claimed.occurrence.admissionId,
      workspaceId: claimed.workspaceId,
      sessionId: claimed.sessionId,
      sessionIncarnationId: claimed.sessionIncarnationId,
      turnId: claimed.occurrence.turnId,
      profileId,
      profileHash,
      createdAt: profileCreatedAt,
      requestRuntimeClaim: {
        runtimeOwnerId: claimed.occurrence.runtimeOwnerId,
        leaseRevision: 1,
      },
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
      turnId: claimed.occurrence.turnId,
      sessionId: claimed.sessionId,
      workspaceId: claimed.workspaceId,
      durableRunId: claimed.occurrence.durableRunId,
      profileHash,
      snapshotId: `snapshot-hb-${seed}`,
      createdAt: profileCreatedAt,
    });
  });

  const payload = {
    version: "chat.turn.execute.v2",
    heartbeatOccurrenceId: claimed.occurrence.occurrenceId,
    heartbeatClaimSha256: claimed.occurrence.claimSha256,
    heartbeatEvaluatedPolicySha256: claimed.occurrence.evaluatedPolicySha256,
    heartbeatFrozenObjectiveSha256: claimed.occurrence.frozenObjectiveSha256,
    admissionId: claimed.occurrence.admissionId,
    sessionIncarnationId: claimed.sessionIncarnationId,
    admissionMaterialSha256: claimed.frozenRequestSha256,
    workspaceId: claimed.workspaceId,
    admissionAggregateRevision: claimed.aggregateRevision,
    admissionControllerGeneration: 1,
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({
        version: 1,
        admissionMaterialSha256: claimed.frozenRequestSha256,
        request: claimed.request,
      }),
    ),
    requestActor: { actorKind: "system", actorId: HEARTBEAT_SYSTEM_ACTOR_ID },
    sessionId: claimed.sessionId,
    turnId: claimed.occurrence.turnId,
    userMessageId: claimed.occurrence.userMessageId,
    assistantMessageId: claimed.occurrence.assistantMessageId,
    capabilityProfileId: profileId,
    capabilityProfileHash: profileHash,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: claimed.request,
    userInputResponses: [],
  };
  const now = new Date().toISOString();
  new DurableRunRepository(db).createRun({
    runId: claimed.occurrence.durableRunId,
    workflowKey: "chat.turn.execute",
    payload,
    metadata: {},
    now,
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
    turnId: claimed.occurrence.turnId,
    sessionId: claimed.sessionId,
    userMessageId: claimed.occurrence.userMessageId,
    assistantMessageId: claimed.occurrence.assistantMessageId,
    startedAt: now,
  });
  claimed.admissions.bindDurableRun({
    admissionId: claimed.occurrence.admissionId,
    workspaceId: claimed.workspaceId,
    sessionId: claimed.sessionId,
    sessionIncarnationId: claimed.sessionIncarnationId,
    turnId: claimed.occurrence.turnId,
    durableRunId: claimed.occurrence.durableRunId,
    requestRuntimeClaim: { runtimeOwnerId: claimed.occurrence.runtimeOwnerId, leaseRevision: 1 },
  });
  const exactIdentity = {
    occurrenceId: claimed.occurrence.occurrenceId,
    workspaceId: claimed.workspaceId,
    sessionId: claimed.sessionId,
    sessionIncarnationId: claimed.sessionIncarnationId,
    admissionId: claimed.occurrence.admissionId,
    turnId: claimed.occurrence.turnId,
    durableRunId: claimed.occurrence.durableRunId,
  };
  const boundIdentity = { ...exactIdentity, capabilityProfileId: profileId, capabilityProfileHash: profileHash };
  return {
    ...claimed,
    db,
    profileId,
    profileHash,
    payload,
    exactIdentity,
    boundIdentity,
    markBound: () => claimed.occurrences.markDurableBound(boundIdentity),
  };
}

function writeTerminalRunAndTrace(
  fixture: ReturnType<typeof createBoundHeartbeatFixture>,
  status: "completed" | "failed" | "cancelled" | "dead_lettered",
  options: { notify?: boolean } = {},
): void {
  const committedAt = new Date().toISOString();
  const childRunIds: string[] = [];
  const traceStatus = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
  const postCommitEligibility = {
    version: 1 as const,
    autonomyEnabledAtParentSettlement: false,
    evalIntegrityTurn: false,
    humanSession: false,
  };
  const marker = {
    version: 1,
    admissionId: fixture.occurrence.admissionId,
    sessionIncarnationId: fixture.sessionIncarnationId,
    turnId: fixture.occurrence.turnId,
    parentRunId: fixture.occurrence.durableRunId,
    postCommitGenerationId: `generation-${fixture.occurrence.occurrenceId}`,
    parentLocalEffectsStatus: "settled",
    childRunIds,
    childRunIdsSha256: sha256(canonicalJsonString(childRunIds)),
    committedAt,
  };
  const generalChatPostCommit = {
    generationId: marker.postCommitGenerationId,
    traceStatus,
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
  };
  const outputText = "Canonical heartbeat completion.";
  const outputSummary = "Canonical heartbeat completion.";
  const notify = options.notify ?? false;
  const heartbeatDecisionRawOutput = notify
    ? JSON.stringify({ notify: true, message: `  ${outputText}  ` })
    : JSON.stringify({ notify: false });
  const heartbeatDecisionReceipt = {
    version: 1,
    occurrenceId: fixture.occurrence.occurrenceId,
    claimSha256: fixture.occurrence.claimSha256,
    rawOutputSha256: sha256(heartbeatDecisionRawOutput),
    notify,
    normalizedMessageSha256: notify ? sha256(outputText) : null,
  };
  const terminalOutput =
    status === "completed" && notify
      ? {
          assistantMessageId: fixture.occurrence.assistantMessageId,
          outputTextSha256: sha256(canonicalJsonString(outputText)),
          outputSummarySha256: sha256(canonicalJsonString(outputSummary)),
        }
      : null;
  const authorityMaterial = {
    version: "chat.turn.runtime-authority.v1",
    runId: fixture.occurrence.durableRunId,
    turnId: fixture.occurrence.turnId,
    transitionKind: "terminal",
    durableStatus: status,
    traceStatus,
    transitionAt: committedAt,
    postCommitGenerationId: marker.postCommitGenerationId,
    postCommitEligibility,
    waitForEvent: null,
    terminalOutput,
    linkedFinalization: null,
    requiredFinalizers: status === "completed" ? ["autonomous", "general"] : ["general"],
    ...(status === "completed" ? { heartbeatDecisionReceipt } : {}),
  };
  const chatTurnRuntimeAuthority = {
    material: authorityMaterial,
    materialSha256: sha256(canonicalJsonString(authorityMaterial)),
  };
  const autonomous = {
    kind: "heartbeat",
    systemActorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    sourceRunId: `source-${fixture.occurrence.occurrenceId}`,
    reason: `heartbeat self-wake:${fixture.sessionId}`,
    deliverMode: "on_notify",
  };
  const autonomousAdmissionMaterial = {
    version: "chat.autonomous.admission.v1",
    identity: {
      userMessageId: fixture.occurrence.userMessageId,
      turnId: fixture.occurrence.turnId,
      assistantMessageId: fixture.occurrence.assistantMessageId,
      durableRunId: fixture.occurrence.durableRunId,
    },
    sessionId: fixture.sessionId,
    objectiveSha256: sha256(canonicalJsonString((fixture.payload.request as { content: string }).content)),
    autonomous,
    admission: {
      admissionId: fixture.payload.admissionId,
      sessionIncarnationId: fixture.payload.sessionIncarnationId,
      workspaceId: fixture.payload.workspaceId,
      admissionMaterialSha256: fixture.payload.admissionMaterialSha256,
      effectiveRequestMaterialSha256: fixture.payload.effectiveRequestMaterialSha256,
    },
    capability: {
      profileId: fixture.profileId,
      profileHash: fixture.profileHash,
      snapshotId: `snapshot-${fixture.occurrence.occurrenceId}`,
    },
    cronAdmission: null,
  };
  const autonomousAdmission = {
    material: autonomousAdmissionMaterial,
    materialSha256: sha256(canonicalJsonString(autonomousAdmissionMaterial)),
  };
  const metadata = {
    objective: (fixture.payload.request as { content: string }).content,
    autonomous,
    capabilityProfileId: fixture.profileId,
    capabilityProfileHash: fixture.profileHash,
    autonomousAdmission,
    generalChatPostCommit,
    chatTurnAdmissionHandoff: marker,
    chatTurnRuntimeAuthority,
    ...(status === "completed"
      ? {
          autonomousChatPostCommit: {
            delivery: { status: "skipped", reason: "not_required" },
            heartbeatCleanup: { status: "not_required" },
            generationId: marker.postCommitGenerationId,
            requestedAt: committedAt,
            completedAt: committedAt,
          },
          heartbeatDecisionRawOutput,
          heartbeatDecisionReceipt,
          ...(notify ? { outputText, finalOutput: outputText, outputSummary, finalSummary: outputSummary } : {}),
        }
      : {}),
  };
  const runs = new DurableRunRepository(fixture.db);
  const current = runs.getRun(fixture.occurrence.durableRunId);
  runs.updateRun({
    runId: current.runId,
    status,
    finishedAt: committedAt,
    clearLease: true,
    metadata,
    updatedAt: committedAt,
    expectedVersion: current.version,
  });
  runs.createCheckpoint({
    checkpointId: `checkpoint-${fixture.occurrence.occurrenceId}-${status}`,
    runId: fixture.occurrence.durableRunId,
    checkpointKind: status === "completed" ? "run_completed" : status === "cancelled" ? "run_cancelled" : "run_failed",
    state: {
      chatTurnRuntimeAuthority,
      ...(status === "completed"
        ? {
            heartbeatDecisionRawOutput,
            heartbeatDecisionReceipt,
            ...(notify ? { assistantMessageId: fixture.occurrence.assistantMessageId, outputText, outputSummary } : {}),
          }
        : {}),
    },
    createdAt: committedAt,
  });
  if (status === "completed" && notify) {
    new ChatMessageRepository(fixture.db).upsert({
      messageId: fixture.occurrence.assistantMessageId,
      sessionId: fixture.sessionId,
      role: "assistant",
      actorType: "system",
      actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
      content: outputText,
      timestamp: committedAt,
    });
  }
  fixture.db
    .prepare(
      `UPDATE chat_turn_traces
     SET status = @status, finished_at = @finishedAt, durable_json = @durableJson
     WHERE turn_id = @turnId`,
    )
    .run({
      status: traceStatus,
      finishedAt: committedAt,
      durableJson: JSON.stringify({
        runId: fixture.occurrence.durableRunId,
        status,
        checkpointKind:
          status === "completed" ? "run_completed" : status === "cancelled" ? "run_cancelled" : "run_failed",
      }),
      turnId: fixture.occurrence.turnId,
    });
}

function settleDurableHeartbeat(
  fixture: ReturnType<typeof createBoundHeartbeatFixture>,
  status: "completed" | "failed" | "cancelled",
  options: { notify?: boolean } = {},
): void {
  writeTerminalRunAndTrace(fixture, status, options);
  const closed = fixture.admissions.closeTurnWrite({
    ...fixture.exactIdentity,
    status: status === "completed" ? "completed" : "cancelled",
    actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    idempotencyKey: `close:${fixture.occurrence.occurrenceId}`,
    correlationId: fixture.occurrence.durableRunId,
  });
  assert.equal(closed.terminalAuthorityKind, "durable_terminal");
  assert.equal(closed.terminalDurableRunStatus, status);
}

function readRunMetadata(db: DatabaseClient, runId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT metadata_json FROM durable_runs WHERE run_id = @runId")
    .get<{ metadata_json: string }>({ runId });
  assert.ok(row);
  return JSON.parse(row.metadata_json) as Record<string, unknown>;
}

function writeRunMetadata(db: DatabaseClient, runId: string, metadata: Record<string, unknown>): void {
  db.prepare("UPDATE durable_runs SET metadata_json = @metadataJson WHERE run_id = @runId").run({
    runId,
    metadataJson: JSON.stringify(metadata),
  });
}

function rawTerminalTransition(db: DatabaseClient, fixture: ReturnType<typeof createBoundHeartbeatFixture>): void {
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

function seedOpenOccurrenceAfterCandidateSelection(
  db: DatabaseClient,
  fixture: ReturnType<typeof seedHeartbeatSession>,
  admission: ReturnType<SessionMutationAdmissionRepository["require"]>,
): void {
  const clock = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!;
  const occurrenceId = admission.correlationId;
  db.prepare(
    `UPDATE session_autonomy_prefs
     SET last_proactive_at = @claimedAt, last_proactive_run_id = @occurrenceId, updated_at = @claimedAt
     WHERE session_id = @sessionId`,
  ).run({ claimedAt: clock.now, occurrenceId, sessionId: fixture.sessionId });
  db.prepare(
    `INSERT INTO chat_heartbeat_occurrences (
       occurrence_id, workspace_id, session_id, session_incarnation_id,
       admission_id, admission_request_sha256, admission_idempotency_key, admission_correlation_id,
       runtime_owner_id, system_actor_id, admission_material_sha256,
       evaluated_policy_sha256, frozen_request_sha256, frozen_objective_sha256, claim_sha256,
       aggregate_revision, controller_generation, prior_last_proactive_at, prior_last_proactive_run_id,
       heartbeat_interval_seconds, cooldown_seconds, idle_floor_seconds, observed_session_activity_at,
       user_message_id, assistant_message_id, turn_id, expected_durable_run_id, durable_run_id,
       capability_profile_id, capability_profile_hash, state, revision, claimed_at,
       durable_bound_at, terminal_at, abandoned_at, terminal_status, terminal_handoff_sha256,
       abandonment_reason, updated_at
     ) VALUES (
       @occurrenceId, @workspaceId, @sessionId, @sessionIncarnationId,
       @admissionId, @admissionRequestSha256, @admissionIdempotencyKey, @admissionCorrelationId,
       @runtimeOwnerId, @systemActorId, @materialSha256,
       @evaluatedPolicySha256, @materialSha256, @frozenObjectiveSha256, @claimSha256,
       @aggregateRevision, @controllerGeneration, NULL, NULL,
       900, 0, 0, @claimedAt,
       @userMessageId, @assistantMessageId, @turnId, @expectedDurableRunId, NULL,
       NULL, NULL, 'admitted', 1, @claimedAt,
       NULL, NULL, NULL, NULL, NULL, NULL, @claimedAt
     )`,
  ).run({
    occurrenceId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    sessionIncarnationId: fixture.sessionIncarnationId,
    admissionId: admission.admissionId,
    admissionRequestSha256: admission.requestSha256,
    admissionIdempotencyKey: admission.idempotencyKey,
    admissionCorrelationId: admission.correlationId,
    runtimeOwnerId: admission.runtimeOwnerId,
    systemActorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    materialSha256: admission.materialSha256,
    evaluatedPolicySha256: fixture.claimInput.evaluatedPolicySha256,
    frozenObjectiveSha256: fixture.claimInput.frozenObjectiveSha256,
    claimSha256: sha256("cleanup-race-claim"),
    aggregateRevision: admission.aggregateRevision,
    controllerGeneration: admission.controllerGeneration,
    claimedAt: clock.now,
    userMessageId: "message-cleanup-race-user",
    assistantMessageId: "message-cleanup-race-assistant",
    turnId: admission.turnId,
    expectedDurableRunId: "run-cleanup-race",
  });
}

class CandidateHookDatabaseClient implements DatabaseClient {
  public readonly dialect = "sqlite" as const;
  public hookCount = 0;

  public constructor(
    private readonly delegate: DatabaseClient,
    private readonly hook: () => void,
  ) {}

  public prepare(sql: string): DbStatement {
    const statement = this.delegate.prepare(sql);
    if (
      sql.includes("FROM chat_session_mutation_admissions admission") &&
      sql.includes("ORDER BY admission.session_id ASC")
    ) {
      return {
        run: (...params: DbBindParams[]) => statement.run(...params),
        get: <T>(...params: DbBindParams[]) => statement.get<T>(...params),
        all: <T>(...params: DbBindParams[]) => {
          const rows = statement.all<T>(...params);
          if (this.hookCount === 0 && rows.length > 0) {
            this.hookCount += 1;
            this.hook();
          }
          return rows;
        },
      };
    }
    return statement;
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

function readCount(db: DatabaseClient, table: string): number {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()!.count;
}

function forceAdmissionLeaseExpired(db: DatabaseClient, admissionId: string): void {
  const triggerName = "trg_chat_session_mutation_admissions_update_guard";
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = @triggerName")
    .get<{ sql: string }>({ triggerName });
  assert.ok(trigger?.sql);
  db.exec(`DROP TRIGGER ${triggerName}`);
  try {
    db.prepare(
      `UPDATE chat_session_mutation_admissions
       SET runtime_last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 seconds'),
           runtime_lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
       WHERE admission_id = @admissionId`,
    ).run({ admissionId });
  } finally {
    db.exec(trigger.sql);
  }
}

function tempDatabasePath(seed: string): string {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-heartbeat-${seed}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return dbPath;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface HeartbeatWorkerResult {
  ok: boolean;
  disposition?: "created" | "replayed";
  occurrenceId?: string;
  error?: string;
}

async function runHeartbeatClaimRace(
  dbPath: string,
  claimInput: ClaimHeartbeatOccurrenceInput,
): Promise<[HeartbeatWorkerResult, HeartbeatWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = ["left", "right"].map((contender) =>
    runHeartbeatClaimWorker(dbPath, claimInput, contender, startSignal),
  ) as [ReturnType<typeof runHeartbeatClaimWorker>, ReturnType<typeof runHeartbeatClaimWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[HeartbeatWorkerResult, HeartbeatWorkerResult]>;
}

function runHeartbeatClaimWorker(
  dbPath: string,
  claimInput: ClaimHeartbeatOccurrenceInput,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<HeartbeatWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath,
      claimInput,
      contender,
      startSignal,
      occurrenceModuleUrl: new URL(`./heartbeat-occurrence-repo${extension}`, import.meta.url).href,
      admissionModuleUrl: new URL(`./session-mutation-admission-repo${extension}`, import.meta.url).href,
      sqliteModuleUrl: new URL(`./sqlite${extension}`, import.meta.url).href,
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
      const error = new Error(`heartbeat worker ${contender} exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const HEARTBEAT_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { HeartbeatOccurrenceRepository } = await tsImport(
        workerData.occurrenceModuleUrl,
        workerData.occurrenceModuleUrl,
      );
      const { SessionMutationAdmissionRepository } = await tsImport(
        workerData.admissionModuleUrl,
        workerData.admissionModuleUrl,
      );
      const { createDatabase } = await tsImport(workerData.sqliteModuleUrl, workerData.sqliteModuleUrl);
      db = createDatabase({ dbPath: workerData.dbPath });
      parentPort.postMessage({ kind: "ready" });
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const admissions = new SessionMutationAdmissionRepository(db);
      const outcome = new HeartbeatOccurrenceRepository(db).claim(workerData.claimInput, (request) => ({
        admission: admissions.admit(request.admissionInput).admission,
        child: request.child,
      }));
      if (outcome.disposition !== "created" && outcome.disposition !== "replayed") {
        throw new Error("unexpected claim disposition: " + outcome.disposition);
      }
      parentPort.postMessage({
        kind: "result",
        result: {
          ok: true,
          disposition: outcome.disposition,
          occurrenceId: outcome.occurrence.occurrenceId,
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
