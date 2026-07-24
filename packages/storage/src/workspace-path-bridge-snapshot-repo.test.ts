import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  WorkspacePathBridgeSnapshotRepository,
  sealWorkspacePathBridgeSnapshot,
} from "./workspace-path-bridge-snapshot-repo.js";
import { createDatabase } from "./sqlite.js";

const databases: DatabaseClient[] = [];
const files: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const file of files.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createStore() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-path-bridge-${randomUUID()}.db`);
  files.push(dbPath);
  const db = createDatabase({ dbPath });
  databases.push(db);
  return { db, repository: new WorkspacePathBridgeSnapshotRepository(db) };
}

function buildSnapshot(snapshotId = "bridge-1") {
  return sealWorkspacePathBridgeSnapshot({
    schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
    snapshotId,
    requestHash: "a".repeat(64),
    workspaceId: "workspace-1",
    inputFlavor: "windows_native",
    targetFlavor: "msys",
    gitIdentityRequired: false,
    inputPathHash: "b".repeat(64),
    allowedRootsHash: "c".repeat(64),
    canonicalHostPath: "F:\\code\\personal-ai",
    canonicalTargetPath: "/f/code/personal-ai",
    roundTrip: {
      attempted: true,
      converter: "native",
      inputHostPathSha256: "d".repeat(64),
      targetPathSha256: "e".repeat(64),
      roundTripHostPathSha256: "d".repeat(64),
      equal: true,
    },
    gitIdentity: { status: "not_repository" },
    status: "verified",
    callable: true,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
}

describe("WorkspacePathBridgeSnapshotRepository", () => {
  it("persists exact replay, workspace-scoped listing, and immutable rows", () => {
    const { db, repository } = createStore();
    const snapshot = buildSnapshot();
    assert.deepEqual(repository.create(snapshot), snapshot);
    assert.deepEqual(repository.create(snapshot), snapshot);
    assert.deepEqual(repository.listByWorkspace("workspace-1", 10), [snapshot]);
    assert.deepEqual(repository.listByWorkspace("workspace-2", 10), []);
    assert.throws(
      () =>
        db
          .prepare("UPDATE workspace_path_bridge_snapshots SET callable = 0 WHERE snapshot_id = ?")
          .run(snapshot.snapshotId),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM workspace_path_bridge_snapshots WHERE snapshot_id = ?").run(snapshot.snapshotId),
      /immutable/u,
    );
  });

  it("rejects same-id different bytes and validates indexed columns on every read", () => {
    const { db, repository } = createStore();
    const snapshot = buildSnapshot();
    repository.create(snapshot);
    const { snapshotSha256: _snapshotSha256, ...draft } = snapshot;
    const conflicting = sealWorkspacePathBridgeSnapshot({
      ...draft,
      requestHash: "9".repeat(64),
    });
    assert.throws(() => repository.create(conflicting), /conflicts with an existing immutable record/u);

    db.exec("DROP TRIGGER trg_workspace_path_bridge_snapshots_no_update");
    db.prepare("UPDATE workspace_path_bridge_snapshots SET request_hash = ? WHERE snapshot_id = ?").run(
      "8".repeat(64),
      snapshot.snapshotId,
    );
    assert.throws(() => repository.get(snapshot.snapshotId), /indexed-column verification/u);
  });

  it("keeps blocked snapshots non-callable and rejects malformed limits", () => {
    const { repository } = createStore();
    const { snapshotSha256: _snapshotSha256, ...draft } = buildSnapshot("bridge-blocked");
    const blocked = sealWorkspacePathBridgeSnapshot({
      ...draft,
      canonicalHostPath: undefined,
      canonicalTargetPath: undefined,
      roundTrip: { attempted: false, converter: "native", equal: false },
      gitIdentity: { status: "failed" },
      status: "blocked",
      reasonCode: "outside_jail",
      callable: false,
    });
    assert.equal(repository.create(blocked).callable, false);
    assert.throws(() => repository.listByWorkspace("workspace-1", 101), /limit is invalid/u);
  });
});
