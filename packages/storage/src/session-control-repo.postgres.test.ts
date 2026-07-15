import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { ConflictError } from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import {
  SessionControlRepository,
  type AuthRevokeSessionControlsInput,
  type CreateExternalSessionControlRequestInput,
  type HandoffSessionControlInput,
  type ReconnectSessionControlInput,
  type RevokeIdentityAmbiguityInput,
} from "./session-control-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

describe("SessionControlRepository live PostgreSQL authority", () => {
  postgresIt(
    "backfills generation one and permits one reconnect winner across two workers",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_session_control_${suffix}`;
      const sessionId = `session-${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx411-session-control-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        setupDb.exec(`SET search_path TO ${schemaName}`);
        assert.equal(
          setupDb.prepare("SELECT current_schema() AS schema_name").get<{ schema_name: string }>()!.schema_name,
          schemaName,
        );
        await runPostgresMigrations(
          migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 113),
        );
        const seededAt = "2026-07-14T00:00:00.000Z";
        setupDb
          .prepare(
            `INSERT INTO chat_session_meta (session_id, workspace_id, created_at, updated_at)
             VALUES (@sessionId, 'default', @seededAt, @seededAt)`,
          )
          .run({ sessionId, seededAt });
        seedLegacyGeneralCompanionAuth(setupDb, suffix, seededAt);

        const applied = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        assert.deepEqual(applied.appliedVersions, [114]);
        assert.deepEqual((await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS)).appliedVersions, []);
        assert.equal(
          setupDb
            .prepare(
              `SELECT COUNT(*) AS count FROM pg_constraint
               WHERE connamespace = current_schema()::regnamespace AND conname LIKE 'gc_sc%'`,
            )
            .get<{ count: number }>()!.count,
          78,
        );
        assertLegacyPurposeBackfill(setupDb, suffix);
        const repo = new SessionControlRepository(setupDb);
        const backfilled = repo.getControl("default", sessionId);
        assert.equal(backfilled.generation, 1);
        assert.equal(backfilled.ownerKind, "operator");
        assert.equal(backfilled.leaseState, "operator_active");
        assert.equal(backfilled.lastEventReasonCode, "session_initialized");

        const noOpReceiptInput: AuthRevokeSessionControlsInput = {
          bindingKind: "companion_session",
          bindingId: `companion-receipt-race-${suffix}`,
          actorId: "auth-owner",
          idempotencyKey: `auth-revoke:receipt-race:${suffix}`,
          correlationId: `correlation:auth-revoke:receipt-race:${suffix}`,
        };
        const receiptRace = await runPostgresRepositoryRace(
          scopedUrl.toString(),
          database,
          schemaName,
          "revokeByAuthBinding",
          [noOpReceiptInput, noOpReceiptInput],
        );
        assert.equal(
          receiptRace.every((result) => result.ok),
          true,
        );
        assert.deepEqual(receiptRace.map((result) => result.disposition).sort(), ["created", "replayed"]);
        assert.deepEqual(
          setupDb
            .prepare(
              `SELECT target_count, session_count FROM chat_session_control_auth_revoke_receipts
               WHERE idempotency_key = @idempotencyKey`,
            )
            .get({ idempotencyKey: noOpReceiptInput.idempotencyKey }),
          { target_count: 0, session_count: 0 },
        );

        assertDirectCapabilityConstraint(setupDb, sessionId, suffix);
        assertDirectEventConstraints(setupDb, suffix);
        assertDirectDatabaseClockConstraint(setupDb, suffix);
        assertAuthBindingRevocation(setupDb, repo, suffix);
        assertHandoffAuthRecheck(setupDb, repo, suffix);

        seedPostgresAuthBinding(setupDb, `companion-${suffix}-cancelled`, `grant-${suffix}-cancelled`);
        const cancelledRequest = repo.createExternalRequest(request(`${suffix}-cancelled`, sessionId));
        const cancelled = repo.cancelExternalRequest({
          workspaceId: "default",
          sessionId,
          requestId: cancelledRequest.request.requestId,
          operatorActorId: "operator-a",
          idempotencyKey: `cancel:${suffix}`,
          correlationId: `correlation:cancel:${suffix}`,
        });
        assert.equal(cancelled.request.status, "cancelled");
        assert.equal(cancelled.control.generation, 1);

        const requestInput = request(suffix, sessionId);
        seedPostgresAuthBinding(setupDb, requestInput.companionSessionId, requestInput.deviceGrantId);
        assertPostgresAuthParentImmutability(setupDb, suffix);
        const requested = repo.createExternalRequest(requestInput);
        const handedOff = repo.handoff(handoff(suffix, sessionId, requested.request.requestId));
        assert.equal(handedOff.control.generation, 2);
        assert.equal(handedOff.control.ownerKind, "external_companion");

        const oldTokenHashSha256 = requestInput.tokenHashSha256;
        const reconnectInputs = [
          reconnect(suffix, sessionId, oldTokenHashSha256, "left"),
          reconnect(suffix, sessionId, oldTokenHashSha256, "right"),
        ] as const;
        const results = await runPostgresRepositoryRace(
          scopedUrl.toString(),
          database,
          schemaName,
          "reconnect",
          reconnectInputs,
        );
        assert.equal(results.filter((result) => result.ok).length, 1);
        assert.equal(results.filter((result) => !result.ok).length, 1);

        const current = repo.getControl("default", sessionId);
        assert.equal(current.generation, 3);
        assert.equal(current.ownerKind, "external_companion");
        assert.equal(current.leaseState, "external_live");
        assert.equal(current.lastEventReasonCode, "reconnect");
        assert.equal(count(setupDb, "chat_session_control_grants", sessionId, "AND is_current = 1"), 1);
        assert.equal(count(setupDb, "chat_session_control_events", sessionId, "AND reason_code = 'reconnect'"), 1);
        assert.equal(
          setupDb
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_control_grants
               WHERE session_id = @sessionId AND generation = 2 AND is_current = 0 AND lease_state = 'superseded'`,
            )
            .get<{ count: number }>({ sessionId })!.count,
          1,
        );

        assert.throws(
          () =>
            repo.resolveMutationAuthority({
              actorKind: "external_companion",
              workspaceId: "default",
              sessionId,
              companionSessionId: `companion-${suffix}`,
              deviceGrantId: `grant-${suffix}`,
              clientInstanceId: `client-${suffix}`,
              principalPurpose: "session_control_client",
              expectedGeneration: 2,
              tokenHashSha256: oldTokenHashSha256,
              requiredCapability: "send",
            }),
          ConflictError,
        );
        const winnerIndex = results.findIndex((result) => result.ok);
        const winner = reconnectInputs[winnerIndex]!;
        assert.equal(
          repo.resolveMutationAuthority({
            actorKind: "external_companion",
            workspaceId: "default",
            sessionId,
            companionSessionId: `companion-${suffix}`,
            deviceGrantId: `grant-${suffix}`,
            clientInstanceId: `client-${suffix}`,
            principalPurpose: "session_control_client",
            expectedGeneration: 3,
            tokenHashSha256: winner.newTokenHashSha256,
            requiredCapability: "send",
          }).generation,
          3,
        );

        const identityInputs = ["left", "right"].map(
          (contender): RevokeIdentityAmbiguityInput => ({
            workspaceId: "default",
            sessionId,
            expectedGeneration: 3,
            systemActorId: `gateway-${contender}`,
            idempotencyKey: `identity-ambiguity:${suffix}:${contender}`,
            correlationId: `correlation:identity-ambiguity:${suffix}:${contender}`,
          }),
        ) as [RevokeIdentityAmbiguityInput, RevokeIdentityAmbiguityInput];
        const identityResults = await runPostgresRepositoryRace(
          scopedUrl.toString(),
          database,
          schemaName,
          "revokeIdentityAmbiguity",
          identityInputs,
        );
        assert.equal(identityResults.filter((result) => result.ok).length, 1);
        assert.equal(identityResults.filter((result) => !result.ok).length, 1);
        const returned = repo.getControl("default", sessionId);
        assert.equal(returned.ownerKind, "operator");
        assert.equal(returned.generation, 4);
        assert.equal(returned.lastEventReasonCode, "identity_revoked");
        assert.equal(count(setupDb, "chat_session_control_grants", sessionId, "AND is_current = 1"), 1);
        assert.equal(
          count(setupDb, "chat_session_control_events", sessionId, "AND reason_code = 'identity_revoked'"),
          1,
        );
        assert.equal(count(setupDb, "chat_session_control_events", sessionId, "AND reason_code = 'lease_stale'"), 0);
        assert.equal(
          setupDb
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_control_grants
               WHERE session_id = @sessionId AND generation = 3 AND is_current = 0 AND lease_state = 'revoked'`,
            )
            .get<{ count: number }>({ sessionId })!.count,
          1,
        );
        const identityWinner = identityInputs[identityResults.findIndex((result) => result.ok)]!;
        assert.equal(repo.revokeIdentityAmbiguity(identityWinner).disposition, "replayed");
        assert.throws(
          () => repo.revokeIdentityAmbiguity({ ...identityWinner, systemActorId: "gateway-conflict" }),
          ConflictError,
        );
      } finally {
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function seedLegacyGeneralCompanionAuth(db: PostgresSyncDatabaseClient, seed: string, createdAt: string): void {
  const requestId = `legacy-auth-request-${seed}`;
  const grantId = `legacy-auth-grant-${seed}`;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by
     ) VALUES (
       @requestId, @approvalId, @secretHash, 'Legacy companion', 'test', 'approved',
       @createdAt, '2099-01-01T00:00:00.000Z', @createdAt, 'operator-a'
     )`,
  ).run({
    requestId,
    approvalId: `legacy-approval-${seed}`,
    secretHash: D(`legacy-request-secret:${seed}`),
    createdAt,
  });
  db.prepare(
    `INSERT INTO auth_device_grants (
       grant_id, request_id, token_hash, device_label, device_type, granted_by,
       created_at, expires_at, metadata_json
     ) VALUES (
       @grantId, @requestId, @tokenHash, 'Legacy companion', 'test', 'operator-a',
       @createdAt, '2099-01-01T00:00:00.000Z', '{}'
     )`,
  ).run({ grantId, requestId, tokenHash: D(`legacy-device-token:${seed}`), createdAt });
  db.prepare(
    `INSERT INTO companion_sessions (
       session_id, grant_id, access_token_hash, access_token_expires_at,
       refresh_token_hash, refresh_token_expires_at, signing_public_key_pem,
       signature_algorithm, created_at, last_rotated_at, metadata_json
     ) VALUES (
       @sessionId, @grantId, @accessTokenHash, '2099-01-01T00:00:00.000Z',
       @refreshTokenHash, '2099-01-01T00:00:00.000Z', 'hx411-test-public-key',
       'ed25519', @createdAt, @createdAt, '{}'
     )`,
  ).run({
    sessionId: `legacy-companion-${seed}`,
    grantId,
    accessTokenHash: D(`legacy-access-token:${seed}`),
    refreshTokenHash: D(`legacy-refresh-token:${seed}`),
    createdAt,
  });
}

function assertLegacyPurposeBackfill(db: PostgresSyncDatabaseClient, seed: string): void {
  assert.equal(
    db
      .prepare("SELECT principal_purpose FROM auth_device_requests WHERE request_id = @requestId")
      .get<{ principal_purpose: string }>({ requestId: `legacy-auth-request-${seed}` })!.principal_purpose,
    "general_companion",
  );
  assert.equal(
    db
      .prepare("SELECT principal_purpose FROM auth_device_grants WHERE grant_id = @grantId")
      .get<{ principal_purpose: string }>({ grantId: `legacy-auth-grant-${seed}` })!.principal_purpose,
    "general_companion",
  );
  assert.equal(
    db
      .prepare("SELECT principal_purpose FROM companion_sessions WHERE session_id = @sessionId")
      .get<{ principal_purpose: string }>({ sessionId: `legacy-companion-${seed}` })!.principal_purpose,
    "general_companion",
  );
  assert.throws(() =>
    db
      .prepare(
        `UPDATE auth_device_grants SET principal_purpose = 'session_control_client'
         WHERE grant_id = @grantId`,
      )
      .run({ grantId: `legacy-auth-grant-${seed}` }),
  );
}

function assertPostgresAuthParentImmutability(db: PostgresSyncDatabaseClient, seed: string): void {
  seedPostgresAuthBinding(db, `companion-parent-b-${seed}`, `grant-parent-b-${seed}`);
  const clock = db
    .prepare(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
              to_char((clock_timestamp() + INTERVAL '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
    )
    .get<{ now: string; expires_at: string }>()!;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES (
       @requestId, @approvalId, @secretHash, 'HX-411 orphan parent', 'test', 'approved',
       @now, @expiresAt, @now, 'operator-a', 'session_control_client'
     )`,
  ).run({
    requestId: `auth-parent-orphan-${seed}`,
    approvalId: `approval-parent-orphan-${seed}`,
    secretHash: D(`auth-parent-orphan:${seed}`),
    now: clock.now,
    expiresAt: clock.expires_at,
  });
  assert.throws(() =>
    db
      .prepare(
        `UPDATE auth_device_grants SET request_id = @requestId
         WHERE grant_id = @grantId`,
      )
      .run({ requestId: `auth-parent-orphan-${seed}`, grantId: `grant-${seed}` }),
  );
  assert.throws(() =>
    db
      .prepare(
        `UPDATE companion_sessions SET grant_id = @nextGrantId
         WHERE session_id = @sessionId`,
      )
      .run({
        nextGrantId: `grant-parent-b-${seed}`,
        sessionId: `companion-${seed}`,
      }),
  );
}

