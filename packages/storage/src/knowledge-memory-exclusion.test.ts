import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRepository } from "./knowledge-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const databases = new TempSqliteFiles();
afterEach(() => databases.cleanup());

it("excludes private memory documents and chunks before ordinary knowledge limits", () => {
  const repo = new KnowledgeRepository(databases.open({ dbPath: databases.path("private-knowledge") }));
  const publicDoc = repo.createDocumentWithChunks(
    { namespace: "shared", sourceType: "text", sourceRef: "public", title: "Public reference" },
    [{ content: "PUBLIC_CANARY" }],
    "2026-01-01T00:00:00.000Z",
  );
  const privateDocs = Array.from({ length: 5 }, (_, index) =>
    repo.createDocumentWithChunks(
      {
        namespace: "shared",
        sourceType: "memory",
        sourceRef: "private-" + index,
        title: "Private note",
        workspaceId: index % 2 ? "workspace-B" : "workspace-A",
        sessionId: index === 2 ? "group-A" : undefined,
      },
      [{ content: "PRIVATE_CANARY_" + index }],
      "2026-02-01T00:00:00.000Z",
    ),
  );
  const options = { excludeMemory: true };
  for (const namespace of [undefined, "shared"]) {
    assert.deepEqual(
      repo.listDocuments(namespace, 1, options).map((item) => item.docId),
      [publicDoc.document.docId],
    );
    assert.deepEqual(
      repo.listChunksByNamespace(namespace, 1, options).map((item) => item.docId),
      [publicDoc.document.docId],
    );
  }
  for (const item of privateDocs) assert.deepEqual(repo.listChunksByDocument(item.document.docId, 5, options), []);
  assert.equal(repo.listChunksByDocument(publicDoc.document.docId, 5, options).length, 1);
  // Lifecycle/artifact owners retain their explicit internal read; public tools opt into exclusion.
  assert.equal(repo.listDocuments("shared", 20).length, 6);
});
