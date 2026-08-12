import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { composeChatCompletionMemoryContext } from "./llm-completion-memory-context.js";
import type { LlmCompletionHost } from "./llm-completion-host.js";

// Review Finding 1 regression guard: the chat-completion memory path MUST scope
// DB memory-item collection to the turn's workspace. The bug was that this caller
// never passed `workspaceId`, so `collectMemoryItemSources` ran the unfiltered
// query and could surface another workspace's memory items into the completion.
// These tests assert the caller forwards a resolved, non-undefined workspaceId.

function buildHost(overrides: {
  composeContext: ReturnType<typeof vi.fn>;
  resolveWorkspaceId: () => string;
}): LlmCompletionHost {
  const host = {
    config: {
      assistant: {
        memory: { enabled: true, qmd: { enabled: true, applyToChat: true } },
      },
    },
    memoryLifecycleService: { composeContext: overrides.composeContext },
    resolveMemoryWorkspaceRelativeDir: () => "memory",
    resolveChatCompletionHookWorkspaceId: overrides.resolveWorkspaceId,
  } as unknown as LlmCompletionHost;
  return host;
}

function buildRequest(sessionId: string): ChatCompletionRequest {
  return {
    messages: [{ role: "user", content: "what did we decide about pricing?" }],
    memory: { enabled: true, mode: "qmd", sessionId },
  } as ChatCompletionRequest;
}

describe("composeChatCompletionMemoryContext workspace scoping (Finding 1)", () => {
  it("does not compose retrieval context when the turn disables memory", async () => {
    const composeContext = vi.fn();
    const host = buildHost({ composeContext, resolveWorkspaceId: () => "workspace-b" });
    const request = {
      ...buildRequest("sess-memory-off"),
      memory: { enabled: false, mode: "off", sessionId: "sess-memory-off" },
    } as ChatCompletionRequest;

    await expect(composeChatCompletionMemoryContext(host, request, request.memory)).resolves.toBeUndefined();
    expect(composeContext).not.toHaveBeenCalled();
  });

  it("forwards the resolved workspaceId into composeContext", async () => {
    const composeContext = vi.fn().mockResolvedValue({ contextText: "", citations: [], placement: undefined });
    const host = buildHost({ composeContext, resolveWorkspaceId: () => "workspace-b" });

    await composeChatCompletionMemoryContext(host, buildRequest("sess-in-b"), buildRequest("sess-in-b").memory);

    expect(composeContext).toHaveBeenCalledTimes(1);
    expect(composeContext.mock.calls[0][0]).toMatchObject({ workspaceId: "workspace-b" });
  });

  it("always passes a defined workspaceId (never falls back to the unfiltered query)", async () => {
    const composeContext = vi.fn().mockResolvedValue({ contextText: "", citations: [], placement: undefined });
    const host = buildHost({ composeContext, resolveWorkspaceId: () => "default" });

    await composeChatCompletionMemoryContext(host, buildRequest("sess-x"), buildRequest("sess-x").memory);

    const passed = composeContext.mock.calls[0][0] as { workspaceId?: string };
    expect(passed.workspaceId).toBeDefined();
    expect(passed.workspaceId).toBe("default");
  });
});