function seedPostgresAuthBinding(
  db: PostgresSyncDatabaseClient,
  companionSessionId: string,
  deviceGrantId: string,
): void {
  const existing = db
    .prepare("SELECT grant_id FROM companion_sessions WHERE session_id = @sessionId")
    .get<{ grant_id: string }>({ sessionId: companionSessionId });
  if (existing) {
    assert.equal(existing.grant_id, deviceGrantId);
    return;
  }
  const clock = db
    .prepare(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
              to_char((clock_timestamp() + INTERVAL '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
    )
    .get<{ now: string; expires_at: string }>()!;
  const requestId = `auth-request-${D(deviceGrantId).slice(0, 24)}`;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES (
       @requestId, @approvalId, @secretHash, 'HX-411 test client', 'test', 'approved',
       @now, @expiresAt, @now, 'operator-a', 'session_control_client'
     )`,
  ).run({
    requestId,
    approvalId: `approval-${D(deviceGrantId).slice(0, 24)}`,
    secretHash: D(`request-secret:${deviceGrantId}`),
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
    requestId,
    tokenHash: D(`device-token:${deviceGrantId}`),
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
    accessTokenHash: D(`access-token:${companionSessionId}`),
    refreshTokenHash: D(`refresh-token:${companionSessionId}`),
    now: clock.now,
    expiresAt: clock.expires_at,
  });
}

function request(seed: string, sessionId: string): CreateExternalSessionControlRequestInput {
  return {
    workspaceId: "default",
    sessionId,
    companionSessionId: `companion-${seed}`,
    deviceGrantId: `grant-${seed}`,
    clientInstanceId: `client-${seed}`,
    principalPurpose: "session_control_client",
    expectedGeneration: 1,
    tokenHashSha256: D(`token:${seed}:old`),
    capabilities: ["send", "read"],
    idempotencyKey: `request:${seed}`,
    correlationId: `correlation:request:${seed}`,
  };
}

function handoff(seed: string, sessionId: string, requestId: string): HandoffSessionControlInput {
  return {
    workspaceId: "default",
    sessionId,
    requestId,
    expectedGeneration: 1,
    effectiveCapabilities: ["send", "read"],
    operatorActorId: "operator-a",
    idempotencyKey: `handoff:${seed}`,
    correlationId: `correlation:handoff:${seed}`,
  };
}

function reconnect(
  seed: string,
  sessionId: string,
  tokenHashSha256: string,
  contender: "left" | "right",
): ReconnectSessionControlInput {
  return {
    workspaceId: "default",
    sessionId,
    companionSessionId: `companion-${seed}`,
    deviceGrantId: `grant-${seed}`,
    clientInstanceId: `client-${seed}`,
    principalPurpose: "session_control_client",
    expectedGeneration: 2,
    tokenHashSha256,
    newTokenHashSha256: D(`token:${seed}:${contender}`),
    idempotencyKey: `reconnect:${seed}:${contender}`,
    correlationId: `correlation:reconnect:${seed}:${contender}`,
  };
}

function assertDirectCapabilityConstraint(db: PostgresSyncDatabaseClient, sessionId: string, seed: string): void {
  const now = db
    .prepare(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
              to_char((clock_timestamp() + INTERVAL '15 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
    )
    .get<{ now: string; expires_at: string }>()!;
  const token = D(`direct-capability:${seed}`);
  const requestId = `bad-capability-${seed}`;
  db.prepare(
    `INSERT INTO chat_session_control_tokens (
       token_sha256, workspace_id, session_id, first_request_id, created_at
     ) VALUES (@token, 'default', @sessionId, @requestId, @now)`,
  ).run({ token, sessionId, requestId, now: now.now });
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO chat_session_control_requests (
           request_id, workspace_id, session_id, companion_session_id, device_grant_id,
           client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
           requested_capabilities_sha256, requested_generation, status, idempotency_key,
           request_sha256, expires_at, created_at
         ) VALUES (
           @requestId, 'default', @sessionId, 'companion-direct', 'grant-direct', 'client-direct',
           'session_control_client', @token, '["read"]', @digest, 1, 'pending',
           @idempotencyKey, @digest, @expiresAt, @createdAt
         )`,
      )
      .run({
        requestId,
        sessionId,
        token,
        digest: D(`bad-capability:${seed}`),
        idempotencyKey: `bad-capability:${seed}`,
        expiresAt: now.expires_at,
        createdAt: now.now,
      }),
  );
}

