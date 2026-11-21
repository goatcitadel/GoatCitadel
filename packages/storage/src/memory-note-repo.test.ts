import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { SessionRepository } from "./session-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { MemoryNoteRepository } from "./memory-note-repo.js";
import { MemoryRecallRepository } from "./memory-recall-repo.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
function fixture() {
  const db = files.open({ dbPath: files.path("canonical-memory-note") });
  for (const [sessionId, kind, origin] of [
    ["private", "dm", "operator"],
    ["other", "dm", "operator"],
    ["group", "group", "operator"],
    ["machine", "dm", "automation"],
  ] as const) {
    new SessionRepository(db).upsert({
      sessionId,
      sessionKey: sessionId,
      kind,
      channel: "web",
      account: "operator",
      timestamp: "2026-11-18T00:00:00.000Z",
    });
    const meta = new ChatSessionMetaRepository(db);
    meta.ensure(sessionId, undefined, "default");
    meta.patch(sessionId, { origin } as never);
  }
  return { db, notes: new MemoryNoteRepository(db), recall: new MemoryRecallRepository(db) };
}
function write(
  f: ReturnType<typeof fixture>,
  sessionId = "private",
  upsert = true,
  target: Record<string, string> = {},
) {
  const binding = f.notes.prepareWrite({
    sessionId,
    namespace: "notes",
    title: "Notebook",
    trustLevel: "trusted_operator",
    upsert,
    ...target,
  });
  return f.notes.write({
    binding,
    namespace: "notes",
    title: "Notebook",
    content: "The notebook is blue.",
    metadata: {},
    chunks: [{ content: "The notebook is blue." }],
    actorId: "operator",
    upsert,
  });
}
it("uses one lifecycle identity for exact upserts, with immutable artifacts and stale-write refusal", () => {
  const f = fixture(),
    first = write(f);
  assert.ok(first.itemId);
  assert.equal(first.sourceHash.length, 64);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get<{ n: number }>()?.n, 1);
  assert.throws(() => write(f), /review|current|target/i);
  const binding = f.notes.prepareWrite({
    sessionId: "private",
    namespace: "notes",
    title: "Notebook",
    upsert: true,
    trustLevel: "trusted_operator",
    expectedItemId: first.itemId,
    expectedSourceHash: first.sourceHash,
  });
  const second = f.notes.write({
    binding,
    namespace: "notes",
    title: "Notebook",
    content: "The notebook is green.",
    metadata: {},
    chunks: [{ content: "The notebook is green." }],
    actorId: "operator",
    upsert: true,
  });
  assert.equal(second.itemId, first.itemId);
  assert.notEqual(second.document.docId, first.document.docId);
  assert.notEqual(second.sourceHash, first.sourceHash);
  assert.throws(
    () =>
      f.notes.write({
        binding,
        namespace: "notes",
        title: "Notebook",
        content: "Stale replacement",
        metadata: {},
        chunks: [],
        actorId: "operator",
        upsert: true,
      }),
    /changed|current|target/i,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_change_history").get<{ n: number }>()?.n, 2);
  assert.equal(
    f.recall.searchEligibleCorpus({ workspaceId: "default", sessionId: "other", query: "notebook" }).hits.length,
    1,
  );
  f.db.prepare("UPDATE memory_items SET status='forgotten' WHERE item_id=?").run(first.itemId);
  assert.deepEqual(
    f.recall.searchEligibleCorpus({ workspaceId: "default", sessionId: "private", query: "notebook" }).hits,
    [],
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents").get<{ n: number }>()?.n, 2);
});
it("keeps group and machine notes session-only and invalidates a pending write after incarnation changes", () => {
  const f = fixture();
  for (const sessionId of ["group", "machine"]) {
    const saved = write(f, sessionId);
    assert.deepEqual(
      f.recall.getEligibleSources({
        workspaceId: "default",
        sessionId: "private",
        sources: [{ sourceType: "memory_item", sourceRef: saved.itemId }],
      }),
      [],
    );
  }
  const binding = f.notes.prepareWrite({
    sessionId: "private",
    namespace: "notes",
    title: "Pending",
    trustLevel: "trusted_operator",
    upsert: false,
  });
  f.db.prepare("UPDATE chat_session_meta SET created_at='2026-11-19T00:00:00.000Z' WHERE session_id='private'").run();
  assert.throws(
    () =>
      f.notes.write({
        binding,
        namespace: "notes",
        title: "Pending",
        content: "stale",
        metadata: {},
        chunks: [],
        actorId: "operator",
        upsert: false,
      }),
    /changed|scope|incarnation/i,
  );
});
it("preserves restrictive trust and hashes the same complete item bytes in the default and indexed readers", () => {
  const f = fixture();
  const binding = f.notes.prepareWrite({
    sessionId: "private",
    namespace: "notes",
    title: "External",
    trustLevel: "untrusted_external",
    upsert: false,
  });
  const saved = f.notes.write({
    binding,
    namespace: "notes",
    title: "External",
    content: "External notebook evidence.",
    metadata: { ingestion: { trustLevel: "trusted_operator" } },
    chunks: [],
    actorId: "operator",
    upsert: false,
  });
  const input = { workspaceId: "default", sessionId: "private" };
  const plain = f.recall.listEligibleMemoryItemSources(input).find((item) => item.sourceRef === saved.itemId)!;
  const indexed = f.recall.searchEligibleCorpus({ ...input, query: "notebook" }).hits[0]!;
  assert.equal(plain.trustLevel, "untrusted_external");
  assert.equal(indexed.trustLevel, "untrusted_external");
  assert.equal(plain.sourceHash, indexed.sourceHash);
  assert.equal(plain.sourceHash, saved.sourceHash);
  f.db.prepare("UPDATE memory_items SET content='Corrected source bytes' WHERE item_id=?").run(saved.itemId);
  assert.notEqual(f.recall.listEligibleMemoryItemSources(input)[0]?.sourceHash, saved.sourceHash);
});
it("retains the same upsert identity after the Library owner renames the canonical item", () => {
  const f = fixture(),
    first = write(f);
  f.db.prepare("UPDATE memory_items SET title='Renamed notebook' WHERE item_id=?").run(first.itemId);
  const current = f.recall.getEligibleSources({
    workspaceId: "default",
    sessionId: "private",
    sources: [{ sourceType: "memory_item", sourceRef: first.itemId }],
  })[0]!;
  const binding = f.notes.prepareWrite({
    sessionId: "private",
    namespace: "notes",
    title: "Renamed notebook",
    upsert: true,
    trustLevel: "trusted_operator",
    expectedItemId: first.itemId,
    expectedSourceHash: current.sourceHash,
  });
  const next = f.notes.write({
    binding,
    namespace: "notes",
    title: "Renamed notebook",
    content: "The renamed notebook is green.",
    metadata: {},
    chunks: [],
    actorId: "operator",
    upsert: true,
  });
  assert.equal(next.itemId, first.itemId);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get<{ n: number }>()?.n, 1);
});
it("projects only current, unchanged note embeddings under the canonical item identity", () => {
  const f = fixture(),
    binding = f.notes.prepareWrite({
      sessionId: "private",
      namespace: "notes",
      title: "Vectors",
      trustLevel: "trusted_operator",
      upsert: false,
    });
  const saved = f.notes.write({
    binding,
    namespace: "notes",
    title: "Vectors",
    content: "First notebook evidence. Second notebook evidence.",
    metadata: {},
    actorId: "operator",
    upsert: false,
    chunks: [
      {
        content: "First notebook evidence.",
        embedding: [1, 0],
        embeddingMetadata: { provider: "remote", modelId: "fixture", dimensions: 2, version: "1" },
      },
      {
        content: "Second notebook evidence.",
        embedding: [0, 1],
        embeddingMetadata: { provider: "remote", modelId: "fixture", dimensions: 2, version: "1" },
      },
    ],
  });
  const input = { workspaceId: "default", sessionId: "private" };
  const page = f.recall.listVectorPage(input);
  assert.equal(page.entries.length, 2);
  assert.ok(page.entries.every((entry) => entry.sourceType === "memory_item" && entry.sourceRef === saved.itemId));
  assert.equal(new Set(page.entries.map((entry) => entry.vectorRef)).size, 2);
  f.db
    .prepare("UPDATE memory_items SET content='A new canonical note without fresh embeddings.' WHERE item_id=?")
    .run(saved.itemId);
  assert.deepEqual(f.recall.listVectorPage(input).entries, []);
});
