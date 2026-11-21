import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { MemoryRecallRepository } from "./memory-recall-repo.js";
import { SessionRepository } from "./session-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { KnowledgeRepository } from "./knowledge-repo.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const now = "2026-11-18T00:00:00.000Z";

it("searches old facts among 10,000 entries before applying candidate limits and rechecks live eligibility", (t) => {
  const db = files.open({ dbPath: files.path("recall-corpus") });
  const sessions = new SessionRepository(db);
  for (const kind of ["dm", "group", "thread"] as const) {
    sessions.upsert({ sessionId: kind, sessionKey: kind, kind, channel: "web", account: "operator", timestamp: now });
    const meta = new ChatSessionMetaRepository(db);
    meta.ensure(kind, now, "default");
    meta.patch(kind, { origin: "operator" });
  }
  const insert = db.prepare(`INSERT INTO memory_items
    (item_id, namespace, title, content, metadata_json, pinned, status, created_at, updated_at, workspace_id)
    VALUES (?, 'notes', ?, ?, '{}', 0, 'active', ?, ?, ?)`);
  db.transaction("immediate", () => {
    for (let i = 0; i < 10_000; i++)
      insert.run(
        `m${i}`,
        `Entry ${i}`,
        i === 37 ? "The kestrel deployment uses port 45433." : `Unrelated shopping entry ${i}`,
        now,
        now,
        "default",
      );
    insert.run("foreign", "Foreign", "kestrel secret foreign deployment", now, now, "foreign");
  });
  const repo = new MemoryRecallRepository(db);
  const request = { workspaceId: "default", sessionId: "dm", query: "kestrel deployment", limit: 40 };
  const result = repo.searchEligibleCorpus(request);
  assert.equal(result.hits[0]?.sourceRef, "m37");
  assert.ok(result.hits.every((hit) => hit.sourceRef !== "foreign"));
  assert.equal(result.hits[0]?.sourceHash.length, 64);
  assert.ok(result.hits[0]!.snippet.includes("45433"));
  assert.equal(result.coverage.lexicalStatus, "ready");
  const timings = Array.from({ length: 20 }, () => {
    const started = performance.now();
    assert.equal(repo.searchEligibleCorpus(request).hits[0]?.sourceRef, "m37");
    return performance.now() - started;
  }).sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ corpusEntries: 10_000, queries: 20, p50Ms: timings[10], p95Ms: timings[18] }));
  assert.deepEqual(repo.searchEligibleCorpus({ ...request, query: "nonexistentnebula" }).hits, []);
  for (const sessionId of ["group", "thread", "missing"])
    assert.deepEqual(repo.searchEligibleCorpus({ ...request, sessionId }).hits, []);
  assert.deepEqual(repo.searchEligibleCorpus({ ...request, workspaceId: "foreign" }).hits, []);
  db.prepare("UPDATE memory_items SET status = 'forgotten' WHERE item_id = 'm37'").run();
  assert.deepEqual(repo.searchEligibleCorpus(request).hits, []);
});

it("backfills a bounded page without changing canonical data, and does not infer ownership of legacy knowledge", () => {
  const db = files.open({ dbPath: files.path("recall-backfill") });
  new SessionRepository(db).upsert({
    sessionId: "dm",
    sessionKey: "dm",
    kind: "dm",
    channel: "web",
    account: "operator",
    timestamp: now,
  });
  const meta = new ChatSessionMetaRepository(db);
  meta.ensure("dm", now, "default");
  meta.patch("dm", { origin: "operator" });
  const insert = db.prepare(`INSERT INTO memory_items
    (item_id, namespace, title, content, metadata_json, pinned, status, created_at, updated_at)
    VALUES (?, 'notes', 'Legacy', 'legacy kestrel fact', '{}', 0, 'active', ?, ?)`);
  for (let i = 0; i < 7; i++) insert.run(`legacy${i}`, now, now);
  db.prepare("DELETE FROM memory_recall_documents").run(); // simulate an older, not-yet-indexed corpus
  const repo = new MemoryRecallRepository(db);
  const page = repo.backfillPage({ limit: 3 });
  assert.equal(page.indexed, 3);
  assert.equal(page.hasMore, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get<{ n: number }>()?.n, 7);
  assert.equal(
    repo.searchEligibleCorpus({ workspaceId: "default", sessionId: "dm", query: "kestrel", limit: 40 }).coverage
      .lexicalStatus,
    "building",
  );
  while (repo.backfillPage({ limit: 3 }).hasMore) {
    /* bounded pages, no full-corpus materialization */
  }
  assert.equal(
    repo.searchEligibleCorpus({ workspaceId: "default", sessionId: "dm", query: "kestrel", limit: 40 }).hits.length,
    7,
  );
});

it("preserves carried source trust, scopes vector pages, and invalidates generations on document ownership changes", () => {
  const db = files.open({ dbPath: files.path("recall-knowledge-scope") });
  new SessionRepository(db).upsert({
    sessionId: "dm",
    sessionKey: "dm",
    kind: "dm",
    channel: "web",
    account: "operator",
    timestamp: now,
  });
  const meta = new ChatSessionMetaRepository(db);
  meta.ensure("dm", now, "default");
  meta.patch("dm", { origin: "operator" });
  const knowledge = new KnowledgeRepository(db);
  const owned = knowledge.createDocumentWithChunks(
    {
      namespace: "notes",
      title: "Kestrel source",
      sourceType: "memory",
      sourceRef: "explicit-note",
      workspaceId: "default",
      metadata: { ingestion: { trustLevel: "untrusted_external" } },
    },
    [
      {
        content: "Kestrel retained external evidence",
        embedding: [1, 0],
        embeddingMetadata: { provider: "remote", modelId: "fixture", dimensions: 2, version: "1" },
      },
    ],
  );
  knowledge.createDocumentWithChunks(
    { namespace: "notes", title: "Unowned legacy", sourceType: "memory", sourceRef: "legacy" },
    [{ content: "Kestrel foreign legacy", embedding: [1, 0] }],
  );
  const repo = new MemoryRecallRepository(db);
  const input = { workspaceId: "default", sessionId: "dm", query: "Kestrel", limit: 40 };
  const result = repo.searchEligibleCorpus(input);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.trustLevel, "untrusted_external");
  assert.equal(result.hits[0]?.documentSourceRef, "explicit-note");
  assert.equal(repo.listVectorPage(input).entries.length, 1);
  const generation = repo.readGeneration();
  db.prepare("UPDATE knowledge_documents SET workspace_id = 'foreign' WHERE doc_id = ?").run(owned.document.docId);
  assert.ok(repo.readGeneration() > generation);
  assert.deepEqual(repo.searchEligibleCorpus(input).hits, []);
  assert.deepEqual(repo.listVectorPage(input).entries, []);
});
