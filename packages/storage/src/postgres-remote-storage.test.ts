import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import { __postgresRemoteStorageInternals, createPostgresRemoteStorage } from "./postgres/remote-storage.js";
import type {
  PostgresRemoteStorageRequest,
  PostgresRemoteStorageResponse,
} from "./postgres/remote-storage-protocol.js";

class FakeRemoteStorageWorker extends EventEmitter {
  public readonly requests: PostgresRemoteStorageRequest[] = [];
  public terminated = false;

  public constructor() {
    super();
    queueMicrotask(() => this.emit("message", { kind: "ready", ok: true } satisfies PostgresRemoteStorageResponse));
  }

  public postMessage(value: unknown): void {
    const request = structuredClone(value) as PostgresRemoteStorageRequest;
    this.requests.push(request);
    const result =
      request.kind === "statement" && request.mode === "get"
        ? { value: "remote" }
        : request.kind === "invoke" && request.path.join(".") === "heartbeatOccurrences.claimWithAdmission"
          ? { disposition: "not_due", reason: "interval", databaseNow: "2026-08-05T00:00:00.000Z" }
          : request.kind === "invoke" &&
              request.path.join(".") === "sessionMutationAdmissions.beginPostCommitChildStageInCurrentTransaction"
            ? {
                disposition: "allowed",
                admission: { admissionId: "admission-1", status: "active" },
                durableRunVersion: 3,
              }
            : request.kind === "invoke" &&
                request.path.join(".") === "sessionMutationAdmissions.finishPostCommitChildStageInCurrentTransaction"
              ? {
                  disposition: request.args[2],
                  admission: { admissionId: "admission-1", status: "completed" },
                }
              : request.kind === "invoke" && request.path.join(".") === "chatMessages.list"
                ? [{ messageId: "message-1" }]
                : request.kind === "invoke" && request.path.join(".") === "deleteChatSessionData"
                  ? { sessionId: request.args[0], deleted: true, cleanupRelPaths: [], attachments: [] }
                  : undefined;
    queueMicrotask(() =>
      this.emit("message", {
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result,
      } satisfies PostgresRemoteStorageResponse),
    );
  }

  public unref(): void {}