function assertAuthBindingRevocation(
  db: PostgresSyncDatabaseClient,
  repo: SessionControlRepository,
  seed: string,
): void {
  const bindingId = `companion-auth-${seed}`;
  const deviceGrantId = `grant-auth-${seed}`;
  const sessionIds = [`session-auth-pending-${seed}`, `session-auth-current-${seed}`] as const;
  const now = db
    .prepare(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)
    .get<{ now: string }>()!.now;
  for (const sessionId of sessionIds) {
    db.prepare(
      `INSERT INTO chat_session_meta (session_id, workspace_id, created_at, updated_at)
       VALUES (@sessionId, 'default', @now, @now)`,
    ).run({ sessionId, now });
    repo.initializeExistingSession({
      workspaceId: "default",
      sessionId,
      idempotencyKey: `init:${sessionId}`,
      correlationId: `correlation:init:${sessionId}`,
    });
  }
  seedPostgresAuthBinding(db, bindingId, deviceGrantId);

  const pendingOnly = ["a", "b"].map((part) =>
    repo.createExternalRequest({
      ...request(`auth-pending-${seed}-${part}`, sessionIds[0]),
      companionSessionId: bindingId,
      deviceGrantId,
    }),
  );
  const active = repo.createExternalRequest({
    ...request(`auth-active-${seed}`, sessionIds[1]),
    companionSessionId: bindingId,
    deviceGrantId,
  });
  const pendingCurrent = repo.createExternalRequest({
    ...request(`auth-current-pending-${seed}`, sessionIds[1]),
    companionSessionId: bindingId,
    deviceGrantId,
  });
  repo.handoff(handoff(`auth-active-${seed}`, sessionIds[1], active.request.requestId));

  const input = {
    bindingKind: "companion_session",
    bindingId,
    actorId: "auth-owner",
    idempotencyKey: `auth-revoke:${seed}`,
    correlationId: `correlation:auth-revoke:${seed}`,
  } as const;
  const outcome = repo.revokeByAuthBinding(input);
  assert.equal(outcome.disposition, "created");
  assert.deepEqual(
    outcome.controls.map((control) => [control.sessionId, control.ownerKind, control.generation]),
    [
      [sessionIds[1], "operator", 3],
      [sessionIds[0], "operator", 1],
    ],
  );
  const expectedCancelled = [...pendingOnly.map((entry) => entry.request.requestId), pendingCurrent.request.requestId];
  const cancelled = db
    .prepare(
      `SELECT request_id, decision_reason_code FROM chat_session_control_requests
       WHERE companion_session_id = @bindingId AND status = 'cancelled' ORDER BY request_id`,
    )
    .all<{ request_id: string; decision_reason_code: string }>({ bindingId });
  assert.deepEqual(
    cancelled.map((row) => row.request_id),
    [...expectedCancelled].sort(),
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
  assert.deepEqual(
    db
      .prepare(
        `SELECT target_count, session_count FROM chat_session_control_auth_revoke_receipts
         WHERE idempotency_key = @idempotencyKey`,
      )
      .get({ idempotencyKey: input.idempotencyKey }),
    { target_count: 4, session_count: 2 },
  );
  assert.equal(repo.revokeByAuthBinding(input).disposition, "replayed");
  assert.throws(() => repo.revokeByAuthBinding({ ...input, actorId: "changed-auth-owner" }), ConflictError);
  assert.throws(
    () =>
      repo.handoff(
        handoff(`auth-current-pending-after-revoke-${seed}`, sessionIds[1], pendingCurrent.request.requestId),
      ),
    ConflictError,
  );
}

function assertHandoffAuthRecheck(db: PostgresSyncDatabaseClient, repo: SessionControlRepository, seed: string): void {
  const requestSeed = `auth-recheck-${seed}`;
  const sessionId = `session-${requestSeed}`;
  const now = db
    .prepare(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)
    .get<{ now: string }>()!.now;
  db.prepare(
    `INSERT INTO chat_session_meta (session_id, workspace_id, created_at, updated_at)
     VALUES (@sessionId, 'default', @now, @now)`,
  ).run({ sessionId, now });
  repo.initializeExistingSession({
    workspaceId: "default",
    sessionId,
    idempotencyKey: `init:${requestSeed}`,
    correlationId: `correlation:init:${requestSeed}`,
  });
  seedPostgresAuthBinding(db, `companion-${requestSeed}`, `grant-${requestSeed}`);
  const pending = repo.createExternalRequest(request(requestSeed, sessionId));
  db.prepare(
    `UPDATE auth_device_grants SET expires_at = '2000-01-01T00:00:00.000Z'
     WHERE grant_id = @grantId`,
  ).run({ grantId: `grant-${requestSeed}` });
  assert.throws(() => repo.handoff(handoff(requestSeed, sessionId, pending.request.requestId)), ConflictError);
  assert.equal(repo.getControl("default", sessionId).generation, 1);
  assert.equal(
    db
      .prepare("SELECT status FROM chat_session_control_requests WHERE request_id = @requestId")
      .get<{ status: string }>({ requestId: pending.request.requestId })!.status,
    "pending",
  );
}

function assertDirectDatabaseClockConstraint(db: PostgresSyncDatabaseClient, seed: string): void {
  const future = "2099-01-01T00:00:00.000Z";
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO chat_session_control_grants (
           workspace_id, session_id, generation, is_current, owner_kind, lease_state,
           requested_capabilities_json, requested_capabilities_sha256,
           effective_capabilities_json, effective_capabilities_sha256,
           control_revision, transition_idempotency_key, transition_request_sha256,
           created_at, updated_at
         ) VALUES (
           'default', @sessionId, 1, 1, 'operator', 'operator_active',
           '[]', @emptyDigest, '[]', @emptyDigest, 1, @idempotencyKey, @requestDigest,
           @future, @future
         )`,
      )
      .run({
        sessionId: `clock-${seed}`,
        emptyDigest: D("[]"),
        idempotencyKey: `clock:${seed}`,
        requestDigest: D(`clock:${seed}`),
        future,
      }),
  );
}

function assertDirectEventConstraints(db: PostgresSyncDatabaseClient, seed: string): void {
  const now = db
    .prepare(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)
    .get<{ now: string }>()!.now;
  const insertEvent = (input: { eventId: string; actorId: string; reasonCode: string }): void => {
    db.prepare(
      `INSERT INTO chat_session_control_events (
         event_id, workspace_id, session_id, event_sequence, previous_generation, next_generation,
         previous_owner_kind, next_owner_kind, previous_lease_state, next_lease_state,
         reason_code, actor_kind, actor_id, idempotency_key, request_sha256, correlation_id, created_at
       ) VALUES (
         @eventId, 'default', @sessionId, 1, 1, 1, 'operator', 'operator',
         'operator_active', 'operator_active', @reasonCode, 'system', @actorId,
         @idempotencyKey, @requestSha256, @correlationId, @createdAt
       )`,
    ).run({
      eventId: input.eventId,
      sessionId: `direct-event-${seed}`,
      reasonCode: input.reasonCode,
      actorId: input.actorId,
      idempotencyKey: `direct-event:${seed}:${input.eventId}`,
      requestSha256: D(`direct-event:${seed}:${input.eventId}`),
      correlationId: `direct-event:${seed}`,
      createdAt: now,
    });
  };
  assert.throws(() => insertEvent({ eventId: `bad-reason-${seed}`, actorId: "system", reasonCode: "bogus" }));
  assert.throws(() =>
    insertEvent({ eventId: `bad-actor-${seed}`, actorId: "x".repeat(257), reasonCode: "mutation_denied" }),
  );
}

function count(db: PostgresSyncDatabaseClient, table: string, sessionId: string, suffix: string): number {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = @sessionId ${suffix}`)
    .get<{ count: number }>({ sessionId })!.count;
}

