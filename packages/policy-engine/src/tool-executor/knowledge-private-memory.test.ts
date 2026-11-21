import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Storage, createLocalAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { executeKnowledgeTool } from "./knowledge-executor.js";

let root: string, storage: Storage, store: AsyncStorage;
let workspaceA: string, workspaceB: string, privateDocId: string;
beforeEach(async () => {
  vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-private-knowledge-"));
  storage = new Storage({
    dbPath: path.join(root, "runtime.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  store = createLocalAsyncStorage(storage);
  workspaceA = storage.workspaces.create({ name: "Private A" }).workspaceId;
  workspaceB = storage.workspaces.create({ name: "Private B" }).workspaceId;
  const written = storage.knowledge.createDocumentWithChunks(
    {
      namespace: "shared",
      sourceType: "memory",
      sourceRef: "private-note",
      title: "PRIVATE_MEMORY_TITLE",
      workspaceId: workspaceA,
    },
    [{ content: "PRIVATE_MEMORY_CANARY" }],
  );
  privateDocId = written.document.docId;
  storage.knowledge.createDocumentWithChunks(
    {
      namespace: "shared",
      sourceType: "memory",
      sourceRef: "group-note",
      title: "PRIVATE_GROUP_TITLE",
      workspaceId: workspaceA,
      sessionId: "group-A",
    },
    [{ content: "PRIVATE_GROUP_CANARY" }],
  );
  storage.knowledge.createDocumentWithChunks(
    { namespace: "shared", sourceType: "text", sourceRef: "public-doc", title: "Public reference" },
    [{ content: "PUBLIC_REFERENCE_CANARY" }],
  );
});
afterEach(async () => {
  storage?.close();
  vi.unstubAllEnvs();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("gc-private-knowledge-"));
  await fs.rm(root, { recursive: true, force: true });
});
function invoke(toolName: string, args: Record<string, unknown>, workspaceId = workspaceB, sessionId = "dm-B") {
  return executeKnowledgeTool(
    { toolName, args, workspaceId, sessionId, agentId: "private-note-proof" } as ToolInvokeRequest,
    {} as never,
    store,
    {} as never,
  );
}
it.each(["docs.search", "embeddings.query"])(
  "%s excludes private notes in another workspace and a group",
  async (toolName) => {
    for (const [workspaceId, sessionId] of [
      [workspaceB, "dm-B"],
      [workspaceA, "group-A"],
    ]) {
      const result = await invoke(
        toolName,
        { namespace: "shared", query: "CANARY", limit: 10 },
        workspaceId,
        sessionId,
      );
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_(?:MEMORY|GROUP)/);
      expect(JSON.stringify(result)).toContain("PUBLIC_REFERENCE_CANARY");
    }
  },
);
it("embedding indexing never reads or repairs a private memory artifact", async () => {
  const result = await invoke("embeddings.index", { documentId: privateDocId, force: true });
  expect(result).toMatchObject({ indexed: 0, skipped: 0 });
  expect(storage.knowledge.listChunksByDocument(privateDocId)[0]!.embedding).toBeUndefined();
});
it("namespace-wide embedding repair also excludes private notes", async () => {
  const result = await invoke("embeddings.index", { namespace: "shared", force: true });
  expect(result).toMatchObject({ indexed: 1 });
  expect(storage.knowledge.listChunksByDocument(privateDocId)[0]!.embedding).toBeUndefined();
});
