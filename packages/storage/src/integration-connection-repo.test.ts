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
  });
});
