import assert from "node:assert/strict";
import test from "node:test";
import { assertWindowedRecords } from "./cockpit-long-lists-proof.mjs";
import { assertExactRecords } from "./cockpit-long-list-fixture.mjs";
test("windowing proves a bounded DOM of exact owner keys", () => {
  const fixture = { total: 105, rendered: 2, keys: ["a", "b"], expectedKeys: ["a", "b", ...Array.from({ length: 103 }, (_, i) => "record-" + i)] };
  assert.doesNotThrow(() => assertWindowedRecords(fixture));
  for (const change of [{ total: 100 }, { total: 106 }, { expectedKeys: ["a", "a"] }, { rendered: 105 }, { keys: ["a", "a"] }, { keys: ["a", "foreign"] }]) assert.throws(() => assertWindowedRecords({ ...fixture, ...change }));
});
test("independent canonical comparison preserves every field, uniqueness and complete identity set", () => {
  const records = [{ id: "a", status: "completed", version: 3 }, { id: "b", status: "failed", version: 4 }];
  assert.doesNotThrow(() => assertExactRecords(records, [...records].reverse(), "id"));
  for (const changed of [[records[0]], [records[0], records[0]], [records[0], { ...records[1], version: 5 }], [records[0], { ...records[1], id: "foreign" }]]) assert.throws(() => assertExactRecords(records, changed, "id"));
});
