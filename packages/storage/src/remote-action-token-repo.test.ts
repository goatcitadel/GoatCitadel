import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { RemoteActionTokenRepository } from "./remote-action-token-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): RemoteActionTokenRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-remote-action-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new RemoteActionTokenRepository(db);
}

describe("RemoteActionTokenRepository", () => {
  it("creates and finds tokens by hash", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-1",
      actionType: "approval.resolve",
      approvalId: "apr-1",
      connectorId: "mission-control",
      mutation: { approvalId: "apr-1" },
      expiresAt: "2026-03-21T00:00:00.000Z",
    });

    const found = repo.findByTokenHash("hash-1");
    assert.ok(found);
    assert.equal(found?.tokenId, created.tokenId);
    assert.equal(found?.approvalId, "apr-1");
    assert.deepEqual(found?.mutation, { approvalId: "apr-1" });
  });

  it("updates token state and consumption metadata", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-2",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-21T00:00:00.000Z",
    });

    const consumed = repo.updateState(created.tokenId, "consumed", {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:mission-control",
    });

    assert.equal(consumed.state, "consumed");
    assert.equal(consumed.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(consumed.consumedBy, "connector:mission-control");
    const expired = repo.updateState(created.tokenId, "expired");
    assert.equal(expired.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(expired.consumedBy, "connector:mission-control");
  });

  it("atomically consumes pending tokens once and preserves the first consumer", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-atomic",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-21T00:00:00.000Z",
    });

    const first = repo.consumePending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:first",
    });
    const second = repo.consumePending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:01.000Z",
      consumedBy: "connector:second",
    });

    assert.equal(first?.state, "consumed");
    assert.equal(second, undefined);
    const persisted = repo.get(created.tokenId);
    assert.equal(persisted.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(persisted.consumedBy, "connector:first");
  });

  it("validates required token fields and reports missing reads", () => {
    const repo = createRepo();

    assert.throws(
      () =>
        repo.create({
          tokenHash: "   ",
          actionType: "approval.resolve",
          connectorId: "mission-control",
          expiresAt: "2026-03-21T00:00:00.000Z",
        }),
      /tokenHash is required/,
    );
    assert.throws(
      () =>
        repo.create({
          tokenHash: "hash-missing-connector",
          actionType: "approval.resolve",
          connectorId: "   ",
          expiresAt: "2026-03-21T00:00:00.000Z",
        }),
      /connectorId is required/,
    );
    assert.throws(() => repo.get("missing-token"), /Remote action token missing-token not found/);
    assert.throws(() => repo.updateState("missing-token", "consumed"), /Remote action token missing-token not found/);
  });
});