  public async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

test("remote Postgres storage restores known error prototypes across the worker boundary", () => {
  const notFound = __postgresRemoteStorageInternals.deserializeError({
    name: "NotFoundError",
    message: "Durable run run-1 not found",
    stack: "NotFoundError: Durable run run-1 not found",
    properties: {
      code: "ENTITY_NOT_FOUND",
      httpStatus: 404,
      details: { entity: "Durable run", id: "run-1" },
    },
  });
  assert.ok(notFound instanceof NotFoundError);
  assert.equal(notFound.name, "NotFoundError");
  assert.equal(notFound.message, "Durable run run-1 not found");
  assert.equal(notFound.stack, "NotFoundError: Durable run run-1 not found");
  assert.equal(notFound.code, "ENTITY_NOT_FOUND");
  assert.equal(notFound.httpStatus, 404);
  assert.deepEqual(notFound.details, { entity: "Durable run", id: "run-1" });

  const conflict = __postgresRemoteStorageInternals.deserializeError({
    name: "ConflictError",
    message: "write conflict",
    properties: { code: "WRITE_CONFLICT", httpStatus: 409 },
  });
  assert.ok(conflict instanceof ConflictError);

  const typeError = __postgresRemoteStorageInternals.deserializeError({
    name: "TypeError",
    message: "bad remote argument",
  });
  assert.ok(typeError instanceof TypeError);

  const unknown = __postgresRemoteStorageInternals.deserializeError({
    name: "DatabaseDriverError",
    message: "driver failed",
    properties: { severity: "ERROR" },
  });
  assert.ok(unknown instanceof Error);
  assert.equal(unknown.name, "DatabaseDriverError");
  assert.equal((unknown as Error & { severity?: string }).severity, "ERROR");
});

test("remote Postgres storage exposes awaited repository calls and nested transaction posture", async () => {
  const worker = new FakeRemoteStorageWorker();
  const storage = createPostgresRemoteStorage(
    {
      connection: { database: "test" },
      migrationsTable: "schema_migrations",
      transcriptsDir: "transcripts",
      auditDir: "audit",
    },
    { workerFactory: () => worker as never },
  );

  await storage.waitUntilReady();
  const messages = await storage.chatMessages.list("session-1", 10);
  assert.deepEqual(messages, [{ messageId: "message-1" }]);

  const rootResult = await storage.deleteChatSessionData("session-1");
  assert.deepEqual(rootResult, {
    sessionId: "session-1",
    deleted: true,
    cleanupRelPaths: [],
    attachments: [],
  });

  assert.equal(storage.gatewaySql.dialect, "postgres");
  const gatewaySqlRow = await storage.gatewaySql
    .prepare("SELECT value FROM async_gateway_sql_fixture WHERE id = $1")
    .get<{ value: string }>(1);
  assert.deepEqual(gatewaySqlRow, { value: "remote" });
  const heartbeatClaim = await storage.heartbeatOccurrences.claimWithAdmission({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    expectedPriorCadence: {},
    evaluatedPolicySha256: "a".repeat(64),
    frozenRequestSha256: "b".repeat(64),
    frozenObjectiveSha256: "c".repeat(64),
    idleFloorSeconds: 300,
  });
  assert.deepEqual(heartbeatClaim, {
    disposition: "not_due",
    reason: "interval",
    databaseNow: "2026-08-05T00:00:00.000Z",
  });

  await storage.runImmediateTransaction(async () => {
    await storage.chatMessages.list("session-1", 10);
    await storage.runImmediateTransaction(async () => {
      await storage.chatMessages.list("session-1", 10);
    });
  });
  await storage.gatewaySql.runImmediateTransaction(async () => {
    await storage.chatMessages.list("session-1", 10);
    await storage.gatewaySql.prepare("UPDATE async_gateway_sql_fixture SET value = $1 WHERE id = $2").run("updated", 1);
  });

  const transactionRequests = worker.requests.filter((request) => request.kind.startsWith("transaction_"));
  assert.deepEqual(
    transactionRequests.map((request) => ({
      kind: request.kind,
      transactionId: request.transactionId,
      depth: "depth" in request ? request.depth : undefined,
    })),
    [
      { kind: "transaction_begin", transactionId: transactionRequests[0]?.transactionId, depth: 0 },
      { kind: "transaction_begin", transactionId: transactionRequests[0]?.transactionId, depth: 1 },
      { kind: "transaction_commit", transactionId: transactionRequests[0]?.transactionId, depth: 1 },
      { kind: "transaction_commit", transactionId: transactionRequests[0]?.transactionId, depth: 0 },
      { kind: "transaction_begin", transactionId: transactionRequests[4]?.transactionId, depth: 0 },
      { kind: "transaction_commit", transactionId: transactionRequests[4]?.transactionId, depth: 0 },
    ],
  );
  assert.ok(transactionRequests[0]?.transactionId);
  assert.notEqual(transactionRequests[0]?.transactionId, transactionRequests[4]?.transactionId);
  assert.ok(
    worker.requests.some((request) => request.kind === "invoke" && request.path.join(".") === "deleteChatSessionData"),
  );
  assert.equal(
    worker.requests.some(
      (request) => request.kind === "invoke" && request.path.join(".") === "gatewaySql.runImmediateTransaction",
    ),
    false,
  );
  const gatewayStatements = worker.requests.filter((request) => request.kind === "statement");
  assert.deepEqual(
    gatewayStatements.map((request) => ({ mode: request.mode, sql: request.sql, args: request.args })),
    [
      {
        mode: "get",
        sql: "SELECT value FROM async_gateway_sql_fixture WHERE id = $1",
        args: [1],
      },
      {
        mode: "run",
        sql: "UPDATE async_gateway_sql_fixture SET value = $1 WHERE id = $2",
        args: ["updated", 1],
      },
    ],
  );
  assert.equal(gatewayStatements[1]?.transactionId, transactionRequests[4]?.transactionId);
  assert.equal(
    worker.requests.some((request) => request.kind === "invoke" && request.path.join(".") === "gatewaySql.prepare"),
    false,
  );

  await storage.close();
  assert.equal(worker.terminated, true);
});

test("remote Postgres storage bridges an awaited post-commit callback under one worker transaction", async () => {
  const worker = new FakeRemoteStorageWorker();
  const storage = createPostgresRemoteStorage(
    {
      connection: { database: "test" },
      migrationsTable: "schema_migrations",
      transcriptsDir: "transcripts",
      auditDir: "audit",
    },
    { workerFactory: () => worker as never },
  );
  await storage.waitUntilReady();

  const input = { childRunId: "child-run-1" } as never;
  const outcome = await storage.sessionMutationAdmissions.runPostCommitChildStage(input, async (authority) => {
    await Promise.resolve();
    assert.equal(authority.durableRunVersion, 3);
    return { disposition: "allowed", value: { persisted: true } };
  });
  assert.deepEqual(outcome, {
    disposition: "allowed",
    value: { persisted: true },
    admission: { admissionId: "admission-1", status: "completed" },
  });

  await assert.rejects(
    storage.sessionMutationAdmissions.runPostCommitChildStage(input, async () => {
      throw new Error("post-commit bridge rollback");
    }),
    /post-commit bridge rollback/u,
  );

  const phaseRequests = worker.requests.filter(
    (request) => request.kind === "invoke" && request.path[0] === "sessionMutationAdmissions",
  );
  assert.deepEqual(
    phaseRequests.map((request) => request.kind === "invoke" && request.path.at(-1)),
    [
      "beginPostCommitChildStageInCurrentTransaction",
      "finishPostCommitChildStageInCurrentTransaction",
      "beginPostCommitChildStageInCurrentTransaction",
    ],
  );
  assert.equal(
    phaseRequests.some(
      (request) => request.kind === "invoke" && request.args.some((argument) => typeof argument === "function"),
    ),
    false,
  );
  const finishRequest = phaseRequests.find(
    (request) => request.kind === "invoke" && request.path.at(-1) === "finishPostCommitChildStageInCurrentTransaction",
  );
  assert.ok(finishRequest?.kind === "invoke");
  assert.equal(finishRequest.args[2], "allowed");
  assert.equal(JSON.stringify(finishRequest.args).includes("persisted"), false);
  const transactionRequests = worker.requests.filter((request) => request.kind.startsWith("transaction_"));
  assert.deepEqual(
    transactionRequests.map((request) => request.kind),
    ["transaction_begin", "transaction_commit", "transaction_begin", "transaction_rollback"],
  );
  assert.equal(phaseRequests[0]?.transactionId, transactionRequests[0]?.transactionId);
  assert.equal(phaseRequests[1]?.transactionId, transactionRequests[0]?.transactionId);
  assert.equal(phaseRequests[2]?.transactionId, transactionRequests[2]?.transactionId);

  await storage.close();
});
