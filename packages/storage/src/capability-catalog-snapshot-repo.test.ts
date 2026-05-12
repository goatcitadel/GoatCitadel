import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { CapabilityCatalogSnapshotRepository } from "./capability-catalog-snapshot-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: CapabilityCatalogSnapshotRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-capability-catalog-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new CapabilityCatalogSnapshotRepository(db) };
}

function sampleEntry(capabilityId: string): CapabilityCatalogEntry {
  return {
    capabilityId,
    kind: "skill",
    category: "community_imported",
    title: "Review skill",
    summary: "Reviews a source file",
    callable: true,
    lifecycleState: "approved",
    trustLabel: "Reviewed",
    declaredTools: ["shell"],
    requires: ["repo"],
  };
}

function setRawField(db: DatabaseClient, snapshotId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE capability_catalog_snapshots SET ${field} = ? WHERE snapshot_id = ?`).run(value, snapshotId);
}

describe("CapabilityCatalogSnapshotRepository", () => {
  it("creates, finds, gets, and keeps the first snapshot for duplicate ids", () => {
    const { repo } = createStore();
    const created = repo.create({
      snapshotId: "snapshot-a",
      inspectableEntries: [sampleEntry("skill-a")],
      callableEntries: [sampleEntry("skill-a")],
      createdAt: "2026-03-26T00:00:01.000Z",
    });

    assert.deepEqual(
      created.inspectableEntries.map((entry) => entry.capabilityId),
      ["skill-a"],
    );
    assert.deepEqual(repo.get("snapshot-a"), created);
    assert.deepEqual(repo.find("snapshot-a"), created);

    const duplicate = repo.create({
      snapshotId: "snapshot-a",
      inspectableEntries: [sampleEntry("skill-b")],
      callableEntries: [],
      createdAt: "2026-03-26T00:00:02.000Z",
    });
    assert.equal(duplicate.createdAt, "2026-03-26T00:00:01.000Z");
    assert.deepEqual(
      duplicate.inspectableEntries.map((entry) => entry.capabilityId),
      ["skill-a"],
    );

    assert.equal(repo.find("missing-snapshot"), undefined);
    assert.throws(() => repo.get("missing-snapshot"), /capability catalog snapshot missing-snapshot not found/);
  });

  it("filters malformed rows and falls back for malformed entry JSON", () => {
    const { db, repo } = createStore();
    repo.create({
      snapshotId: "snapshot-a",
      inspectableEntries: [sampleEntry("skill-a")],
      callableEntries: [sampleEntry("skill-a")],
      createdAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "snapshot-a", "inspectable_json", "{}");
    setRawField(db, "snapshot-a", "callable_json", "{bad json");
    const malformedEntries = repo.get("snapshot-a");
    assert.deepEqual(malformedEntries.inspectableEntries, []);
    assert.deepEqual(malformedEntries.callableEntries, []);

    setRawField(db, "snapshot-a", "created_at", new Uint8Array([1]));
    assert.equal(repo.find("snapshot-a"), undefined);
    assert.throws(() => repo.get("snapshot-a"), /capability catalog snapshot snapshot-a not found/);
  });
});
