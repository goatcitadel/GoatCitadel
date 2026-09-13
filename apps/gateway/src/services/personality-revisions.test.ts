import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { createDatabase } from "@goatcitadel/storage";
import { createRemoteWorkerPostgresTestScope } from "../../../../packages/storage/src/remote-worker-test-fixtures.js";
import { verifyPersonalityRaces, verifyPersonalityRevisions } from "./personality-revisions.test-support.js";

it("SQLite personality catalog revisions preserve reviewed state under independent concurrent writers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-personality-revisions-"));
  const dbPath = path.join(root, "catalog.db"); const db = createDatabase({ dbPath });
  try {
    await verifyPersonalityRevisions(db);
    await verifyPersonalityRaces(db, "sqlite", { dbPath });
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-personality-revisions-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
it.skipIf(!connectionString)("PostgreSQL personality catalog revisions reject independent competing writers", async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "personality_revisions");
  try {
    await verifyPersonalityRevisions(scope.db);
    const url = new URL(connectionString!); url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    await verifyPersonalityRaces(scope.db, "postgres", { connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 } });
  } finally { await scope.teardown(); }
}, 90_000);
