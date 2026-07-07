import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): IntegrationConnectionRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-integrations-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new IntegrationConnectionRepository(db);
}

describe("IntegrationConnectionRepository", () => {
  it("creates, updates, lists and deletes connections", () => {
    const repo = createRepo();

    const created = repo.create({
      catalogId: "channel.discord",
      kind: "channel",
      key: "discord",
      label: "Discord Primary",
      enabled: true,
      status: "connected",
      config: {
        guildId: "123",
        botTokenEnv: "DISCORD_BOT_TOKEN",
      },
    });

    assert.equal(created.kind, "channel");
    assert.equal(created.key, "discord");
    assert.equal(created.enabled, true);

    const updated = repo.update(created.connectionId, {
      enabled: false,
      status: "paused",
      lastError: "manual pause",
    });
    assert.equal(updated.enabled, false);
    assert.equal(updated.status, "paused");
    assert.equal(updated.lastError, "manual pause");

    const listed = repo.list("channel");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.connectionId, created.connectionId);
    assert.equal(repo.list(undefined, 1000).length, 1);

    const deleted = repo.delete(created.connectionId);
    assert.equal(deleted, true);
    assert.equal(repo.list("channel").length, 0);
    assert.equal(repo.delete(created.connectionId), false);
    assert.throws(() => repo.get(created.connectionId), /Integration connection .* not found/);
  });

  it("round-trips the optional workspace binding, including clearing it", () => {
    const repo = createRepo();

    const created = repo.create({
      catalogId: "automation.gmail",
      kind: "automation",
      key: "gmail",
      label: "Gmail",
      workspaceId: "ws-guarded",
      config: {},
    });
    assert.equal(created.workspaceId, "ws-guarded");
    assert.equal(repo.get(created.connectionId).workspaceId, "ws-guarded");

    // Unrelated updates preserve the binding.
    assert.equal(repo.update(created.connectionId, { label: "Gmail Ops" }).workspaceId, "ws-guarded");
    // Rebinding and clearing (null) both persist.
    assert.equal(repo.update(created.connectionId, { workspaceId: "ws-other" }).workspaceId, "ws-other");
    assert.equal(repo.update(created.connectionId, { workspaceId: null }).workspaceId, undefined);

    // Unbound creates stay unbound.
    const unbound = repo.create({
      catalogId: "productivity.trello",
      kind: "productivity",
      key: "trello",
      label: "Trello",
      config: {},
    });
    assert.equal(unbound.workspaceId, undefined);
  });

  it("maps plugin fields and filters malformed adapter rows", () => {
    const repo = createRepo();
    const created = repo.create({
      catalogId: "tool.github",
      kind: "productivity",
      key: "github",
      label: "GitHub",
      enabled: false,
      status: "disconnected",
      config: { scopes: ["repo"] },
      pluginId: "github",
      pluginVersion: "1.0.0",
      pluginEnabled: true,
    });

    assert.equal(created.pluginId, "github");
    assert.equal(created.pluginVersion, "1.0.0");
    assert.equal(created.pluginEnabled, true);

    const updated = repo.update(created.connectionId, {
      enabled: true,
      status: "connected",
      lastSyncAt: "2026-03-29T00:00:00.000Z",
      lastError: null as unknown as string | undefined,
    });
    assert.equal(updated.lastSyncAt, "2026-03-29T00:00:00.000Z");
    assert.equal(updated.lastError, undefined);

    const internal = repo as unknown as {
      listStmt: { all: (...args: unknown[]) => unknown };
      listByKindStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listStmt = { all: () => ({ not: "an array" }) };
    internal.listByKindStmt = { all: () => [null] };
    assert.deepEqual(repo.list(), []);
    assert.deepEqual(repo.list("productivity"), []);
  });
});
