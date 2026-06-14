import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { KnowledgeRepository } from "./knowledge-repo.js";

const createdFiles: string[] = [];
type FakeStatementOverrides = {
  run?: (...params: unknown[]) => { changes: number };
  get?: (...params: unknown[]) => unknown;
  all?: (...params: unknown[]) => unknown;
};

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): KnowledgeRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-knowledge-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new KnowledgeRepository(createDatabase({ dbPath }));
}

describe("KnowledgeRepository", () => {
  it("round-trips documents, chunks, embeddings, and deletes", () => {
    const repo = createRepo();
    const doc = repo.createDocument(
      {
        namespace: "workspace:a",
        sourceType: "file",
        sourceRef: "notes/plan.md",
        title: "Plan",
        metadata: { owner: "ops", priority: 2 },
      },
      "2026-04-20T00:00:00.000Z",
    );
    const other = repo.createDocument(
      {
        namespace: "workspace:b",
        sourceType: "url",
        sourceRef: "https://example.com",
        title: "Reference",
      },
      "2026-04-20T00:01:00.000Z",
    );

    const chunks = repo.appendChunks(
      doc.docId,
      [
        {
          content: "",
          embedding: [0.1, 0.2],
          embeddingMetadata: {
            provider: "transformers-js",
            modelId: "test-model",
            dimensions: 2,
            generatedAt: "2026-04-20T00:02:00.000Z",
            version: "test",
          },
        },
        { content: "123456789" },
      ],
      "2026-04-20T00:02:00.000Z",
    );

    assert.equal(chunks[0]?.tokenEstimate, 0);
    assert.equal(chunks[0]?.embeddingMetadata?.modelId, "test-model");
    assert.equal(chunks[1]?.tokenEstimate, 3);
    assert.deepEqual(repo.getDocument(doc.docId)?.metadata, { owner: "ops", priority: 2 });
    assert.equal(repo.getDocument("missing-doc"), undefined);
    assert.deepEqual(
      repo.listDocuments("workspace:a").map((item) => item.docId),
      [doc.docId],
    );
    assert.deepEqual(
      repo.listDocuments(undefined, 10).map((item) => item.docId),
      [other.docId, doc.docId],
    );
    assert.deepEqual(
      repo.listChunksByNamespace("workspace:a").map((chunk) => chunk.chunkId),
      [chunks[0]!.chunkId, chunks[1]!.chunkId],
    );
    assert.deepEqual(
      repo.listChunksByNamespace(undefined, 10).map((chunk) => chunk.chunkId),
      [chunks[0]!.chunkId, chunks[1]!.chunkId],
    );

    repo.updateChunkEmbedding(chunks[1]!.chunkId, [0.4, 0.5], {
      provider: "pseudo",
      modelId: "pseudo-hash-v1",
      dimensions: 2,
      generatedAt: "2026-04-20T00:03:00.000Z",
      version: "test",
    });
    assert.deepEqual(repo.listChunksByDocument(doc.docId)[1]?.embedding, [0.4, 0.5]);
    assert.equal(repo.listChunksByDocument(doc.docId)[1]?.embeddingMetadata?.provider, "pseudo");
    assert.equal(repo.deleteDocument("missing-doc"), false);
    assert.equal(repo.deleteDocument(other.docId), true);
    repo.deleteNamespace("workspace:a");
    assert.deepEqual(repo.listDocuments(undefined, 10), []);
    assert.deepEqual(repo.listChunksByNamespace(undefined, 10), []);
  });

  it("filters malformed rows and falls back on invalid JSON fields", () => {
    const validDocumentRow = {
      doc_id: "doc-valid",
      namespace: "workspace:a",
      source_type: "memory",
      source_ref: "memory:1",
      title: "Memory",
      metadata_json: "{not-json",
      created_at: "2026-04-20T00:00:00.000Z",
    };
    const validChunkRow = {
      chunk_id: "chunk-valid",
      doc_id: "doc-valid",
      seq: 0,
      content: "chunk",
      embedding_json: JSON.stringify([1, "bad"]),
      embedding_metadata_json: "{not-json",
      token_estimate: 4,
      created_at: "2026-04-20T00:01:00.000Z",
    };
    const repo = new KnowledgeRepository(
      fakeDatabase([
        fakeStatement(),
        fakeStatement(),
        fakeStatement({ all: () => [null, { ...validChunkRow, chunk_id: 42 }, validChunkRow] }),
        fakeStatement({ all: () => "not-an-array" }),
        fakeStatement({ all: () => [validChunkRow] }),
        fakeStatement({ all: () => [null, { ...validDocumentRow, source_type: "bad" }, validDocumentRow] }),
        fakeStatement({ all: () => "not-an-array" }),
        fakeStatement({ all: () => [validDocumentRow] }),
        fakeStatement(),
        fakeStatement(),
        fakeStatement(),
        fakeStatement({ run: () => ({ changes: 0 }) }),
      ]),
    );

    assert.deepEqual(
      repo.listDocuments().map((item) => item.metadata),
      [{}],
    );
    assert.deepEqual(repo.listDocuments("workspace:a"), []);
    assert.equal(repo.getDocument("doc-valid")?.docId, "doc-valid");
    assert.deepEqual(repo.listChunksByNamespace(), []);
    assert.deepEqual(
      repo.listChunksByNamespace("workspace:a").map((chunk) => chunk.embedding),
      [undefined],
    );
    assert.equal(repo.listChunksByDocument("doc-valid")[0]?.embedding, undefined);
  });
});

function fakeDatabase(statements: DbStatement[]): DatabaseClient {
  let index = 0;
  return {
    dialect: "sqlite",
    prepare: () => statements[index++] ?? fakeStatement(),
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
}

function fakeStatement(overrides: FakeStatementOverrides = {}): DbStatement {
  return {
    run: overrides.run ?? (() => ({ changes: 1 })),
    get: <T = unknown>(...params: unknown[]) => (overrides.get?.(...params) as T | undefined) ?? undefined,
    all: <T = unknown>(...params: unknown[]) => (overrides.all?.(...params) ?? []) as T[],
  };
}
