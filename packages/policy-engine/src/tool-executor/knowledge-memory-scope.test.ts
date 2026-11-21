import { afterEach, describe, expect, it, vi } from "vitest";
import { executeKnowledgeTool } from "./knowledge-executor.js";
afterEach(() => vi.unstubAllEnvs());

function request(toolName: string, args: Record<string, unknown>) {
  return { toolName, args, sessionId: "private-chat", workspaceId: "workspace-A" } as never;
}

describe("governed memory tool reads", () => {
  it("requires the lifecycle write owner and passes its frozen scope instead of independently storing a document", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
    const documentWrite = vi.fn(),
      writeMemory = vi.fn(async () => ({
        itemId: "canonical-note",
        sourceHash: "a".repeat(64),
        document: {
          docId: "artifact",
          metadata: {},
          sourceType: "memory",
          sourceRef: "memory-item:canonical-note",
          title: "The notebook is blue.",
        },
        chunks: [],
      }));
    const call = {
      ...(request("memory.write", { content: "The notebook is blue." }) as object),
      memoryWriteBinding: {
        workspaceId: "workspace-A",
        sessionId: "private-chat",
        sessionIncarnation: "b".repeat(64),
        visibility: "workspace",
        trustLevel: "trusted_operator",
        upsertKey: "c".repeat(64),
      },
    } as never;
    await expect(
      executeKnowledgeTool(
        call,
        {} as never,
        { knowledge: { createDocumentWithChunks: documentWrite } } as never,
        {} as never,
      ),
    ).rejects.toThrow(/lifecycle|owner/i);
    const result = await executeKnowledgeTool(call, {} as never, {} as never, { writeMemory } as never);
    expect(result).toMatchObject({ itemId: "canonical-note", sourceHash: "a".repeat(64) });
    expect(writeMemory).toHaveBeenCalledWith(
      call,
      expect.objectContaining({
        namespace: "general",
        title: "The notebook is blue.",
        content: "The notebook is blue.",
        upsert: false,
        chunks: expect.any(Array),
      }),
    );
    expect(documentWrite).not.toHaveBeenCalled();
  });
  it("uses the lifecycle read port and never falls back to an unscoped knowledge scan", async () => {
    const listDocuments = vi.fn();
    const searchMemory = vi.fn(async () => ({
      items: [{ sourceRef: "approved", snippet: "Kestrel uses port 45433" }],
      coverage: { lexicalStatus: "ready" },
    }));
    const storage = { knowledge: { listDocuments } } as never;
    const result = await executeKnowledgeTool(request("memory.search", { query: "Kestrel" }), {} as never, storage, {
      searchMemory,
    } as never);
    expect(result.items).toEqual([{ sourceRef: "approved", snippet: "Kestrel uses port 45433" }]);
    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "private-chat" }));
    expect(listDocuments).not.toHaveBeenCalled();
    const unavailable = await executeKnowledgeTool(
      request("memory.read", { query: "Kestrel" }),
      {} as never,
      storage,
      {} as never,
    );
    expect(unavailable).toMatchObject({ items: [], unavailable: true });
    expect(listDocuments).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing writes before embedding or persistence", async () => {
    const write = vi.fn();
    await expect(
      executeKnowledgeTool(
        request("memory.write", { content: "My password is synthetic-only-value-8472" }),
        {} as never,
        { knowledge: { createDocumentWithChunks: write } } as never,
        {} as never,
      ),
    ).rejects.toThrow("credential");
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["namespace", "title", "tags", "metadata"])(
    "rejects credential values in %s before persistence",
    async (field) => {
      const secret = "GC_SYNTHETIC_TEST_KEY_ABCD_8642";
      vi.stubEnv("OPENAI_API_KEY", secret);
      vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
      const write = vi.fn(async (input) => ({
        document: { ...input, docId: "synthetic-write", createdAt: new Date().toISOString() },
        chunks: [],
      }));
      const storage = {
        sessions: { getBySessionId: vi.fn(async () => ({ sessionId: "private-chat", kind: "dm" })) },
        chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-A", lifecycleStatus: "active" })) },
        knowledge: { createDocumentWithChunks: write },
      };
      const value = field === "tags" ? [secret] : field === "metadata" ? { nested: { value: secret } } : secret;
      await expect(
        executeKnowledgeTool(
          request("memory.write", { content: "The notebook is blue.", [field]: value }),
          {} as never,
          storage as never,
          {} as never,
        ),
      ).rejects.toThrow("credential");
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("rejects a nested credential-key value even without an environment match", async () => {
    await expect(
      executeKnowledgeTool(
        request("memory.write", {
          content: "The notebook is blue.",
          metadata: { database: { password: "synthetic-credential-8472" } },
        }),
        {} as never,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow("credential");
  });

  it("keeps group transcript search in the calling session and blocks cross-session expansion", async () => {
    const searchMessages = vi.fn(async () => []);
    const storage = {
      sessions: { getBySessionId: vi.fn(async () => ({ kind: "group" })) },
      chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-A", includeInHistory: true })) },
      chatMessages: { searchMessages },
    };
    const result = await executeKnowledgeTool(
      request("session.search", { query: "deployment", scope: "all" }),
      {} as never,
      storage as never,
      {} as never,
    );
    expect(result.scope).toBe("session");
    expect(searchMessages).toHaveBeenCalledWith(
      "deployment",
      expect.objectContaining({ workspaceId: "workspace-A", sessionId: "private-chat" }),
    );
    await expect(
      executeKnowledgeTool(
        request("session.history", { sessionId: "another-chat", messageId: "m", sequence: 1 }),
        {} as never,
        storage as never,
        {} as never,
      ),
    ).rejects.toThrow("unavailable");
  });
});