interface PostgresRaceWorkerResult {
  ok: boolean;
  generation?: number;
  disposition?: "created" | "replayed";
  error?: string;
}

type PostgresRepositoryRaceInput =
  | AuthRevokeSessionControlsInput
  | ReconnectSessionControlInput
  | RevokeIdentityAmbiguityInput;
type PostgresRepositoryRaceMethod = "reconnect" | "revokeByAuthBinding" | "revokeIdentityAmbiguity";

async function runPostgresRepositoryRace(
  connectionString: string,
  database: string,
  schemaName: string,
  method: PostgresRepositoryRaceMethod,
  inputs: readonly [PostgresRepositoryRaceInput, PostgresRepositoryRaceInput],
): Promise<[PostgresRaceWorkerResult, PostgresRaceWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = inputs.map((input, index) =>
    runPostgresRepositoryWorker(
      connectionString,
      database,
      schemaName,
      `hx411-${method}-${index}`,
      method,
      input,
      startSignal,
    ),
  ) as [ReturnType<typeof runPostgresRepositoryWorker>, ReturnType<typeof runPostgresRepositoryWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const startState = new Int32Array(startSignal);
  Atomics.store(startState, 0, 1);
  Atomics.notify(startState, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<
    [PostgresRaceWorkerResult, PostgresRaceWorkerResult]
  >;
}

function runPostgresRepositoryWorker(
  connectionString: string,
  database: string,
  schemaName: string,
  applicationName: string,
  method: PostgresRepositoryRaceMethod,
  input: PostgresRepositoryRaceInput,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<PostgresRaceWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(POSTGRES_REPOSITORY_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      method,
      input,
      schemaName,
      startSignal,
      repositoryModuleUrl: new URL(`./session-control-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: PostgresRaceWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<PostgresRaceWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: PostgresRaceWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`HX-411 PostgreSQL worker exited with code ${code}.`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const POSTGRES_REPOSITORY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { SessionControlRepository } = await tsImport(
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
      const value = new SessionControlRepository(db)[workerData.method](workerData.input);
      parentPort.postMessage({
        kind: "result",
        result: {
          ok: true,
          disposition: value.disposition,
          generation: value.control ? value.control.generation : undefined,
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
