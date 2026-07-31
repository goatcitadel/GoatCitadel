import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { DurableRunEventRepository } from "./durable-run-event-repo.js";
import { SessionControlRepository } from "./session-control-repo.js";
import {
  SessionMutationAdmissionRepository,
  computePostCommitChildAdmissionMaterialSha256,
  type PostCommitChildAdmissionIdentity,
  type PostCommitChildStageInput,
} from "./session-mutation-admission-repo.js";

describe("SessionMutationAdmissionRepository SQLite", () => {
  it("persists a content-free exact admission and append-only lifecycle evidence", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    new ChatSessionLifecycleRepository(db).initialize({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:session-a",
      correlationId: "correlation:init:session-a",
    });
    const repo = new SessionMutationAdmissionRepository(db);
    const input = {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      turnId: "turn-one",
      runtimeOwnerId: "runtime-owner-one",
      admissionKind: "turn_write" as const,
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "operator" as const,
      actorId: "operator-a",
      operation: "chat.turn.execute",
      materialSha256: "a".repeat(64),
      idempotencyKey: "admission:session-a:turn-a",
      correlationId: "correlation:session-a:turn-a",
    };

    const created = repo.admit(input);
    assert.equal(created.disposition, "created");
    assert.equal(created.admission.status, "active");
    assert.equal(repo.admit(input).disposition, "replayed");
    assert.equal(repo.listActive("workspace-a", "session-a").length, 1);
    assert.deepEqual(
      db
        .prepare(
          `SELECT event_sequence, event_type, material_sha256
           FROM chat_session_mutation_admission_events
           WHERE admission_id = @admissionId ORDER BY event_sequence`,
        )
        .all({ admissionId: created.admission.admissionId })
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ event_sequence: 1, event_type: "admitted", material_sha256: "a".repeat(64) }],
    );

    const columns = db.prepare("PRAGMA table_info(chat_session_mutation_admissions)").all<{
      name: string;
    }>();
    assert.equal(
      columns.some((column) =>
        /content|prompt|message|part|attachment|context|tool_result|approval_body/iu.test(column.name),
      ),
      false,
    );

    const closed = repo.closeTurnWrite({
      admissionId: created.admission.admissionId,
      workspaceId: created.admission.workspaceId,
      sessionId: created.admission.sessionId,
      sessionIncarnationId: created.admission.sessionIncarnationId,
      turnId: created.admission.turnId!,
      status: "completed",
      actorId: "operator-a",
      idempotencyKey: "admission:session-a:turn-a:completed",
      correlationId: "correlation:session-a:turn-a:completed",
      requestRuntimeClaim: {
        runtimeOwnerId: created.admission.runtimeOwnerId!,
        leaseRevision: created.admission.runtimeLeaseRevision!,
      },
    });
    assert.equal(closed.status, "completed");
    assert.deepEqual(
      repo.listEvents(created.admission.admissionId).map((event) => event.eventType),
      ["admitted", "completed"],
    );
    const nextTurn = repo.admit({
      ...input,
      turnId: "turn-two",
      runtimeOwnerId: "runtime-owner-two",
      materialSha256: "c".repeat(64),
      idempotencyKey: "admission:session-a:turn-b",
      correlationId: "correlation:session-a:turn-b",
    });
    assert.equal(nextTurn.disposition, "created");
    assert.equal(nextTurn.admission.status, "active");
    assert.deepEqual(
      repo.listActive("workspace-a", "session-a").map((admission) => admission.admissionId),
      [nextTurn.admission.admissionId],
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE chat_session_mutation_admissions SET material_sha256 = @digest WHERE admission_id = @admissionId",
          )
          .run({ digest: "b".repeat(64), admissionId: created.admission.admissionId }),
      /immutable/iu,
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM chat_session_mutation_admission_events WHERE admission_id = @admissionId")
          .run({ admissionId: created.admission.admissionId }),
      /append-only/iu,
    );
    db.close();
  });

  it("proves immutable capability bindings read-only across active and terminal admissions", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const lifecycle = new ChatSessionLifecycleRepository(db);
    const repo = new SessionMutationAdmissionRepository(db);
    const seed = (suffix: string, status?: "completed" | "cancelled") => {
      const sessionId = `session-capability-${suffix}`;
      lifecycle.initialize({
        workspaceId: "workspace-a",
        sessionId,
        actorId: "operator-a",
        idempotencyKey: `lifecycle:init:${sessionId}`,
        correlationId: `correlation:init:${sessionId}`,
      });
      const admitted = repo.admit({
        workspaceId: "workspace-a",
        sessionId,
        turnId: `turn-capability-${suffix}`,
        runtimeOwnerId: `runtime-capability-${suffix}`,
        admissionKind: "turn_write",
        aggregateRevision: 1,
        controllerGeneration: 1,
        actorKind: "system",
        actorId: "system:test",
        operation: "chat.turn.execute",
        materialSha256: createHash("sha256").update(`material:${suffix}`).digest("hex"),
        idempotencyKey: `admission:capability:${suffix}`,
        correlationId: `correlation:capability:${suffix}`,
      }).admission;
      const binding = {
        admissionId: admitted.admissionId,
        workspaceId: admitted.workspaceId,
        sessionId: admitted.sessionId,
        sessionIncarnationId: admitted.sessionIncarnationId,
        turnId: admitted.turnId!,
        profileId: `profile-capability-${suffix}`,
        profileHash: createHash("sha256").update(`profile:${suffix}`).digest("hex"),
        createdAt: `2026-07-15T00:00:0${suffix.length}.000Z`,
      };
      db.transaction("immediate", () => {
        repo.bindCapabilityProfile({
          ...binding,
          requestRuntimeClaim: {
            runtimeOwnerId: admitted.runtimeOwnerId!,
            leaseRevision: admitted.runtimeLeaseRevision!,
          },
        });
        db.prepare(
          `INSERT INTO chat_turn_capability_profiles (
             profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
             schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
             selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
           ) VALUES (
             @profileId, @turnId, @sessionId, @workspaceId, NULL, NULL, NULL,
             'chat.turn.capability-profile.v1', @profileHash, @snapshotId, @profileHash, @profileHash,
             @profileHash, @profileHash, @profileHash, '{}', @createdAt
           )`,
        ).run({
          profileId: binding.profileId,
          turnId: binding.turnId,
          sessionId: binding.sessionId,
          workspaceId: binding.workspaceId,
          profileHash: binding.profileHash,
          createdAt: binding.createdAt,
          snapshotId: `snapshot-${suffix}`,
        });
      });
      if (status) {
        repo.closeTurnWrite({
          admissionId: admitted.admissionId,
          workspaceId: admitted.workspaceId,
          sessionId: admitted.sessionId,
          sessionIncarnationId: admitted.sessionIncarnationId,
          turnId: admitted.turnId!,
          status,
          actorId: "system:test",
          idempotencyKey: `admission:capability:${suffix}:${status}`,
          correlationId: `correlation:capability:${suffix}:${status}`,
          requestRuntimeClaim: {
            runtimeOwnerId: admitted.runtimeOwnerId!,
            leaseRevision: admitted.runtimeLeaseRevision!,
          },
        });
      }
      return { admitted, binding };
    };

    const active = seed("active");
    const completed = seed("completed", "completed");
    const cancelled = seed("cancelled", "cancelled");
    for (const [fixture, expectedStatus] of [
      [active, "active"],
      [completed, "completed"],
      [cancelled, "cancelled"],
    ] as const) {
      const proof = repo.requireCapabilityProfileBinding(fixture.binding);
      assert.equal(proof.admission.status, expectedStatus);
      assert.deepEqual(proof.binding, {
        profileId: fixture.binding.profileId,
        turnId: fixture.binding.turnId,
        profileHash: fixture.binding.profileHash,
        createdAt: fixture.binding.createdAt,
      });
    }

    const requireActive = (patch: Partial<typeof active.binding>) =>
      repo.requireCapabilityProfileBinding({ ...active.binding, ...patch });
    assert.throws(() => requireActive({ sessionIncarnationId: "wrong-incarnation" }), /identity conflicts/iu);
    assert.throws(() => requireActive({ workspaceId: "workspace-b" }), /identity conflicts/iu);
    assert.throws(() => requireActive({ sessionId: "session-other" }), /identity conflicts/iu);
    assert.throws(() => requireActive({ turnId: completed.binding.turnId }), /identity conflicts/iu);
    assert.throws(() => requireActive({ profileId: "profile-other" }), /binding conflicts/iu);
    assert.throws(() => requireActive({ profileHash: "f".repeat(64) }), /binding conflicts/iu);
    assert.throws(() => requireActive({ createdAt: "2026-07-15T00:01:00.000Z" }), /binding conflicts/iu);
    assert.throws(() => requireActive({ profileId: completed.binding.profileId }), /binding conflicts/iu);

    const missingSessionId = "session-capability-missing";
    lifecycle.initialize({
      workspaceId: "workspace-a",
      sessionId: missingSessionId,
      actorId: "operator-a",
      idempotencyKey: `lifecycle:init:${missingSessionId}`,
      correlationId: `correlation:init:${missingSessionId}`,
    });
    const missing = repo.admit({
      workspaceId: "workspace-a",
      sessionId: missingSessionId,
      turnId: "turn-capability-missing",
      runtimeOwnerId: "runtime-capability-missing",
      admissionKind: "turn_write",
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "system",
      actorId: "system:test",
      operation: "chat.turn.execute",
      materialSha256: "e".repeat(64),
      idempotencyKey: "admission:capability:missing",
      correlationId: "correlation:capability:missing",
    }).admission;
    assert.throws(
      () =>
        repo.requireCapabilityProfileBinding({
          admissionId: missing.admissionId,
          workspaceId: missing.workspaceId,
          sessionId: missing.sessionId,
          sessionIncarnationId: missing.sessionIncarnationId,
          turnId: missing.turnId!,
          profileId: "profile-capability-missing",
          profileHash: "e".repeat(64),
          createdAt: "2026-07-15T00:00:00.000Z",
        }),
      /binding is missing/iu,
    );
    db.close();
  });

  it("fails closed for workspace, revision, generation, and one-active-turn mismatches", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    new ChatSessionLifecycleRepository(db).initialize({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:session-a",
      correlationId: "correlation:init:session-a",
    });
    const repo = new SessionMutationAdmissionRepository(db);
    const base = {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      turnId: "turn-one",
      runtimeOwnerId: "runtime-owner-one",
      admissionKind: "turn_write" as const,
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "operator" as const,
      actorId: "operator-a",
      operation: "chat.turn.execute",
      materialSha256: "c".repeat(64),
      idempotencyKey: "admission:one",
      correlationId: "correlation:one",
    };
    repo.admit(base);
    assert.throws(() => repo.admit({ ...base, idempotencyKey: "admission:two" }), /active.*turn/iu);
    assert.throws(
      () =>
        repo.admit({
          ...base,
          admissionKind: "synchronous",
          turnId: undefined,
          runtimeOwnerId: undefined,
          workspaceId: "workspace-b",
          idempotencyKey: "bad-ws",
        }),
      /workspace|authority/iu,
    );
    assert.throws(
      () =>
        repo.admit({
          ...base,
          admissionKind: "synchronous",
          turnId: undefined,
          runtimeOwnerId: undefined,
          aggregateRevision: 2,
          idempotencyKey: "bad-rev",
        }),
      /revision|authority/iu,
    );
    assert.throws(
      () =>
        repo.admit({
          ...base,
          admissionKind: "synchronous",
          turnId: undefined,
          runtimeOwnerId: undefined,
          controllerGeneration: 2,
          idempotencyKey: "bad-gen",
        }),
      /generation|authority/iu,
    );
    db.close();
  });

  it("recovers an active durable admission after restart and closes it exactly once", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-admission-restart-${randomUUID()}.db`);
    const first = createDatabase({ dbPath });
    new ChatSessionLifecycleRepository(first).initialize({
      workspaceId: "workspace-a",
      sessionId: "session-restart",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:session-restart",
      correlationId: "correlation:init:session-restart",
    });
    const created = new SessionMutationAdmissionRepository(first).admit(admissionInput("session-restart", "restart"));
    first.close();

    try {
      const recoveredDb = createDatabase({ dbPath });
      const recovered = new SessionMutationAdmissionRepository(recoveredDb);
      assert.equal(recovered.require(created.admission.admissionId).status, "active");
      assert.deepEqual(
        recovered.listActive("workspace-a", "session-restart").map((record) => record.admissionId),
        [created.admission.admissionId],
      );
      const closed = recovered.closeTurnWrite({
        admissionId: created.admission.admissionId,
        workspaceId: created.admission.workspaceId,
        sessionId: created.admission.sessionId,
        sessionIncarnationId: created.admission.sessionIncarnationId,
        turnId: created.admission.turnId!,
        status: "cancelled",
        actorId: "recovery-owner",
        idempotencyKey: "admission:session-restart:recovered:cancelled",
        correlationId: "correlation:session-restart:recovered:cancelled",
        requestRuntimeClaim: {
          runtimeOwnerId: created.admission.runtimeOwnerId!,
          leaseRevision: created.admission.runtimeLeaseRevision!,
        },
      });
      assert.equal(closed.status, "cancelled");
      assert.equal(
        recovered.closeTurnWrite({
          admissionId: created.admission.admissionId,
          workspaceId: created.admission.workspaceId,
          sessionId: created.admission.sessionId,
          sessionIncarnationId: created.admission.sessionIncarnationId,
          turnId: created.admission.turnId!,
          status: "cancelled",
          actorId: "recovery-owner",
          idempotencyKey: "admission:session-restart:recovered:cancelled",
          correlationId: "correlation:session-restart:recovered:cancelled",
          requestRuntimeClaim: {
            runtimeOwnerId: created.admission.runtimeOwnerId!,
            leaseRevision: created.admission.runtimeLeaseRevision!,
          },
        }).status,
        "cancelled",
      );
      assert.deepEqual(
        recovered.listEvents(created.admission.admissionId).map((event) => event.eventSequence),
        [1, 2],
      );
      recoveredDb.close();
    } finally {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it("atomically resolves durable user input and replays from the immutable seal after later run progress", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createContinuationFixture(db);
    const events = new DurableRunEventRepository(db);
    assert.equal(
      events.append({
        eventId: "event-continuation-waiting",
        runId: fixture.runId,
        eventType: "run_waiting",
        createdAt: "2026-07-30T00:00:00.000Z",
      }).sequence,
      1,
    );

    const resolved = fixture.repo.resolveDurableChatUserInput(fixture.resolution);
    assert.equal(resolved.disposition, "resolved");
    assert.deepEqual(resolved.run, { runId: fixture.runId, status: "queued", version: 3 });
    assert.equal(resolved.responseRecord.answeredAt, resolved.seal.resolvedAt);
    assert.equal(resolved.seal.waitingRunVersion, 2);
    assert.equal(resolved.seal.queuedRunVersion, 3);
    assert.deepEqual(
      {
        ...(db.prepare("SELECT status, pending_user_input_json FROM chat_turn_traces WHERE turn_id = @turnId").get({
          turnId: fixture.turnId,
        }) as Record<string, unknown>),
      },
      { status: "running", pending_user_input_json: null },
    );
    assert.equal(
      events.append({
        eventId: "event-continuation-started",
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
    const sequenceBeforeReplay = db
      .prepare("SELECT last_sequence FROM durable_run_event_sequences WHERE run_id = @runId")
      .get<{ last_sequence: number }>({ runId: fixture.runId })?.last_sequence;

    db.prepare(
      `UPDATE durable_runs
       SET status = 'running', lease_owner_id = 'worker-later',
           lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes'),
           lease_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
       WHERE run_id = @runId`,
    ).run({ runId: fixture.runId });

    const replayed = fixture.repo.resolveDurableChatUserInput({
      ...fixture.resolution,
      expectedWaitingRunVersion: 4,
    });
    assert.equal(replayed.disposition, "replayed");
    assert.deepEqual(replayed.run, { runId: fixture.runId, status: "running", version: 4 });
    assert.deepEqual(replayed.responseRecord, resolved.responseRecord);
    assert.deepEqual(replayed.seal, resolved.seal);
    assert.equal(
      db
        .prepare("SELECT last_sequence FROM durable_run_event_sequences WHERE run_id = @runId")
        .get<{ last_sequence: number }>({ runId: fixture.runId })?.last_sequence,
      sequenceBeforeReplay,
    );
    assert.throws(
      () =>
        fixture.repo.resolveDurableChatUserInput({
          ...fixture.resolution,
          expectedWaitingRunVersion: 4,
          response: { kind: "text", text: "changed answer" },
        }),
      /replay conflicts/iu,
    );
    assert.throws(
      () =>
        fixture.repo.resolveDurableChatUserInput({
          ...fixture.resolution,
          expectedWaitingRunVersion: 4,
          responder: { actorId: "operator-other", authActorSource: "token" },
        }),
      /replay conflicts/iu,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM durable_run_events
           WHERE run_id = @runId AND event_type = 'run_woken'`,
        )
        .get<{ count: number }>({ runId: fixture.runId })!.count,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_turn_user_input_continuation_seals WHERE durable_run_id = @runId")
        .get<{ count: number }>({ runId: fixture.runId })!.count,
      1,
    );
    db.close();
  });

  it("permits only control-plane operator responders before resolution and replay", () => {
    for (const authActorSource of ["none", "token", "basic", "loopback"] as const) {
      const db = createDatabase({ dbPath: ":memory:" });
      const fixture = createContinuationFixture(db);
      const resolution = {
        ...fixture.resolution,
        responder: { actorId: `operator-shifted-${authActorSource}`, authActorSource },
      };
      assert.equal(fixture.repo.resolveDurableChatUserInput(resolution).disposition, "resolved");
      const beforeUnauthorizedReplay = readContinuationMutationSnapshot(db, fixture);
      assert.throws(
        () =>
          fixture.repo.resolveDurableChatUserInput({
            ...resolution,
            expectedWaitingRunVersion: 3,
            responder: { actorId: resolution.responder.actorId, authActorSource: "companion" },
          }),
        /requires an operator admission and a control-plane responder/iu,
      );
      assert.deepEqual(readContinuationMutationSnapshot(db, fixture), beforeUnauthorizedReplay);
      db.close();
    }

    for (const authActorSource of ["companion", "device", "a2a_peer", "sse"] as const) {
      const db = createDatabase({ dbPath: ":memory:" });
      const fixture = createContinuationFixture(db);
      const before = readContinuationMutationSnapshot(db, fixture);
      assert.throws(
        () =>
          fixture.repo.resolveDurableChatUserInput({
            ...fixture.resolution,
            responder: { actorId: "operator-a", authActorSource },
          }),
        /requires an operator admission and a control-plane responder/iu,
      );
      assert.deepEqual(readContinuationMutationSnapshot(db, fixture), before);
      db.close();
    }
  });

  it("rejects system and external-companion continuation admissions before any mutation", () => {
    for (const actor of [
      { actorKind: "system", actorId: "system-heartbeat", authActorSource: "loopback" },
      {
        actorKind: "external_companion",
        actorId: "companion-continuation",
        authActorSource: "companion",
      },
    ] as const) {
      const db = createDatabase({ dbPath: ":memory:" });
      const fixture = createContinuationFixture(db, actor);
      const before = readContinuationMutationSnapshot(db, fixture);
      assert.throws(
        () =>
          fixture.repo.resolveDurableChatUserInput({
            ...fixture.resolution,
            responder: { actorId: actor.actorId, authActorSource: actor.authActorSource },
          }),
        /requires an operator admission and a control-plane responder/iu,
      );
      assert.deepEqual(readContinuationMutationSnapshot(db, fixture), before);
      db.close();
    }
  });

  it("settles stale turn-write authority exactly once and never re-labels it completed", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const workspaceId = "workspace-settle";
    const sessionId = "session-settle";
    const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
      workspaceId,
      sessionId,
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:settle",
      correlationId: "correlation:lifecycle:init:settle",
    });
    const repo = new SessionMutationAdmissionRepository(db);
    const admission = repo.admit({
      workspaceId,
      sessionId,
      expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
      turnId: "turn-settle",
      runtimeOwnerId: "runtime-settle",
      admissionKind: "turn_write",
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "operator",
      actorId: "operator-a",
      operation: "chat.turn.execute",
      materialSha256: "e".repeat(64),
      idempotencyKey: "admission:settle",
      correlationId: "correlation:admission:settle",
    }).admission;
    const identity = {
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId,
      sessionId,
      turnId: admission.turnId!,
    };

    const current = repo.settleTurnWriteAuthority(identity);
    assert.equal(current.disposition, "current");
    assert.equal(current.admission.status, "active");
    assert.deepEqual(
      repo.listEvents(admission.admissionId).map((event) => event.eventType),
      ["admitted"],
    );

    seedSessionControlAuth(db, "companion-settle", "grant-settle");
    const controls = new SessionControlRepository(db);
    const requested = controls.createExternalRequest({
      workspaceId,
      sessionId,
      companionSessionId: "companion-settle",
      deviceGrantId: "grant-settle",
      clientInstanceId: "client-settle",
      principalPurpose: "session_control_client",
      expectedGeneration: 1,
      tokenHashSha256: sha256("control-token:settle"),
      capabilities: ["send", "read"],
      idempotencyKey: "control:request:settle",
      correlationId: "correlation:control:request:settle",
    });
    const handedOff = controls.handoff({
      workspaceId,
      sessionId,
      requestId: requested.request.requestId,
      expectedGeneration: 1,
      effectiveCapabilities: ["send", "read"],
      operatorActorId: "operator-a",
      idempotencyKey: "control:handoff:settle",
      correlationId: "correlation:control:handoff:settle",
    });

    const settled = repo.settleTurnWriteAuthority(identity);
    assert.equal(settled.disposition, "authority_superseded");
    assert.equal(settled.admission.status, "cancelled");
    assert.equal(settled.admission.terminalAuthorityKind, "authority_superseded");
    assert.equal(settled.admission.terminalControlEventId, handedOff.control.lastEventId);
    assert.deepEqual(repo.settleTurnWriteAuthority(identity), settled);
    assert.deepEqual(
      repo.listEvents(admission.admissionId).map((event) => event.eventType),
      ["admitted", "cancelled"],
    );

    const closeReplay = repo.closeTurnWrite({
      ...identity,
      status: "completed",
      actorId: "runtime-settle",
      idempotencyKey: "admission:settle:must-not-complete",
      correlationId: "correlation:admission:settle:must-not-complete",
      requestRuntimeClaim: {
        runtimeOwnerId: admission.runtimeOwnerId!,
        leaseRevision: admission.runtimeLeaseRevision!,
      },
    });
    assert.equal(closeReplay.status, "cancelled");
    assert.equal(closeReplay.terminalAuthorityKind, "authority_superseded");
    db.close();
  });

  it("rejects authority settlement after another terminal path and fails closed without current-event evidence", () => {
    const terminalDb = createDatabase({ dbPath: ":memory:" });
    const lifecycle = new ChatSessionLifecycleRepository(terminalDb).initialize({
      workspaceId: "workspace-terminal",
      sessionId: "session-terminal",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:terminal",
      correlationId: "correlation:lifecycle:init:terminal",
    });
    const terminalRepo = new SessionMutationAdmissionRepository(terminalDb);
    const terminalAdmission = terminalRepo.admit({
      workspaceId: "workspace-terminal",
      sessionId: "session-terminal",
      expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
      turnId: "turn-terminal",
      runtimeOwnerId: "runtime-terminal",
      admissionKind: "turn_write",
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "operator",
      actorId: "operator-a",
      operation: "chat.turn.execute",
      materialSha256: "f".repeat(64),
      idempotencyKey: "admission:terminal",
      correlationId: "correlation:admission:terminal",
    }).admission;
    const terminalIdentity = {
      admissionId: terminalAdmission.admissionId,
      sessionIncarnationId: terminalAdmission.sessionIncarnationId,
      workspaceId: terminalAdmission.workspaceId,
      sessionId: terminalAdmission.sessionId,
      turnId: terminalAdmission.turnId!,
    };
    terminalRepo.closeTurnWrite({
      ...terminalIdentity,
      status: "completed",
      actorId: "runtime-terminal",
      idempotencyKey: "admission:terminal:completed",
      correlationId: "correlation:admission:terminal:completed",
      requestRuntimeClaim: {
        runtimeOwnerId: terminalAdmission.runtimeOwnerId!,
        leaseRevision: terminalAdmission.runtimeLeaseRevision!,
      },
    });
    assert.throws(() => terminalRepo.settleTurnWriteAuthority(terminalIdentity), /different authority path|closed/iu);
    terminalDb.close();

    const corruptDb = createDatabase({ dbPath: ":memory:" });
    const corruptLifecycle = new ChatSessionLifecycleRepository(corruptDb).initialize({
      workspaceId: "workspace-corrupt",
      sessionId: "session-corrupt",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:corrupt",
      correlationId: "correlation:lifecycle:init:corrupt",
    });
    const corruptRepo = new SessionMutationAdmissionRepository(corruptDb);
    const corruptAdmission = corruptRepo.admit({
      workspaceId: "workspace-corrupt",
      sessionId: "session-corrupt",
      expectedSessionIncarnationId: corruptLifecycle.intent.sessionIncarnationId,
      turnId: "turn-corrupt",
      runtimeOwnerId: "runtime-corrupt",
      admissionKind: "turn_write",
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "operator",
      actorId: "operator-a",
      operation: "chat.turn.execute",
      materialSha256: "9".repeat(64),
      idempotencyKey: "admission:corrupt",
      correlationId: "correlation:admission:corrupt",
    }).admission;
    corruptDb.exec("DROP TRIGGER trg_chat_session_control_events_no_delete");
    corruptDb
      .prepare("DELETE FROM chat_session_control_events WHERE session_id = @sessionId")
      .run({ sessionId: "session-corrupt" });
    assert.throws(
      () =>
        corruptRepo.settleTurnWriteAuthority({
          admissionId: corruptAdmission.admissionId,
          sessionIncarnationId: corruptAdmission.sessionIncarnationId,
          workspaceId: corruptAdmission.workspaceId,
          sessionId: corruptAdmission.sessionId,
          turnId: corruptAdmission.turnId!,
        }),
      /authority evidence is missing/iu,
    );
    assert.equal(corruptRepo.require(corruptAdmission.admissionId).status, "active");
    corruptDb.close();
  });

  it("atomically fences and receipts parent-local post-commit stages", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createParentLocalPostCommitFixture(db);
    const durableBinding = fixture.repo.findDurableRunBinding(fixture.input.parentAdmission);
    assert.ok(durableBinding);
    assert.deepEqual(
      { ...durableBinding, createdAt: undefined },
      {
        admissionId: fixture.input.parentAdmission.admissionId,
        sessionIncarnationId: fixture.input.parentAdmission.sessionIncarnationId,
        workspaceId: fixture.input.parentAdmission.workspaceId,
        sessionId: fixture.input.parentAdmission.sessionId,
        turnId: fixture.input.parentAdmission.turnId,
        durableRunId: fixture.input.parentRunId,
        createdAt: undefined,
      },
    );
    assert.match(durableBinding.createdAt, /T.*Z$/u);
    assert.throws(
      () =>
        fixture.repo.findDurableRunBinding({
          ...fixture.input.parentAdmission,
          workspaceId: "workspace-wrong",
        }),
      /binding conflicts/iu,
    );
    let callbackCount = 0;
    const allowed = fixture.repo.runParentLocalPostCommitStage(
      { ...fixture.input, effect: "capability_gap" },
      (authority) => {
        callbackCount += 1;
        assert.equal(authority.effect, "capability_gap");
        return "recorded";
      },
    );
    assert.equal(allowed.disposition, "allowed");
    assert.equal(allowed.value, "recorded");
    assert.equal(allowed.durableRunVersion, 3);
    const replayed = fixture.repo.runParentLocalPostCommitStage({ ...fixture.input, effect: "capability_gap" }, () => {
      callbackCount += 1;
      return "must-not-run";
    });
    assert.equal(replayed.disposition, "replayed");
    assert.equal(callbackCount, 1);

    assert.throws(
      () =>
        fixture.repo.runParentLocalPostCommitStage({ ...fixture.input, effect: "realtime" }, () => {
          throw new Error("local effect failed");
        }),
      /local effect failed/iu,
    );
    assert.deepEqual(readGeneralPostCommitCompletedEffects(db, fixture.input.parentRunId), ["capability_gap"]);
    fixture.repo.runParentLocalPostCommitStage({ ...fixture.input, effect: "realtime" }, () => "published");

    seedSessionControlAuth(db, "companion-parent-local", "grant-parent-local");
    const controls = new SessionControlRepository(db);
    const requested = controls.createExternalRequest({
      workspaceId: fixture.input.parentAdmission.workspaceId,
      sessionId: fixture.input.parentAdmission.sessionId,
      companionSessionId: "companion-parent-local",
      deviceGrantId: "grant-parent-local",
      clientInstanceId: "client-parent-local",
      principalPurpose: "session_control_client",
      expectedGeneration: 1,
      tokenHashSha256: sha256("control-token:parent-local"),
      capabilities: ["send"],
      idempotencyKey: "control:request:parent-local",
      correlationId: "correlation:control:request:parent-local",
    });
    controls.handoff({
      workspaceId: fixture.input.parentAdmission.workspaceId,
      sessionId: fixture.input.parentAdmission.sessionId,
      requestId: requested.request.requestId,
      expectedGeneration: 1,
      effectiveCapabilities: ["send"],
      operatorActorId: "operator-a",
      idempotencyKey: "control:handoff:parent-local",
      correlationId: "correlation:control:handoff:parent-local",
    });
    const blocked = fixture.repo.runParentLocalPostCommitStage({ ...fixture.input, effect: "agent_end" }, () => {
      callbackCount += 1;
      return "must-not-run";
    });
    assert.equal(blocked.disposition, "late_blocked");
    assert.equal(blocked.admission.status, "cancelled");
    assert.equal(blocked.admission.terminalAuthorityKind, "authority_superseded");
    assert.equal(callbackCount, 1);
    assert.deepEqual(readGeneralPostCommitCompletedEffects(db, fixture.input.parentRunId), [
      "capability_gap",
      "realtime",
    ]);
    db.close();
  });

  it("rejects forged v2 request actors before any parent-local callback", () => {
    for (const requestActor of [
      { actorKind: "external_companion", actorId: "companion:companion-parent" },
      { actorKind: "system", actorId: "integration:cron" },
    ]) {
      const db = createDatabase({ dbPath: ":memory:" });
      const fixture = createParentLocalPostCommitFixture(db);
      const row = db
        .prepare("SELECT payload_json FROM durable_runs WHERE run_id = @runId")
        .get<{ payload_json: string }>({ runId: fixture.input.parentRunId })!;
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.requestActor = requestActor;
      db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @runId").run({
        payloadJson: canonicalJsonString(payload),
        runId: fixture.input.parentRunId,
      });
      let callbackCalled = false;
      assert.throws(
        () =>
          fixture.repo.runParentLocalPostCommitStage({ ...fixture.input, effect: "capability_gap" }, () => {
            callbackCalled = true;
          }),
        /payload conflicts|frozen admission/iu,
      );
      assert.equal(callbackCalled, false);
      db.close();
    }
  });

  it("uses the post-callback durable version for terminal settlement and rolls claim divergence back", () => {
    const terminalDb = createDatabase({ dbPath: ":memory:" });
    const terminal = createPostCommitChildFixture(terminalDb, "commitments", "terminal-version");
    const terminalOutcome = terminal.repo.runPostCommitChildStage(terminal.input, (authority) => {
      assert.equal(authority.durableRunVersion, 3);
      terminalDb.prepare("UPDATE durable_runs SET version = version + 1 WHERE run_id = @runId").run({
        runId: terminal.input.childRunId,
      });
      return { disposition: "allowed", value: "stored" };
    });
    assert.equal(terminalOutcome.disposition, "allowed");
    assert.equal(terminalOutcome.admission.status, "completed");
    assert.equal(terminalOutcome.admission.terminalDurableRunVersion, 4);
    terminalDb.close();

    const divergentDb = createDatabase({ dbPath: ":memory:" });
    const divergent = createPostCommitChildFixture(divergentDb, "commitments", "claim-divergence");
    assert.throws(
      () =>
        divergent.repo.runPostCommitChildStage(divergent.input, () => {
          divergentDb
            .prepare(
              "UPDATE durable_runs SET lease_owner_id = 'other-worker', version = version + 1 WHERE run_id = @runId",
            )
            .run({ runId: divergent.input.childRunId });
          return { disposition: "allowed", value: "must-rollback" };
        }),
      /claim|lease/iu,
    );
    assert.equal(divergent.repo.require(divergent.input.childAdmission.admissionId).status, "active");
    assert.deepEqual(
      {
        ...(divergentDb
          .prepare("SELECT lease_owner_id, version FROM durable_runs WHERE run_id = @runId")
          .get({ runId: divergent.input.childRunId }) as Record<string, unknown>),
      },
      { lease_owner_id: divergent.input.durableClaim.leaseOwnerId, version: 3 },
    );
    divergentDb.close();
  });

  it("keeps an allowed nonterminal post-commit child active after durable version advancement", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const fixture = createPostCommitChildFixture(db, "background_review", "nonterminal-version");
    const outcome = fixture.repo.runPostCommitChildStage(fixture.input, () => {
      db.prepare("UPDATE durable_runs SET version = version + 1 WHERE run_id = @runId").run({
        runId: fixture.input.childRunId,
      });
      return { disposition: "allowed", value: { due: false } };
    });
    assert.equal(outcome.disposition, "allowed");
    assert.equal(outcome.admission.status, "active");
    assert.equal(
      db.prepare("SELECT version FROM durable_runs WHERE run_id = @runId").get<{ version: number }>({
        runId: fixture.input.childRunId,
      })!.version,
      4,
    );
    db.close();
  });

  it("admits only one active durable turn across two SQLite workers", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-admission-race-${randomUUID()}.db`);
    const db = createDatabase({ dbPath });
    new ChatSessionLifecycleRepository(db).initialize({
      workspaceId: "workspace-a",
      sessionId: "session-race",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:admission-session-race",
      correlationId: "correlation:init:admission-session-race",
    });
    db.close();

    try {
      const results = await runAdmissionRace(dbPath, ["left", "right"]);
      assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
      assert.equal(results.filter((result) => !result.ok).length, 1, JSON.stringify(results));
      const verify = createDatabase({ dbPath });
      const active = new SessionMutationAdmissionRepository(verify).listActive("workspace-a", "session-race");
      assert.equal(active.length, 1);
      assert.equal(active[0]?.status, "active");
      assert.equal(
        (
          verify
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_mutation_admission_events
             WHERE session_id = 'session-race' AND event_type = 'admitted'`,
            )
            .get() as { count: number }
        ).count,
        1,
      );
      verify.close();
    } finally {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

function readContinuationMutationSnapshot(
  db: ReturnType<typeof createDatabase>,
  fixture: ReturnType<typeof createContinuationFixture>,
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

function createContinuationFixture(
  db: ReturnType<typeof createDatabase>,
  options: {
    actorKind?: "operator" | "system" | "external_companion";
    actorId?: string;
  } = {},
) {
  const workspaceId = "workspace-continuation";
  const sessionId = "session-continuation";
  const turnId = "turn-continuation";
  const runId = "run-continuation";
  const promptId = "prompt-continuation";
  const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-a",
    idempotencyKey: "lifecycle:init:session-continuation",
    correlationId: "correlation:init:session-continuation",
  });
  const actorKind = options.actorKind ?? "operator";
  const actorId = options.actorId ?? (actorKind === "operator" ? "operator-a" : `actor-${actorKind}`);
  let controllerGeneration = 1;
  if (actorKind === "external_companion") {
    seedSessionControlAuth(db, actorId, "grant-continuation");
    const controls = new SessionControlRepository(db);
    const requested = controls.createExternalRequest({
      workspaceId,
      sessionId,
      companionSessionId: actorId,
      deviceGrantId: "grant-continuation",
      clientInstanceId: "client-continuation",
      principalPurpose: "session_control_client",
      expectedGeneration: 1,
      tokenHashSha256: sha256("control-token:continuation"),
      capabilities: ["send"],
      idempotencyKey: "control:request:continuation",
      correlationId: "correlation:control:request:continuation",
    });
    controls.handoff({
      workspaceId,
      sessionId,
      requestId: requested.request.requestId,
      expectedGeneration: 1,
      effectiveCapabilities: ["send"],
      operatorActorId: "operator-a",
      idempotencyKey: "control:handoff:continuation",
      correlationId: "correlation:control:handoff:continuation",
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
    runtimeOwnerId: "request-runtime-continuation",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration,
    actorKind,
    actorId,
    operation: "chat.turn.execute",
    materialSha256,
    idempotencyKey: "admission:continuation",
    correlationId: "correlation:continuation",
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
       @turnId, @sessionId, 'message-continuation', 'waiting_for_user_input', 'chat',
       'off', 'off', 'standard', '{}', @pendingUserInputJson, @durableJson, @now
     )`,
  ).run({
    turnId,
    sessionId,
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

function createPostCommitChildFixture(
  db: ReturnType<typeof createDatabase>,
  effect: "commitments" | "background_review" | "memory_maintenance",
  seed: string,
) {
  const workspaceId = `workspace-${seed}`;
  const sessionId = `session-${seed}`;
  const sourceTurnId = `turn-parent-${seed}`;
  const parentRunId = `run-parent-${seed}`;
  const childRunId = `run-child-${seed}`;
  const postCommitGenerationId = `generation-${seed}`;
  const postCommitEligibility = {
    version: 1 as const,
    autonomyEnabledAtParentSettlement: true,
    evalIntegrityTurn: false,
    humanSession: true,
  };
  const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-a",
    idempotencyKey: `lifecycle:init:${seed}`,
    correlationId: `correlation:lifecycle:init:${seed}`,
  });
  const materialSha256 = computePostCommitChildAdmissionMaterialSha256({
    parentRunId,
    postCommitGenerationId,
    effect,
    childRunId,
    workspaceId,
    sessionId,
    sourceTurnId,
    sessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    postCommitEligibility,
  });
  const repo = new SessionMutationAdmissionRepository(db);
  const child = repo.admit({
    workspaceId,
    sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    admissionKind: "synchronous",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator-a",
    operation: "chat_post_commit_child",
    materialSha256,
    idempotencyKey: `admission:post-commit:${seed}`,
    correlationId: `correlation:post-commit:${seed}`,
  }).admission;
  const childAdmission: PostCommitChildAdmissionIdentity = {
    admissionId: child.admissionId,
    sessionIncarnationId: child.sessionIncarnationId,
    workspaceId,
    sessionId,
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator-a",
    operation: "chat_post_commit_child",
    materialSha256,
  };
  const payload = {
    version: "chat.post_commit.effect.v2",
    parentRunId,
    postCommitGenerationId,
    effect,
    traceStatus: "completed",
    childAdmission,
    postCommitEligibility,
    input: {},
  };
  const metadata = {
    parentRunId,
    postCommitGenerationId,
    effect,
    workspaceId,
    sessionId,
    turnId: sourceTurnId,
    childAdmission,
    postCommitEligibility,
  };
  const leaseOwnerId = `worker-${seed}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO durable_runs (
       run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
       lease_owner_id, lease_expires_at, lease_heartbeat_at, version, created_at, updated_at
     ) VALUES (
       @runId, 'chat.post_commit.effect', 'running', 1, 3, @payloadJson, @metadataJson,
       @leaseOwnerId, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 3, @now, @now
     )`,
  ).run({
    runId: childRunId,
    payloadJson: canonicalJsonString(payload),
    metadataJson: canonicalJsonString(metadata),
    leaseOwnerId,
    now,
  });
  const input: PostCommitChildStageInput = {
    childAdmission,
    parentRunId,
    postCommitGenerationId,
    effect,
    childRunId,
    sourceTurnId,
    postCommitEligibility,
    ...(effect === "commitments"
      ? { stage: "commitments_write" as const, terminal: true }
      : effect === "memory_maintenance"
        ? { stage: "memory_maintenance_evaluation" as const, terminal: true }
        : { stage: "background_counter" as const, terminal: false }),
    durableClaim: { durableRunId: childRunId, leaseOwnerId, attemptCount: 1 },
  };
  return { repo, input };
}

function createParentLocalPostCommitFixture(db: ReturnType<typeof createDatabase>) {
  const continuation = createContinuationFixture(db);
  const postCommitGenerationId = "generation-parent-local";
  const run = db
    .prepare("SELECT metadata_json FROM durable_runs WHERE run_id = @runId")
    .get<{ metadata_json: string }>({ runId: continuation.runId })!;
  const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
  metadata.generalChatPostCommitPending = {
    version: 1,
    generationId: postCommitGenerationId,
    traceStatus: "waiting_for_user_input",
    requestedAt: new Date().toISOString(),
    postCommitEligibility: {
      version: 1,
      autonomyEnabledAtParentSettlement: false,
      evalIntegrityTurn: false,
      humanSession: true,
    },
    completedEffects: [],
    durableEffectRunIds: {},
  };
  db.prepare("UPDATE durable_runs SET metadata_json = @metadataJson WHERE run_id = @runId").run({
    metadataJson: canonicalJsonString(metadata),
    runId: continuation.runId,
  });
  return {
    repo: continuation.repo,
    input: {
      parentAdmission: continuation.resolution.admissionIdentity,
      parentRunId: continuation.runId,
      postCommitGenerationId,
      effect: "capability_gap" as const,
    },
  };
}

function readGeneralPostCommitCompletedEffects(db: ReturnType<typeof createDatabase>, runId: string): unknown[] {
  const row = db
    .prepare("SELECT metadata_json FROM durable_runs WHERE run_id = @runId")
    .get<{ metadata_json: string }>({ runId })!;
  const metadata = JSON.parse(row.metadata_json) as {
    generalChatPostCommitPending?: { completedEffects?: unknown[] };
  };
  return metadata.generalChatPostCommitPending?.completedEffects ?? [];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function seedSessionControlAuth(
  db: ReturnType<typeof createDatabase>,
  companionSessionId: string,
  deviceGrantId: string,
): void {
  const clock = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day') AS expires_at`,
    )
    .get<{ now: string; expires_at: string }>()!;
  const authRequestId = `auth-request-${sha256(deviceGrantId).slice(0, 24)}`;
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
    approvalId: `approval-${sha256(deviceGrantId).slice(0, 24)}`,
    secretHash: sha256(`request-secret:${deviceGrantId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
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
    tokenHash: sha256(`device-token:${deviceGrantId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
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
    accessTokenHash: sha256(`access-token:${companionSessionId}`),
    refreshTokenHash: sha256(`refresh-token:${companionSessionId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
  });
}

function admissionInput(sessionId: string, contender: string) {
  return {
    workspaceId: "workspace-a",
    sessionId,
    turnId: `turn-${sessionId}-${contender}`,
    runtimeOwnerId: `runtime-${sessionId}-${contender}`,
    admissionKind: "turn_write" as const,
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator" as const,
    actorId: `operator-${contender}`,
    operation: "chat.turn.execute",
    materialSha256: contender === "right" ? "d".repeat(64) : "c".repeat(64),
    idempotencyKey: `admission:${sessionId}:${contender}`,
    correlationId: `correlation:${sessionId}:${contender}`,
  };
}

interface AdmissionRaceResult {
  ok: boolean;
  admissionId?: string;
  disposition?: string;
  error?: string;
}

async function runAdmissionRace(
  dbPath: string,
  contenders: readonly [string, string],
): Promise<[AdmissionRaceResult, AdmissionRaceResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = contenders.map((contender) => runAdmissionWorker(dbPath, contender, startSignal)) as [
    ReturnType<typeof runAdmissionWorker>,
    ReturnType<typeof runAdmissionWorker>,
  ];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[AdmissionRaceResult, AdmissionRaceResult]>;
}

function runAdmissionWorker(
  dbPath: string,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<AdmissionRaceResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(ADMISSION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath,
      contender,
      startSignal,
      repositoryModuleUrl: new URL(`./session-mutation-admission-repo${extension}`, import.meta.url).href,
      sqliteModuleUrl: new URL(`./sqlite${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: AdmissionRaceResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<AdmissionRaceResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: AdmissionRaceResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`SQLite admission race worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const ADMISSION_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { SessionMutationAdmissionRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { createDatabase } = await tsImport(workerData.sqliteModuleUrl, workerData.sqliteModuleUrl);
      db = createDatabase({ dbPath: workerData.dbPath });
      parentPort.postMessage({ kind: "ready" });
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const contender = workerData.contender;
      const value = new SessionMutationAdmissionRepository(db).admit({
        workspaceId: "workspace-a",
        sessionId: "session-race",
        turnId: "turn-session-race-" + contender,
        runtimeOwnerId: "runtime-session-race-" + contender,
        admissionKind: "turn_write",
        aggregateRevision: 1,
        controllerGeneration: 1,
        actorKind: "operator",
        actorId: "operator-" + contender,
        operation: "chat.turn.execute",
        materialSha256: (contender === "right" ? "d" : "c").repeat(64),
        idempotencyKey: "admission:session-race:" + contender,
        correlationId: "correlation:session-race:" + contender,
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
