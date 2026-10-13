import assert from "node:assert/strict";
import test from "node:test";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { buildCanonicalPostgresSchemaShapeManifest } from "./migrator.js";

test("context admission replaces only the historical v2 shape postcondition", () => {
  const before = buildCanonicalPostgresSchemaShapeManifest(
    POSTGRES_MIGRATIONS.filter((migration) => migration.version < 204),
  );
  const after = buildCanonicalPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS);
  const checks = (manifest: typeof before) =>
    manifest.tables
      .find((table) => table.name === "chat_routed_context_snapshots")!
      .constraints.filter((constraint) => constraint.type === "c")
      .map((constraint) => constraint.name);
  assert.ok(checks(before).includes("chat_routed_context_snapshots_schema_version_v2_check"));
  assert.ok(!checks(after).includes("chat_routed_context_snapshots_schema_version_v2_check"));
  assert.ok(checks(after).includes("chat_routed_context_snapshot_authority_v3"));
});
