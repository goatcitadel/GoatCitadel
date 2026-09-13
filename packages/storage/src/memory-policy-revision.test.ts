import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { policyDefaults, raceMemoryPolicySaves, verifyMemoryPolicyRevisions } from "./memory-policy-revision.test-support.js";

test("SQLite policy saves compare revisions, settle recommendations atomically, and reject concurrent overwrites", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-memory-policy-"));
  const dbPath = path.join(root, "policy.db");
  const db = createDatabase({ dbPath });
  try {
    verifyMemoryPolicyRevisions(db);
    const repo = new MemoryMaintenanceRepository(db);
    const base = repo.ensurePolicy(policyDefaults("race-workspace"));
    const results = await raceMemoryPolicySaves({ kind: "sqlite", workerOptions: { dbPath }, workspaceId: base.workspaceId, expectedRevision: base.revision });
    assert.deepEqual(results.map((item) => item.outcome).sort(), ["conflict", "saved"]);
    const winner = results.find((item) => item.outcome === "saved")!;
    const current = repo.requirePolicy(base.workspaceId);
    assert.equal(current.enabled, winner.enabled);
    assert.equal(current.minChangedSessions, winner.threshold);
    assert.equal(current.timeZone, base.timeZone);
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("goat-memory-policy-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
