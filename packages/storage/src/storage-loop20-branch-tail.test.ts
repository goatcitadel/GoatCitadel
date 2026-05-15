import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { WorkspaceHookRepository } from "./workspace-hook-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Best-effort cleanup for temp SQLite files.
    }
  }
});

function createDb(label: string) {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-${label}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createDatabase({ dbPath });
}

function webhookAction(url = "https://example.test/hook") {
  return { type: "webhook", webhook: { url } } as const;
}

describe("storage loop 20 branch tails", () => {
  it("preserves durable run optional fields across lease and update lifecycles", () => {
    const repo = new DurableRunRepository(createDb("durable-loop20"));
    const run = repo.createRun({
      workflowKey: "loop20.durable",
      status: "queued",
      payload: { task: "coverage" },
      metadata: { owner: "worker-f" },
      startedAt: "2026-05-14T01:00:00.000Z",
      finishedAt: "2026-05-14T01:05:00.000Z",
      lastError: " previous failure ",
      leaseOwnerId: "worker-old",
      leaseExpiresAt: "2026-05-14T01:10:00.000Z",
      leaseHeartbeatAt: "2026-05-14T01:02:00.000Z",
    });

    const updated = repo.updateRun({
      runId: run.runId,
      status: "running",
      metadata: {},
      clearFinishedAt: true,
      clearLastError: true,
      expectedVersion: run.version,
    });
    assert.equal(updated.startedAt, "2026-05-14T01:00:00.000Z");
    assert.deepEqual(updated.metadata, {});
    assert.equal(updated.finishedAt, undefined);
    assert.equal(updated.lastError, undefined);
    assert.equal(updated.leaseOwnerId, "worker-old");

    const renewed = repo.renewLease({
      runId: run.runId,
      workerId: "worker-old",
      leaseHeartbeatAt: "2026-05-14T01:03:00.000Z",
      leaseExpiresAt: "2026-05-14T01:13:00.000Z",
    });
    assert.equal(renewed?.leaseOwnerId, "worker-old");
    assert.equal(renewed?.leaseHeartbeatAt, "2026-05-14T01:03:00.000Z");
    assert.equal(renewed?.leaseExpiresAt, "2026-05-14T01:13:00.000Z");
  });

  it("applies integration connection create and update defaults without dropping plugin state", () => {
    const repo = new IntegrationConnectionRepository(createDb("integration-loop20"));
    const created = repo.create({
      catalogId: "channel.email",
      kind: "channel",
      key: "email",
      label: "Email",
    });

    assert.equal(created.enabled, true);
    assert.equal(created.status, "connected");
    assert.deepEqual(created.config, {});
    assert.equal(created.pluginEnabled, false);

    const pluginBacked = repo.create({
      catalogId: "plugin.github",
      kind: "productivity",
      key: "github",
      label: "GitHub",
      enabled: false,
      status: "disconnected",
      config: { scopes: ["repo"] },
      pluginId: "github",
      pluginVersion: "2.0.0",
      pluginEnabled: true,
    });
    const preserved = repo.update(pluginBacked.connectionId, {});
    assert.equal(preserved.enabled, false);
    assert.equal(preserved.status, "disconnected");
    assert.deepEqual(preserved.config, { scopes: ["repo"] });
    assert.equal(preserved.pluginId, "github");
    assert.equal(preserved.pluginVersion, "2.0.0");
    assert.equal(preserved.pluginEnabled, true);
    assert.equal(preserved.lastSyncAt, undefined);
    assert.equal(preserved.lastError, undefined);
  });

  it("preserves workspace hook settings when update input is empty", () => {
    const repo = new WorkspaceHookRepository(createDb("workspace-hook-loop20"));
    const created = repo.create({
      workspaceId: "workspace-1",
      label: "Notify",
      trigger: "tool.call.after",
      mode: "observe",
      enabled: false,
      priority: 42,
      timeoutMs: 4_000,
      failPolicy: "closed",
      action: webhookAction(),
    });

    const updated = repo.update("workspace-1", created.hookId, {}, "2026-05-14T02:00:00.000Z");
    assert.equal(updated.label, "Notify");
    assert.equal(updated.enabled, false);
    assert.equal(updated.priority, 42);
    assert.equal(updated.timeoutMs, 4_000);
    assert.equal(updated.failPolicy, "closed");
    assert.deepEqual(updated.action, webhookAction());
    assert.equal(updated.updatedAt, "2026-05-14T02:00:00.000Z");
  });

  it("reports empty mesh status counts when the database adapter returns no count row", () => {
    const statement: DbStatement = {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const db: DatabaseClient = {
      dialect: "sqlite",
      prepare: () => statement,
      exec: () => undefined,
      close: () => undefined,
      transaction: (_mode, callback) => callback(),
    };
    const repo = new MeshRepository(db);

    assert.deepEqual(repo.buildStatus(false, "lan", "node-local"), {
      enabled: false,
      mode: "lan",
      localNodeId: "node-local",
      tailnetEnabled: false,
      nodesOnline: 0,
      activeLeases: 0,
      ownedSessions: 0,
    });
  });
});
