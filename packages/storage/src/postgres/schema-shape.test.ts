import assert from "node:assert/strict";
import test from "node:test";
import { buildPostgresSchemaShapeManifest } from "./schema-shape.js";

test("schema-shape manifest expands serial pseudo-types the way Postgres reports them back", () => {
  // The real-Postgres coverage lane applies an ad-hoc migration using SERIAL;
  // pg_attribute reports the column as `integer` with a sequence default, so
  // the parsed expectation must match that shape or canonical validation
  // rejects the lane's own scratch table.
  const manifest = buildPostgresSchemaShapeManifest([
    {
      version: 1,
      name: "create_real_postgres_lane_table",
      sql: "CREATE TABLE coverage_lane (id SERIAL PRIMARY KEY, payload TEXT NOT NULL)",
    },
  ]);

  const table = manifest.tables.find((candidate) => candidate.name === "coverage_lane");
  assert.ok(table, "expected the parsed table");
  const id = table.columns.find((column) => column.name === "id");
  assert.deepEqual(id, {
    name: "id",
    type: "integer",
    notNull: true,
    hasDefault: true,
    generated: false,
  });
});

test("schema-shape manifest normalizes each serial alias to its integer family", () => {
  const manifest = buildPostgresSchemaShapeManifest([
    {
      version: 1,
      name: "serial_aliases",
      sql: "CREATE TABLE serial_aliases (" + "a SMALLSERIAL, b SERIAL2, c SERIAL, d SERIAL4, e BIGSERIAL, f SERIAL8)",
    },
  ]);
  const table = manifest.tables.find((candidate) => candidate.name === "serial_aliases");
  assert.ok(table);
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  assert.equal(byName.get("a")?.type, "smallint");
  assert.equal(byName.get("b")?.type, "smallint");
  assert.equal(byName.get("c")?.type, "integer");
  assert.equal(byName.get("d")?.type, "integer");
  assert.equal(byName.get("e")?.type, "bigint");
  assert.equal(byName.get("f")?.type, "bigint");
  for (const column of table.columns) {
    assert.equal(column.hasDefault, true, `${column.name} carries the sequence default`);
  }
});
