import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

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

function createRepo(): StateValidationQuarantineRepository {
  const dbPath = path.join(os.tmpdir(), `gc-quarantine-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new StateValidationQuarantineRepository(db);
}

describe("StateValidationQuarantineRepository", () => {
  it("records an entry and lists it back", () => {
    const repo = createRepo();
    repo.record({
      store: "session.routing_hints",
      rowId: "session-1",
      rawValue: "{not json",
      schemaError: "json_parse: Unexpected token",
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    const list = repo.list(10);
    assert.equal(list.length, 1);
    const entry = list[0];
    assert.ok(entry);
    assert.equal(entry.store, "session.routing_hints");
    assert.equal(entry.rowId, "session-1");
    assert.equal(entry.schemaError, "json_parse: Unexpected token");
  });

  it("orders entries newest-observed-first", () => {
    const repo = createRepo();
    repo.record({
      store: "a",
      rowId: "r1",
      rawValue: null,
      schemaError: "schema: x",
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    repo.record({
      store: "a",
      rowId: "r2",
      rawValue: null,
      schemaError: "schema: x",
      observedAt: "2026-05-15T01:00:00.000Z",
    });
    const list = repo.list(10);
    const first = list[0];
    const second = list[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.rowId, "r2");
    assert.equal(second.rowId, "r1");
  });

  it("counts entries", () => {
    const repo = createRepo();
    assert.equal(repo.count(), 0);
    repo.record({
      store: "a",
      rowId: "r1",
      rawValue: null,
      schemaError: "schema: x",
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    repo.record({
      store: "a",
      rowId: "r2",
      rawValue: null,
      schemaError: "schema: x",
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    assert.equal(repo.count(), 2);
  });

  it("groups counts by store", () => {
    const repo = createRepo();
    repo.record({ store: "a", rowId: "r1", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "a", rowId: "r2", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "b", rowId: "r3", rawValue: null, schemaError: "y", observedAt: "2026-05-15T00:00:00Z" });
    const grouped = repo.countsByStore();
    assert.deepEqual(
      grouped.sort((l, r) => l.store.localeCompare(r.store)),
      [
        { store: "a", count: 2 },
        { store: "b", count: 1 },
      ],
    );
  });

  it("clears entries by store", () => {
    const repo = createRepo();
    repo.record({ store: "a", rowId: "r1", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "b", rowId: "r2", rawValue: null, schemaError: "y", observedAt: "2026-05-15T00:00:00Z" });
    const cleared = repo.clear("a");
    assert.equal(cleared, 1);
    assert.equal(repo.count(), 1);
    const remaining = repo.list(10)[0];
    assert.ok(remaining);
    assert.equal(remaining.store, "b");
  });

  it("clears all entries when no store filter", () => {
    const repo = createRepo();
    repo.record({ store: "a", rowId: "r1", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "b", rowId: "r2", rawValue: null, schemaError: "y", observedAt: "2026-05-15T00:00:00Z" });
    const cleared = repo.clear();
    assert.equal(cleared, 2);
    assert.equal(repo.count(), 0);
  });
});

describe("state_validation_quarantine schema", () => {
  it("creates the quarantine table on first boot", () => {
    const dbPath = path.join(os.tmpdir(), `gc-quarantine-schema-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_validation_quarantine'")
      .get();
    assert.ok(row, "quarantine table should exist after migrate");
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_state_validation_quarantine_store_observed'",
      )
      .get();
    assert.ok(idx, "quarantine index should exist after migrate");
  });
});
