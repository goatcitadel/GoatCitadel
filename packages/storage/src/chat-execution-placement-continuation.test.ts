import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { remoteWorkerInferenceCanonicalSha256 as digest } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerChatPlacementRepository } from "./remote-worker-chat-placement-repo.js";
import { createRemediationParentFixture } from "./governed-remediation-parent-reservation-fixture.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

function verifyContinuation(open: () => DatabaseClient, legacy: boolean) {
  let db = open();
  try {
    // Reuse the exact admission/prompt fixture; no remediation is reserved or run.
    const fixture = createRemediationParentFixture(db);
    let runs = new DurableRunRepository(db);
    let placements = new RemoteWorkerChatPlacementRepository(db);
    const initial = runs.updateRun({
      runId: fixture.runId,
      status: "running",
      expectedVersion: 2,
      leaseOwnerId: "initial-worker",
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    // Upgrade compatibility: the old ledger included the original empty array.
    const legacyHash = digest(initial.payload);
    if (legacy)
      db.prepare(
        `INSERT INTO chat_execution_placements
      (durable_run_id, workspace_id, session_id, turn_id, payload_sha256, execution_kind, created_at)
      VALUES (@runId, @workspaceId, @sessionId, @turnId, @hash, 'local', @now)`,
      ).run({
        workspaceId: fixture.resolution.admissionIdentity.workspaceId,
        sessionId: fixture.resolution.admissionIdentity.sessionId,
        turnId: fixture.turnId,
        runId: fixture.runId,
        hash: legacyHash,
        now: new Date().toISOString(),
      });
    const selected = placements.claimLocal(initial);
    assert.equal(selected.executionKind, "local");
    const waiting = runs.updateRun({
      runId: fixture.runId,
      status: "waiting",
      clearLease: true,
      expectedVersion: initial.version,
    });
    fixture.repo.resolveDurableChatUserInput({ ...fixture.resolution, expectedWaitingRunVersion: waiting.version });
    db.close();
    db = open();
    runs = new DurableRunRepository(db);
    placements = new RemoteWorkerChatPlacementRepository(db);
    const resumed = runs.tryClaimQueuedRunWithDatabaseClock({
      runId: fixture.runId,
      workerId: "resumed-worker",
      leaseDurationMs: 300_000,
    });
    assert.ok(resumed);
    assert.notEqual(digest(resumed.payload), legacyHash);
    assert.deepEqual(placements.claimLocal(resumed), selected);
    assert.deepEqual(placements.claimLocal(resumed), selected);
    assert.throws(() => placements.claimLocal({ ...resumed, leaseOwnerId: "stale-worker" }));

    // Neither compatibility path permits an unsealed answer, replacement
    // request, capability, or message identity.
    const answers = resumed.payload.userInputResponses as Array<Record<string, unknown>>;
    assert.equal(answers.length, 1);
    for (const patch of [
      { userInputResponses: [] },
      { userInputResponses: [{ ...answers[0], response: { kind: "text", text: "Different authorization" } }] },
      { request: { content: "Execute a different task" } },
      { assistantMessageId: "other-assistant" },
      { capabilityProfileId: "other-profile", capabilityProfileHash: "a".repeat(64) },
    ]) {
      runs.updateRun({ runId: fixture.runId, status: "running", payload: { ...resumed.payload, ...patch } });
      assert.throws(() => placements.claimLocal(resumed));
      runs.updateRun({ runId: fixture.runId, status: "running", payload: resumed.payload });
    }
    assert.deepEqual(placements.claimLocal(resumed), selected);
  } finally {
    db.close();
  }
}

for (const legacy of [false, true]) {
  it(`keeps ${legacy ? "legacy" : "current"} Chat placement across sealed input and SQLite reopen, rejecting changed authority`, () => {
    const root = mkdtempSync(join(tmpdir(), "chat-placement-continuation-"));
    try {
      verifyContinuation(() => createDatabase({ dbPath: join(root, "fixture.sqlite") }), legacy);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
  it(
    `keeps ${legacy ? "legacy" : "current"} Chat placement across sealed input and PostgreSQL reconnect, rejecting changed authority`,
    { skip: !connectionString, timeout: 120_000 },
    async () => {
      const schema = `chat_placement_${randomUUID().replaceAll("-", "")}`;
      assert.match(schema, /^chat_placement_[a-f0-9]+$/u);
      const admin = new Pool({ connectionString });
      const scoped = new URL(connectionString!);
      scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const config = { connectionString: scoped.toString(), database: scoped.pathname.slice(1) };
      const migrations = new PostgresDatabaseClient(config, {
        pool: new Pool({ connectionString: scoped.toString() }),
      });
      try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        verifyContinuation(
          () =>
            new PostgresSyncDatabaseClient({
              ...config,
              applicationName: "chat-placement-continuation-proof",
              pool: { max: 1, connectionTimeoutMs: 10_000 },
            }),
          legacy,
        );
      } finally {
        await migrations.close();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );
}
