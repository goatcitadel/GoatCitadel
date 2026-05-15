import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeFacadeService,
  knowledgeDocsIngest,
  knowledgeEmbeddingsIndex,
  knowledgeEmbeddingsQuery,
  knowledgeMemorySearch,
  knowledgeMemoryWrite,
  type KnowledgeFacadePort,
} from "./memory-facade-service.js";

describe("memory-facade-service", () => {
  it("routes knowledge memory writes with default session and agent context", async () => {
    const deps = fakeDeps();

    await expect(
      knowledgeMemoryWrite(deps, {
        namespace: "workspace",
        title: "Decision",
        content: "Use sqlite for tests.",
        tags: ["coverage"],
        metadata: { source: "test" },
        source: "operator",
      }),
    ).resolves.toEqual({ ok: true });

    expect(deps.invokeAndUnwrap).toHaveBeenCalledWith(
      {
        toolName: "memory.write",
        args: {
          namespace: "workspace",
          title: "Decision",
          content: "Use sqlite for tests.",
          tags: ["coverage"],
          metadata: { source: "test" },
          source: "operator",
        },
        sessionId: "session:operator:knowledge",
        agentId: "operator",
        taskId: undefined,
      },
      "knowledge_memory_write",
    );
  });

  it("routes all knowledge facade methods with explicit session context", async () => {
    const deps = fakeDeps();
    const service = new KnowledgeFacadeService(deps);

    await service.knowledgeMemoryWrite({
      namespace: "workspace",
      title: "Decision",
      content: "Use sqlite for tests.",
      sessionId: "session-0",
      agentId: "agent-0",
      taskId: "task-0",
    });
    await service.knowledgeMemorySearch({
      namespace: "workspace",
      query: "coverage",
      limit: 3,
      filters: { tag: "test" },
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
    });
    await service.knowledgeDocsIngest({
      sourceType: "text",
      source: "doc body",
      namespace: "docs",
      title: "Doc",
      chunking: { strategy: "paragraph" },
      metadata: { imported: true },
      sessionId: "session-2",
      agentId: "agent-2",
      taskId: "task-2",
    });
    await service.knowledgeEmbeddingsIndex({
      namespace: "docs",
      documentId: "doc-1",
      force: true,
      sessionId: "session-3",
      agentId: "agent-3",
      taskId: "task-3",
    });
    await service.knowledgeEmbeddingsQuery({
      namespace: "docs",
      query: "decision",
      limit: 5,
      sessionId: "session-4",
      agentId: "agent-4",
      taskId: "task-4",
    });

    expect(deps.invokeAndUnwrap).toHaveBeenNthCalledWith(
      1,
      {
        toolName: "memory.write",
        args: {
          namespace: "workspace",
          title: "Decision",
          content: "Use sqlite for tests.",
          tags: undefined,
          metadata: undefined,
          source: undefined,
        },
        sessionId: "session-0",
        agentId: "agent-0",
        taskId: "task-0",
      },
      "knowledge_memory_write",
    );
    expect(deps.invokeAndUnwrap).toHaveBeenNthCalledWith(
      2,
      {
        toolName: "memory.search",
        args: { namespace: "workspace", query: "coverage", limit: 3, filters: { tag: "test" } },
        sessionId: "session-1",
        agentId: "agent-1",
        taskId: "task-1",
      },
      "knowledge_memory_search",
    );
    expect(deps.invokeAndUnwrap).toHaveBeenNthCalledWith(
      3,
      {
        toolName: "docs.ingest",
        args: {
          sourceType: "text",
          source: "doc body",
          namespace: "docs",
          title: "Doc",
          chunking: { strategy: "paragraph" },
          metadata: { imported: true },
        },
        sessionId: "session-2",
        agentId: "agent-2",
        taskId: "task-2",
      },
      "knowledge_docs_ingest",
    );
    expect(deps.invokeAndUnwrap).toHaveBeenNthCalledWith(
      4,
      {
        toolName: "embeddings.index",
        args: { namespace: "docs", documentId: "doc-1", force: true },
        sessionId: "session-3",
        agentId: "agent-3",
        taskId: "task-3",
      },
      "knowledge_embeddings_index",
    );
    expect(deps.invokeAndUnwrap).toHaveBeenNthCalledWith(
      5,
      {
        toolName: "embeddings.query",
        args: { namespace: "docs", query: "decision", limit: 5 },
        sessionId: "session-4",
        agentId: "agent-4",
        taskId: "task-4",
      },
      "knowledge_embeddings_query",
    );
  });

  it("exports standalone helpers for docs and embedding calls", async () => {
    const deps = fakeDeps();

    await knowledgeDocsIngest(deps, { sourceType: "url", source: "https://example.test", namespace: "docs" });
    await knowledgeEmbeddingsIndex(deps, { namespace: "docs", documentId: "doc-2" });
    await knowledgeEmbeddingsQuery(deps, { namespace: "docs", query: "status" });
    await knowledgeMemorySearch(deps, { namespace: "workspace", query: "status" });

    expect(deps.invokeAndUnwrap).toHaveBeenCalledTimes(4);
  });
});

function fakeDeps(): KnowledgeFacadePort {
  return {
    invokeAndUnwrap: vi.fn(async () => ({ ok: true })),
  };
}
