import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CapabilityCatalogSnapshotRepository } from "./capability-catalog-snapshot-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createStore(): { db: DatabaseClient; repo: CapabilityCatalogSnapshotRepository } {
  const dbPath = tempDbs.path("goatcitadel-capability-catalog");
  const db = tempDbs.open({ dbPath });
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
  it("creates, finds, gets, and accepts only byte-equivalent catalogs for duplicate ids", () => {
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
      inspectableEntries: [sampleEntry("skill-a")],
      callableEntries: [sampleEntry("skill-a")],
      createdAt: "2026-03-26T00:00:02.000Z",
    });
    assert.equal(duplicate.createdAt, "2026-03-26T00:00:01.000Z");
    assert.deepEqual(
      duplicate.inspectableEntries.map((entry) => entry.capabilityId),
      ["skill-a"],
    );

    assert.throws(
      () =>
        repo.create({
          snapshotId: "snapshot-a",
          inspectableEntries: [sampleEntry("skill-b")],
          callableEntries: [],
          createdAt: "2026-03-26T00:00:03.000Z",
        }),
      /conflicts with an existing immutable record/,
    );
    assert.throws(
      () =>
        repo.create({
          snapshotId: "snapshot-a",
          inspectableEntries: [sampleEntry("skill-a")],
          callableEntries: [],
          createdAt: "2026-03-26T00:00:04.000Z",
        }),
      /conflicts with an existing immutable record/,
    );

    assert.equal(repo.find("missing-snapshot"), undefined);
    assert.throws(() => repo.get("missing-snapshot"), /capability catalog snapshot missing-snapshot not found/);
  });

  it("filters malformed rows and fails closed for corrupt entry JSON", () => {
    const { db, repo } = createStore();
    repo.create({
      snapshotId: "snapshot-a",
      inspectableEntries: [sampleEntry("skill-a")],
      callableEntries: [sampleEntry("skill-a")],
      createdAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "snapshot-a", "inspectable_json", "{}");
    setRawField(db, "snapshot-a", "callable_json", "{bad json");
    assert.throws(() => repo.get("snapshot-a"), /malformed entry JSON/);
    assert.throws(
      () =>
        repo.create({
          snapshotId: "snapshot-a",
          inspectableEntries: [sampleEntry("skill-a")],
          callableEntries: [sampleEntry("skill-a")],
          createdAt: "2026-03-26T00:00:02.000Z",
        }),
      /malformed entry JSON/,
    );

    setRawField(db, "snapshot-a", "created_at", new Uint8Array([1]));
    assert.equal(repo.find("snapshot-a"), undefined);
    assert.throws(() => repo.get("snapshot-a"), /capability catalog snapshot snapshot-a not found/);
  });
});
