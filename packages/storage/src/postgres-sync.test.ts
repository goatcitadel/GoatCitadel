import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DbRunResult } from "./db.js";
import { PostgresSyncDatabaseClient, __postgresSyncInternals } from "./postgres/sync.js";

function createClientHarness() {
  const calls: Array<{ mode: "run" | "get" | "all"; sql: string; params: unknown[] }> = [];
  const client = Object.create(PostgresSyncDatabaseClient.prototype) as PostgresSyncDatabaseClient & {
    executeRun: (sql: string, params: unknown[]) => DbRunResult;
    executeGet: <T = unknown>(sql: string, params: unknown[]) => T | undefined;
    executeAll: <T = unknown>(sql: string, params: unknown[]) => T[];
  };
  client.executeRun = (sql, params) => {
    calls.push({ mode: "run", sql, params });
    return { changes: 2 };
  };
  client.executeGet = <T = unknown>(sql: string, params: unknown[]) => {
    calls.push({ mode: "get", sql, params });
    return { ok: true } as T;
  };
  client.executeAll = <T = unknown>(sql: string, params: unknown[]) => {
    calls.push({ mode: "all", sql, params });
    return [{ ok: true }] as T[];
  };
  return { client, calls };
}

describe("PostgresSyncDatabaseClient statement adapter", () => {
  it("translates positional parameters for run, get, and all calls", () => {
    const { client, calls } = createClientHarness();
    const statement = client.prepare("SELECT * FROM tasks WHERE status = ? AND workspace_id = ?");

    assert.deepEqual(statement.run("review", "default"), { changes: 2 });
    assert.deepEqual(statement.get("review", "default"), { ok: true });
    assert.deepEqual(statement.all("review", "default"), [{ ok: true }]);
    assert.deepEqual(
      calls.map((call) => call.sql),
      [
        "SELECT * FROM tasks WHERE status = $1 AND workspace_id = $2",
        "SELECT * FROM tasks WHERE status = $1 AND workspace_id = $2",
        "SELECT * FROM tasks WHERE status = $1 AND workspace_id = $2",
      ],
    );
    assert.deepEqual(calls[0]?.params, ["review", "default"]);
  });

  it("translates named parameters and falls back to undefined for missing or non-record params", () => {
    const named = __postgresSyncInternals.translateSql(
      "UPDATE tasks SET status = @status WHERE task_id = @taskId AND workspace_id = @workspaceId",
      [{ status: "done", taskId: "task-a" }],
    );
    const missing = __postgresSyncInternals.translateSql("SELECT @value AS value", [["not", "a", "record"]]);

    assert.equal(named.sql, "UPDATE tasks SET status = $1 WHERE task_id = $2 AND workspace_id = $3");
    assert.deepEqual(named.params, ["done", "task-a", undefined]);
    assert.deepEqual(missing.params, [undefined]);
    assert.equal(__postgresSyncInternals.isRecord({ value: true }), true);
    assert.equal(__postgresSyncInternals.isRecord(["not", "record"]), false);
  });

  it("resolves the worker URL and preserves serialized worker error details", () => {
    const workerUrl = __postgresSyncInternals.resolveWorkerUrl();
    const error = __postgresSyncInternals.deserializeWorkerError({
      name: "QueryError",
      message: "bad query",
      stack: "stack line",
    });

    assert.match(workerUrl.pathname, /sync-worker\.(ts|js)$/);
    assert.equal(error.name, "QueryError");
    assert.equal(error.message, "bad query");
    assert.equal(error.stack, "stack line");
  });
});
