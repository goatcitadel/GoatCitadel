import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ExternalSideEffectRunRepository } from "./external-side-effect-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures in transient test databases
    }
  }
});

function createRepo(): ExternalSideEffectRunRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-external-side-effect-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new ExternalSideEffectRunRepository(createDatabase({ dbPath }));
}

describe("ExternalSideEffectRunRepository", () => {
  it("persists pre-boundary intent and dedupes by route, idempotency key, and actor", () => {
    const repo = createRepo();
    const created = repo.createOrGet(
      {
        workspaceId: "workspace-1",
        boundary: "integration_operator_action",
        routePath: "external_side_effect:integration_operator_action:automation.activepieces:conn-1:trigger_webhook",
        catalogId: "automation.activepieces",
        connectionId: "conn-1",
        actionId: "trigger_webhook",
        actorScope: "conn-1",
        idempotencyKey: "operator-key",
        payloadHash: "payload-hash",
        requestPayload: {
          provider: "activepieces",
          payloadKeys: ["message"],
        },
      },
      "2026-05-31T10:00:00.000Z",
    );

    assert.equal(created.status, "claimed_not_sent");
    assert.equal(created.resumeState, "not_resumable");
    assert.equal(created.replayAttempt, "new");
    assert.deepEqual(created.requestPayload, {
      provider: "activepieces",
      payloadKeys: ["message"],
    });

    const duplicate = repo.createOrGet(
      {
        boundary: "integration_operator_action",
        routePath: created.routePath,
        actorScope: "conn-1",
        idempotencyKey: "operator-key",
        payloadHash: "payload-hash",
      },
      "2026-05-31T10:00:01.000Z",
    );

    assert.equal(duplicate.runId, created.runId);
    assert.equal(repo.findByIdempotency(created.routePath, "operator-key", "conn-1")?.runId, created.runId);
    assert.equal(repo.listByWorkspace("workspace-1")[0]?.runId, created.runId);
  });

  it("tracks external-start, completion, evidence, and unknown-outcome failure states", () => {
    const repo = createRepo();
    const run = repo.createOrGet(
      {
        boundary: "integration_operator_action",
        routePath: "external_side_effect:integration_operator_action:productivity.trello:conn-2:write",
        catalogId: "productivity.trello",
        connectionId: "conn-2",
        actionId: "write",
        actorScope: "conn-2",
        idempotencyKey: "trello-key",
        payloadHash: "payload-hash",
      },
      "2026-05-31T10:00:00.000Z",
    );

    const started = repo.markExternalCallStarted(run.runId, {}, "2026-05-31T10:00:02.000Z");
    assert.equal(started.status, "external_call_started");
    assert.equal(started.attemptCount, 1);
    assert.equal(started.externalCallStartedAt, "2026-05-31T10:00:02.000Z");

    const failed = repo.markFailure(
      run.runId,
      {
        status: "unknown_external_outcome",
        errorText: "connection reset after request started",
        responsePayload: { provider: "trello" },
      },
      "2026-05-31T10:00:03.000Z",
    );
    assert.equal(failed.status, "unknown_external_outcome");
    assert.equal(failed.resumeState, "not_resumable");
    assert.equal(failed.errorText, "connection reset after request started");
    assert.deepEqual(failed.responsePayload, { provider: "trello" });

    const completed = repo.markCompleted(
      run.runId,
      {
        replayOutcome: "claimed",
        responsePayload: { id: "card-1" },
        externalReferenceId: "id:card-1",
        envelopeId: "env-1",
      },
      "2026-05-31T10:00:04.000Z",
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.resumeState, "completed");
    assert.equal(completed.envelopeId, "env-1");
    assert.equal(completed.externalReferenceId, "id:card-1");

    const attached = repo.attachEnvelope(run.runId, "env-2", "2026-05-31T10:00:05.000Z");
    assert.equal(attached.envelopeId, "env-2");
  });

  it("lists side-effect runs by connection within a workspace", () => {
    const repo = createRepo();
    const first = repo.createOrGet(
      {
        workspaceId: "workspace-1",
        boundary: "integration_operator_action",
        routePath: "external_side_effect:integration_operator_action:productivity.trello:conn-a:write",
        catalogId: "productivity.trello",
        connectionId: "conn-a",
        actionId: "write",
        actorScope: "conn-a",
        idempotencyKey: "trello-key-a",
        payloadHash: "payload-hash-a",
      },
      "2026-05-31T10:00:00.000Z",
    );
    const second = repo.createOrGet(
      {
        workspaceId: "workspace-1",
        boundary: "integration_operator_action",
        routePath: "external_side_effect:integration_operator_action:productivity.trello:conn-b:write",
        catalogId: "productivity.trello",
        connectionId: "conn-b",
        actionId: "write",
        actorScope: "conn-b",
        idempotencyKey: "trello-key-b",
        payloadHash: "payload-hash-b",
      },
      "2026-05-31T10:00:01.000Z",
    );
    repo.createOrGet(
      {
        workspaceId: "workspace-2",
        boundary: "integration_operator_action",
        routePath: "external_side_effect:integration_operator_action:productivity.trello:conn-a:write",
        catalogId: "productivity.trello",
        connectionId: "conn-a",
        actionId: "write",
        actorScope: "conn-a",
        idempotencyKey: "trello-key-c",
        payloadHash: "payload-hash-c",
      },
      "2026-05-31T10:00:02.000Z",
    );

    assert.deepEqual(
      repo.listByConnection("conn-a", { workspaceId: "workspace-1" }).map((item) => item.runId),
      [first.runId],
    );
    assert.deepEqual(
      repo.listByWorkspace("workspace-1").map((item) => item.runId),
      [second.runId, first.runId],
    );
  });
});
