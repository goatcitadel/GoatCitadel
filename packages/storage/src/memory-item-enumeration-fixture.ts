import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseClient } from "./db.js";
import { MemoryItemEnumerationRepository } from "./memory-item-enumeration-repo.js";
import { MEMORY_ITEM_ENUMERATION_POSTGRES_SQL, MEMORY_ITEM_ENUMERATION_SQLITE_SQL } from "./memory-item-enumeration-schema.js";

/** Shared assertions run only against independently allocated test databases. */
export async function verifyMemoryItemEnumeration(db: DatabaseClient) {
  const schema = db.dialect === "postgres" ? MEMORY_ITEM_ENUMERATION_POSTGRES_SQL : MEMORY_ITEM_ENUMERATION_SQLITE_SQL;
  const insert = db.prepare(`INSERT INTO memory_items
    (item_id, namespace, title, content, metadata_json, pinned, status, created_at, updated_at, workspace_id, expires_at)
    VALUES (@id, @namespace, @id, @content, @metadata, 0, @status, @time, @time, @workspaceId, @expiresAt)`);
  const seed = (id: string, overrides: Record<string, unknown> = {}) => insert.run({
    id, namespace: "enumeration", content: "needle", metadata: "{}", status: "active",
    time: "2026-01-01T00:00:00.000Z", workspaceId: "workspace-a", expiresAt: null, ...overrides,
  });
  // Additive installation must preserve already persisted content and metadata.
  seed("retained-before-enumeration", { namespace: "retained", content: "original content" });
  db.exec(schema);
  assert.equal(db.prepare("SELECT content FROM memory_items WHERE item_id = 'retained-before-enumeration'").get<{ content: string }>()?.content, "original content");
  const expected: string[] = [];
  db.transaction("immediate", () => {
    for (let index = 0; index < 1_207; index += 1) {
      const id = `enumerated-${String(index).padStart(4, "0")}`;
      seed(id); expected.push(id);
    }
    for (const [id, overrides] of [
      ["canonical-a", { metadata: '{"workspaceId":"workspace-b"}' }],
      ["legacy-a", { workspaceId: null, metadata: '{"workspaceId":" workspace-a "}' }],
      ["global", { workspaceId: null }],
      ["legacy-malformed-global", { workspaceId: null, metadata: "{invalid-json" }],
    ] as const) { seed(id, overrides); expected.push(id); }
    seed("canonical-b", { workspaceId: "workspace-b", metadata: '{"workspaceId":"workspace-a"}' });
    seed("legacy-b", { workspaceId: null, metadata: '{"workspaceId":"workspace-b"}' });
    seed("different-namespace", { namespace: "elsewhere" });
    seed("different-query", { content: "unrelated" });
    seed("forgotten", { status: "forgotten" });
    seed("expired", { expiresAt: "2000-01-01T00:00:00.000Z" });
  });
  const repository = new MemoryItemEnumerationRepository(db);
  const input = { workspaceId: "workspace-a", namespace: "enumeration", query: "needle", status: "active" as const, limit: 500 };
  const first = repository.listPage(input);
  assert.equal(first.rows.length, 500);
  assert.equal(first.total, expected.length);
  assert.ok(first.continuation);
  let page = first;
  const seen: string[] = [];
  let pages = 0;
  while (pages < 10) {
    pages += 1;
    assert.equal(page.total, expected.length);
    assert.equal(page.snapshotAt, first.snapshotAt);
    assert.ok(page.rows.length <= 500);
    seen.push(...page.rows.map(row => row.item_id));
    if (!page.continuation) break;
    page = repository.listPage({ ...input, continuation: page.continuation });
    assert.ok(pages < 10, "pagination must terminate");
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, expected.length);
  assert.equal(new Set(seen).size, seen.length, "duplicate IDs across pages");
  assert.deepEqual(new Set(seen), new Set(expected), "every scoped matching item must be enumerated");
  assert.equal(repository.listPage({ ...input, status: "all" }).total, expected.length + 2);
  assert.deepEqual(repository.listPage({ ...input, status: "forgotten" }).rows.map(row => row.item_id), ["forgotten"]);
  for (const limit of [0, 501, NaN]) assert.throws(() => repository.listPage({ ...input, limit }), /limit/);

  // Rolling a write back must roll its generation back too, retaining a usable cursor.
  assert.throws(() => db.transaction("immediate", () => { seed("rolled-back"); throw new Error("rollback fixture"); }), /rollback fixture/);
  assert.equal(repository.listPage({ ...input, continuation: first.continuation }).total, expected.length);
  db.exec(schema);
  assert.equal(repository.listPage({ ...input, continuation: first.continuation }).total, expected.length, "schema replay must not reset generation");

  const stale = (mutate: () => unknown) => {
    const before = repository.listPage(input);
    assert.ok(before.continuation);
    mutate();
    assert.throws(() => repository.listPage({ ...input, continuation: before.continuation }),
      (error: unknown) => error instanceof Error && "details" in error &&
        (error.details as { reason?: string })?.reason === "MEMORY_CURSOR_STALE");
  };
  stale(() => seed("later-insert"));
  stale(() => db.prepare("UPDATE memory_items SET content = 'changed needle' WHERE item_id = 'enumerated-0001'").run());
  stale(() => db.prepare("UPDATE memory_items SET status = 'forgotten' WHERE item_id = 'enumerated-0002'").run());
  stale(() => db.prepare("DELETE FROM memory_items WHERE item_id = 'enumerated-0003'").run());
  stale(() => seed("other-workspace-write", { workspaceId: "workspace-b" }));
  assert.throws(() => db.exec("DELETE FROM memory_item_enumeration_state"), /cannot be deleted/);
  assert.throws(() => db.exec("UPDATE memory_item_enumeration_state SET generation = generation - 1"), /advance once/);

  const expiryInput = { ...input, namespace: "expiry", limit: 1 };
  const expiryClock = repository.listPage(expiryInput).snapshotAt;
  const expiresAt = new Date(Date.parse(expiryClock) + 2_000).toISOString();
  seed("expires-during-pagination", { namespace: "expiry", expiresAt });
  seed("stable-expiry-row", { namespace: "expiry" });
  const expiringPage = repository.listPage(expiryInput);
  assert.equal(expiringPage.total, 2);
  assert.equal(expiringPage.continuation?.validUntil, expiresAt);
  await delay(Math.max(0, Date.parse(expiresAt) - Date.now()) + 80);
  assert.throws(() => repository.listPage({ ...expiryInput, continuation: expiringPage.continuation }), /expired/);
  assert.deepEqual(repository.listPage(expiryInput).rows.map(row => row.item_id), ["stable-expiry-row"]);
  return { enumerated: seen.length, pages, mutationInvalidations: 5, expiryInvalidation: true, schemaPreserved: true };
}
