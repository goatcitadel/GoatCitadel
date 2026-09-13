import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { PermissionProfileRepository } from "./permission-profile-repo.js";
import { profileInput, racePermissionProfileMutations, verifyPermissionProfileRevisions } from "./permission-profile-revision.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL permission profile saves and archives compare reviewed revisions across independent writers", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "permission_profile_revision");
  try {
    verifyPermissionProfileRevisions(scope.db);
    const repo = new PermissionProfileRepository(scope.db);
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    for (const includeArchive of [false, true]) {
      const base = repo.createProfile(profileInput("Race profile"));
      const results = await racePermissionProfileMutations({ kind: "postgres", workerOptions: {
        connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 },
      }, profileId: base.profileId, expectedRevision: base.revision, includeArchive });
      assert.deepEqual(results.map((result) => result.outcome).sort(), ["conflict", "saved"]);
      const winner = results.find((result) => result.outcome === "saved")!;
      const current = repo.getProfile(base.profileId);
      assert.equal(current.status, winner.operation === "archive" ? "archived" : "active");
      assert.equal(current.label, winner.operation === "archive" ? base.label : winner.label);
      assert.deepEqual(current.deny, base.deny);
    }
  } finally { await scope.teardown(); }
});
