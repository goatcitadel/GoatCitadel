import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { canonicalJsonString, ConflictError } from "@goatcitadel/contracts";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import type { DatabaseClient } from "./db.js";
import {
  SessionControlRepository,
  type AuthRevokeSessionControlsInput,
  type CreateExternalSessionControlRequestInput,
  type ExternalSessionControlIdentity,
  type HandoffSessionControlInput,
  type RevokeIdentityAmbiguityInput,
} from "./session-control-repo.js";
import { __sqliteInternals, createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SessionControlRepository SQLite foundation", () => {
  it("initializes an existing session and runs request, handoff, heartbeat, stale, reconnect, release, and revoke", () => {
    const { db, repo } = createHarness("lifecycle");
    const initialization = repo.getControl("default", "session-lifecycle");
    assert.equal(initialization.ownerKind, "operator");
    assert.equal(initialization.generation, 1);
    assert.equal(initialization.lastEventReasonCode, "session_initialized");

    seedSessionControlAuth(db, "companion-lifecycle-cancelled", "grant-lifecycle-cancelled");
    const cancelledRequest = repo.createExternalRequest(
      request("lifecycle-cancelled", 1, ["send"], "session-lifecycle"),
    );
    const cancelInput = {
      workspaceId: "default",
      sessionId: "session-lifecycle",
      requestId: cancelledRequest.request.requestId,
      operatorActorId: "operator-a",
      idempotencyKey: "cancel:lifecycle",
      correlationId: "correlation:cancel:lifecycle",
    } as const;
    const cancelled = repo.cancelExternalRequest(cancelInput);
    assert.equal(cancelled.request.status, "cancelled");
    assert.equal(cancelled.control.generation, 1);
    assert.equal(repo.cancelExternalRequest(cancelInput).disposition, "replayed");

    const requestInput = request("lifecycle", 1, ["send", "read"]);
    const requested = repo.createExternalRequest(requestInput);
    assert.equal(requested.disposition, "created");
    assert.equal(requested.request.status, "pending");
    assert.deepEqual(requested.request.requestedCapabilities, ["send", "read"]);
    assert.equal(requested.control.generation, 1);

    const requestReplay = repo.createExternalRequest(requestInput);
    assert.equal(requestReplay.disposition, "replayed");
    assert.equal(requestReplay.request.requestId, requested.request.requestId);
    assert.throws(
      () => repo.createExternalRequest({ ...requestInput, clientInstanceId: "changed-client" }),
      ConflictError,
    );

    const handoffInput = handoff("lifecycle", requested.request.requestId, 1, ["send", "read"]);
    const handedOff = repo.handoff(handoffInput);
    assert.equal(handedOff.control.ownerKind, "external_companion");
    assert.equal(handedOff.control.generation, 2);
    assert.equal(handedOff.control.leaseState, "external_live");
    assert.deepEqual(handedOff.control.capabilities, ["send", "read"]);
    assert.equal(repo.handoff(handoffInput).disposition, "replayed");

    assert.throws(
      () =>
        repo.resolveMutationAuthority({
          actorKind: "operator",
          workspaceId: "default",
          sessionId: "session-lifecycle",
          expectedGeneration: 2,
        }),
      ConflictError,
    );
    const external = identity("lifecycle", 2, D("token:lifecycle"));
    assert.equal(
      repo.resolveMutationAuthority({ ...external, actorKind: "external_companion", requiredCapability: "read" })
        .generation,
      2,
    );

    const tokenExpiryBeforeHeartbeat = db
      .prepare(
        "SELECT token_expires_at FROM chat_session_control_grants WHERE session_id = @sessionId AND is_current = 1",
      )
      .get<{ token_expires_at: string }>({ sessionId: "session-lifecycle" })!.token_expires_at;
    const heartbeat = repo.heartbeat({ ...external, idempotencyKey: "heartbeat:lifecycle" });
    assert.equal(heartbeat.control.generation, 2);
    assert.equal(heartbeat.control.lastEventReasonCode, "heartbeat");
    assert.equal(
      db
        .prepare(
          "SELECT token_expires_at FROM chat_session_control_grants WHERE session_id = @sessionId AND is_current = 1",
        )
        .get<{ token_expires_at: string }>({ sessionId: "session-lifecycle" })!.token_expires_at,
      tokenExpiryBeforeHeartbeat,
    );

    const stale = repo.markStale({
      workspaceId: "default",
      sessionId: "session-lifecycle",
      expectedGeneration: 2,
      expectedControlRevision: 2,
      idempotencyKey: "stale:lifecycle",
      correlationId: "correlation:stale:lifecycle",
    });
    assert.equal(stale.control.leaseState, "external_stale");
    assert.throws(
      () => repo.resolveMutationAuthority({ ...external, actorKind: "external_companion", requiredCapability: "send" }),
      ConflictError,
    );

    const reconnect = repo.reconnect({
      ...external,
      idempotencyKey: "reconnect:lifecycle",
      correlationId: "correlation:reconnect:lifecycle",
      newTokenHashSha256: D("token:lifecycle:rotated"),
    });
    assert.equal(reconnect.control.generation, 3);
    assert.equal(reconnect.control.ownerKind, "external_companion");
    assert.equal(reconnect.control.lastEventReasonCode, "reconnect");
    assert.throws(
      () => repo.resolveMutationAuthority({ ...external, actorKind: "external_companion", requiredCapability: "send" }),
      ConflictError,
    );

    const releaseIdentity = identity("lifecycle", 3, D("token:lifecycle:rotated"));
    const released = repo.release({ ...releaseIdentity, idempotencyKey: "release:lifecycle" });
    assert.equal(released.control.ownerKind, "operator");
    assert.equal(released.control.generation, 4);
    assert.equal(released.control.lastEventReasonCode, "release");

    seedSessionControlAuth(db, "companion-lifecycle-b", "grant-lifecycle-b");
    const second = repo.createExternalRequest(request("lifecycle-b", 4, ["send"], "session-lifecycle"));
    const secondHandoff = repo.handoff(
      handoff("lifecycle-b", second.request.requestId, 4, ["send"], "session-lifecycle"),
    );
    assert.equal(secondHandoff.control.generation, 5);
    const revoked = repo.revoke({
      workspaceId: "default",
      sessionId: "session-lifecycle",
      expectedGeneration: 5,
      mode: "emergency_takeover",
      operatorActorId: "operator-a",
      idempotencyKey: "revoke:lifecycle",
      correlationId: "correlation:revoke:lifecycle",
    });
    assert.equal(revoked.control.ownerKind, "operator");
    assert.equal(revoked.control.generation, 6);
    assert.equal(revoked.control.lastEventReasonCode, "emergency_takeover");
    assert.equal(
      repo.initializeExistingSession({
        workspaceId: "default",
        sessionId: "session-lifecycle",
        idempotencyKey: "init:lifecycle:after-history",
        correlationId: "correlation:init:lifecycle:after-history",
      }).disposition,
      "already_initialized",
    );

    const events = repo.listEvents("default", "session-lifecycle");
    assert.deepEqual(
      events.map((event) => event.reasonCode),
      [
        "session_initialized",
        "request_created",
        "request_cancelled",
        "request_created",
        "handoff",
        "heartbeat",
        "lease_stale",
        "reconnect",
        "release",
        "request_created",
        "handoff",
        "emergency_takeover",
      ],
    );
    assert.equal(repo.getDetail("default", "session-lifecycle").control.generation, 6);
    assert.equal(
      repo.listControls("default").items.some((item) => item.sessionId === "session-lifecycle"),
      true,
    );
  });

  it("requires exact existing metadata and never creates or moves chat_session_meta", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const repo = new SessionControlRepository(db);
    assert.throws(
      () =>
        repo.initializeExistingSession({
          workspaceId: "default",
          sessionId: "missing-session",
          idempotencyKey: "init:missing",
          correlationId: "correlation:init:missing",
        }),
      /not found/iu,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_session_meta WHERE session_id = 'missing-session'")
        .get<{ count: number }>()!.count,
      0,
    );

    const meta = new ChatSessionMetaRepository(db);
    meta.ensure("session-workspace", new Date().toISOString(), "default");
    assert.throws(
      () =>
        repo.initializeExistingSession({
          workspaceId: "other",
          sessionId: "session-workspace",
          idempotencyKey: "init:wrong-workspace",
          correlationId: "correlation:init:wrong-workspace",
        }),
      /not found/iu,
    );
    const initialized = repo.initializeExistingSession({
      workspaceId: "default",
      sessionId: "session-workspace",
      idempotencyKey: "init:workspace",
      correlationId: "correlation:init:workspace",
    });
    assert.equal(initialized.disposition, "already_initialized");
    assert.equal(
      repo.initializeExistingSession({
        workspaceId: "default",
        sessionId: "session-workspace",
        idempotencyKey: "init:workspace:second",
        correlationId: "correlation:init:workspace:second",
      }).disposition,
      "already_initialized",
    );
    assert.equal(
      db.prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = 'session-workspace'").get<{
        workspace_id: string;
      }>()!.workspace_id,
      "default",
    );
  });

  it("couples companion and device revocation to sorted one-generation operator returns", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const meta = new ChatSessionMetaRepository(db);
    const repo = new SessionControlRepository(db);
    seedSessionControlAuth(db, "companion-shared", "grant-shared");
    for (const seed of ["auth-a", "auth-b"]) {
      const sessionId = `session-${seed}`;
      meta.ensure(sessionId, new Date().toISOString(), "default");
      repo.initializeExistingSession({
        workspaceId: "default",
        sessionId,
        idempotencyKey: `init:${seed}`,
        correlationId: `correlation:init:${seed}`,
      });
      const pending = repo.createExternalRequest(
        request(seed, 1, ["send"], sessionId, "companion-shared", "grant-shared"),
      );
      repo.handoff(handoff(seed, pending.request.requestId, 1, ["send"], sessionId));
    }

    const revoked = repo.revokeByAuthBinding({
      bindingKind: "companion_session",
      bindingId: "companion-shared",
      actorId: "auth-owner",
      idempotencyKey: "auth-revoke:shared",
      correlationId: "correlation:auth-revoke:shared",
    });
    assert.equal(revoked.disposition, "created");
    assert.deepEqual(
      revoked.controls.map((control) => [control.sessionId, control.ownerKind, control.generation]),
      [
        ["session-auth-a", "operator", 3],
        ["session-auth-b", "operator", 3],
      ],
    );
    const replay = repo.revokeByAuthBinding({
      bindingKind: "companion_session",
      bindingId: "companion-shared",
      actorId: "auth-owner",
      idempotencyKey: "auth-revoke:shared",
      correlationId: "correlation:auth-revoke:shared",
    });
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.controls.length, 2);
    assert.throws(
      () =>
        repo.revokeByAuthBinding({
          bindingKind: "companion_session",
          bindingId: "companion-shared",
          actorId: "changed-auth-owner",
          idempotencyKey: "auth-revoke:shared",
          correlationId: "correlation:auth-revoke:shared",
        }),
      ConflictError,
    );
  });

  it("atomically cancels every pending auth binding and revokes current grants with exact replay", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const meta = new ChatSessionMetaRepository(db);
    const repo = new SessionControlRepository(db);
    for (const sessionId of ["session-auth-pending", "session-auth-current"]) {
      meta.ensure(sessionId, new Date().toISOString(), "default");
      repo.initializeExistingSession({
        workspaceId: "default",
        sessionId,
        idempotencyKey: `init:${sessionId}`,
        correlationId: `correlation:init:${sessionId}`,
      });
    }
    seedSessionControlAuth(db, "companion-auth-shared", "grant-auth-shared");

    const pendingOnly = ["pending-a", "pending-b"].map((seed) =>
      repo.createExternalRequest(
        request(seed, 1, ["send"], "session-auth-pending", "companion-auth-shared", "grant-auth-shared"),
      ),
    );
    const activated = repo.createExternalRequest(
      request("current-active", 1, ["send"], "session-auth-current", "companion-auth-shared", "grant-auth-shared"),
    );
    const currentPending = repo.createExternalRequest(
      request(
        "current-pending",
        1,
        ["send", "read"],
        "session-auth-current",
        "companion-auth-shared",
        "grant-auth-shared",
      ),
    );
    repo.handoff(handoff("current-active", activated.request.requestId, 1, ["send"], "session-auth-current"));

    const input = {
      bindingKind: "companion_session",
      bindingId: "companion-auth-shared",
      actorId: "auth-owner",
      idempotencyKey: "auth-revoke:pending-and-current",
      correlationId: "correlation:auth-revoke:pending-and-current",
    } as const;
    const clockProbe = observeDatabaseClockReads(repo);
    const revoked = repo.revokeByAuthBinding(input);
    assert.equal(revoked.disposition, "created");
    assert.equal(clockProbe.readCount(), 1);
    assert.deepEqual(
      revoked.controls.map((control) => [control.sessionId, control.ownerKind, control.generation]),
      [
        ["session-auth-current", "operator", 3],
        ["session-auth-pending", "operator", 1],
      ],
    );

    const cancelledRequestIds = [
      ...pendingOnly.map((outcome) => outcome.request.requestId),
      currentPending.request.requestId,
    ];
    const cancelled = db
      .prepare(
        `SELECT request_id, status, decision_reason_code
         FROM chat_session_control_requests
         WHERE companion_session_id = 'companion-auth-shared' AND status = 'cancelled'
         ORDER BY request_id`,
      )
      .all<{ request_id: string; status: string; decision_reason_code: string }>();
    assert.deepEqual(
      cancelled.map((row) => row.request_id),
      [...cancelledRequestIds].sort(),
    );
    assert.equal(
      cancelled.every((row) => row.decision_reason_code === "request_cancelled"),
      true,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_events
           WHERE reason_code = 'auth_revoked' AND correlation_id = @correlationId`,
        )
        .get<{ count: number }>({ correlationId: input.correlationId })!.count,
      1,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_events
           WHERE reason_code = 'mutation_denied' AND correlation_id = @correlationId`,
        )
        .get<{ count: number }>({ correlationId: input.correlationId })!.count,
      3,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_session_control_events WHERE idempotency_key = @idempotencyKey")
        .get<{ count: number }>({ idempotencyKey: input.idempotencyKey })!.count,
      1,
    );
    const persistedTimestamps = authRevokePersistedTimestamps(db, input, "session-auth-current");
    assert.equal(persistedTimestamps.length, 12);
    assert.deepEqual([...new Set(persistedTimestamps)], [revoked.occurredAt]);
    assert.throws(
      () =>
        repo.handoff(
          handoff(
            "current-pending-after-revoke",
            currentPending.request.requestId,
            3,
            ["send"],
            "session-auth-current",
          ),
        ),
      ConflictError,
    );

    const replay = repo.revokeByAuthBinding(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.occurredAt, revoked.occurredAt);
    assert.equal(clockProbe.readCount(), 1);
    assert.deepEqual(
      replay.controls.map((control) => control.sessionId),
      ["session-auth-current", "session-auth-pending"],
    );
    assert.throws(
      () => repo.revokeByAuthBinding({ ...input, correlationId: "correlation:auth-revoke:changed" }),
      ConflictError,
    );
    assert.equal(clockProbe.readCount(), 1);
    clockProbe.restore();
  });

  it("settles more than 4,000 frozen targets after a deterministic stale-clock delay without opening ordinary writes", () => {
    const seed = "auth-revoke-scale";
    const { db, repo } = createHarness(seed);
    const sessionId = `session-${seed}`;
    const companionSessionId = `companion-${seed}`;
    const deviceGrantId = `grant-${seed}`;
    const targetCount = 4_001;
    for (let index = 0; index < targetCount; index += 1) {
      const requestSeed = `${seed}-${index}`;
      repo.createExternalRequest(request(requestSeed, 1, ["send"], sessionId, companionSessionId, deviceGrantId));
    }

    seedSessionControlAuth(db, "companion-auth-revoke-scale-unrelated", "grant-auth-revoke-scale-unrelated");
    const unrelated = repo.createExternalRequest(
      request(
        "auth-revoke-scale-unrelated",
        1,
        ["send"],
        sessionId,
        "companion-auth-revoke-scale-unrelated",
        "grant-auth-revoke-scale-unrelated",
      ),
    );
    const delay = delayFirstAuthRevokeEvent(repo, 1_300);
    const input = authRevokeInput(seed);
    const startedAt = performance.now();
    const revoked = repo.revokeByAuthBinding(input);
    const elapsedMs = performance.now() - startedAt;
    delay.restore();

    assert.equal(delay.didDelay(), true);
    assert.equal(elapsedMs >= 1_250, true);
    assert.equal(revoked.disposition, "created");
    assert.equal(revoked.occurredAtBasis, "operation");
    assert.equal(requestStatus(db, unrelated.request.requestId), "pending");
    assert.deepEqual(
      {
        ...db
          .prepare(
            `SELECT operation.target_count, operation.session_count, COUNT(target.target_index) AS persisted_targets
           FROM chat_session_control_auth_revoke_operations operation
           JOIN chat_session_control_auth_revoke_operation_targets target
             ON target.operation_idempotency_key = operation.idempotency_key
           WHERE operation.idempotency_key = @idempotencyKey
           GROUP BY operation.target_count, operation.session_count`,
          )
          .get<{ target_count: number; session_count: number; persisted_targets: number }>({
            idempotencyKey: input.idempotencyKey,
          }),
      },
      { target_count: targetCount, session_count: 1, persisted_targets: targetCount },
    );
    const timestamps = db
      .prepare(
        `SELECT occurred_at FROM chat_session_control_auth_revoke_operations
         WHERE idempotency_key = @idempotencyKey
         UNION ALL
         SELECT created_at FROM chat_session_control_auth_revoke_receipts
         WHERE idempotency_key = @idempotencyKey
         UNION ALL
         SELECT created_at FROM chat_session_control_events
         WHERE correlation_id = @correlationId
         UNION ALL
         SELECT decided_at FROM chat_session_control_requests
         WHERE companion_session_id = @bindingId AND status = 'cancelled'`,
      )
      .all<{ occurred_at: string }>({
        bindingId: input.bindingId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      })
      .map((row) => row.occurred_at);
    assert.equal(timestamps.length, targetCount * 2 + 2);
    assert.deepEqual([...new Set(timestamps)], [revoked.occurredAt]);
    assert.equal(repo.revokeByAuthBinding(input).occurredAt, revoked.occurredAt);

    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE chat_session_control_requests
             SET status = 'cancelled', decided_at = @decidedAt, decided_by_actor_id = 'auth-owner',
                 decision_reason_code = 'request_cancelled'
             WHERE request_id = @requestId`,
          )
          .run({ decidedAt: revoked.occurredAt, requestId: unrelated.request.requestId }),
      /database-clock|transition invariant/iu,
    );
    assert.equal(requestStatus(db, unrelated.request.requestId), "pending");
  });

  it("persists exact zero-target auth revoke receipts and never acquires later candidates", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const repo = new SessionControlRepository(db);
    const input = {
      bindingKind: "companion_session",
      bindingId: "companion-auth-noop",
      actorId: "auth-owner",
      idempotencyKey: "auth-revoke:noop",
      correlationId: "correlation:auth-revoke:noop",
    } as const;
    const clockProbe = observeDatabaseClockReads(repo);
    const created = repo.revokeByAuthBinding(input);
    assert.equal(created.disposition, "created");
    assert.deepEqual(created.controls, []);
    assert.equal(clockProbe.readCount(), 1);
    assert.deepEqual(
      {
        ...(db
          .prepare(
            `SELECT binding_kind, binding_id, actor_id, correlation_id, target_count, session_count, created_at
             FROM chat_session_control_auth_revoke_receipts
             WHERE idempotency_key = @idempotencyKey`,
          )
          .get({ idempotencyKey: input.idempotencyKey }) as Record<string, unknown>),
      },
      {
        binding_kind: input.bindingKind,
        binding_id: input.bindingId,
        actor_id: input.actorId,
        correlation_id: input.correlationId,
        target_count: 0,
        session_count: 0,
        created_at: created.occurredAt,
      },
    );
    const replay = repo.revokeByAuthBinding(input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.occurredAt, created.occurredAt);
    assert.throws(() => repo.revokeByAuthBinding({ ...input, actorId: "changed-auth-owner" }), ConflictError);
    assert.equal(clockProbe.readCount(), 1);
    clockProbe.restore();

    const meta = new ChatSessionMetaRepository(db);
    meta.ensure("session-auth-noop-later", new Date().toISOString(), "default");
    repo.initializeExistingSession({
      workspaceId: "default",
      sessionId: "session-auth-noop-later",
      idempotencyKey: "init:auth-noop-later",
      correlationId: "correlation:init:auth-noop-later",
    });
    seedSessionControlAuth(db, input.bindingId, "grant-auth-noop");
    const later = repo.createExternalRequest(
      request("auth-noop-later", 1, ["send"], "session-auth-noop-later", input.bindingId, "grant-auth-noop"),
    );
    assert.deepEqual(repo.revokeByAuthBinding(input).controls, []);
    assert.equal(requestStatus(db, later.request.requestId), "pending");
    const aliasInput = {
      ...input,
      idempotencyKey: `${input.idempotencyKey}::caller-owned-key`,
      correlationId: `${input.correlationId}:alias`,
    };
    assert.equal(repo.revokeByAuthBinding(aliasInput).disposition, "created");
    assert.equal(requestStatus(db, later.request.requestId), "cancelled");
    const originalReplay = repo.revokeByAuthBinding(input);
    assert.deepEqual(originalReplay.controls, []);
    assert.equal(originalReplay.occurredAt, created.occurredAt);
  });

  it("rolls back every auth-bound mutation when the canonical receipt cannot persist", () => {
    const { db, repo } = createHarness("auth-revoke-rollback");
    const sessionId = "session-auth-revoke-rollback";
    const companionSessionId = "companion-auth-revoke-rollback";
    const deviceGrantId = "grant-auth-revoke-rollback";
    const active = repo.createExternalRequest(
      request("auth-revoke-rollback-active", 1, ["send"], sessionId, companionSessionId, deviceGrantId),
    );
    const pending = repo.createExternalRequest(
      request("auth-revoke-rollback-pending", 1, ["send", "read"], sessionId, companionSessionId, deviceGrantId),
    );
    repo.handoff(handoff("auth-revoke-rollback-active", active.request.requestId, 1, ["send"], sessionId));
    const input = authRevokeInput("auth-revoke-rollback");
    db.exec(`
      CREATE TRIGGER gc_test_fail_auth_revoke_receipt
      BEFORE INSERT ON chat_session_control_auth_revoke_receipts
      BEGIN
        SELECT RAISE(ABORT, 'forced auth revoke receipt failure');
      END;
    `);
    const clockProbe = observeDatabaseClockReads(repo);
    assert.throws(() => repo.revokeByAuthBinding(input), /durable authority|forced auth revoke receipt failure/iu);
    assert.equal(clockProbe.readCount(), 1);
    assert.equal(requestStatus(db, pending.request.requestId), "pending");
    assert.deepEqual(
      [repo.getControl("default", sessionId).ownerKind, repo.getControl("default", sessionId).generation],
      ["external_companion", 2],
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_events
           WHERE correlation_id = @correlationId`,
        )
        .get<{ count: number }>({ correlationId: input.correlationId })!.count,
      0,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_receipts
           WHERE idempotency_key = @idempotencyKey`,
        )
        .get<{ count: number }>({ idempotencyKey: input.idempotencyKey })!.count,
      0,
    );

    db.exec("DROP TRIGGER gc_test_fail_auth_revoke_receipt;");
    const retry = repo.revokeByAuthBinding(input);
    assert.equal(retry.disposition, "created");
    assert.equal(clockProbe.readCount(), 2);
    assert.equal(repo.revokeByAuthBinding(input).occurredAt, retry.occurredAt);
    assert.equal(clockProbe.readCount(), 2);
    clockProbe.restore();
  });

  it("rejects incomplete, premature, extra, and changed auth-revoke operation evidence", () => {
    const fixture = createRawAuthRevokeFixture("auth-revoke-malformed");

    assert.throws(
      () => fixture.db.transaction("immediate", () => insertRawAuthRevokeOperation(fixture)),
      /foreign key|constraint/iu,
    );
    assert.equal(rawAuthRevokeOperationCount(fixture), 0);

    assert.throws(
      () =>
        fixture.db.transaction("immediate", () => {
          insertRawAuthRevokeOperation(fixture);
          insertRawAuthRevokeReceipt(fixture);
        }),
      /receipt invariant/iu,
    );
    assert.equal(rawAuthRevokeOperationCount(fixture), 0);

    assert.throws(
      () =>
        fixture.db.transaction("immediate", () => {
          insertRawAuthRevokeOperation(fixture);
          insertRawAuthRevokeTarget(fixture, { generation: fixture.generation + 1 });
        }),
      /target invariant/iu,
    );
    assert.equal(rawAuthRevokeOperationCount(fixture), 0);

    assert.throws(
      () =>
        fixture.db.transaction("immediate", () => {
          insertRawAuthRevokeOperation(fixture);
          insertRawAuthRevokeTarget(fixture);
          insertRawAuthRevokeTarget(fixture, {
            targetIndex: 1,
            eventId: `${fixture.eventId}-extra`,
            eventIdempotencyKey: `${fixture.eventIdempotencyKey}-extra`,
            eventSequence: fixture.eventSequence + 1,
          });
        }),
      /target invariant/iu,
    );
    assert.equal(rawAuthRevokeOperationCount(fixture), 0);

    assert.throws(
      () =>
        fixture.db.transaction("immediate", () => {
          insertRawAuthRevokeOperation(fixture);
          insertRawAuthRevokeTarget(fixture);
          settleRawAuthRevokeRequest(fixture);
          insertRawAuthRevokeReceipt(fixture);
        }),
      /receipt invariant/iu,
    );
    assert.equal(requestStatus(fixture.db, fixture.requestId), "pending");

    assert.throws(
      () =>
        fixture.db.transaction("immediate", () => {
          insertRawAuthRevokeOperation(fixture);
          insertRawAuthRevokeTarget(fixture);
          settleRawAuthRevokeRequest(fixture);
          insertRawAuthRevokeEvent(fixture, { actorId: "changed-actor" });
        }),
      /event request or auth operation invariant/iu,
    );
    assert.equal(requestStatus(fixture.db, fixture.requestId), "pending");

    assert.throws(
      () =>
        fixture.db.transaction("immediate", () => {
          insertRawAuthRevokeOperation(fixture);
          insertRawAuthRevokeTarget(fixture);
          settleRawAuthRevokeRequest(fixture);
          insertRawAuthRevokeEvent(fixture);
          insertRawAuthRevokeEvent(fixture, {
            eventId: `${fixture.eventId}-extra`,
            eventIdempotencyKey: `${fixture.eventIdempotencyKey}-extra`,
            eventSequence: fixture.eventSequence + 1,
          });
        }),
      /event request or auth operation invariant/iu,
    );
    assert.equal(rawAuthRevokeOperationCount(fixture), 0);
    assert.equal(requestStatus(fixture.db, fixture.requestId), "pending");
  });

  it("closes settled auth-revoke context against mutation, deletion, extension, and identity reuse", () => {
    const seed = "auth-revoke-settled";
    const { db, repo } = createHarness(seed);
    repo.createExternalRequest(
      request(`${seed}-pending`, 1, ["send"], `session-${seed}`, `companion-${seed}`, `grant-${seed}`),
    );
    const input = authRevokeInput(seed);
    const created = repo.revokeByAuthBinding(input);
    const replayed = repo.revokeByAuthBinding(input);
    assert.equal(created.disposition, "created");
    assert.equal(replayed.disposition, "replayed");
    assert.equal(
      canonicalJsonString({ occurredAt: created.occurredAt, controls: created.controls }),
      canonicalJsonString({ occurredAt: replayed.occurredAt, controls: replayed.controls }),
    );

    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE chat_session_control_auth_revoke_operations SET actor_id = 'changed-actor'
             WHERE idempotency_key = @idempotencyKey`,
          )
          .run({ idempotencyKey: input.idempotencyKey }),
      /immutable/iu,
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM chat_session_control_auth_revoke_operations WHERE idempotency_key = @idempotencyKey")
          .run({ idempotencyKey: input.idempotencyKey }),
      /immutable/iu,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE chat_session_control_auth_revoke_operation_targets SET event_sequence = event_sequence + 1
             WHERE operation_idempotency_key = @idempotencyKey`,
          )
          .run({ idempotencyKey: input.idempotencyKey }),
      /immutable/iu,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "DELETE FROM chat_session_control_auth_revoke_operation_targets WHERE operation_idempotency_key = @idempotencyKey",
          )
          .run({ idempotencyKey: input.idempotencyKey }),
      /immutable/iu,
    );
    const frozenTarget = db
      .prepare(
        `SELECT * FROM chat_session_control_auth_revoke_operation_targets
         WHERE operation_idempotency_key = @idempotencyKey`,
      )
      .get<Record<string, string | number | null>>({ idempotencyKey: input.idempotencyKey })!;
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO chat_session_control_auth_revoke_operation_targets (
               operation_idempotency_key, target_index, target_kind, workspace_id, session_id,
               request_id, generation, control_revision, owner_kind, lease_state,
               event_id, event_sequence, event_idempotency_key, event_reason_code
             ) VALUES (
               @operationIdempotencyKey, 1, @targetKind, @workspaceId, @sessionId,
               @requestId, @generation, @controlRevision, @ownerKind, @leaseState,
               @eventId, @eventSequence, @eventIdempotencyKey, @eventReasonCode
             )`,
          )
          .run({
            operationIdempotencyKey: input.idempotencyKey,
            targetKind: frozenTarget.target_kind,
            workspaceId: frozenTarget.workspace_id,
            sessionId: frozenTarget.session_id,
            requestId: frozenTarget.request_id,
            generation: frozenTarget.generation,
            controlRevision: frozenTarget.control_revision,
            ownerKind: frozenTarget.owner_kind,
            leaseState: frozenTarget.lease_state,
            eventId: `${String(frozenTarget.event_id)}-reuse`,
            eventSequence: Number(frozenTarget.event_sequence) + 1,
            eventIdempotencyKey: `${String(frozenTarget.event_idempotency_key)}-reuse`,
            eventReasonCode: frozenTarget.event_reason_code,
          }),
      /target invariant/iu,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_operation_targets
           WHERE operation_idempotency_key = @idempotencyKey`,
        )
        .get<{ count: number }>({ idempotencyKey: input.idempotencyKey })!.count,
      1,
    );
  });

  it("replays pre-173 receipts as legacy receipt-time evidence without opening the operation bypass", () => {
    const directory = mkdtempSync(join(tmpdir(), "goatcitadel-hx411-legacy-receipt-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "legacy.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const markApplied = raw.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)");
    for (let version = 1; version <= 172; version += 1) {
      raw.exec("BEGIN IMMEDIATE");
      try {
        __sqliteInternals.applySchemaMigrationForTest(version, raw);
        markApplied.run(version, __sqliteInternals.getSchemaMigrationNameForTest(version), new Date().toISOString());
        raw.exec("COMMIT");
      } catch (error) {
        raw.exec("ROLLBACK");
        raw.close();
        throw error;
      }
    }
    const input = authRevokeInput("legacy-receipt");
    const requestSha256 = D(canonicalJsonString({ operation: "auth_revoke", value: input }));
    const occurredAt = raw.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get() as { now: string };
    raw
      .prepare(
        `INSERT INTO chat_session_control_auth_revoke_receipts (
           idempotency_key, request_sha256, binding_kind, binding_id, actor_id,
           correlation_id, target_count, session_count, event_set_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(
        input.idempotencyKey,
        requestSha256,
        input.bindingKind,
        input.bindingId,
        input.actorId,
        input.correlationId,
        D("[]"),
        occurredAt.now,
      );
    raw.close();

    const db = createDatabase({ dbPath });
    clients.push(db);
    const repo = new SessionControlRepository(db);
    const replayed = repo.revokeByAuthBinding(input);
    assert.deepEqual(
      {
        disposition: replayed.disposition,
        occurredAt: replayed.occurredAt,
        occurredAtBasis: replayed.occurredAtBasis,
        controls: replayed.controls,
      },
      {
        disposition: "replayed",
        occurredAt: occurredAt.now,
        occurredAtBasis: "legacy_receipt",
        controls: [],
      },
    );
    const freshNow = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!.now;
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO chat_session_control_auth_revoke_operations (
               idempotency_key, request_sha256, binding_kind, binding_id, actor_id,
               correlation_id, target_count, session_count, event_set_sha256, occurred_at
             ) VALUES (
               @idempotencyKey, @requestSha256, @bindingKind, @bindingId, @actorId,
               @correlationId, 0, 0, @eventSetSha256, @occurredAt
             )`,
          )
          .run({
            idempotencyKey: input.idempotencyKey,
            requestSha256,
            bindingKind: input.bindingKind,
            bindingId: input.bindingId,
            actorId: input.actorId,
            correlationId: input.correlationId,
            eventSetSha256: D("[]"),
            occurredAt: freshNow,
          }),
      /operation invariant/iu,
    );
    assert.equal(repo.revokeByAuthBinding(input).occurredAtBasis, "legacy_receipt");
  });

  it("fails closed for missing or corrupt auth revoke receipts and event sets", () => {
    const receiptCorrupt = createHarness("receipt-corrupt");
    receiptCorrupt.repo.createExternalRequest(request("receipt-corrupt", 1, ["send"]));
    const receiptInput = authRevokeInput("receipt-corrupt");
    receiptCorrupt.repo.revokeByAuthBinding(receiptInput);
    receiptCorrupt.db.exec("DROP TRIGGER trg_chat_session_control_auth_revoke_receipts_no_update;");
    receiptCorrupt.db
      .prepare(
        `UPDATE chat_session_control_auth_revoke_receipts SET event_set_sha256 = @eventSetSha256
         WHERE idempotency_key = @idempotencyKey`,
      )
      .run({ eventSetSha256: D("corrupt-receipt-event-set"), idempotencyKey: receiptInput.idempotencyKey });
    assert.throws(() => receiptCorrupt.repo.revokeByAuthBinding(receiptInput), /corrupt/iu);

    const eventCorrupt = createHarness("event-set-corrupt");
    eventCorrupt.repo.createExternalRequest(request("event-set-corrupt", 1, ["send"]));
    const eventInput = authRevokeInput("event-set-corrupt");
    eventCorrupt.repo.revokeByAuthBinding(eventInput);
    eventCorrupt.db.exec("DROP TRIGGER trg_chat_session_control_events_no_update;");
    eventCorrupt.db
      .prepare(
        `UPDATE chat_session_control_events SET actor_id = 'corrupt-auth-owner'
         WHERE idempotency_key = @idempotencyKey`,
      )
      .run({ idempotencyKey: eventInput.idempotencyKey });
    assert.throws(() => eventCorrupt.repo.revokeByAuthBinding(eventInput), /corrupt/iu);

    const missing = createHarness("receipt-missing");
    missing.repo.createExternalRequest(request("receipt-missing", 1, ["send"]));
    const missingInput = authRevokeInput("receipt-missing");
    missing.repo.revokeByAuthBinding(missingInput);
    missing.db.exec("DROP TRIGGER trg_chat_session_control_auth_revoke_receipts_no_delete;");
    assert.throws(
      () =>
        missing.db
          .prepare("DELETE FROM chat_session_control_auth_revoke_receipts WHERE idempotency_key = @idempotencyKey")
          .run({ idempotencyKey: missingInput.idempotencyKey }),
      /foreign key|constraint/iu,
    );
    missing.db.exec("PRAGMA foreign_keys = OFF;");
    missing.db
      .prepare("DELETE FROM chat_session_control_auth_revoke_receipts WHERE idempotency_key = @idempotencyKey")
      .run({ idempotencyKey: missingInput.idempotencyKey });
    missing.db.exec("PRAGMA foreign_keys = ON;");
    assert.throws(() => missing.repo.revokeByAuthBinding(missingInput), /immutable receipt|corrupt/iu);
  });

  it("freezes exact auth parent linkage even across same-purpose rows", () => {
    const { db } = createHarness("auth-parent-a");
    seedSessionControlAuth(db, "companion-auth-parent-b", "grant-auth-parent-b");
    const clock = db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day') AS expires_at`,
      )
      .get<{ now: string; expires_at: string }>()!;
    db.prepare(
      `INSERT INTO auth_device_requests (
         request_id, approval_id, request_secret_hash, device_label, device_type, status,
         created_at, expires_at, resolved_at, resolved_by, principal_purpose
       ) VALUES (
         'auth-parent-orphan', 'approval-auth-parent-orphan', @secretHash,
         'HX-411 orphan parent', 'test', 'approved', @now, @expiresAt, @now,
         'operator-a', 'session_control_client'
       )`,
    ).run({ secretHash: D("auth-parent-orphan"), now: clock.now, expiresAt: clock.expires_at });
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE auth_device_grants SET request_id = 'auth-parent-orphan'
             WHERE grant_id = 'grant-auth-parent-a'`,
          )
          .run(),
      /immutable|parent/iu,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE companion_sessions SET grant_id = 'grant-auth-parent-b'
             WHERE session_id = 'companion-auth-parent-a'`,
          )
          .run(),
      /immutable|parent/iu,
    );
  });

  it("serializes one zero-target auth revoke receipt winner across two SQLite connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "goatcitadel-hx411-auth-receipt-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "session-control.sqlite");
    createDatabase({ dbPath }).close();
    const input = authRevokeInput("receipt-race");
    const results = await runSqliteRepositoryRace(dbPath, "revokeByAuthBinding", [input, input]);
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    assert.deepEqual(results.map((result) => result.disposition).sort(), ["created", "replayed"]);
    const verifyDb = createDatabase({ dbPath });
    clients.push(verifyDb);
    const receipt = verifyDb
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS created_at
         FROM chat_session_control_auth_revoke_receipts
         WHERE idempotency_key = @idempotencyKey`,
      )
      .get<{ count: number; created_at: string }>({ idempotencyKey: input.idempotencyKey })!;
    assert.equal(receipt.count, 1);
    assert.deepEqual(
      results.map((result) => result.occurredAt),
      [receipt.created_at, receipt.created_at],
    );
  });

  it("rejects canonical-hash drift, foreign request attribution, and mismatched terminal reasons at SQL and read time", () => {
    const { db, repo } = createHarness("integrity-read");
    const pending = repo.createExternalRequest(request("integrity-read", 1, ["send"]));
    const clock = db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes') AS expires_at`,
      )
      .get<{ now: string; expires_at: string }>()!;

    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO chat_session_control_tokens (token_sha256, workspace_id, session_id, created_at)
           VALUES (@token, 'foreign-workspace', 'session-integrity-read', @now)`,
        )
        .run({ token: D("foreign-workspace-token"), now: clock.now }),
    );

    const badHashRequestId = "request-bad-canonical-hash";
    const badHashToken = D("bad-canonical-hash-token");
    db.prepare(
      `INSERT INTO chat_session_control_tokens (
         token_sha256, workspace_id, session_id, first_request_id, created_at
       ) VALUES (@token, 'default', 'session-integrity-read', @requestId, @now)`,
    ).run({ token: badHashToken, requestId: badHashRequestId, now: clock.now });
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO chat_session_control_requests (
             request_id, workspace_id, session_id, companion_session_id, device_grant_id,
             client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
             requested_capabilities_sha256, requested_generation, status, idempotency_key,
             request_sha256, expires_at, created_at
           ) VALUES (
             @requestId, 'default', 'session-integrity-read', 'companion-bad-hash', 'grant-bad-hash',
             'client-bad-hash', 'session_control_client', @token, '["send"]', @wrongDigest,
             1, 'pending', 'request:bad-canonical-hash', @requestDigest, @expiresAt, @now
           )`,
        )
        .run({
          requestId: badHashRequestId,
          token: badHashToken,
          wrongDigest: D("not-[send]"),
          requestDigest: D("request:bad-canonical-hash"),
          expiresAt: clock.expires_at,
          now: clock.now,
        }),
    );

    const badReasonRequestId = "request-bad-terminal-reason";
    const badReasonToken = D("bad-terminal-reason-token");
    db.prepare(
      `INSERT INTO chat_session_control_tokens (
         token_sha256, workspace_id, session_id, first_request_id, created_at
       ) VALUES (@token, 'default', 'session-integrity-read', @requestId, @now)`,
    ).run({ token: badReasonToken, requestId: badReasonRequestId, now: clock.now });
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO chat_session_control_requests (
             request_id, workspace_id, session_id, companion_session_id, device_grant_id,
             client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
             requested_capabilities_sha256, requested_generation, status, idempotency_key,
             request_sha256, expires_at, created_at, decided_at, decided_by_actor_id, decision_reason_code
           ) VALUES (
             @requestId, 'default', 'session-integrity-read', 'companion-bad-reason', 'grant-bad-reason',
             'client-bad-reason', 'session_control_client', @token, '["send"]', @capabilitiesDigest,
             1, 'rejected', 'request:bad-terminal-reason', @requestDigest, @expiresAt, @now,
             @now, 'operator-a', 'request_cancelled'
           )`,
        )
        .run({
          requestId: badReasonRequestId,
          token: badReasonToken,
          capabilitiesDigest: D('["send"]'),
          requestDigest: D("request:bad-terminal-reason"),
          expiresAt: clock.expires_at,
          now: clock.now,
        }),
    );

    const foreignDb = createDatabase({ dbPath: ":memory:" });
    clients.push(foreignDb);
    const foreignMeta = new ChatSessionMetaRepository(foreignDb);
    const foreignRepo = new SessionControlRepository(foreignDb);
    for (const sessionId of ["session-event-a", "session-event-b"]) {
      foreignMeta.ensure(sessionId, new Date().toISOString(), "default");
      foreignRepo.initializeExistingSession({
        workspaceId: "default",
        sessionId,
        idempotencyKey: `init:${sessionId}`,
        correlationId: `correlation:init:${sessionId}`,
      });
    }
    seedSessionControlAuth(foreignDb, "companion-event-b", "grant-event-b");
    const foreignRequest = foreignRepo.createExternalRequest(request("event-b", 1, ["send"], "session-event-b"));
    const eventClock = foreignDb.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!
      .now;
    assert.throws(() =>
      foreignDb
        .prepare(
          `INSERT INTO chat_session_control_events (
             event_id, workspace_id, session_id, event_sequence, request_id,
             previous_generation, next_generation, previous_owner_kind, next_owner_kind,
             previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
             companion_session_id, device_grant_id, idempotency_key, request_sha256,
             correlation_id, created_at
           ) VALUES (
             'foreign-event-request', 'default', 'session-event-a', 2, @requestId,
             1, 1, 'operator', 'operator', 'operator_active', 'operator_active',
             'mutation_denied', 'system', 'system', 'companion-event-b', 'grant-event-b',
             'foreign-event-request', @requestDigest, 'foreign-event-request', @now
           )`,
        )
        .run({
          requestId: foreignRequest.request.requestId,
          requestDigest: D("foreign-event-request"),
          now: eventClock,
        }),
    );

    db.exec("DROP TRIGGER trg_chat_session_control_requests_transition_guard; PRAGMA ignore_check_constraints = ON;");
    db.prepare(
      `UPDATE chat_session_control_requests
       SET requested_capabilities_sha256 = @wrongDigest
       WHERE request_id = @requestId`,
    ).run({ requestId: pending.request.requestId, wrongDigest: D("read-time-drift") });
    assert.throws(
      () => repo.getDetail("default", "session-integrity-read"),
      /state is corrupt|capability binding is corrupt/iu,
    );
  });

  it("fails closed when canonical auth is revoked or expires after request creation and before handoff", () => {
    const revoked = createHarness("auth-recheck-revoked");
    const revokedRequest = revoked.repo.createExternalRequest(request("auth-recheck-revoked", 1, ["send"]));
    revoked.db
      .prepare(
        `UPDATE companion_sessions SET revoked_at = @revokedAt
         WHERE session_id = 'companion-auth-recheck-revoked'`,
      )
      .run({ revokedAt: new Date().toISOString() });
    assert.throws(
      () => revoked.repo.handoff(handoff("auth-recheck-revoked", revokedRequest.request.requestId, 1, ["send"])),
      ConflictError,
    );
    assert.equal(revoked.repo.getControl("default", "session-auth-recheck-revoked").generation, 1);
    assert.equal(requestStatus(revoked.db, revokedRequest.request.requestId), "pending");

    const expired = createHarness("auth-recheck-expired");
    const expiredRequest = expired.repo.createExternalRequest(request("auth-recheck-expired", 1, ["send"]));
    expired.db
      .prepare(
        `UPDATE companion_sessions SET refresh_token_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE session_id = 'companion-auth-recheck-expired'`,
      )
      .run();
    assert.throws(
      () => expired.repo.handoff(handoff("auth-recheck-expired", expiredRequest.request.requestId, 1, ["send"])),
      ConflictError,
    );
    assert.equal(expired.repo.getControl("default", "session-auth-recheck-expired").generation, 1);
    assert.equal(requestStatus(expired.db, expiredRequest.request.requestId), "pending");
  });

  it("rejects a delayed stale observation after heartbeat and accepts the current disconnect revision", () => {
    const { db, repo } = createHarness("stale-revision");
    const pending = repo.createExternalRequest(request("stale-revision", 1, ["send"]));
    repo.handoff(handoff("stale-revision", pending.request.requestId, 1, ["send"]));
    const external = identity("stale-revision", 2, D("token:stale-revision"));
    const observedRevision = db
      .prepare(
        `SELECT control_revision FROM chat_session_control_grants
         WHERE session_id = 'session-stale-revision' AND is_current = 1`,
      )
      .get<{ control_revision: number }>()!.control_revision;
    assert.equal(observedRevision, 1);
    repo.heartbeat({ ...external, idempotencyKey: "heartbeat:stale-revision" });
    assert.throws(
      () =>
        repo.markStale({
          workspaceId: "default",
          sessionId: "session-stale-revision",
          expectedGeneration: 2,
          expectedControlRevision: observedRevision,
          idempotencyKey: "stale:delayed-observation",
          correlationId: "correlation:stale:delayed-observation",
        }),
      ConflictError,
    );
    assert.equal(repo.getControl("default", "session-stale-revision").leaseState, "external_live");
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_events
           WHERE session_id = 'session-stale-revision' AND reason_code = 'lease_stale'`,
        )
        .get<{ count: number }>()!.count,
      0,
    );
    const currentRevision = db
      .prepare(
        `SELECT control_revision FROM chat_session_control_grants
         WHERE session_id = 'session-stale-revision' AND is_current = 1`,
      )
      .get<{ control_revision: number }>()!.control_revision;
    assert.equal(currentRevision, 2);
    const stale = repo.markStale({
      workspaceId: "default",
      sessionId: "session-stale-revision",
      expectedGeneration: 2,
      expectedControlRevision: currentRevision,
      idempotencyKey: "stale:current-disconnect",
      correlationId: "correlation:stale:current-disconnect",
    });
    assert.equal(stale.control.leaseState, "external_stale");
    assert.throws(
      () =>
        repo.markStale({
          workspaceId: "default",
          sessionId: "session-stale-revision",
          expectedGeneration: 2,
          expectedControlRevision: currentRevision + 1,
          idempotencyKey: "stale:current-disconnect",
          correlationId: "correlation:stale:current-disconnect",
        }),
      ConflictError,
    );
  });

  it("hard-revokes ambiguous external identity with one operator winner across two connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "goatcitadel-hx411-identity-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "session-control.sqlite");
    const setupDb = createDatabase({ dbPath });
    const meta = new ChatSessionMetaRepository(setupDb);
    meta.ensure("session-identity-ambiguity", new Date().toISOString(), "default");
    const repo = new SessionControlRepository(setupDb);
    repo.initializeExistingSession({
      workspaceId: "default",
      sessionId: "session-identity-ambiguity",
      idempotencyKey: "init:identity-ambiguity",
      correlationId: "correlation:init:identity-ambiguity",
    });
    seedSessionControlAuth(setupDb, "companion-identity-ambiguity", "grant-identity-ambiguity");
    const pending = repo.createExternalRequest(request("identity-ambiguity", 1, ["send"]));
    repo.handoff(handoff("identity-ambiguity", pending.request.requestId, 1, ["send"]));
    setupDb.close();

    const inputs = ["left", "right"].map(
      (contender): RevokeIdentityAmbiguityInput => ({
        workspaceId: "default",
        sessionId: "session-identity-ambiguity",
        expectedGeneration: 2,
        systemActorId: `gateway-${contender}`,
        idempotencyKey: `identity-ambiguity:revoke:${contender}`,
        correlationId: `correlation:identity-ambiguity:revoke:${contender}`,
      }),
    ) as [RevokeIdentityAmbiguityInput, RevokeIdentityAmbiguityInput];
    const results = await runSqliteRepositoryRace(dbPath, "revokeIdentityAmbiguity", inputs);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);

    const verifyDb = createDatabase({ dbPath });
    clients.push(verifyDb);
    const verifyRepo = new SessionControlRepository(verifyDb);
    const current = verifyRepo.getControl("default", "session-identity-ambiguity");
    assert.equal(current.ownerKind, "operator");
    assert.equal(current.generation, 3);
    assert.equal(current.lastEventReasonCode, "identity_revoked");
    assert.equal(
      verifyDb
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_grants
           WHERE session_id = 'session-identity-ambiguity' AND generation = 2
             AND is_current = 0 AND lease_state = 'revoked'`,
        )
        .get<{ count: number }>()!.count,
      1,
    );
    assert.equal(
      verifyDb
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_events
           WHERE session_id = 'session-identity-ambiguity' AND reason_code = 'identity_revoked'`,
        )
        .get<{ count: number }>()!.count,
      1,
    );
    assert.equal(
      verifyDb
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_events
           WHERE session_id = 'session-identity-ambiguity' AND reason_code = 'lease_stale'`,
        )
        .get<{ count: number }>()!.count,
      0,
    );
    const winner = inputs[results.findIndex((result) => result.ok)]!;
    assert.equal(verifyRepo.revokeIdentityAmbiguity(winner).disposition, "replayed");
    assert.throws(
      () => verifyRepo.revokeIdentityAmbiguity({ ...winner, systemActorId: "gateway-conflict" }),
      ConflictError,
    );
  });

  it("enforces hash-only, content-free, monotonic, immutable, and no-cascade SQL invariants", () => {
    const { db, repo } = createHarness("sql");
    const pending = repo.createExternalRequest(request("sql", 1, ["send"]));
    repo.handoff(handoff("sql", pending.request.requestId, 1, ["send"]));
    repo.release({ ...identity("sql", 2, D("token:sql")), idempotencyKey: "release:sql" });

    const eventColumns = db.prepare("PRAGMA table_info(chat_session_control_events)").all<{ name: string }>();
    assert.equal(
      eventColumns.some((column) => /(?:content|message|prompt|tool|approval|plaintext|payload)/iu.test(column.name)),
      false,
    );
    assert.throws(
      () => db.prepare("UPDATE chat_session_control_events SET actor_id = 'attacker'").run(),
      /append-only/iu,
    );
    assert.throws(() => db.prepare("DELETE FROM chat_session_control_events").run(), /append-only/iu);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE chat_session_control_grants SET updated_at = @now, control_revision = control_revision + 1 WHERE session_id = 'session-sql' AND generation = 2",
          )
          .run({ now: new Date().toISOString() }),
      /transition invariant/iu,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO chat_session_control_tokens (
               token_sha256, workspace_id, session_id, created_at
             ) VALUES (@token, 'default', 'session-other', @now)`,
          )
          .run({ token: D("token:sql"), now: new Date().toISOString() }),
      /unique|constraint|binding invariant/iu,
    );
    const badCapabilityToken = D("bad-capability-token");
    db.prepare(
      `INSERT INTO chat_session_control_tokens (
         token_sha256, workspace_id, session_id, created_at
       ) VALUES (@token, 'default', 'session-sql', @now)`,
    ).run({ token: badCapabilityToken, now: new Date().toISOString() });
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO chat_session_control_requests (
               request_id, workspace_id, session_id, companion_session_id, device_grant_id,
               client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
               requested_capabilities_sha256, requested_generation, status, idempotency_key,
               request_sha256, expires_at, created_at
             ) VALUES (
               'bad-request', 'default', 'session-sql', 'companion', 'grant', 'client',
               'session_control_client', @token, '["read"]', @digest, 3, 'pending',
               'bad:request', @digest, '2099-01-01T00:00:00.000Z', @now
             )`,
          )
          .run({ token: badCapabilityToken, digest: D("bad"), now: new Date().toISOString() }),
      /constraint|binding invariant/iu,
    );
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
               'default', 'session-clock-invalid', 1, 1, 'operator', 'operator_active',
               '[]', @emptyDigest, '[]', @emptyDigest, 1, 'clock:invalid', @requestDigest,
               '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
             )`,
          )
          .run({ emptyDigest: D("[]"), requestDigest: D("clock:invalid") }),
      /database-clock/iu,
    );

    assert.throws(
      () => db.prepare("DELETE FROM chat_session_meta WHERE session_id = 'session-sql'").run(),
      /terminal lifecycle evidence/iu,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chat_session_control_grants WHERE session_id = 'session-sql'").get<{
        count: number;
      }>()!.count,
      3,
    );
    assert.equal(repo.listEvents("default", "session-sql").length, 4);
  });

  it("uses BEGIN IMMEDIATE to permit one SQLite handoff winner across two connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "goatcitadel-hx411-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "session-control.sqlite");
    const setupDb = createDatabase({ dbPath });
    const meta = new ChatSessionMetaRepository(setupDb);
    const repo = new SessionControlRepository(setupDb);
    meta.ensure("session-race", new Date().toISOString(), "default");
    repo.initializeExistingSession({
      workspaceId: "default",
      sessionId: "session-race",
      idempotencyKey: "init:race",
      correlationId: "correlation:init:race",
    });
    seedSessionControlAuth(setupDb, "companion-race-left", "grant-race-left");
    seedSessionControlAuth(setupDb, "companion-race-right", "grant-race-right");
    const left = repo.createExternalRequest(request("race-left", 1, ["send"], "session-race"));
    const right = repo.createExternalRequest(request("race-right", 1, ["send"], "session-race"));
    setupDb.close();

    const results = await runSqliteRepositoryRace(dbPath, "handoff", [
      handoff("race-left", left.request.requestId, 1, ["send"], "session-race"),
      handoff("race-right", right.request.requestId, 1, ["send"], "session-race"),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);

    const verifyDb = createDatabase({ dbPath });
    clients.push(verifyDb);
    const verifyRepo = new SessionControlRepository(verifyDb);
    assert.equal(verifyRepo.getControl("default", "session-race").generation, 2);
    assert.equal(
      verifyDb
        .prepare(
          "SELECT COUNT(*) AS count FROM chat_session_control_grants WHERE session_id = 'session-race' AND is_current = 1",
        )
        .get<{ count: number }>()!.count,
      1,
    );
    assert.equal(
      verifyDb
        .prepare(
          "SELECT COUNT(*) AS count FROM chat_session_control_events WHERE session_id = 'session-race' AND reason_code = 'handoff'",
        )
        .get<{ count: number }>()!.count,
      1,
    );
  });
});

