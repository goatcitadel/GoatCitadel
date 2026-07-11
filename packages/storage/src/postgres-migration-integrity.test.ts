import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPostgresMigrationIntegrity } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

describe("protected Postgres migration integrity", () => {
  it("recomputes every explicit digest from the generated migration statements", () => {
    const protectedMigrations = POSTGRES_MIGRATIONS.filter((migration) => migration.integritySha256 !== undefined);
    assert.ok(protectedMigrations.length > 0, "expected at least one integrity-protected migration");

    for (const migration of protectedMigrations) {
      assert.doesNotThrow(() => assertPostgresMigrationIntegrity(migration));
    }
  });

  it("fails when generated statement content drifts without a matching digest", () => {
    const migration = POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.integritySha256 !== undefined && candidate.batchedStatements,
    );
    const statements = migration?.batchedStatements;
    assert.ok(migration && statements);

    assert.throws(
      () =>
        assertPostgresMigrationIntegrity({
          ...migration,
          batchedStatements: [
            ...statements.slice(0, -1),
            {
              ...statements.at(-1)!,
              sql: `${statements.at(-1)!.sql}\n-- unintended drift`,
            },
          ],
        }),
      /integrity hash mismatch/,
    );
  });
});
