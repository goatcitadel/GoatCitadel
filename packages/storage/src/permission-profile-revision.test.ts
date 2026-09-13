import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { PermissionProfileRepository } from "./permission-profile-repo.js";
import { profileInput, racePermissionProfileMutations, verifyPermissionProfileRevisions } from "./permission-profile-revision.test-support.js";

test("SQLite permission profile saves and archives compare reviewed revisions across independent writers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-permission-revision-"));
  const dbPath = path.join(root, "profiles.db");
  const db = createDatabase({ dbPath });
  try {
    verifyPermissionProfileRevisions(db);
    const repo = new PermissionProfileRepository(db);
    for (const includeArchive of [false, true]) {
      const base = repo.createProfile(profileInput("Race profile"));
      const results = await racePermissionProfileMutations({ kind: "sqlite", workerOptions: { dbPath }, profileId: base.profileId, expectedRevision: base.revision, includeArchive });
      assert.deepEqual(results.map((result) => result.outcome).sort(), ["conflict", "saved"]);
      const winner = results.find((result) => result.outcome === "saved")!;
      const current = repo.getProfile(base.profileId);
      assert.equal(current.status, winner.operation === "archive" ? "archived" : "active");
      assert.equal(current.label, winner.operation === "archive" ? base.label : winner.label);
      assert.deepEqual(current.deny, base.deny);
    }
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-permission-revision-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