describe("SessionControlRepository event-sequence stream paging (HX-411)", () => {
  it("forward-pages control events by event_sequence PAST the list cap and reports honest bounds", () => {
    const { repo } = createHarness("stream-paging");
    const requested = repo.createExternalRequest(request("stream-paging", 1, ["send", "read"]));
    repo.handoff(handoff("stream-paging", requested.request.requestId, 1, ["send", "read"]));
    const external = identity("stream-paging", 2, D("token:stream-paging"));
    // One control event per heartbeat (not collapsed) — routinely crosses the 200 list cap.
    for (let beat = 1; beat <= 205; beat += 1) {
      repo.heartbeat({
        ...external,
        idempotencyKey: `hb:stream-paging:${beat}`,
        correlationId: `correlation:hb:stream-paging:${beat}`,
      });
    }
    // A late, distinctive "recent" event well past sequence 200.
    repo.revoke({
      workspaceId: "default",
      sessionId: "session-stream-paging",
      expectedGeneration: 2,
      mode: "emergency_takeover",
      operatorActorId: "operator-a",
      idempotencyKey: "revoke:stream-paging",
      correlationId: "correlation:revoke:stream-paging",
    });

    // 1 init + 1 request + 1 handoff + 205 heartbeats + 1 revoke = 209.
    const bounds = repo.getEventSequenceBounds("default", "session-stream-paging");
    assert.equal(bounds.oldestSequence, 1);
    assert.equal(bounds.newestSequence, 209);

    // The old oldest-200 cap would leave 201+ permanently unreachable; the
    // after-sequence path reaches them, including the recent emergency takeover.
    const recent = repo.listEventsAfterSequence("default", "session-stream-paging", 200, 200);
    assert.deepEqual(
      recent.map((row) => row.sequence),
      [201, 202, 203, 204, 205, 206, 207, 208, 209],
    );
    assert.equal(recent.at(-1)?.sequence, 209);
    assert.equal(recent.at(-1)?.event.reasonCode, "emergency_takeover");

    // Forward paging with a small limit walks the log in ascending sequence order.
    const firstPage = repo.listEventsAfterSequence("default", "session-stream-paging", 0, 3);
    assert.deepEqual(
      firstPage.map((row) => row.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      firstPage.map((row) => row.event.reasonCode),
      ["session_initialized", "request_created", "handoff"],
    );
    const secondPage = repo.listEventsAfterSequence("default", "session-stream-paging", 3, 3);
    assert.deepEqual(
      secondPage.map((row) => row.sequence),
      [4, 5, 6],
    );
    // Past the newest retained sequence: empty (a caught-up tail, not a gap).
    assert.deepEqual(repo.listEventsAfterSequence("default", "session-stream-paging", 209, 10), []);

    // Wrong workspace fails closed with no cross-workspace disclosure.
    assert.throws(() => repo.listEventsAfterSequence("other-workspace", "session-stream-paging", 0, 10), /not found/iu);
    assert.throws(() => repo.getEventSequenceBounds("other-workspace", "session-stream-paging"), /not found/iu);
  });

  it("scopes event-sequence paging to the exact session (per-session monotonic sequences)", () => {
    const { db, repo } = createHarness("stream-x");
    new ChatSessionMetaRepository(db).ensure("session-stream-y", new Date().toISOString(), "default");
    seedSessionControlAuth(db, "companion-stream-y", "grant-stream-y");
    const yRequest = repo.createExternalRequest(
      request("stream-y", 1, ["send"], "session-stream-y", "companion-stream-y", "grant-stream-y"),
    );
    repo.handoff(handoff("stream-y", yRequest.request.requestId, 1, ["send"], "session-stream-y"));

    // X has only its own initialization event; Y's activity does not bleed in.
    const xEvents = repo.listEventsAfterSequence("default", "session-stream-x", 0, 50);
    assert.equal(xEvents.length, 1);
    assert.equal(xEvents[0]?.sequence, 1);
    assert.equal(xEvents[0]?.event.sessionId, "session-stream-x");
    assert.equal(repo.getEventSequenceBounds("default", "session-stream-x").newestSequence, 1);

    // Y keeps its own sequence namespace starting at 1.
    const yEvents = repo.listEventsAfterSequence("default", "session-stream-y", 0, 50);
    assert.deepEqual(
      yEvents.map((row) => row.sequence),
      [1, 2, 3],
    );
    assert.equal(
      yEvents.every((row) => row.event.sessionId === "session-stream-y"),
      true,
    );
    assert.equal(repo.getEventSequenceBounds("default", "session-stream-y").newestSequence, 3);
  });
});

function createHarness(seed: string): { db: DatabaseClient; repo: SessionControlRepository } {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  new ChatSessionMetaRepository(db).ensure(`session-${seed}`, new Date().toISOString(), "default");
  const repo = new SessionControlRepository(db);
  const initialized = repo.initializeExistingSession({
    workspaceId: "default",
    sessionId: `session-${seed}`,
    idempotencyKey: `init:${seed}`,
    correlationId: `correlation:init:${seed}`,
  });
  assert.equal(initialized.disposition, "already_initialized");
  seedSessionControlAuth(db, `companion-${seed}`, `grant-${seed}`);
  return { db, repo };
}

function seedSessionControlAuth(
  db: DatabaseClient,
  companionSessionId: string,
  deviceGrantId: string,
  principalPurpose: "general_companion" | "session_control_client" = "session_control_client",
): void {
  const existing = db
    .prepare(
      `SELECT grant_id, principal_purpose FROM companion_sessions
       WHERE session_id = @companionSessionId`,
    )
    .get<{ grant_id: string; principal_purpose: string }>({ companionSessionId });
  if (existing) {
    assert.equal(existing.grant_id, deviceGrantId);
    assert.equal(existing.principal_purpose, principalPurpose);
    return;
  }
  const clock = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day') AS expires_at`,
    )
    .get<{ now: string; expires_at: string }>()!;
  const authRequestId = `auth-request-${D(deviceGrantId).slice(0, 24)}`;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES (
       @requestId, @approvalId, @secretHash, 'HX-411 test client', 'test', 'approved',
       @now, @expiresAt, @now, 'operator-a', @principalPurpose
     )`,
  ).run({
    requestId: authRequestId,
    approvalId: `approval-${D(deviceGrantId).slice(0, 24)}`,
    secretHash: D(`request-secret:${deviceGrantId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
    principalPurpose,
  });
  db.prepare(
    `INSERT INTO auth_device_grants (
       grant_id, request_id, token_hash, device_label, device_type, granted_by,
       created_at, expires_at, metadata_json, principal_purpose
     ) VALUES (
       @grantId, @requestId, @tokenHash, 'HX-411 test client', 'test', 'operator-a',
       @now, @expiresAt, '{}', @principalPurpose
     )`,
  ).run({
    grantId: deviceGrantId,
    requestId: authRequestId,
    tokenHash: D(`device-token:${deviceGrantId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
    principalPurpose,
  });
  db.prepare(
    `INSERT INTO companion_sessions (
       session_id, grant_id, access_token_hash, access_token_expires_at,
       refresh_token_hash, refresh_token_expires_at, signing_public_key_pem,
       signature_algorithm, created_at, last_rotated_at, metadata_json, principal_purpose
     ) VALUES (
       @sessionId, @grantId, @accessTokenHash, @expiresAt,
       @refreshTokenHash, @expiresAt, 'hx411-test-public-key',
       'ed25519', @now, @now, '{}', @principalPurpose
     )`,
  ).run({
    sessionId: companionSessionId,
    grantId: deviceGrantId,
    accessTokenHash: D(`access-token:${companionSessionId}`),
    refreshTokenHash: D(`refresh-token:${companionSessionId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
    principalPurpose,
  });
}

function requestStatus(db: DatabaseClient, requestId: string): string {
  return db
    .prepare("SELECT status FROM chat_session_control_requests WHERE request_id = @requestId")
    .get<{ status: string }>({ requestId })!.status;
}

function request(
  seed: string,
  expectedGeneration: number,
  capabilities: readonly ("send" | "read")[],
  sessionId = `session-${seed}`,
  companionSessionId = `companion-${seed}`,
  deviceGrantId = `grant-${seed}`,
): CreateExternalSessionControlRequestInput {
  return {
    workspaceId: "default",
    sessionId,
    companionSessionId,
    deviceGrantId,
    clientInstanceId: `client-${seed}`,
    principalPurpose: "session_control_client",
    expectedGeneration,
    tokenHashSha256: D(`token:${seed}`),
    capabilities,
    idempotencyKey: `request:${seed}`,
    correlationId: `correlation:request:${seed}`,
  };
}

function handoff(
  seed: string,
  requestId: string,
  expectedGeneration: number,
  effectiveCapabilities: readonly ("send" | "read")[],
  sessionId = `session-${seed}`,
): HandoffSessionControlInput {
  return {
    workspaceId: "default",
    sessionId,
    requestId,
    expectedGeneration,
    effectiveCapabilities,
    operatorActorId: "operator-a",
    idempotencyKey: `handoff:${seed}`,
    correlationId: `correlation:handoff:${seed}`,
  };
}

function identity(seed: string, expectedGeneration: number, tokenHashSha256: string): ExternalSessionControlIdentity {
  return {
    workspaceId: "default",
    sessionId: `session-${seed.replace(/-b$/u, "")}`,
    companionSessionId: `companion-${seed}`,
    deviceGrantId: `grant-${seed}`,
    clientInstanceId: `client-${seed}`,
    principalPurpose: "session_control_client",
    expectedGeneration,
    tokenHashSha256,
    idempotencyKey: `protocol:${seed}:${expectedGeneration}`,
    correlationId: `correlation:protocol:${seed}:${expectedGeneration}`,
  };
}

function authRevokeInput(seed: string): AuthRevokeSessionControlsInput {
  return {
    bindingKind: "companion_session",
    bindingId: `companion-${seed}`,
    actorId: "auth-owner",
    idempotencyKey: `auth-revoke:${seed}`,
    correlationId: `correlation:auth-revoke:${seed}`,
  };
}

interface RawAuthRevokeFixture {
  db: DatabaseClient;
  input: AuthRevokeSessionControlsInput;
  requestId: string;
  workspaceId: string;
  sessionId: string;
  companionSessionId: string;
  deviceGrantId: string;
  generation: number;
  controlRevision: number;
  eventId: string;
  eventSequence: number;
  eventIdempotencyKey: string;
  eventSetSha256: string;
  requestSha256: string;
  occurredAt: string;
}

function createRawAuthRevokeFixture(seed: string): RawAuthRevokeFixture {
  const { db, repo } = createHarness(seed);
  const workspaceId = "default";
  const sessionId = `session-${seed}`;
  const companionSessionId = `companion-${seed}`;
  const deviceGrantId = `grant-${seed}`;
  const pending = repo.createExternalRequest(
    request(`${seed}-pending`, 1, ["send"], sessionId, companionSessionId, deviceGrantId),
  );
  const control = db
    .prepare(
      `SELECT generation, control_revision FROM chat_session_control_grants
       WHERE session_id = @sessionId AND is_current = 1`,
    )
    .get<{ generation: number; control_revision: number }>({ sessionId })!;
  const eventSequence =
    db
      .prepare(
        "SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM chat_session_control_events WHERE session_id = @sessionId",
      )
      .get<{ sequence: number }>({ sessionId })!.sequence + 1;
  const input = authRevokeInput(seed);
  return {
    db,
    input,
    requestId: pending.request.requestId,
    workspaceId,
    sessionId,
    companionSessionId,
    deviceGrantId,
    generation: control.generation,
    controlRevision: control.control_revision,
    eventId: `raw-auth-revoke-event-${seed}`,
    eventSequence,
    eventIdempotencyKey: input.idempotencyKey,
    eventSetSha256: D(`raw-auth-revoke-event-set:${seed}`),
    requestSha256: D(canonicalJsonString({ operation: "auth_revoke", value: input })),
    occurredAt: db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!.now,
  };
}

function insertRawAuthRevokeOperation(fixture: RawAuthRevokeFixture): void {
  fixture.db
    .prepare(
      `INSERT INTO chat_session_control_auth_revoke_operations (
         idempotency_key, request_sha256, binding_kind, binding_id, actor_id,
         correlation_id, target_count, session_count, event_set_sha256, occurred_at
       ) VALUES (
         @idempotencyKey, @requestSha256, @bindingKind, @bindingId, @actorId,
         @correlationId, 1, 1, @eventSetSha256, @occurredAt
       )`,
    )
    .run({
      idempotencyKey: fixture.input.idempotencyKey,
      requestSha256: fixture.requestSha256,
      bindingKind: fixture.input.bindingKind,
      bindingId: fixture.input.bindingId,
      actorId: fixture.input.actorId,
      correlationId: fixture.input.correlationId,
      eventSetSha256: fixture.eventSetSha256,
      occurredAt: fixture.occurredAt,
    });
}

function insertRawAuthRevokeTarget(
  fixture: RawAuthRevokeFixture,
  overrides: Partial<{
    targetIndex: number;
    generation: number;
    eventId: string;
    eventSequence: number;
    eventIdempotencyKey: string;
  }> = {},
): void {
  fixture.db
    .prepare(
      `INSERT INTO chat_session_control_auth_revoke_operation_targets (
         operation_idempotency_key, target_index, target_kind, workspace_id, session_id,
         request_id, generation, control_revision, owner_kind, lease_state,
         event_id, event_sequence, event_idempotency_key, event_reason_code
       ) VALUES (
         @operationIdempotencyKey, @targetIndex, 'pending_request', @workspaceId, @sessionId,
         @requestId, @generation, @controlRevision, 'operator', 'operator_active',
         @eventId, @eventSequence, @eventIdempotencyKey, 'mutation_denied'
       )`,
    )
    .run({
      operationIdempotencyKey: fixture.input.idempotencyKey,
      targetIndex: overrides.targetIndex ?? 0,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      requestId: fixture.requestId,
      generation: overrides.generation ?? fixture.generation,
      controlRevision: fixture.controlRevision,
      eventId: overrides.eventId ?? fixture.eventId,
      eventSequence: overrides.eventSequence ?? fixture.eventSequence,
      eventIdempotencyKey: overrides.eventIdempotencyKey ?? fixture.eventIdempotencyKey,
    });
}

function settleRawAuthRevokeRequest(fixture: RawAuthRevokeFixture): void {
  fixture.db
    .prepare(
      `UPDATE chat_session_control_requests
       SET status = 'cancelled', decided_at = @occurredAt, decided_by_actor_id = @actorId,
           decision_reason_code = 'request_cancelled'
       WHERE request_id = @requestId`,
    )
    .run({
      occurredAt: fixture.occurredAt,
      actorId: fixture.input.actorId,
      requestId: fixture.requestId,
    });
}

function insertRawAuthRevokeEvent(
  fixture: RawAuthRevokeFixture,
  overrides: Partial<{
    actorId: string;
    eventId: string;
    eventSequence: number;
    eventIdempotencyKey: string;
  }> = {},
): void {
  fixture.db
    .prepare(
      `INSERT INTO chat_session_control_events (
         event_id, workspace_id, session_id, event_sequence, request_id, previous_generation, next_generation,
         previous_owner_kind, next_owner_kind, previous_lease_state, next_lease_state,
         reason_code, actor_kind, actor_id, companion_session_id, device_grant_id,
         idempotency_key, request_sha256, correlation_id, created_at
       ) VALUES (
         @eventId, @workspaceId, @sessionId, @eventSequence, @requestId, @generation, @generation,
         'operator', 'operator', 'operator_active', 'operator_active',
         'mutation_denied', 'system', @actorId, @companionSessionId, @deviceGrantId,
         @eventIdempotencyKey, @requestSha256, @correlationId, @occurredAt
       )`,
    )
    .run({
      eventId: overrides.eventId ?? fixture.eventId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      eventSequence: overrides.eventSequence ?? fixture.eventSequence,
      requestId: fixture.requestId,
      generation: fixture.generation,
      actorId: overrides.actorId ?? fixture.input.actorId,
      companionSessionId: fixture.companionSessionId,
      deviceGrantId: fixture.deviceGrantId,
      eventIdempotencyKey: overrides.eventIdempotencyKey ?? fixture.eventIdempotencyKey,
      requestSha256: fixture.requestSha256,
      correlationId: fixture.input.correlationId,
      occurredAt: fixture.occurredAt,
    });
}

function insertRawAuthRevokeReceipt(fixture: RawAuthRevokeFixture): void {
  fixture.db
    .prepare(
      `INSERT INTO chat_session_control_auth_revoke_receipts (
         idempotency_key, request_sha256, binding_kind, binding_id, actor_id,
         correlation_id, target_count, session_count, event_set_sha256, created_at
       ) VALUES (
         @idempotencyKey, @requestSha256, @bindingKind, @bindingId, @actorId,
         @correlationId, 1, 1, @eventSetSha256, @occurredAt
       )`,
    )
    .run({
      idempotencyKey: fixture.input.idempotencyKey,
      requestSha256: fixture.requestSha256,
      bindingKind: fixture.input.bindingKind,
      bindingId: fixture.input.bindingId,
      actorId: fixture.input.actorId,
      correlationId: fixture.input.correlationId,
      eventSetSha256: fixture.eventSetSha256,
      occurredAt: fixture.occurredAt,
    });
}

function rawAuthRevokeOperationCount(fixture: RawAuthRevokeFixture): number {
  return fixture.db
    .prepare(
      `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_operations
       WHERE idempotency_key = @idempotencyKey`,
    )
    .get<{ count: number }>({ idempotencyKey: fixture.input.idempotencyKey })!.count;
}

interface DatabaseClockSnapshot {
  now: string;
  token_expires_at: string;
  lease_expires_at: string;
  reconnect_expires_at: string;
}

function observeDatabaseClockReads(repo: SessionControlRepository): {
  readCount(): number;
  restore(): void;
} {
  const target = repo as unknown as { readDatabaseClock(): DatabaseClockSnapshot };
  const original = target.readDatabaseClock.bind(repo);
  let reads = 0;
  target.readDatabaseClock = () => {
    reads += 1;
    return original();
  };
  return {
    readCount: () => reads,
    restore: () => {
      target.readDatabaseClock = original;
    },
  };
}

function delayFirstAuthRevokeEvent(
  repo: SessionControlRepository,
  delayMs: number,
): { didDelay(): boolean; restore(): void } {
  const target = repo as unknown as { insertEvent(...args: unknown[]): unknown };
  const original = target.insertEvent.bind(repo);
  let delayed = false;
  target.insertEvent = (...args: unknown[]) => {
    if (!delayed) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    return original(...args);
  };
  return {
    didDelay: () => delayed,
    restore: () => {
      target.insertEvent = original;
    },
  };
}

function authRevokePersistedTimestamps(
  db: DatabaseClient,
  input: AuthRevokeSessionControlsInput,
  activeSessionId: string,
): string[] {
  return db
    .prepare(
      `SELECT decided_at AS occurred_at
       FROM chat_session_control_requests
       WHERE companion_session_id = @bindingId AND status IN ('cancelled', 'expired')
       UNION ALL
       SELECT created_at AS occurred_at
       FROM chat_session_control_events
       WHERE correlation_id = @correlationId
       UNION ALL
       SELECT created_at AS occurred_at
       FROM chat_session_control_auth_revoke_receipts
       WHERE idempotency_key = @idempotencyKey
       UNION ALL
       SELECT updated_at AS occurred_at
       FROM chat_session_control_grants
       WHERE session_id = @activeSessionId AND generation = 2
       UNION ALL
       SELECT terminal_at AS occurred_at
       FROM chat_session_control_grants
       WHERE session_id = @activeSessionId AND generation = 2
       UNION ALL
       SELECT created_at AS occurred_at
       FROM chat_session_control_grants
       WHERE session_id = @activeSessionId AND generation = 3
       UNION ALL
       SELECT updated_at AS occurred_at
       FROM chat_session_control_grants
       WHERE session_id = @activeSessionId AND generation = 3`,
    )
    .all<{ occurred_at: string }>({
      activeSessionId,
      bindingId: input.bindingId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
    })
    .map((row) => row.occurred_at);
}

interface WorkerResult {
  ok: boolean;
  disposition?: "created" | "replayed";
  occurredAt?: string;
  error?: string;
}

type SqliteRepositoryRaceInput =
  | AuthRevokeSessionControlsInput
  | HandoffSessionControlInput
  | RevokeIdentityAmbiguityInput;
type SqliteRepositoryRaceMethod = "handoff" | "revokeByAuthBinding" | "revokeIdentityAmbiguity";

async function runSqliteRepositoryRace(
  dbPath: string,
  method: SqliteRepositoryRaceMethod,
  inputs: readonly [SqliteRepositoryRaceInput, SqliteRepositoryRaceInput],
): Promise<[WorkerResult, WorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = inputs.map((input) => runSqliteRepositoryWorker(dbPath, method, input, startSignal)) as [
    ReturnType<typeof runSqliteRepositoryWorker>,
    ReturnType<typeof runSqliteRepositoryWorker>,
  ];
  await Promise.all(workers.map((worker) => worker.ready));
  const startState = new Int32Array(startSignal);
  Atomics.store(startState, 0, 1);
  Atomics.notify(startState, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[WorkerResult, WorkerResult]>;
}

function runSqliteRepositoryWorker(
  dbPath: string,
  method: SqliteRepositoryRaceMethod,
  input: SqliteRepositoryRaceInput,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<WorkerResult> } {
  const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(SQLITE_REPOSITORY_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath,
      method,
      input,
      startSignal,
      repositoryModuleUrl: new URL(`./session-control-repo${runtimeModuleExtension}`, import.meta.url).href,
      sqliteModuleUrl: new URL(`./sqlite${runtimeModuleExtension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: WorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: WorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Session control SQLite worker exited with code ${code}.`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const SQLITE_REPOSITORY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    const { tsImport } = await import(workerData.tsxApiUrl);
    const { SessionControlRepository } = await tsImport(workerData.repositoryModuleUrl, workerData.repositoryModuleUrl);
    const { createDatabase } = await tsImport(workerData.sqliteModuleUrl, workerData.repositoryModuleUrl);
    const db = createDatabase({ dbPath: workerData.dbPath });
    try {
      parentPort.postMessage({ kind: "ready" });
      const startState = new Int32Array(workerData.startSignal);
      Atomics.wait(startState, 0, 0);
      const value = new SessionControlRepository(db)[workerData.method](workerData.input);
      parentPort.postMessage({
        kind: "result",
        result: { ok: true, disposition: value.disposition, occurredAt: value.occurredAt },
      });
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      db.close();
    }
  })();
`;
